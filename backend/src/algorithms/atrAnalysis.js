/**
 * ============================================================
 * ATR (Average True Range) ANALYSIS MODULE
 * ============================================================
 * Calculates ATR and provides volatility-based trade validation
 * 
 * PURPOSE:
 * - Validate if target points are achievable based on current volatility
 * - Prevent entries when market is too quiet (low ATR)
 * - Prevent entries when market is too volatile (high ATR)
 * - Provide dynamic stop-loss and target recommendations
 * 
 * ATR CONFIDENCE LOGIC:
 * - If target is within 0.5 ATR: 80-100% confidence (highly achievable)
 * - If target is within 1.0 ATR: 60-80% confidence (achievable)
 * - If target is within 1.5 ATR: 40-60% confidence (possible but risky)
 * - If target is beyond 1.5 ATR: 0-40% confidence (unlikely)
 * ============================================================
 */

const logger = require('../utils/logger');
const dhanProd = require('../services/dhanProd.service');

/**
 * Calculate True Range for a single candle
 * TR = max(high - low, abs(high - prevClose), abs(low - prevClose))
 */
function calculateTrueRange(candle, prevClose) {
  if (!prevClose) {
    return candle.high - candle.low;
  }
  
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low - prevClose)
  );
}

/**
 * Calculate ATR using Wilder's smoothing method
 * ATR = ((Previous ATR * (n-1)) + Current TR) / n
 */
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return null;
  }
  
  // Calculate initial ATR (simple average of first 'period' TRs)
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = calculateTrueRange(candles[i], candles[i - 1].close);
    trSum += tr;
  }
  let atr = trSum / period;
  
  // Apply Wilder's smoothing for remaining candles
  for (let i = period + 1; i < candles.length; i++) {
    const tr = calculateTrueRange(candles[i], candles[i - 1].close);
    atr = ((atr * (period - 1)) + tr) / period;
  }
  
  return atr;
}

/**
 * Calculate ATR confidence for a given target
 * Returns confidence % (0-100) that the target is achievable
 */
function calculateATRConfidence(atr, targetPoints, currentPrice) {
  if (!atr || atr <= 0) {
    return 50; // Neutral confidence if ATR unavailable
  }
  
  // Calculate target as percentage of ATR
  const targetAsATRMultiple = targetPoints / atr;
  
  // Confidence mapping:
  // 0.0 - 0.5 ATR: 80-100% confidence (very achievable)
  // 0.5 - 1.0 ATR: 60-80% confidence (achievable)
  // 1.0 - 1.5 ATR: 40-60% confidence (possible)
  // 1.5 - 2.0 ATR: 20-40% confidence (difficult)
  // 2.0+ ATR: 0-20% confidence (very unlikely)
  
  let confidence;
  if (targetAsATRMultiple <= 0.5) {
    confidence = 80 + (0.5 - targetAsATRMultiple) * 40; // 80-100%
  } else if (targetAsATRMultiple <= 1.0) {
    confidence = 60 + (1.0 - targetAsATRMultiple) * 40; // 60-80%
  } else if (targetAsATRMultiple <= 1.5) {
    confidence = 40 + (1.5 - targetAsATRMultiple) * 40; // 40-60%
  } else if (targetAsATRMultiple <= 2.0) {
    confidence = 20 + (2.0 - targetAsATRMultiple) * 40; // 20-40%
  } else {
    confidence = Math.max(0, 20 - (targetAsATRMultiple - 2.0) * 10); // 0-20%
  }
  
  return Math.round(Math.max(0, Math.min(100, confidence)));
}

/**
 * Get dynamic stop-loss and target based on ATR
 * Returns recommended SL and target points
 */
function getDynamicLevels(atr, riskRewardRatio = 1.5) {
  if (!atr || atr <= 0) {
    return {
      slPoints: 12,
      targetPoints: 18,
      reasoning: 'ATR unavailable, using default levels'
    };
  }
  
  // SL should be 0.8-1.0 ATR (enough room for noise, not too wide)
  const slPoints = Math.round(atr * 0.9);
  
  // Target based on R:R ratio
  const targetPoints = Math.round(slPoints * riskRewardRatio);
  
  return {
    slPoints: Math.max(8, Math.min(20, slPoints)), // Clamp between 8-20 points
    targetPoints: Math.max(12, Math.min(30, targetPoints)), // Clamp between 12-30 points
    reasoning: `ATR-based: SL=${slPoints}pts (0.9 ATR), Target=${targetPoints}pts (${riskRewardRatio}:1 R:R)`
  };
}

/**
 * Analyze market volatility state
 * Returns: quiet, normal, elevated, extreme
 */
function analyzeVolatilityState(atr, candles) {
  if (!atr || !candles || candles.length < 20) {
    return {
      state: 'unknown',
      recommendation: 'WAIT',
      reasoning: 'Insufficient data for volatility analysis'
    };
  }
  
  // Calculate ATR percentile over last 20 candles
  const recentATRs = [];
  for (let i = candles.length - 20; i < candles.length; i++) {
    if (i > 0) {
      const tr = calculateTrueRange(candles[i], candles[i - 1].close);
      recentATRs.push(tr);
    }
  }
  
  const avgRecentATR = recentATRs.reduce((a, b) => a + b, 0) / recentATRs.length;
  const atrRatio = atr / avgRecentATR;
  
  let state, recommendation, reasoning;
  
  if (atr < 5) {
    state = 'quiet';
    recommendation = 'REDUCE_SIZE';
    reasoning = 'Very low volatility - targets may be hard to reach, reduce position size';
  } else if (atr < 10) {
    state = 'normal';
    recommendation = 'PROCEED';
    reasoning = 'Normal volatility - good for scalping';
  } else if (atr < 20) {
    state = 'elevated';
    recommendation = 'PROCEED_CAUTIOUS';
    reasoning = 'Elevated volatility - widen stops, be ready for quick moves';
  } else {
    state = 'extreme';
    recommendation = 'REDUCE_SIZE';
    reasoning = 'Extreme volatility - high risk, reduce size or wait';
  }
  
  return {
    state,
    recommendation,
    reasoning,
    atr,
    avgRecentATR,
    atrRatio
  };
}

/**
 * Main ATR analysis function
 * Fetches candles, calculates ATR, and provides trade validation
 */
async function analyzeATR(authKey, targetPoints, slPoints, currentPrice) {
  try {
    // Fetch 1-minute candles for last 60 minutes (need at least 14 for ATR)
    const now = Math.floor(Date.now() / 1000);
    const sixtyMinAgo = now - (60 * 60);
    
    const candlesRes = await dhanProd.getDhanBypassData(authKey, {
      securityId: 13, // NIFTY 50
      exchange: 'IDX',
      segment: 'I',
      instrument: 'INDEX',
      startTime: sixtyMinAgo,
      endTime: now,
      interval: '1',
    });
    
    if (!candlesRes.ok || !candlesRes.data?.candles || candlesRes.data.candles.length < 15) {
      logger.warn('[atrAnalysis] Insufficient candle data for ATR calculation');
      return {
        atrAvailable: false,
        confidence: 50,
        recommendation: 'PROCEED_CAUTIOUS',
        reasoning: 'ATR data unavailable, proceeding with caution',
        volatilityState: 'unknown'
      };
    }
    
    const candles = candlesRes.data.candles;
    
    // Calculate ATR (14-period)
    const atr = calculateATR(candles, 14);
    
    if (!atr) {
      logger.warn('[atrAnalysis] ATR calculation failed');
      return {
        atrAvailable: false,
        confidence: 50,
        recommendation: 'PROCEED_CAUTIOUS',
        reasoning: 'ATR calculation failed, proceeding with caution',
        volatilityState: 'unknown'
      };
    }
    
    // Calculate confidence for target
    const targetConfidence = calculateATRConfidence(atr, targetPoints, currentPrice);
    
    // Get dynamic levels
    const dynamicLevels = getDynamicLevels(atr, 1.5);
    
    // Analyze volatility state
    const volatilityAnalysis = analyzeVolatilityState(atr, candles);
    
    // Determine overall recommendation
    let recommendation = 'PROCEED';
    let reasoning = `ATR: ${atr.toFixed(2)} pts, Target confidence: ${targetConfidence}%`;
    
    if (targetConfidence < 40) {
      recommendation = 'REJECT';
      reasoning = `Target (${targetPoints}pts) is too ambitious for current ATR (${atr.toFixed(2)}pts). Confidence: ${targetConfidence}%`;
    } else if (targetConfidence < 60) {
      recommendation = 'PROCEED_CAUTIOUS';
      reasoning = `Target achievable but challenging. ATR: ${atr.toFixed(2)}pts, Confidence: ${targetConfidence}%`;
    } else if (volatilityAnalysis.state === 'extreme') {
      recommendation = 'REDUCE_SIZE';
      reasoning = `${volatilityAnalysis.reasoning}. ATR: ${atr.toFixed(2)}pts`;
    } else if (volatilityAnalysis.state === 'quiet') {
      recommendation = 'REDUCE_SIZE';
      reasoning = `${volatilityAnalysis.reasoning}. ATR: ${atr.toFixed(2)}pts`;
    }
    
    logger.info({
      atr: atr.toFixed(2),
      targetPoints,
      targetConfidence,
      volatilityState: volatilityAnalysis.state,
      recommendation
    }, '[atrAnalysis] ATR analysis completed');
    
    return {
      atrAvailable: true,
      atr: parseFloat(atr.toFixed(2)),
      targetConfidence,
      slConfidence: calculateATRConfidence(atr, slPoints, currentPrice),
      recommendation,
      reasoning,
      volatilityState: volatilityAnalysis.state,
      volatilityAnalysis,
      dynamicLevels,
      targetAsATRMultiple: parseFloat((targetPoints / atr).toFixed(2)),
      candleCount: candles.length
    };
    
  } catch (error) {
    logger.error({ error: error.message }, '[atrAnalysis] ATR analysis failed');
    return {
      atrAvailable: false,
      confidence: 50,
      recommendation: 'PROCEED_CAUTIOUS',
      reasoning: `ATR analysis error: ${error.message}`,
      volatilityState: 'unknown'
    };
  }
}

module.exports = {
  analyzeATR,
  calculateATR,
  calculateATRConfidence,
  getDynamicLevels,
  analyzeVolatilityState
};
