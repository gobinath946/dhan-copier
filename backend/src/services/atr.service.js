/**
 * ATR (Average True Range) Service
 * 
 * Calculates ATR for volatility-based confirmation.
 * ATR helps determine if the market has enough movement to capture target points.
 * 
 * Key Concepts:
 * - ATR measures market volatility
 * - Higher ATR = more volatile = easier to capture points
 * - Lower ATR = less volatile = harder to capture points
 * - We use ATR to validate if targetPoints is achievable
 */

const logger = require('../utils/logger');

/**
 * Calculate True Range for a single candle
 * TR = max(high - low, abs(high - prevClose), abs(low - prevClose))
 */
function calculateTrueRange(candle, prevClose) {
  if (!candle || !candle.h || !candle.l) return 0;
  
  const highLow = candle.h - candle.l;
  
  if (!prevClose) {
    return highLow; // First candle, use high-low only
  }
  
  const highPrevClose = Math.abs(candle.h - prevClose);
  const lowPrevClose = Math.abs(candle.l - prevClose);
  
  return Math.max(highLow, highPrevClose, lowPrevClose);
}

/**
 * Calculate ATR from candles
 * @param {Array} candles - Array of OHLC candles [{o, h, l, c, t}]
 * @param {number} period - ATR period (default 14)
 * @returns {Object} ATR data
 */
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return {
      atr: null,
      atrPct: null,
      volatility: 'unknown',
      error: `Insufficient candles (need ${period + 1}, got ${candles.length})`,
    };
  }
  
  // Calculate True Range for each candle
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = calculateTrueRange(candles[i], candles[i - 1].c);
    trueRanges.push(tr);
  }
  
  if (trueRanges.length < period) {
    return {
      atr: null,
      atrPct: null,
      volatility: 'unknown',
      error: `Insufficient TR values (need ${period}, got ${trueRanges.length})`,
    };
  }
  
  // Calculate initial ATR (simple average of first 'period' TRs)
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  
  // Calculate smoothed ATR for remaining candles
  // ATR = ((previous ATR * (period - 1)) + current TR) / period
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }
  
  // Get current price for percentage calculation
  const currentPrice = candles[candles.length - 1].c;
  const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  
  // Classify volatility
  let volatility = 'low';
  if (atrPct > 1.5) volatility = 'very_high';
  else if (atrPct > 1.0) volatility = 'high';
  else if (atrPct > 0.5) volatility = 'moderate';
  
  return {
    atr: Number(atr.toFixed(2)),
    atrPct: Number(atrPct.toFixed(3)),
    volatility,
    currentPrice: Number(currentPrice.toFixed(2)),
    candlesUsed: candles.length,
    period,
  };
}

/**
 * Analyze if target points are achievable based on ATR
 * @param {number} atr - Current ATR value
 * @param {number} targetPoints - Target points to capture
 * @param {number} currentPrice - Current option premium
 * @returns {Object} Analysis result
 */
function analyzeTargetAchievability(atr, targetPoints, currentPrice) {
  if (!atr || !targetPoints || !currentPrice) {
    return {
      achievable: false,
      confidence: 0,
      reasoning: 'Missing ATR, target points, or current price',
    };
  }
  
  // Calculate how many ATRs the target represents
  const targetAsATRMultiple = targetPoints / atr;
  
  // Calculate target as percentage of current price
  const targetPct = (targetPoints / currentPrice) * 100;
  
  // Achievability logic:
  // - If target < 0.5 ATR: Very achievable (80-95% confidence)
  // - If target < 1.0 ATR: Achievable (60-80% confidence)
  // - If target < 1.5 ATR: Moderately achievable (40-60% confidence)
  // - If target >= 1.5 ATR: Difficult (0-40% confidence)
  
  let achievable = false;
  let confidence = 0;
  let reasoning = '';
  
  if (targetAsATRMultiple < 0.5) {
    achievable = true;
    confidence = 85;
    reasoning = `Target (${targetPoints}pts) is ${(targetAsATRMultiple * 100).toFixed(0)}% of ATR (${atr}pts) - very achievable`;
  } else if (targetAsATRMultiple < 1.0) {
    achievable = true;
    confidence = 70;
    reasoning = `Target (${targetPoints}pts) is ${(targetAsATRMultiple * 100).toFixed(0)}% of ATR (${atr}pts) - achievable`;
  } else if (targetAsATRMultiple < 1.5) {
    achievable = targetAsATRMultiple < 1.2; // Only achievable if < 1.2 ATR
    confidence = 50;
    reasoning = `Target (${targetPoints}pts) is ${(targetAsATRMultiple * 100).toFixed(0)}% of ATR (${atr}pts) - moderately achievable`;
  } else {
    achievable = false;
    confidence = 25;
    reasoning = `Target (${targetPoints}pts) is ${(targetAsATRMultiple * 100).toFixed(0)}% of ATR (${atr}pts) - difficult to achieve`;
  }
  
  return {
    achievable,
    confidence,
    reasoning,
    targetAsATRMultiple: Number(targetAsATRMultiple.toFixed(2)),
    targetPct: Number(targetPct.toFixed(2)),
    atr,
    targetPoints,
  };
}

/**
 * Get ATR data for entry/monitor decisions
 * @param {Array} candles1m - 1-minute candles
 * @param {Array} candles5m - 5-minute candles
 * @param {number} targetPoints - Target points to validate
 * @param {number} currentPrice - Current option premium
 * @returns {Object} Complete ATR analysis
 */
function getATRAnalysis(candles1m, candles5m, targetPoints, currentPrice) {
  // Calculate ATR on both timeframes
  const atr1m = calculateATR(candles1m, 14);
  const atr5m = calculateATR(candles5m, 14);
  
  // Use 5m ATR as primary (more stable), 1m as secondary
  const primaryATR = atr5m.atr || atr1m.atr;
  const primaryVolatility = atr5m.volatility !== 'unknown' ? atr5m.volatility : atr1m.volatility;
  
  if (!primaryATR) {
    return {
      atr_1m: atr1m,
      atr_5m: atr5m,
      primary_atr: null,
      volatility: 'unknown',
      target_achievability: {
        achievable: false,
        confidence: 0,
        reasoning: 'Insufficient data for ATR calculation',
      },
      recommendation: 'WAIT - Need more candles for ATR calculation',
    };
  }
  
  // Analyze target achievability
  const achievability = analyzeTargetAchievability(primaryATR, targetPoints, currentPrice);
  
  // Generate recommendation
  let recommendation = 'WAIT';
  if (achievability.achievable && achievability.confidence >= 70) {
    recommendation = 'ENTER - High probability of capturing target';
  } else if (achievability.achievable && achievability.confidence >= 50) {
    recommendation = 'ENTER_CAUTIOUS - Moderate probability of capturing target';
  } else if (achievability.confidence >= 40) {
    recommendation = 'WAIT - Target may be too ambitious for current volatility';
  } else {
    recommendation = 'NO_TRADE - Target not achievable with current ATR';
  }
  
  return {
    atr_1m: atr1m,
    atr_5m: atr5m,
    primary_atr: primaryATR,
    primary_atr_pct: atr5m.atrPct || atr1m.atrPct,
    volatility: primaryVolatility,
    target_achievability: achievability,
    recommendation,
  };
}

/**
 * Check if ATR confirms entry (60% threshold)
 * @param {Object} atrAnalysis - ATR analysis from getATRAnalysis
 * @returns {boolean} True if ATR confirms entry
 */
function atrConfirmsEntry(atrAnalysis) {
  if (!atrAnalysis || !atrAnalysis.target_achievability) {
    return false;
  }
  
  // Require 60% confidence minimum
  return atrAnalysis.target_achievability.achievable && 
         atrAnalysis.target_achievability.confidence >= 60;
}

module.exports = {
  calculateATR,
  analyzeTargetAchievability,
  getATRAnalysis,
  atrConfirmsEntry,
};
