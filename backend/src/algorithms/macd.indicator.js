/**
 * MACD (Moving Average Convergence Divergence) Indicator
 * 
 * Purpose: Trend following and momentum indicator
 * Components:
 *   - MACD Line: Fast EMA - Slow EMA
 *   - Signal Line: EMA of MACD Line
 *   - Histogram: MACD Line - Signal Line
 */

const logger = require('../utils/logger');

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {Array} values - Array of values
 * @param {number} period - EMA period
 * @returns {number} EMA value
 */
function calculateEMA(values, period) {
  if (!values || values.length === 0) return 0;
  
  const k = 2 / (period + 1);
  let ema = values[0];
  
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  
  return ema;
}

/**
 * Calculate MACD for given candles
 * @param {Array} candles - Array of candle objects with {close, ...}
 * @param {number} fastPeriod - Fast EMA period (default: 12)
 * @param {number} slowPeriod - Slow EMA period (default: 26)
 * @param {number} signalPeriod - Signal line period (default: 9)
 * @returns {Object} MACD analysis
 */
function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!candles || candles.length < slowPeriod) {
    logger.warn({
      candleCount: candles?.length || 0,
      required: slowPeriod
    }, '[macd] Insufficient candles for MACD calculation');
    return null;
  }

  try {
    // Get closing prices
    const closes = candles.map(c => c.close || c.c);
    
    // Calculate Fast and Slow EMAs
    const emaFast = calculateEMA(closes, fastPeriod);
    const emaSlow = calculateEMA(closes, slowPeriod);
    
    // Calculate MACD Line
    const macdLine = emaFast - emaSlow;
    
    // Calculate Signal Line (EMA of MACD line)
    // For proper calculation, we need MACD values for all candles
    // Simplified: use a portion of the MACD line
    const macdValues = [];
    for (let i = slowPeriod - 1; i < closes.length; i++) {
      const periodCloses = closes.slice(0, i + 1);
      const fast = calculateEMA(periodCloses, fastPeriod);
      const slow = calculateEMA(periodCloses, slowPeriod);
      macdValues.push(fast - slow);
    }
    
    const signalLine = macdValues.length >= signalPeriod 
      ? calculateEMA(macdValues.slice(-signalPeriod), signalPeriod)
      : macdLine * 0.9; // Fallback approximation
    
    // Calculate Histogram
    const histogram = macdLine - signalLine;
    
    // Determine trend
    const trend = histogram > 0 ? 'bullish' : 'bearish';
    
    // Determine strength
    let strength = 'weak';
    const absHistogram = Math.abs(histogram);
    if (absHistogram > 5) {
      strength = 'very_strong';
    } else if (absHistogram > 2) {
      strength = 'strong';
    } else if (absHistogram > 1) {
      strength = 'moderate';
    }
    
    // Determine crossover
    const crossover = macdLine > signalLine ? 'bullish' : 'bearish';
    
    // Check for recent crossover
    let recentCrossover = null;
    if (macdValues.length >= 2) {
      const prevMacd = macdValues[macdValues.length - 2];
      const prevSignal = macdValues.length >= signalPeriod + 1
        ? calculateEMA(macdValues.slice(-signalPeriod - 1, -1), signalPeriod)
        : prevMacd * 0.9;
      
      if (prevMacd <= prevSignal && macdLine > signalLine) {
        recentCrossover = 'bullish_crossover';
      } else if (prevMacd >= prevSignal && macdLine < signalLine) {
        recentCrossover = 'bearish_crossover';
      }
    }
    
    // Check for divergence
    let divergence = null;
    if (candles.length >= slowPeriod * 2) {
      const recentCandles = candles.slice(-slowPeriod);
      const priceHigh = Math.max(...recentCandles.map(c => c.high || c.h));
      const priceLow = Math.min(...recentCandles.map(c => c.low || c.l));
      const currentPrice = closes[closes.length - 1];
      
      // Simple divergence detection
      const priceDirection = currentPrice > closes[closes.length - slowPeriod] ? 'up' : 'down';
      const macdDirection = histogram > 0 ? 'up' : 'down';
      
      if (priceDirection !== macdDirection) {
        divergence = priceDirection === 'up' ? 'bearish_divergence' : 'bullish_divergence';
      }
    }
    
    const result = {
      macd: Number(macdLine.toFixed(2)),
      signal: Number(signalLine.toFixed(2)),
      histogram: Number(histogram.toFixed(2)),
      trend,
      strength,
      crossover,
      recent_crossover: recentCrossover,
      divergence,
      bullish: histogram > 0,
      bearish: histogram < 0,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      confidence: calculateConfidence(histogram, strength, recentCrossover),
    };

    logger.info({
      macd: result.macd,
      signal: result.signal,
      histogram: result.histogram,
      trend: result.trend,
      crossover: result.recent_crossover
    }, '[macd] MACD calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[macd] Error calculating MACD');
    return null;
  }
}

/**
 * Calculate confidence based on MACD values and signals
 * @param {number} histogram - MACD histogram value
 * @param {string} strength - Signal strength
 * @param {string} recentCrossover - Recent crossover type
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(histogram, strength, recentCrossover) {
  let confidence = 50; // Base confidence
  
  // Strength increases confidence
  if (strength === 'very_strong') {
    confidence = 85;
  } else if (strength === 'strong') {
    confidence = 75;
  } else if (strength === 'moderate') {
    confidence = 65;
  }
  
  // Recent crossovers significantly increase confidence
  if (recentCrossover) {
    confidence += 15;
  }
  
  // Strong histogram values increase confidence
  const absHistogram = Math.abs(histogram);
  if (absHistogram > 10) {
    confidence = Math.min(95, confidence + 10);
  } else if (absHistogram > 5) {
    confidence = Math.min(90, confidence + 5);
  }
  
  return Math.min(100, confidence);
}

/**
 * Analyze MACD for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} MACD analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const candles1m = aggregator?.payload?.candles?.['1m'] || [];
    const candles5m = aggregator?.payload?.candles?.['5m'] || [];
    
    const macd1m = calculateMACD(
      candles1m,
      settings?.macdFastPeriod || 12,
      settings?.macdSlowPeriod || 26,
      settings?.macdSignalPeriod || 9
    );
    const macd5m = calculateMACD(
      candles5m,
      settings?.macdFastPeriod || 12,
      settings?.macdSlowPeriod || 26,
      settings?.macdSignalPeriod || 9
    );

    if (!macd1m && !macd5m) {
      return {
        macd_score: 50,
        macd_bias: 'neutral',
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    // Use 5m MACD as primary, 1m as confirmation
    const primaryMACD = macd5m || macd1m;
    const confirmMACD = macd1m;

    // Calculate combined score
    let score = 50; // Neutral base
    
    if (primaryMACD.trend === 'bullish') {
      if (primaryMACD.strength === 'very_strong') {
        score = 85;
      } else if (primaryMACD.strength === 'strong') {
        score = 75;
      } else if (primaryMACD.strength === 'moderate') {
        score = 65;
      } else {
        score = 55;
      }
    } else if (primaryMACD.trend === 'bearish') {
      if (primaryMACD.strength === 'very_strong') {
        score = 15;
      } else if (primaryMACD.strength === 'strong') {
        score = 25;
      } else if (primaryMACD.strength === 'moderate') {
        score = 35;
      } else {
        score = 45;
      }
    }

    // Boost for recent crossovers
    if (primaryMACD.recent_crossover === 'bullish_crossover') {
      score += 10;
    } else if (primaryMACD.recent_crossover === 'bearish_crossover') {
      score -= 10;
    }

    // Adjust for confirmation
    if (confirmMACD) {
      if (confirmMACD.trend === primaryMACD.trend) {
        score += primaryMACD.trend === 'bullish' ? 5 : -5;
      }
      if (confirmMACD.recent_crossover === primaryMACD.recent_crossover) {
        score += primaryMACD.recent_crossover === 'bullish_crossover' ? 5 : -5;
      }
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    const result = {
      macd_score: Number(score.toFixed(1)),
      macd_bias: primaryMACD.trend === 'bullish' ? 'bullish' : 'bearish',
      signal: primaryMACD.recent_crossover === 'bullish_crossover' ? 'buy' :
              primaryMACD.recent_crossover === 'bearish_crossover' ? 'sell' :
              primaryMACD.trend === 'bullish' ? 'buy' :
              primaryMACD.trend === 'bearish' ? 'sell' : 'wait',
      confidence: primaryMACD.confidence,
      macd_1m: macd1m,
      macd_5m: macd5m,
      primary_histogram: primaryMACD.histogram,
      recent_crossover: primaryMACD.recent_crossover,
      divergence: primaryMACD.divergence,
      trading_implication: getTradingImplication(primaryMACD, confirmMACD),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[macd] Error in analyze');
    return {
      macd_score: 50,
      macd_bias: 'neutral',
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on MACD analysis
 * @param {Object} primaryMACD - Primary MACD data
 * @param {Object} confirmMACD - Confirmation MACD data
 * @returns {string} Trading implication
 */
function getTradingImplication(primaryMACD, confirmMACD) {
  if (!primaryMACD) return 'Insufficient data for MACD analysis';

  if (primaryMACD.recent_crossover === 'bullish_crossover') {
    if (confirmMACD && confirmMACD.recent_crossover === 'bullish_crossover') {
      return 'Strong bullish MACD crossover on multiple timeframes - excellent trend entry for CE';
    }
    return 'Bullish MACD crossover - trend turning up, good for CE entry';
  }

  if (primaryMACD.recent_crossover === 'bearish_crossover') {
    if (confirmMACD && confirmMACD.recent_crossover === 'bearish_crossover') {
      return 'Strong bearish MACD crossover on multiple timeframes - excellent trend entry for PE';
    }
    return 'Bearish MACD crossover - trend turning down, good for PE entry';
  }

  if (primaryMACD.divergence === 'bullish_divergence') {
    return 'Bullish divergence detected - price making lower lows but MACD making higher lows, potential reversal to upside';
  }

  if (primaryMACD.divergence === 'bearish_divergence') {
    return 'Bearish divergence detected - price making higher highs but MACD making lower highs, potential reversal to downside';
  }

  if (primaryMACD.trend === 'bullish' && primaryMACD.strength === 'very_strong') {
    return 'Very strong bullish MACD trend - excellent momentum for CE entries';
  }

  if (primaryMACD.trend === 'bearish' && primaryMACD.strength === 'very_strong') {
    return 'Very strong bearish MACD trend - excellent momentum for PE entries';
  }

  if (primaryMACD.trend === 'bullish') {
    return 'MACD shows bullish trend - favor CE entries';
  }

  if (primaryMACD.trend === 'bearish') {
    return 'MACD shows bearish trend - favor PE entries';
  }

  return 'MACD neutral - wait for clearer trend signal';
}

module.exports = {
  calculateMACD,
  analyze,
  name: 'MACD Indicator',
  description: 'Moving Average Convergence Divergence for trend following',
};
