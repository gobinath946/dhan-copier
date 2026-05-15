/**
 * Behavioral Analysis
 * Used by: Contrarian traders, Market psychology experts, Sentiment analysts
 * 
 * Analyzes retail panic, FOMO, short squeeze, trap moves, overreaction,
 * and mean reversion after emotional candles
 * 
 * CRITICAL FOR CONTRARIAN OPPORTUNITIES AND AVOIDING TRAPS
 */
const logger = require('../../utils/logger');

/**
 * Analyze behavioral patterns
 * @param {Array} candles - Recent candles (last 30-60 minutes)
 * @param {Object} optionChain - Option chain data
 * @param {number} spotPrice - Current spot price
 * @param {Object} volumeData - Volume data
 * @param {Object} previousBehavior - Previous cycle data
 */
function analyzeBehavioralPatterns(candles, optionChain, spotPrice, volumeData, previousBehavior = null) {
  try {
    if (!candles || candles.length < 10) {
      return null;
    }
    
    // 1. Detect Retail Panic
    const retailPanic = detectRetailPanic(candles, volumeData);
    
    // 2. Detect FOMO (Fear of Missing Out)
    const fomo = detectFOMO(candles, volumeData);
    
    // 3. Detect Short Squeeze
    const shortSqueeze = detectShortSqueeze(candles, optionChain, volumeData);
    
    // 4. Detect Trap Moves
    const trapMoves = detectTrapMoves(candles, spotPrice);
    
    // 5. Detect Overreaction
    const overreaction = detectOverreaction(candles, previousBehavior);
    
    // 6. Detect Mean Reversion Opportunity
    const meanReversion = detectMeanReversion(candles, overreaction);
    
    // 7. Detect Emotional Candles
    const emotionalCandles = detectEmotionalCandles(candles);
    
    // 8. Calculate Behavioral Score
    const behavioralScore = calculateBehavioralScore(
      retailPanic,
      fomo,
      shortSqueeze,
      trapMoves,
      overreaction,
      meanReversion
    );
    
    return {
      retail_panic: retailPanic,
      fomo: fomo,
      short_squeeze: shortSqueeze,
      trap_moves: trapMoves,
      overreaction: overreaction,
      mean_reversion: meanReversion,
      emotional_candles: emotionalCandles,
      behavioral_score: behavioralScore,
      behavioral_bias: determineBehavioralBias(retailPanic, fomo, shortSqueeze, meanReversion),
      trading_implication: getTradingImplication(retailPanic, fomo, shortSqueeze, trapMoves, meanReversion)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[behavioralAnalysis] Analysis failed');
    return null;
  }
}

/**
 * 1. Detect Retail Panic
 * Large volume + sharp drop + quick reversal = Retail panic selling
 */
function detectRetailPanic(candles, volumeData) {
  const recentCandles = candles.slice(-10);
  
  let panicDetected = false;
  let panicCandle = null;
  let panicSeverity = 'none';
  
  for (let i = 1; i < recentCandles.length; i++) {
    const current = recentCandles[i];
    const prev = recentCandles[i - 1];
    
    // Sharp drop (>0.5% in 1 minute)
    const dropPct = ((current.close - prev.close) / prev.close) * 100;
    const isSharpDrop = dropPct < -0.5;
    
    // High volume (>2x average)
    const avgVolume = recentCandles.slice(0, i).reduce((sum, c) => sum + (c.volume || 0), 0) / i;
    const isHighVolume = (current.volume || 0) > avgVolume * 2;
    
    // Long lower wick (buyers stepping in)
    const wickSize = current.low < current.close ? current.close - current.low : 0;
    const bodySize = Math.abs(current.close - current.open);
    const hasLongWick = wickSize > bodySize * 1.5;
    
    if (isSharpDrop && isHighVolume && hasLongWick) {
      panicDetected = true;
      panicCandle = current;
      panicSeverity = Math.abs(dropPct) > 1 ? 'high' : 'moderate';
      break;
    }
  }
  
  // Check for reversal after panic
  let reversalConfirmed = false;
  if (panicDetected && panicCandle) {
    const afterPanic = recentCandles.slice(recentCandles.indexOf(panicCandle) + 1);
    if (afterPanic.length > 0) {
      const recoveryPct = ((afterPanic[afterPanic.length - 1].close - panicCandle.low) / panicCandle.low) * 100;
      reversalConfirmed = recoveryPct > 0.3;
    }
  }
  
  return {
    detected: panicDetected,
    severity: panicSeverity,
    panic_candle: panicCandle ? {
      timestamp: panicCandle.timestamp,
      low: panicCandle.low,
      close: panicCandle.close,
      volume: panicCandle.volume
    } : null,
    reversal_confirmed: reversalConfirmed,
    opportunity: panicDetected && reversalConfirmed ? 'buy_the_dip' : 'none'
  };
}

/**
 * 2. Detect FOMO (Fear of Missing Out)
 * Rapid rise + increasing volume + small pullbacks = FOMO buying
 */
function detectFOMO(candles, volumeData) {
  const recentCandles = candles.slice(-10);
  
  // Count consecutive green candles
  let consecutiveGreen = 0;
  let volumeIncreasing = true;
  
  for (let i = recentCandles.length - 1; i >= 1; i--) {
    const current = recentCandles[i];
    const prev = recentCandles[i - 1];
    
    if (current.close > current.open) {
      consecutiveGreen++;
      
      // Check if volume is increasing
      if ((current.volume || 0) < (prev.volume || 0)) {
        volumeIncreasing = false;
      }
    } else {
      break;
    }
  }
  
  // FOMO = 4+ consecutive green candles with increasing volume
  const fomoDetected = consecutiveGreen >= 4 && volumeIncreasing;
  
  // Calculate rally strength
  const rallyStart = recentCandles[recentCandles.length - consecutiveGreen - 1];
  const rallyEnd = recentCandles[recentCandles.length - 1];
  const rallyPct = rallyStart ? ((rallyEnd.close - rallyStart.close) / rallyStart.close) * 100 : 0;
  
  let fomoSeverity = 'none';
  if (fomoDetected) {
    if (rallyPct > 1.5) fomoSeverity = 'extreme';
    else if (rallyPct > 1) fomoSeverity = 'high';
    else fomoSeverity = 'moderate';
  }
  
  return {
    detected: fomoDetected,
    severity: fomoSeverity,
    consecutive_green: consecutiveGreen,
    rally_pct: Number(rallyPct.toFixed(2)),
    volume_increasing: volumeIncreasing,
    opportunity: fomoDetected && fomoSeverity === 'extreme' ? 'fade_the_rally' : 'none'
  };
}

/**
 * 3. Detect Short Squeeze
 * High put OI + sharp rise + volume spike = Short squeeze
 */
function detectShortSqueeze(candles, optionChain, volumeData) {
  if (!optionChain || !optionChain.strikes) {
    return {
      detected: false,
      severity: 'none',
      opportunity: 'none'
    };
  }
  
  const recentCandles = candles.slice(-5);
  
  // Check for sharp rise
  const firstCandle = recentCandles[0];
  const lastCandle = recentCandles[recentCandles.length - 1];
  const risePct = ((lastCandle.close - firstCandle.close) / firstCandle.close) * 100;
  const isSharpRise = risePct > 0.7;
  
  // Check for high put OI (shorts trapped)
  const atmStrike = Math.round(lastCandle.close / 50) * 50;
  const atmRow = optionChain.strikes.find(s => s.strike === atmStrike);
  
  let highPutOI = false;
  if (atmRow) {
    const putCallRatio = (atmRow.put.oi || 0) / (atmRow.call.oi || 1);
    highPutOI = putCallRatio > 1.5; // More puts than calls = shorts
  }
  
  // Check for volume spike
  const avgVolume = recentCandles.slice(0, -1).reduce((sum, c) => sum + (c.volume || 0), 0) / (recentCandles.length - 1);
  const lastVolume = lastCandle.volume || 0;
  const volumeSpike = lastVolume > avgVolume * 2;
  
  const squeezeDetected = isSharpRise && highPutOI && volumeSpike;
  
  let squeezeSeverity = 'none';
  if (squeezeDetected) {
    if (risePct > 1.5) squeezeSeverity = 'extreme';
    else if (risePct > 1) squeezeSeverity = 'high';
    else squeezeSeverity = 'moderate';
  }
  
  return {
    detected: squeezeDetected,
    severity: squeezeSeverity,
    rise_pct: Number(risePct.toFixed(2)),
    put_call_ratio: atmRow ? Number(((atmRow.put.oi || 0) / (atmRow.call.oi || 1)).toFixed(2)) : 0,
    volume_spike: volumeSpike,
    opportunity: squeezeDetected ? 'ride_the_squeeze' : 'none'
  };
}

/**
 * 4. Detect Trap Moves
 * False breakout followed by reversal = Trap
 */
function detectTrapMoves(candles, spotPrice) {
  const recentCandles = candles.slice(-20);
  
  // Find recent highs and lows
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(0, -5));
  const recentLow = Math.min(...lows.slice(0, -5));
  
  // Check for bull trap (breaks high then reverses)
  const lastCandles = recentCandles.slice(-5);
  const brokeHigh = lastCandles.some(c => c.high > recentHigh);
  const reversedDown = brokeHigh && lastCandles[lastCandles.length - 1].close < recentHigh;
  
  // Check for bear trap (breaks low then reverses)
  const brokeLow = lastCandles.some(c => c.low < recentLow);
  const reversedUp = brokeLow && lastCandles[lastCandles.length - 1].close > recentLow;
  
  let trapType = 'none';
  let trapSeverity = 'none';
  
  if (reversedDown) {
    trapType = 'bull_trap';
    trapSeverity = 'moderate';
  } else if (reversedUp) {
    trapType = 'bear_trap';
    trapSeverity = 'moderate';
  }
  
  return {
    detected: trapType !== 'none',
    trap_type: trapType,
    severity: trapSeverity,
    recent_high: recentHigh,
    recent_low: recentLow,
    opportunity: trapType === 'bull_trap' ? 'short' : trapType === 'bear_trap' ? 'long' : 'none'
  };
}

/**
 * 5. Detect Overreaction
 * Excessive move compared to normal volatility = Overreaction
 */
function detectOverreaction(candles, previousBehavior) {
  const recentCandles = candles.slice(-20);
  
  // Calculate average range
  const avgRange = recentCandles.slice(0, -1).reduce((sum, c) => sum + (c.high - c.low), 0) / (recentCandles.length - 1);
  
  // Check last candle
  const lastCandle = recentCandles[recentCandles.length - 1];
  const lastRange = lastCandle.high - lastCandle.low;
  
  // Overreaction = range > 2x average
  const isOverreaction = lastRange > avgRange * 2;
  
  let overreactionType = 'none';
  let overreactionSeverity = 'none';
  
  if (isOverreaction) {
    overreactionType = lastCandle.close > lastCandle.open ? 'bullish_overreaction' : 'bearish_overreaction';
    overreactionSeverity = lastRange > avgRange * 3 ? 'extreme' : 'moderate';
  }
  
  return {
    detected: isOverreaction,
    type: overreactionType,
    severity: overreactionSeverity,
    range_multiple: Number((lastRange / avgRange).toFixed(2)),
    avg_range: Number(avgRange.toFixed(2)),
    last_range: Number(lastRange.toFixed(2)),
    opportunity: isOverreaction ? 'mean_reversion' : 'none'
  };
}

/**
 * 6. Detect Mean Reversion Opportunity
 * After overreaction, expect reversion to mean
 */
function detectMeanReversion(candles, overreaction) {
  if (!overreaction.detected) {
    return {
      opportunity: false,
      direction: 'none',
      confidence: 0
    };
  }
  
  const recentCandles = candles.slice(-20);
  
  // Calculate VWAP (simple mean)
  const vwap = recentCandles.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3), 0) / recentCandles.length;
  
  const lastCandle = recentCandles[recentCandles.length - 1];
  const distanceFromVWAP = ((lastCandle.close - vwap) / vwap) * 100;
  
  // Mean reversion opportunity if >1% away from VWAP
  const opportunity = Math.abs(distanceFromVWAP) > 1;
  
  let direction = 'none';
  let confidence = 0;
  
  if (opportunity) {
    direction = distanceFromVWAP > 0 ? 'short' : 'long'; // Revert to mean
    confidence = Math.min(10, Math.abs(distanceFromVWAP) * 5); // Higher distance = higher confidence
  }
  
  return {
    opportunity,
    direction,
    confidence: Math.round(confidence),
    distance_from_vwap: Number(distanceFromVWAP.toFixed(2)),
    vwap: Number(vwap.toFixed(2)),
    expected_target: Number(vwap.toFixed(2))
  };
}

/**
 * 7. Detect Emotional Candles
 * Very large candles with long wicks = Emotional trading
 */
function detectEmotionalCandles(candles) {
  const recentCandles = candles.slice(-10);
  const emotionalCandles = [];
  
  recentCandles.forEach((candle, idx) => {
    const bodySize = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const totalRange = candle.high - candle.low;
    
    // Emotional candle = long wicks (>50% of range)
    const wickRatio = (upperWick + lowerWick) / totalRange;
    
    if (wickRatio > 0.5 && totalRange > 20) {
      emotionalCandles.push({
        timestamp: candle.timestamp,
        type: upperWick > lowerWick ? 'rejection_up' : 'rejection_down',
        wick_ratio: Number(wickRatio.toFixed(2)),
        range: Number(totalRange.toFixed(2))
      });
    }
  });
  
  return {
    detected: emotionalCandles.length > 0,
    count: emotionalCandles.length,
    candles: emotionalCandles.slice(0, 3), // Top 3
    implication: emotionalCandles.length > 2 ? 'high_volatility' : 'normal'
  };
}

/**
 * Calculate Behavioral Score (0-100)
 */
function calculateBehavioralScore(retailPanic, fomo, shortSqueeze, trapMoves, overreaction, meanReversion) {
  let score = 50; // Start neutral
  
  // 1. Retail Panic (contrarian opportunity) +30 points
  if (retailPanic.detected && retailPanic.reversal_confirmed) {
    score += 30; // Buy the panic
  }
  
  // 2. FOMO (fade opportunity) +20 points
  if (fomo.detected && fomo.severity === 'extreme') {
    score += 20; // Fade the FOMO
  }
  
  // 3. Short Squeeze (ride opportunity) +25 points
  if (shortSqueeze.detected) {
    score += 25; // Ride the squeeze
  }
  
  // 4. Trap Moves (reversal opportunity) +15 points
  if (trapMoves.detected) {
    score += 15; // Trade the trap reversal
  }
  
  // 5. Mean Reversion (reversion opportunity) +10 points
  if (meanReversion.opportunity) {
    score += 10; // Mean reversion trade
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine behavioral bias
 */
function determineBehavioralBias(retailPanic, fomo, shortSqueeze, meanReversion) {
  // Contrarian opportunities
  if (retailPanic.detected && retailPanic.reversal_confirmed) {
    return 'contrarian_bullish'; // Buy the panic
  }
  
  if (fomo.detected && fomo.severity === 'extreme') {
    return 'contrarian_bearish'; // Fade the FOMO
  }
  
  // Momentum opportunities
  if (shortSqueeze.detected) {
    return 'momentum_bullish'; // Ride the squeeze
  }
  
  // Mean reversion
  if (meanReversion.opportunity) {
    return meanReversion.direction === 'long' ? 'reversion_bullish' : 'reversion_bearish';
  }
  
  return 'neutral';
}

/**
 * Get trading implications
 */
function getTradingImplication(retailPanic, fomo, shortSqueeze, trapMoves, meanReversion) {
  if (retailPanic.detected && retailPanic.reversal_confirmed) {
    return 'Retail panic detected with reversal - contrarian buy opportunity';
  }
  
  if (fomo.detected && fomo.severity === 'extreme') {
    return 'Extreme FOMO detected - fade the rally, expect pullback';
  }
  
  if (shortSqueeze.detected) {
    return 'Short squeeze in progress - ride the momentum, tight stops';
  }
  
  if (trapMoves.detected && trapMoves.trap_type === 'bull_trap') {
    return 'Bull trap detected - false breakout, favor shorts';
  }
  
  if (trapMoves.detected && trapMoves.trap_type === 'bear_trap') {
    return 'Bear trap detected - false breakdown, favor longs';
  }
  
  if (meanReversion.opportunity) {
    return `Mean reversion opportunity - ${meanReversion.direction} toward VWAP ${meanReversion.vwap}`;
  }
  
  return 'No clear behavioral pattern - trade with normal strategy';
}

/**
 * Calculate behavioral score for master algorithm (0-100)
 */
function calculateBehavioralScoreForMaster(behavioralData, direction) {
  if (!behavioralData) return 50; // Neutral
  
  let score = behavioralData.behavioral_score; // Start with base score
  
  // 1. Behavioral bias alignment (30 points)
  if (direction === 'bullish') {
    if (behavioralData.behavioral_bias === 'contrarian_bullish' ||
        behavioralData.behavioral_bias === 'momentum_bullish' ||
        behavioralData.behavioral_bias === 'reversion_bullish') {
      score += 30;
    } else if (behavioralData.behavioral_bias === 'contrarian_bearish' ||
               behavioralData.behavioral_bias === 'reversion_bearish') {
      score -= 20;
    }
  } else if (direction === 'bearish') {
    if (behavioralData.behavioral_bias === 'contrarian_bearish' ||
        behavioralData.behavioral_bias === 'reversion_bearish') {
      score += 30;
    } else if (behavioralData.behavioral_bias === 'contrarian_bullish' ||
               behavioralData.behavioral_bias === 'momentum_bullish' ||
               behavioralData.behavioral_bias === 'reversion_bullish') {
      score -= 20;
    }
  }
  
  // 2. Specific pattern bonuses (20 points)
  if (behavioralData.retail_panic.detected && behavioralData.retail_panic.reversal_confirmed && direction === 'bullish') {
    score += 20; // Strong contrarian buy
  }
  
  if (behavioralData.short_squeeze.detected && direction === 'bullish') {
    score += 20; // Ride the squeeze
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeBehavioralPatterns,
  calculateBehavioralScoreForMaster
};
