/**
 * Stochastic Oscillator Indicator
 * 
 * Purpose: Momentum indicator for entry/exit timing
 * Range: 0-100
 * Overbought: > 80
 * Oversold: < 20
 * Crossovers: %K crossing %D signals momentum shifts
 */

const logger = require('../utils/logger');

/**
 * Calculate Stochastic Oscillator for given candles
 * @param {Array} candles - Array of candle objects with {high, low, close, ...}
 * @param {number} kPeriod - %K period (default: 14)
 * @param {number} dPeriod - %D period (default: 3)
 * @returns {Object} Stochastic analysis
 */
function calculateStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod) {
    logger.warn({
      candleCount: candles?.length || 0,
      required: kPeriod
    }, '[stochastic] Insufficient candles for Stochastic calculation');
    return null;
  }

  try {
    // Get recent candles for %K calculation
    const recentCandles = candles.slice(-kPeriod);
    const currentClose = candles[candles.length - 1].close || candles[candles.length - 1].c;
    
    // Find highest high and lowest low in the period
    const lowestLow = Math.min(...recentCandles.map(c => c.low || c.l));
    const highestHigh = Math.max(...recentCandles.map(c => c.high || c.h));
    
    // Calculate %K
    let k = 0;
    if (highestHigh !== lowestLow) {
      k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    }
    
    // Calculate %D (SMA of last dPeriod %K values)
    // For simplicity, we'll calculate %K for the last dPeriod candles and average them
    const kValues = [];
    for (let i = candles.length - dPeriod; i < candles.length; i++) {
      if (i < kPeriod - 1) continue; // Not enough data for this candle
      
      const periodCandles = candles.slice(i - kPeriod + 1, i + 1);
      const close = candles[i].close || candles[i].c;
      const low = Math.min(...periodCandles.map(c => c.low || c.l));
      const high = Math.max(...periodCandles.map(c => c.high || c.h));
      
      if (high !== low) {
        kValues.push(((close - low) / (high - low)) * 100);
      }
    }
    
    const d = kValues.length > 0 
      ? kValues.reduce((sum, val) => sum + val, 0) / kValues.length 
      : k;
    
    // Determine signal
    let signal = 'neutral';
    let strength = 'weak';
    
    if (k > 80) {
      signal = 'overbought';
      strength = k > 90 ? 'very_strong' : 'strong';
    } else if (k < 20) {
      signal = 'oversold';
      strength = k < 10 ? 'very_strong' : 'strong';
    } else if (k > 60) {
      signal = 'bullish';
      strength = 'moderate';
    } else if (k < 40) {
      signal = 'bearish';
      strength = 'moderate';
    }
    
    // Determine crossover
    const crossover = k > d ? 'bullish' : 'bearish';
    const crossoverStrength = Math.abs(k - d);
    
    // Check for recent crossover (strong signal)
    let recentCrossover = null;
    if (kValues.length >= 2) {
      const prevK = kValues[kValues.length - 2];
      const prevD = d; // Simplified - should calculate previous %D
      
      if (prevK <= prevD && k > d) {
        recentCrossover = 'bullish_crossover';
      } else if (prevK >= prevD && k < d) {
        recentCrossover = 'bearish_crossover';
      }
    }
    
    const result = {
      k: Number(k.toFixed(2)),
      d: Number(d.toFixed(2)),
      signal,
      strength,
      crossover,
      crossover_strength: Number(crossoverStrength.toFixed(2)),
      recent_crossover: recentCrossover,
      overbought: k > 80,
      oversold: k < 20,
      neutral: k >= 20 && k <= 80,
      kPeriod,
      dPeriod,
      confidence: calculateConfidence(k, d, signal, recentCrossover),
    };

    logger.info({
      k: result.k,
      d: result.d,
      signal: result.signal,
      crossover: result.crossover,
      recentCrossover: result.recent_crossover
    }, '[stochastic] Stochastic calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[stochastic] Error calculating Stochastic');
    return null;
  }
}

/**
 * Calculate confidence based on Stochastic values and signals
 * @param {number} k - %K value
 * @param {number} d - %D value
 * @param {string} signal - Signal type
 * @param {string} recentCrossover - Recent crossover type
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(k, d, signal, recentCrossover) {
  let confidence = 50; // Base confidence
  
  // Extreme zones increase confidence
  if (signal === 'overbought' || signal === 'oversold') {
    if (k > 90 || k < 10) confidence = 90;
    else if (k > 85 || k < 15) confidence = 80;
    else confidence = 70;
  }
  
  // Crossovers increase confidence
  if (recentCrossover) {
    confidence += 15;
  } else {
    // Strong divergence between %K and %D
    const divergence = Math.abs(k - d);
    if (divergence > 20) confidence += 10;
    else if (divergence > 10) confidence += 5;
  }
  
  // Directional bias
  if (signal === 'bullish' || signal === 'bearish') {
    confidence = Math.max(confidence, 60);
  }
  
  return Math.min(100, confidence);
}

/**
 * Analyze Stochastic for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} Stochastic analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const candles1m = aggregator?.payload?.candles?.['1m'] || [];
    const candles5m = aggregator?.payload?.candles?.['5m'] || [];
    
    const stoch1m = calculateStochastic(
      candles1m, 
      settings?.stochasticKPeriod || 14,
      settings?.stochasticDPeriod || 3
    );
    const stoch5m = calculateStochastic(
      candles5m,
      settings?.stochasticKPeriod || 14,
      settings?.stochasticDPeriod || 3
    );

    if (!stoch1m && !stoch5m) {
      return {
        stochastic_score: 50,
        stochastic_bias: 'neutral',
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    // Use 5m Stochastic as primary, 1m as confirmation
    const primaryStoch = stoch5m || stoch1m;
    const confirmStoch = stoch1m;

    // Calculate combined score
    let score = 50; // Neutral base
    
    if (primaryStoch.signal === 'oversold') {
      score = 75; // Very bullish (excellent for CE entry)
    } else if (primaryStoch.signal === 'overbought') {
      score = 25; // Very bearish (excellent for PE entry)
    } else if (primaryStoch.crossover === 'bullish') {
      score = 65;
    } else if (primaryStoch.crossover === 'bearish') {
      score = 35;
    }

    // Boost for recent crossovers
    if (primaryStoch.recent_crossover === 'bullish_crossover') {
      score += 10;
    } else if (primaryStoch.recent_crossover === 'bearish_crossover') {
      score -= 10;
    }

    // Adjust for confirmation
    if (confirmStoch) {
      if (confirmStoch.crossover === primaryStoch.crossover) {
        score += primaryStoch.crossover === 'bullish' ? 5 : -5;
      }
      if (confirmStoch.recent_crossover === primaryStoch.recent_crossover) {
        score += primaryStoch.recent_crossover === 'bullish_crossover' ? 5 : -5;
      }
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    const result = {
      stochastic_score: Number(score.toFixed(1)),
      stochastic_bias: primaryStoch.crossover === 'bullish' ? 'bullish' : 'bearish',
      signal: primaryStoch.signal === 'oversold' ? 'buy' : 
              primaryStoch.signal === 'overbought' ? 'sell' : 
              primaryStoch.recent_crossover === 'bullish_crossover' ? 'buy' :
              primaryStoch.recent_crossover === 'bearish_crossover' ? 'sell' : 'wait',
      confidence: primaryStoch.confidence,
      stochastic_1m: stoch1m,
      stochastic_5m: stoch5m,
      primary_k: primaryStoch.k,
      primary_d: primaryStoch.d,
      recent_crossover: primaryStoch.recent_crossover,
      trading_implication: getTradingImplication(primaryStoch, confirmStoch),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[stochastic] Error in analyze');
    return {
      stochastic_score: 50,
      stochastic_bias: 'neutral',
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on Stochastic analysis
 * @param {Object} primaryStoch - Primary Stochastic data
 * @param {Object} confirmStoch - Confirmation Stochastic data
 * @returns {string} Trading implication
 */
function getTradingImplication(primaryStoch, confirmStoch) {
  if (!primaryStoch) return 'Insufficient data for Stochastic analysis';

  if (primaryStoch.recent_crossover === 'bullish_crossover') {
    if (confirmStoch && confirmStoch.recent_crossover === 'bullish_crossover') {
      return 'Strong bullish crossover on multiple timeframes - excellent CE entry';
    }
    return 'Bullish crossover detected - good momentum for CE entry';
  }

  if (primaryStoch.recent_crossover === 'bearish_crossover') {
    if (confirmStoch && confirmStoch.recent_crossover === 'bearish_crossover') {
      return 'Strong bearish crossover on multiple timeframes - excellent PE entry';
    }
    return 'Bearish crossover detected - good momentum for PE entry';
  }

  if (primaryStoch.signal === 'oversold') {
    if (confirmStoch && confirmStoch.signal === 'oversold') {
      return 'Strong oversold condition - prime reversal setup for CE';
    }
    return 'Oversold condition - potential bounce for CE entry';
  }

  if (primaryStoch.signal === 'overbought') {
    if (confirmStoch && confirmStoch.signal === 'overbought') {
      return 'Strong overbought condition - prime reversal setup for PE';
    }
    return 'Overbought condition - potential pullback for PE entry';
  }

  if (primaryStoch.crossover === 'bullish') {
    return 'Stochastic shows bullish momentum - favor CE entries';
  }

  if (primaryStoch.crossover === 'bearish') {
    return 'Stochastic shows bearish momentum - favor PE entries';
  }

  return 'Stochastic neutral - wait for clearer momentum signal';
}

module.exports = {
  calculateStochastic,
  analyze,
  name: 'Stochastic Oscillator',
  description: 'Momentum indicator for entry/exit timing',
};
