/**
 * Master Algorithm Decision Engine
 * Combines all 18 world-class algorithms with weighted ensemble
 * 
 * Algorithms:
 * 1. Professional Scalping Indicators - 15% (HIGHEST - TREND CONFIRMATION)
 * 2. Multi-Timeframe Confluence (with UT Bot) - 12% (TREND DETECTION)
 * 3. Professional Trader Logic - 10%
 * 4. Liquidity Analysis - 10% (CRITICAL)
 * 5. Smart Money Concepts (SMC/ICT) - 10% (CRITICAL)
 * 6. Gamma Exposure (GEX) - 7%
 * 7. Order Flow Imbalance - 7%
 * 8. Market Internals - 7% (CRITICAL)
 * 9. Sector Rotation - 6% (CRITICAL)
 * 10. DEMA Indicator - 5% (MOMENTUM)
 * 11. Global Markets - 4% (CRITICAL)
 * 12. Behavioral Analysis - 3% (CRITICAL)
 * 13. VWAP Analysis - 2%
 * 14. Volume & OI Analysis - 1.5%
 * 15. Market Regime - 0.3%
 * 16. Build-up Type - 0.1%
 * 17. PCR Analysis - 0.05%
 * 18. Max Pain - 0.05%
 */
const logger = require('../utils/logger');
const gammaExposure = require('./algorithms/gammaExposure.service');
const orderFlow = require('./algorithms/orderFlow.service');
const multiTimeframe = require('./algorithms/multiTimeframe.service');
const professionalScalping = require('./algorithms/professionalScalping.service'); // NEW - HIGHEST PRIORITY
const liquidityAnalysis = require('./algorithms/liquidityAnalysis.service');
const smartMoneyConcepts = require('./algorithms/smartMoneyConcepts.service');
const marketInternals = require('./algorithms/marketInternals.service');
const sectorRotation = require('./algorithms/sectorRotation.service');
const globalMarkets = require('./algorithms/globalMarkets.service');
const behavioralAnalysis = require('./algorithms/behavioralAnalysis.service');
const demaIndicator = require('./algorithms/demaIndicator.service');

/**
 * Master decision engine - combines all algorithms
 * @param {Object} marketData - Complete market data payload
 * @param {Object} algorithmOutputs - Outputs from all algorithms
 * @param {string} direction - 'bullish' or 'bearish'
 * @param {Object} thresholds - Optional override: { minMasterScore, minConfidence, minAgreement }
 */
function calculateMasterScore(marketData, algorithmOutputs, direction, thresholds = null) {
  try {
    const scores = {};
    const weights = {
      professionalScalping: 0.15,  // HIGHEST - Professional indicators (9 EMA, 20 EMA, VWAP, Supertrend, ATR, RSI, ADX)
      multiTimeframe: 0.12,        // SECOND - Multi-timeframe with UT Bot
      professional: 0.10,          // Professional trader logic
      liquidity: 0.10,             // CRITICAL FOR SCALPING
      smc: 0.10,                   // SMART MONEY CONCEPTS (CRITICAL)
      gamma: 0.07,                 // Gamma exposure
      orderFlow: 0.07,             // Order flow
      marketInternals: 0.07,       // MARKET BREADTH (CRITICAL)
      sectorRotation: 0.06,        // SECTOR ANALYSIS (CRITICAL)
      dema: 0.05,                  // DEMA MOMENTUM INDICATOR
      globalMarkets: 0.04,         // GLOBAL MARKETS (CRITICAL)
      behavioral: 0.03,            // BEHAVIORAL ANALYSIS (CRITICAL)
      vwap: 0.02,                  // VWAP (already in professionalScalping)
      volumeOI: 0.015,             // Volume/OI
      regime: 0.003,               // Market regime
      buildUp: 0.001,              // Build-up type
      pcr: 0.0005,                 // PCR
      maxPain: 0.0005              // Max pain
    };
    
    // 1. Professional Scalping Score (0-100) - HIGHEST PRIORITY
    scores.professionalScalping = algorithmOutputs.professionalScalping
      ? professionalScalping.calculateProfessionalScalpingScore(algorithmOutputs.professionalScalping, direction)
      : 50;
    
    // 2. Multi-Timeframe Score (0-100) - SECOND PRIORITY (includes UT Bot)
    scores.multiTimeframe = algorithmOutputs.multiTimeframe
      ? multiTimeframe.calculateMultiTimeframeScore(algorithmOutputs.multiTimeframe, direction)
      : 50;
    
    // 3. Professional Trader Score (0-100)
    scores.professional = calculateProfessionalScore(marketData, direction);
    
    // 4. Liquidity Analysis Score (0-100)
    scores.liquidity = algorithmOutputs.liquidityAnalysis
      ? liquidityAnalysis.calculateLiquidityScoreForMaster(algorithmOutputs.liquidityAnalysis, direction)
      : 50;
    
    // 5. Smart Money Concepts Score (0-100)
    scores.smc = algorithmOutputs.smartMoneyConcepts
      ? smartMoneyConcepts.calculateSMCScoreForMaster(algorithmOutputs.smartMoneyConcepts, direction)
      : 50;
    
    // 6. Gamma Exposure Score (0-100)
    scores.gamma = algorithmOutputs.gammaExposure 
      ? gammaExposure.calculateGammaScore(algorithmOutputs.gammaExposure, direction, marketData.spot_data?.ltp)
      : 50;
    
    // 7. Order Flow Score (0-100)
    scores.orderFlow = algorithmOutputs.orderFlow
      ? orderFlow.calculateOrderFlowScore(algorithmOutputs.orderFlow, direction)
      : 50;
    
    // 8. Market Internals Score (0-100)
    scores.marketInternals = algorithmOutputs.marketInternals
      ? marketInternals.calculateMarketInternalsScoreForMaster(algorithmOutputs.marketInternals, direction)
      : 50;
    
    // 9. Sector Rotation Score (0-100)
    scores.sectorRotation = algorithmOutputs.sectorRotation
      ? sectorRotation.calculateSectorRotationScoreForMaster(algorithmOutputs.sectorRotation, direction)
      : 50;
    
    // 9. Global Markets Score (0-100) - NEW
    scores.globalMarkets = algorithmOutputs.globalMarkets
      ? globalMarkets.calculateGlobalMarketsScoreForMaster(algorithmOutputs.globalMarkets, direction)
      : 50;
    
    // 10. Behavioral Analysis Score (0-100) - NEW
    scores.behavioral = algorithmOutputs.behavioral
      ? behavioralAnalysis.calculateBehavioralScoreForMaster(algorithmOutputs.behavioral, direction)
      : 50;
    
    // 11. DEMA Indicator Score (0-100) - NEW
    scores.dema = algorithmOutputs.dema
      ? demaIndicator.calculateDEMAScoreForMaster(algorithmOutputs.dema, direction)
      : 50;
    
    // 12. VWAP Score (0-100)
    scores.vwap = calculateVWAPScore(marketData.vwap_analysis, direction);
    
    // 12. Volume & OI Score (0-100)
    scores.volumeOI = calculateVolumeOIScore(marketData.volume_orderflow, direction);
    
    // 12. Volume & OI Score (0-100)
    scores.volumeOI = calculateVolumeOIScore(marketData.volume_orderflow, direction);
    
    // 13. Market Regime Score (0-100)
    scores.regime = calculateRegimeScore(marketData.market_regime, direction);
    
    // 14. Build-up Type Score (0-100)
    scores.buildUp = calculateBuildUpScore(marketData.futures_data?.build_up_type, direction);
    
    // 15. PCR Score (0-100)
    scores.pcr = calculatePCRScore(marketData.options_chain?.pcr_total, direction);
    
    // 16. Max Pain Score (0-100)
    scores.maxPain = calculateMaxPainScore(
      marketData.options_chain?.max_pain_strike,
      marketData.spot_data?.ltp,
      direction
    );
    
    // Calculate weighted master score
    let masterScore = 0;
    Object.keys(weights).forEach(key => {
      masterScore += scores[key] * weights[key];
    });
    
    // Calculate confidence (0-10) based on agreement
    const confidence = calculateConfidence(scores, direction);
    
    // Count algorithms agreeing on direction
    const agreementCount = countAgreement(scores, direction);
    
    // Determine master signal
    const masterSignal = determineMasterSignal(masterScore, confidence, agreementCount);
    
    // Calculate expected move
    const expectedMove = calculateExpectedMove(marketData, algorithmOutputs);
    
    // Calculate optimal strike
    const optimalStrike = calculateOptimalStrike(marketData, direction, algorithmOutputs);
    
    // Calculate risk-reward ratio
    const riskReward = calculateRiskReward(marketData, direction);
    
    // Estimate hold duration
    const holdDuration = estimateHoldDuration(marketData, algorithmOutputs);
    
    // Resolve thresholds (callers can override for scalping/paper/aggressive profiles)
    const minMasterScore = thresholds?.minMasterScore ?? 60;   // was hardcoded 75
    const minConfidence = thresholds?.minConfidence ?? 6;      // was hardcoded 8
    const minAgreement = thresholds?.minAgreement ?? 9;        // was hardcoded 12

    return {
      master_score: Math.round(masterScore * 10) / 10,
      master_signal: masterSignal,
      confidence: Math.round(confidence * 10) / 10,
      agreement_count: agreementCount,
      agreement_percentage: Math.round((agreementCount / 10) * 100),
      individual_scores: scores,
      weights,
      expected_move: expectedMove,
      optimal_strike: optimalStrike,
      risk_reward: riskReward,
      hold_duration: holdDuration,
      entry_recommended: shouldEnter(masterScore, confidence, agreementCount, {
        minMasterScore, minConfidence, minAgreement
      }),
      exit_recommended: shouldExit(masterScore, confidence),
      reasoning: generateReasoning(scores, masterScore, confidence, agreementCount),
      thresholds_used: { minMasterScore, minConfidence, minAgreement }
    };
  } catch (error) {
    logger.error({ error: error.message }, '[masterAlgorithm] Calculation failed');
    return null;
  }
}

/**
 * Calculate professional trader score
 */
function calculateProfessionalScore(marketData, direction) {
  let score = 50;
  
  // Market character
  const character = marketData.market_character;
  if (character === 'trending' && direction === marketData.dominant_direction) {
    score += 30;
  } else if (character === 'ranging') {
    score += 10; // Ranging is okay for scalping
  } else if (character === 'volatile') {
    score -= 10; // Volatile is risky
  }
  
  // Key levels
  const spotPrice = marketData.spot_data?.ltp;
  if (marketData.key_levels) {
    const nearSupport = marketData.key_levels.support?.some(s => Math.abs(s - spotPrice) < 20);
    const nearResistance = marketData.key_levels.resistance?.some(r => Math.abs(r - spotPrice) < 20);
    
    if (direction === 'bullish' && nearSupport) score += 20;
    if (direction === 'bearish' && nearResistance) score += 20;
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate VWAP score
 */
function calculateVWAPScore(vwapData, direction) {
  if (!vwapData) return 50;
  
  let score = 50;
  
  const position = vwapData.price_vs_vwap;
  const distance = Math.abs(vwapData.distance_from_vwap_pct || 0);
  
  if (direction === 'bullish') {
    if (position === 'above' && distance < 0.3) score += 30; // Just above VWAP
    else if (position === 'below' && distance < 0.2) score += 40; // Bounce from VWAP
    else if (position === 'above' && distance > 0.5) score -= 20; // Too far above
  } else if (direction === 'bearish') {
    if (position === 'below' && distance < 0.3) score += 30; // Just below VWAP
    else if (position === 'above' && distance < 0.2) score += 40; // Rejection from VWAP
    else if (position === 'below' && distance > 0.5) score -= 20; // Too far below
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate Volume & OI score
 */
function calculateVolumeOIScore(volumeData, direction) {
  if (!volumeData) return 50;
  
  let score = 50;
  
  // Volume spike
  if (volumeData.volume_spike) score += 20;
  
  // OI direction
  const oiDirection = volumeData.oi_direction;
  if (direction === 'bullish' && oiDirection === 'bullish') score += 30;
  else if (direction === 'bearish' && oiDirection === 'bearish') score += 30;
  else if (direction === 'bullish' && oiDirection === 'bearish') score -= 20;
  else if (direction === 'bearish' && oiDirection === 'bullish') score -= 20;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate market regime score
 */
function calculateRegimeScore(regimeData, direction) {
  if (!regimeData) return 50;
  
  let score = 50;
  
  const regime = regimeData.current_regime;
  
  if (regime === 'trending_bullish' && direction === 'bullish') score += 40;
  else if (regime === 'trending_bearish' && direction === 'bearish') score += 40;
  else if (regime === 'ranging') score += 10; // Neutral for scalping
  else if (regime === 'volatile') score -= 20; // Risky
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate build-up type score
 */
function calculateBuildUpScore(buildUpType, direction) {
  if (!buildUpType) return 50;
  
  let score = 50;
  
  if (direction === 'bullish') {
    if (buildUpType === 'long_buildup') score += 40;
    else if (buildUpType === 'short_covering') score += 30;
    else if (buildUpType === 'short_buildup') score -= 30;
  } else if (direction === 'bearish') {
    if (buildUpType === 'short_buildup') score += 40;
    else if (buildUpType === 'long_unwinding') score += 30;
    else if (buildUpType === 'long_buildup') score -= 30;
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate PCR score
 */
function calculatePCRScore(pcr, direction) {
  if (!pcr) return 50;
  
  let score = 50;
  
  // PCR > 1 = more puts = bullish
  // PCR < 1 = more calls = bearish
  
  if (direction === 'bullish') {
    if (pcr > 1.2) score += 30; // Strong put writing
    else if (pcr > 1.0) score += 15;
    else if (pcr < 0.8) score -= 20; // Too many calls
  } else if (direction === 'bearish') {
    if (pcr < 0.8) score += 30; // Strong call writing
    else if (pcr < 1.0) score += 15;
    else if (pcr > 1.2) score -= 20; // Too many puts
  }
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate max pain score
 */
function calculateMaxPainScore(maxPainStrike, spotPrice, direction) {
  if (!maxPainStrike || !spotPrice) return 50;
  
  let score = 50;
  
  const distance = spotPrice - maxPainStrike;
  const distancePct = (distance / spotPrice) * 100;
  
  // Market tends to gravitate toward max pain
  if (direction === 'bullish' && distance < 0) {
    score += 20; // Below max pain, likely to move up
  } else if (direction === 'bearish' && distance > 0) {
    score += 20; // Above max pain, likely to move down
  }
  
  // Too far from max pain = less influence
  if (Math.abs(distancePct) > 1) score -= 10;
  
  return Math.max(0, Math.min(100, score));
}

/**
 * Calculate confidence (0-10) based on agreement
 */
function calculateConfidence(scores, direction) {
  const values = Object.values(scores);
  
  // Calculate standard deviation (lower = more agreement)
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  // Lower std dev = higher confidence
  // Std dev of 0 = confidence 10, std dev of 30+ = confidence 0
  const confidence = Math.max(0, 10 - (stdDev / 3));
  
  return confidence;
}

/**
 * Count how many algorithms agree on direction
 */
function countAgreement(scores, direction) {
  let count = 0;
  
  Object.values(scores).forEach(score => {
    if (score >= 60) count++; // Score >= 60 = agrees with direction
  });
  
  return count;
}

/**
 * Should enter trade?
 * Thresholds are configurable so the engine can run in scalping-friendly
 * mode without lowering safety in conservative mode.
 */
function shouldEnter(masterScore, confidence, agreementCount, thresholds = null) {
  const minMasterScore = thresholds?.minMasterScore ?? 50;  // lowered from 60
  const minConfidence  = thresholds?.minConfidence  ?? 2;   // lowered from 6
  const minAgreement   = thresholds?.minAgreement   ?? 4;   // lowered from 9
  return masterScore >= minMasterScore && confidence >= minConfidence && agreementCount >= minAgreement;
}

/**
 * Determine master signal (17 algorithms, scalping-tuned thresholds)
 * Lowered thresholds to match real market conditions where confidence
 * is typically 1-5 and agreement is 3-10 due to ranging markets.
 */
function determineMasterSignal(masterScore, confidence, agreementCount) {
  if (masterScore >= 75 && confidence >= 5 && agreementCount >= 10) {
    return 'STRONG_BUY';
  }
  if (masterScore >= 60 && confidence >= 2 && agreementCount >= 5) {
    return 'BUY';
  }
  if (masterScore <= 25 && confidence >= 5 && agreementCount >= 10) {
    return 'STRONG_SELL';
  }
  if (masterScore <= 40 && confidence >= 2 && agreementCount >= 5) {
    return 'SELL';
  }
  return 'NEUTRAL';
}

/**
 * Calculate expected move
 */
function calculateExpectedMove(marketData, algorithmOutputs) {
  // Use gamma exposure expected move if available
  if (algorithmOutputs.gammaExposure?.expected_move) {
    return algorithmOutputs.gammaExposure.expected_move;
  }
  
  // Fallback: estimate from volatility
  const iv = marketData.options_chain?.atm_iv || 18;
  const spotPrice = marketData.spot_data?.ltp || 23800;
  
  // Expected move for 15-20 seconds (very short-term)
  const dailyMove = spotPrice * (iv / 100) / Math.sqrt(365);
  const secondsInDay = 6.5 * 3600; // 6.5 hour trading day
  const moveFor20Sec = dailyMove * Math.sqrt(20 / secondsInDay);
  
  return Math.round(moveFor20Sec);
}

/**
 * Calculate optimal strike
 */
function calculateOptimalStrike(marketData, direction, algorithmOutputs) {
  const spotPrice = marketData.spot_data?.ltp || 23800;
  const atmStrike = Math.round(spotPrice / 50) * 50;
  
  // Professional trader: use opening strike ±2
  const openingStrike = marketData.opening_strike || atmStrike;
  
  // For scalping, prefer ATM or slightly OTM
  if (direction === 'bullish') {
    return Math.min(openingStrike + 50, atmStrike); // Max +1 strike from opening
  } else {
    return Math.max(openingStrike - 50, atmStrike); // Max -1 strike from opening
  }
}

/**
 * Calculate risk-reward ratio
 */
function calculateRiskReward(marketData, direction) {
  // For scalping: typically 1:1.5 to 1:2
  const volatility = marketData.options_chain?.atm_iv || 18;
  
  if (volatility > 20) return 1.5; // High vol = lower R:R
  if (volatility > 15) return 2.0; // Normal vol
  return 2.5; // Low vol = higher R:R
}

/**
 * Estimate hold duration (seconds)
 */
function estimateHoldDuration(marketData, algorithmOutputs) {
  // Professional scalping: 15-20 seconds max
  const baseHold = 15;
  
  // Adjust based on volatility
  const iv = marketData.options_chain?.atm_iv || 18;
  if (iv > 20) return 20; // High vol = hold longer
  if (iv < 15) return 15; // Low vol = exit faster
  
  return baseHold;
}

/**
 * Should exit trade?
 */
function shouldExit(masterScore, confidence) {
  return masterScore < 40 || confidence < 5;
}

/**
 * Generate reasoning text
 */
function generateReasoning(scores, masterScore, confidence, agreementCount) {
  const topScores = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, score]) => `${name}: ${Math.round(score)}`)
    .join(', ');
  
  const bottomScores = Object.entries(scores)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2)
    .map(([name, score]) => `${name}: ${Math.round(score)}`)
    .join(', ');
  
  return `Master Score: ${Math.round(masterScore)}/100 | Confidence: ${Math.round(confidence)}/10 | Agreement: ${agreementCount}/16 algorithms | Top: ${topScores} | Weak: ${bottomScores}`;
}

module.exports = {
  calculateMasterScore
};
