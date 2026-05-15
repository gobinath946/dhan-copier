/**
 * RSI (Relative Strength Index) Indicator
 * 
 * Purpose: Identify overbought/oversold conditions
 * Range: 0-100
 * Overbought: > 70
 * Oversold: < 30
 * Neutral: 30-70
 */

const logger = require('../utils/logger');

/**
 * Calculate RSI for given candles
 * @param {Array} candles - Array of candle objects with {close, ...}
 * @param {number} period - RSI period (default: 14)
 * @returns {Object} RSI analysis
 */
function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    logger.warn({
      candleCount: candles?.length || 0,
      required: period + 1
    }, '[rsi] Insufficient candles for RSI calculation');
    return null;
  }

  try {
    // Get closing prices
    const closes = candles.map(c => c.close || c.c);
    
    // Calculate price changes
    const changes = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    // Calculate initial average gain and loss
    let gains = 0;
    let losses = 0;
    
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) {
        gains += changes[i];
      } else {
        losses += Math.abs(changes[i]);
      }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate RSI using Wilder's smoothing method
    for (let i = period; i < changes.length; i++) {
      const gain = changes[i] > 0 ? changes[i] : 0;
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
      
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    // Calculate RSI
    let rsi;
    if (avgLoss === 0) {
      rsi = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi = 100 - (100 / (1 + rs));
    }

    // Determine signal
    let signal = 'neutral';
    let strength = 'weak';
    
    if (rsi > 70) {
      signal = 'overbought';
      strength = rsi > 80 ? 'very_strong' : 'strong';
    } else if (rsi < 30) {
      signal = 'oversold';
      strength = rsi < 20 ? 'very_strong' : 'strong';
    } else if (rsi > 60) {
      signal = 'bullish';
      strength = 'moderate';
    } else if (rsi < 40) {
      signal = 'bearish';
      strength = 'moderate';
    }

    // Determine bias
    const bias = rsi > 50 ? 'bullish' : 'bearish';

    // Calculate divergence (if we have enough data)
    let divergence = null;
    if (candles.length >= period * 2) {
      const recentCandles = candles.slice(-period);
      const priceHigh = Math.max(...recentCandles.map(c => c.high || c.h));
      const priceLow = Math.min(...recentCandles.map(c => c.low || c.l));
      
      // Simple divergence detection
      const priceDirection = closes[closes.length - 1] > closes[closes.length - period] ? 'up' : 'down';
      const rsiDirection = rsi > 50 ? 'up' : 'down';
      
      if (priceDirection !== rsiDirection) {
        divergence = priceDirection === 'up' ? 'bearish_divergence' : 'bullish_divergence';
      }
    }

    const result = {
      rsi: Number(rsi.toFixed(2)),
      signal,
      strength,
      bias,
      divergence,
      overbought: rsi > 70,
      oversold: rsi < 30,
      neutral: rsi >= 30 && rsi <= 70,
      period,
      confidence: calculateConfidence(rsi, signal),
    };

    logger.info({
      rsi: result.rsi,
      signal: result.signal,
      bias: result.bias,
      strength: result.strength
    }, '[rsi] RSI calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[rsi] Error calculating RSI');
    return null;
  }
}

/**
 * Calculate confidence based on RSI value and signal
 * @param {number} rsi - RSI value
 * @param {string} signal - Signal type
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(rsi, signal) {
  if (signal === 'overbought' || signal === 'oversold') {
    // Higher confidence for extreme values
    if (rsi > 80 || rsi < 20) return 90;
    if (rsi > 75 || rsi < 25) return 80;
    return 70;
  }
  
  if (signal === 'bullish' || signal === 'bearish') {
    // Moderate confidence for directional bias
    return 60;
  }
  
  // Low confidence for neutral
  return 40;
}

/**
 * Analyze RSI for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} RSI analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const candles1m = aggregator?.payload?.candles?.['1m'] || [];
    const candles5m = aggregator?.payload?.candles?.['5m'] || [];
    
    const rsi1m = calculateRSI(candles1m, settings?.rsiPeriod || 14);
    const rsi5m = calculateRSI(candles5m, settings?.rsiPeriod || 14);

    if (!rsi1m && !rsi5m) {
      return {
        rsi_score: 50,
        rsi_bias: 'neutral',
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    // Use 5m RSI as primary, 1m as confirmation
    const primaryRSI = rsi5m || rsi1m;
    const confirmRSI = rsi1m;

    // Calculate combined score
    let score = 50; // Neutral base
    
    if (primaryRSI.signal === 'oversold') {
      score = 70; // Bullish (good for CE entry)
    } else if (primaryRSI.signal === 'overbought') {
      score = 30; // Bearish (good for PE entry)
    } else if (primaryRSI.bias === 'bullish') {
      score = 60;
    } else if (primaryRSI.bias === 'bearish') {
      score = 40;
    }

    // Adjust for confirmation
    if (confirmRSI && confirmRSI.bias === primaryRSI.bias) {
      score += primaryRSI.bias === 'bullish' ? 5 : -5;
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    const result = {
      rsi_score: Number(score.toFixed(1)),
      rsi_bias: primaryRSI.bias,
      signal: primaryRSI.signal === 'oversold' ? 'buy' : 
              primaryRSI.signal === 'overbought' ? 'sell' : 'wait',
      confidence: primaryRSI.confidence,
      rsi_1m: rsi1m,
      rsi_5m: rsi5m,
      primary_rsi: primaryRSI.rsi,
      divergence: primaryRSI.divergence,
      trading_implication: getTradingImplication(primaryRSI, confirmRSI),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[rsi] Error in analyze');
    return {
      rsi_score: 50,
      rsi_bias: 'neutral',
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on RSI analysis
 * @param {Object} primaryRSI - Primary RSI data
 * @param {Object} confirmRSI - Confirmation RSI data
 * @returns {string} Trading implication
 */
function getTradingImplication(primaryRSI, confirmRSI) {
  if (!primaryRSI) return 'Insufficient data for RSI analysis';

  if (primaryRSI.signal === 'oversold') {
    if (confirmRSI && confirmRSI.signal === 'oversold') {
      return 'Strong oversold condition - excellent for CE entry';
    }
    return 'Oversold condition - good for CE entry';
  }

  if (primaryRSI.signal === 'overbought') {
    if (confirmRSI && confirmRSI.signal === 'overbought') {
      return 'Strong overbought condition - excellent for PE entry';
    }
    return 'Overbought condition - good for PE entry';
  }

  if (primaryRSI.divergence === 'bullish_divergence') {
    return 'Bullish divergence detected - potential reversal to upside';
  }

  if (primaryRSI.divergence === 'bearish_divergence') {
    return 'Bearish divergence detected - potential reversal to downside';
  }

  if (primaryRSI.bias === 'bullish') {
    return 'RSI shows bullish bias - favor CE entries';
  }

  if (primaryRSI.bias === 'bearish') {
    return 'RSI shows bearish bias - favor PE entries';
  }

  return 'RSI neutral - wait for clearer signal';
}

module.exports = {
  calculateRSI,
  analyze,
  name: 'RSI Indicator',
  description: 'Relative Strength Index for overbought/oversold conditions',
};
