/**
 * Bollinger Bands Indicator
 * 
 * Purpose: Volatility and mean reversion indicator
 * Components:
 *   - Middle Band: Simple Moving Average (SMA)
 *   - Upper Band: SMA + (Standard Deviation × multiplier)
 *   - Lower Band: SMA - (Standard Deviation × multiplier)
 *   - %B: Position within bands (0-1)
 *   - Bandwidth: Width of bands relative to middle
 */

const logger = require('../utils/logger');

/**
 * Calculate Bollinger Bands for given candles
 * @param {Array} candles - Array of candle objects with {close, ...}
 * @param {number} period - SMA period (default: 20)
 * @param {number} stdDev - Standard deviation multiplier (default: 2)
 * @returns {Object} Bollinger Bands analysis
 */
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  if (!candles || candles.length < period) {
    logger.warn({
      candleCount: candles?.length || 0,
      required: period
    }, '[bollinger] Insufficient candles for Bollinger Bands calculation');
    return null;
  }

  try {
    // Get recent candles for calculation
    const recentCandles = candles.slice(-period);
    const closes = recentCandles.map(c => c.close || c.c);
    
    // Calculate SMA (Middle Band)
    const sma = closes.reduce((sum, close) => sum + close, 0) / period;
    
    // Calculate Standard Deviation
    const squaredDiffs = closes.map(close => Math.pow(close - sma, 2));
    const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period;
    const standardDeviation = Math.sqrt(variance);
    
    // Calculate Upper and Lower Bands
    const upperBand = sma + (stdDev * standardDeviation);
    const lowerBand = sma - (stdDev * standardDeviation);
    
    // Current price
    const currentPrice = candles[candles.length - 1].close || candles[candles.length - 1].c;
    
    // Calculate %B (position within bands)
    // %B = (Price - Lower Band) / (Upper Band - Lower Band)
    // %B > 1: above upper band, %B < 0: below lower band, 0.5: at middle
    const percentB = (currentPrice - lowerBand) / (upperBand - lowerBand);
    
    // Calculate Bandwidth (width of bands relative to middle)
    // Bandwidth = (Upper Band - Lower Band) / Middle Band × 100
    const bandwidth = ((upperBand - lowerBand) / sma) * 100;
    
    // Determine signal
    let signal = 'neutral';
    let strength = 'weak';
    
    if (percentB > 1) {
      signal = 'overbought';
      strength = percentB > 1.2 ? 'very_strong' : 'strong';
    } else if (percentB < 0) {
      signal = 'oversold';
      strength = percentB < -0.2 ? 'very_strong' : 'strong';
    } else if (percentB > 0.8) {
      signal = 'near_upper';
      strength = 'moderate';
    } else if (percentB < 0.2) {
      signal = 'near_lower';
      strength = 'moderate';
    }
    
    // Determine squeeze (low volatility)
    let squeeze = 'normal';
    if (bandwidth < 10) {
      squeeze = 'tight'; // Bollinger Squeeze - breakout likely
    } else if (bandwidth > 20) {
      squeeze = 'wide'; // High volatility
    }
    
    // Distance from bands
    const distanceFromUpper = ((upperBand - currentPrice) / currentPrice) * 100;
    const distanceFromLower = ((currentPrice - lowerBand) / currentPrice) * 100;
    const distanceFromMiddle = ((currentPrice - sma) / currentPrice) * 100;
    
    // Check for band walk (strong trend)
    let bandWalk = null;
    if (candles.length >= period + 5) {
      const last5Candles = candles.slice(-5);
      const allAboveMiddle = last5Candles.every(c => (c.close || c.c) > sma);
      const allBelowMiddle = last5Candles.every(c => (c.close || c.c) < sma);
      
      if (allAboveMiddle) bandWalk = 'upper_band_walk';
      else if (allBelowMiddle) bandWalk = 'lower_band_walk';
    }
    
    const result = {
      upper: Number(upperBand.toFixed(2)),
      middle: Number(sma.toFixed(2)),
      lower: Number(lowerBand.toFixed(2)),
      current: Number(currentPrice.toFixed(2)),
      percentB: Number(percentB.toFixed(2)),
      bandwidth: Number(bandwidth.toFixed(2)),
      signal,
      strength,
      squeeze,
      band_walk: bandWalk,
      distance_from_upper: Number(distanceFromUpper.toFixed(2)),
      distance_from_lower: Number(distanceFromLower.toFixed(2)),
      distance_from_middle: Number(distanceFromMiddle.toFixed(2)),
      above_middle: currentPrice > sma,
      below_middle: currentPrice < sma,
      period,
      stdDev,
      confidence: calculateConfidence(percentB, bandwidth, signal, squeeze),
    };

    logger.info({
      current: result.current,
      middle: result.middle,
      percentB: result.percentB,
      signal: result.signal,
      squeeze: result.squeeze
    }, '[bollinger] Bollinger Bands calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[bollinger] Error calculating Bollinger Bands');
    return null;
  }
}

/**
 * Calculate confidence based on Bollinger Bands values and signals
 * @param {number} percentB - %B value
 * @param {number} bandwidth - Bandwidth value
 * @param {string} signal - Signal type
 * @param {string} squeeze - Squeeze state
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(percentB, bandwidth, signal, squeeze) {
  let confidence = 50; // Base confidence
  
  // Extreme positions increase confidence
  if (signal === 'overbought' || signal === 'oversold') {
    if (percentB > 1.2 || percentB < -0.2) confidence = 90;
    else if (percentB > 1.1 || percentB < -0.1) confidence = 80;
    else confidence = 70;
  }
  
  // Near bands increases confidence
  if (signal === 'near_upper' || signal === 'near_lower') {
    confidence = 65;
  }
  
  // Squeeze increases confidence for breakout
  if (squeeze === 'tight') {
    confidence += 10; // Breakout likely
  }
  
  // Wide bands decrease confidence (high volatility, less predictable)
  if (squeeze === 'wide') {
    confidence -= 5;
  }
  
  return Math.min(100, Math.max(0, confidence));
}

/**
 * Analyze Bollinger Bands for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} Bollinger Bands analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const candles1m = aggregator?.payload?.candles?.['1m'] || [];
    const candles5m = aggregator?.payload?.candles?.['5m'] || [];
    
    const bb1m = calculateBollingerBands(
      candles1m,
      settings?.bollingerPeriod || 20,
      settings?.bollingerStdDev || 2
    );
    const bb5m = calculateBollingerBands(
      candles5m,
      settings?.bollingerPeriod || 20,
      settings?.bollingerStdDev || 2
    );

    if (!bb1m && !bb5m) {
      return {
        bollinger_score: 50,
        bollinger_bias: 'neutral',
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    // Use 5m Bollinger as primary, 1m as confirmation
    const primaryBB = bb5m || bb1m;
    const confirmBB = bb1m;

    // Calculate combined score
    let score = 50; // Neutral base
    
    if (primaryBB.signal === 'oversold' || primaryBB.signal === 'near_lower') {
      // Price near/below lower band - bullish reversal setup
      if (primaryBB.signal === 'oversold') {
        score = 75;
      } else {
        score = 65;
      }
    } else if (primaryBB.signal === 'overbought' || primaryBB.signal === 'near_upper') {
      // Price near/above upper band - bearish reversal setup
      if (primaryBB.signal === 'overbought') {
        score = 25;
      } else {
        score = 35;
      }
    } else if (primaryBB.above_middle) {
      score = 60; // Above middle - bullish bias
    } else if (primaryBB.below_middle) {
      score = 40; // Below middle - bearish bias
    }

    // Adjust for squeeze (breakout potential)
    if (primaryBB.squeeze === 'tight') {
      // Squeeze detected - breakout likely, use direction from middle band
      if (primaryBB.above_middle) {
        score += 5; // Bullish breakout likely
      } else {
        score -= 5; // Bearish breakout likely
      }
    }

    // Adjust for band walk (strong trend)
    if (primaryBB.band_walk === 'upper_band_walk') {
      score += 10; // Strong uptrend
    } else if (primaryBB.band_walk === 'lower_band_walk') {
      score -= 10; // Strong downtrend
    }

    // Adjust for confirmation
    if (confirmBB) {
      if (confirmBB.signal === primaryBB.signal) {
        score += primaryBB.signal === 'oversold' || primaryBB.signal === 'near_lower' ? 5 : -5;
      }
      if (confirmBB.squeeze === 'tight' && primaryBB.squeeze === 'tight') {
        score += primaryBB.above_middle ? 5 : -5; // Confirmed squeeze
      }
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    const result = {
      bollinger_score: Number(score.toFixed(1)),
      bollinger_bias: primaryBB.above_middle ? 'bullish' : 'bearish',
      signal: primaryBB.signal === 'oversold' || primaryBB.signal === 'near_lower' ? 'buy' :
              primaryBB.signal === 'overbought' || primaryBB.signal === 'near_upper' ? 'sell' :
              primaryBB.above_middle ? 'buy' : 'sell',
      confidence: primaryBB.confidence,
      bollinger_1m: bb1m,
      bollinger_5m: bb5m,
      primary_percentB: primaryBB.percentB,
      primary_bandwidth: primaryBB.bandwidth,
      squeeze: primaryBB.squeeze,
      band_walk: primaryBB.band_walk,
      trading_implication: getTradingImplication(primaryBB, confirmBB),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[bollinger] Error in analyze');
    return {
      bollinger_score: 50,
      bollinger_bias: 'neutral',
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on Bollinger Bands analysis
 * @param {Object} primaryBB - Primary Bollinger Bands data
 * @param {Object} confirmBB - Confirmation Bollinger Bands data
 * @returns {string} Trading implication
 */
function getTradingImplication(primaryBB, confirmBB) {
  if (!primaryBB) return 'Insufficient data for Bollinger Bands analysis';

  if (primaryBB.squeeze === 'tight') {
    if (confirmBB && confirmBB.squeeze === 'tight') {
      return 'Bollinger Squeeze detected on multiple timeframes - major breakout imminent, prepare for strong move';
    }
    return 'Bollinger Squeeze detected - volatility compression, breakout likely soon';
  }

  if (primaryBB.band_walk === 'upper_band_walk') {
    return 'Upper band walk detected - very strong uptrend, price riding upper band, excellent for CE';
  }

  if (primaryBB.band_walk === 'lower_band_walk') {
    return 'Lower band walk detected - very strong downtrend, price riding lower band, excellent for PE';
  }

  if (primaryBB.signal === 'oversold') {
    if (confirmBB && confirmBB.signal === 'oversold') {
      return 'Price below lower band on multiple timeframes - strong oversold, prime reversal for CE';
    }
    return 'Price below lower band - oversold condition, mean reversion likely, good for CE entry';
  }

  if (primaryBB.signal === 'overbought') {
    if (confirmBB && confirmBB.signal === 'overbought') {
      return 'Price above upper band on multiple timeframes - strong overbought, prime reversal for PE';
    }
    return 'Price above upper band - overbought condition, mean reversion likely, good for PE entry';
  }

  if (primaryBB.signal === 'near_lower') {
    return 'Price near lower band - potential bounce zone, consider CE entry';
  }

  if (primaryBB.signal === 'near_upper') {
    return 'Price near upper band - potential resistance zone, consider PE entry';
  }

  if (primaryBB.above_middle) {
    return 'Price above middle band - bullish bias, favor CE entries';
  }

  if (primaryBB.below_middle) {
    return 'Price below middle band - bearish bias, favor PE entries';
  }

  return 'Bollinger Bands neutral - price near middle band, wait for clearer signal';
}

module.exports = {
  calculateBollingerBands,
  analyze,
  name: 'Bollinger Bands',
  description: 'Volatility and mean reversion indicator',
};
