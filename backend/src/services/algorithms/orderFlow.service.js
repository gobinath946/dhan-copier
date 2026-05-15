/**
 * Order Flow Imbalance Algorithm
 * Used by: Institutional traders, Prop trading firms, Hedge funds
 * 
 * Analyzes delta-weighted OI changes, aggressive vs passive flow,
 * smart money index, institutional block detection, and sweep detection
 */
const logger = require('../../utils/logger');

/**
 * Analyze order flow imbalance from option chain data
 * @param {Object} optionChain - Option chain data with strikes
 * @param {Object} spotData - Current spot price data
 * @param {Object} previousData - Previous cycle data for comparison
 */
function analyzeOrderFlow(optionChain, spotData, previousData = null) {
  try {
    const spotPrice = spotData?.ltp || 0;
    if (!spotPrice || !optionChain.strikes) {
      return null;
    }
    
    // 1. Calculate Delta-Weighted OI Change
    const deltaWeightedOI = calculateDeltaWeightedOI(optionChain.strikes, spotPrice);
    
    // 2. Detect Aggressive vs Passive Flow
    const flowType = detectFlowType(optionChain.strikes, previousData);
    
    // 3. Calculate Smart Money Index
    const smartMoneyIndex = calculateSmartMoneyIndex(optionChain.strikes, spotPrice);
    
    // 4. Detect Block Trades (large OI changes)
    const blockTrades = detectBlockTrades(optionChain.strikes, previousData);
    
    // 5. Detect Liquidity Sweeps
    const sweepDetection = detectLiquiditySweeps(optionChain.strikes, spotPrice);
    
    // 6. Determine Institutional Sentiment
    const institutionalSentiment = determineInstitutionalSentiment(
      deltaWeightedOI,
      flowType,
      smartMoneyIndex,
      blockTrades
    );
    
    return {
      delta_weighted_oi: Math.round(deltaWeightedOI),
      aggressive_flow: flowType.aggressive,
      passive_flow: flowType.passive,
      net_flow: flowType.net,
      smart_money_index: Math.round(smartMoneyIndex),
      block_trades_detected: blockTrades.detected,
      block_trade_count: blockTrades.count,
      block_trade_strikes: blockTrades.strikes,
      sweep_direction: sweepDetection.direction,
      sweep_strikes: sweepDetection.strikes,
      institutional_sentiment: institutionalSentiment,
      flow_strength: calculateFlowStrength(deltaWeightedOI, smartMoneyIndex),
      trading_implication: getTradingImplication(institutionalSentiment, flowType.net)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[orderFlow] Analysis failed');
    return null;
  }
}

/**
 * Calculate delta-weighted OI change
 * Delta represents how much option price moves with underlying
 */
function calculateDeltaWeightedOI(strikes, spotPrice) {
  let totalDeltaWeightedOI = 0;
  
  strikes.forEach(strike => {
    const strikePrice = strike.strike;
    
    // Estimate delta (simplified Black-Scholes approximation)
    const callDelta = estimateDelta(spotPrice, strikePrice, 'CE');
    const putDelta = estimateDelta(spotPrice, strikePrice, 'PE');
    
    // OI changes (if available, otherwise use current OI)
    const callOIChange = strike.call.oi_change || strike.call.oi || 0;
    const putOIChange = strike.put.oi_change || strike.put.oi || 0;
    
    // Delta-weighted: positive for calls, negative for puts
    const callContribution = callOIChange * callDelta;
    const putContribution = putOIChange * putDelta; // putDelta is negative
    
    totalDeltaWeightedOI += (callContribution + putContribution);
  });
  
  return totalDeltaWeightedOI;
}

/**
 * Estimate option delta (simplified)
 */
function estimateDelta(spotPrice, strikePrice, optionType) {
  const moneyness = spotPrice / strikePrice;
  
  if (optionType === 'CE') {
    // Call delta: 0 to 1
    if (moneyness > 1.02) return 0.8; // Deep ITM
    if (moneyness > 1.01) return 0.7;
    if (moneyness > 0.99) return 0.5; // ATM
    if (moneyness > 0.98) return 0.3;
    return 0.2; // OTM
  } else {
    // Put delta: -1 to 0
    if (moneyness < 0.98) return -0.8; // Deep ITM
    if (moneyness < 0.99) return -0.7;
    if (moneyness < 1.01) return -0.5; // ATM
    if (moneyness < 1.02) return -0.3;
    return -0.2; // OTM
  }
}

/**
 * Detect aggressive vs passive flow
 * Aggressive: buying at ask, selling at bid (market orders)
 * Passive: limit orders at bid/ask
 */
function detectFlowType(strikes, previousData) {
  let aggressiveBuy = 0;
  let aggressiveSell = 0;
  let passiveBuy = 0;
  let passiveSell = 0;
  
  strikes.forEach(strike => {
    const strikePrice = strike.strike;
    
    // Volume indicates activity
    const callVolume = strike.call.volume || 0;
    const putVolume = strike.put.volume || 0;
    
    // OI increase with volume = new positions (aggressive)
    const callOIChange = strike.call.oi_change || 0;
    const putOIChange = strike.put.oi_change || 0;
    
    // Aggressive buying: high volume + OI increase
    if (callVolume > 0 && callOIChange > 0) {
      aggressiveBuy += callVolume;
    }
    
    // Aggressive selling: high volume + OI decrease
    if (callVolume > 0 && callOIChange < 0) {
      aggressiveSell += callVolume;
    }
    
    // Put buying = bearish
    if (putVolume > 0 && putOIChange > 0) {
      aggressiveSell += putVolume; // Put buying = bearish
    }
    
    // Put selling = bullish
    if (putVolume > 0 && putOIChange < 0) {
      aggressiveBuy += putVolume;
    }
    
    // Passive flow: OI change without proportional volume
    if (Math.abs(callOIChange) > callVolume * 2) {
      passiveBuy += Math.abs(callOIChange);
    }
    
    if (Math.abs(putOIChange) > putVolume * 2) {
      passiveSell += Math.abs(putOIChange);
    }
  });
  
  const netAggressive = aggressiveBuy - aggressiveSell;
  const netPassive = passiveBuy - passiveSell;
  
  let flowDirection = 'neutral';
  if (netAggressive > 0) flowDirection = 'buy';
  else if (netAggressive < 0) flowDirection = 'sell';
  
  return {
    aggressive: flowDirection,
    passive: netPassive > 0 ? 'buy' : netPassive < 0 ? 'sell' : 'neutral',
    net: netAggressive > 0 ? 'bullish' : netAggressive < 0 ? 'bearish' : 'neutral',
    aggressive_buy: aggressiveBuy,
    aggressive_sell: aggressiveSell,
    net_aggressive: netAggressive
  };
}

/**
 * Calculate Smart Money Index
 * Tracks institutional activity vs retail
 * Range: -100 (max bearish) to +100 (max bullish)
 */
function calculateSmartMoneyIndex(strikes, spotPrice) {
  let smartMoneyScore = 0;
  
  strikes.forEach(strike => {
    const strikePrice = strike.strike;
    const distanceFromSpot = Math.abs(strikePrice - spotPrice);
    
    // Smart money focuses on ATM and near-ATM strikes
    const isSmartMoneyStrike = distanceFromSpot <= 100;
    
    if (isSmartMoneyStrike) {
      const callOI = strike.call.oi || 0;
      const putOI = strike.put.oi || 0;
      const callVolume = strike.call.volume || 0;
      const putVolume = strike.put.volume || 0;
      
      // High OI + High Volume = Smart Money
      const callActivity = (callOI / 1000) * (callVolume / 100);
      const putActivity = (putOI / 1000) * (putVolume / 100);
      
      // Calls = bullish, Puts = bearish
      smartMoneyScore += (callActivity - putActivity);
    }
  });
  
  // Normalize to -100 to +100
  return Math.max(-100, Math.min(100, smartMoneyScore / 10));
}

/**
 * Detect block trades (institutional-sized orders)
 * Block trade = unusually large OI change at a single strike
 */
function detectBlockTrades(strikes, previousData) {
  const blockThreshold = 5000; // 5000 contracts = significant
  const detectedBlocks = [];
  
  strikes.forEach(strike => {
    const strikePrice = strike.strike;
    
    const callOIChange = Math.abs(strike.call.oi_change || 0);
    const putOIChange = Math.abs(strike.put.oi_change || 0);
    
    if (callOIChange > blockThreshold) {
      detectedBlocks.push({
        strike: strikePrice,
        type: 'CE',
        size: callOIChange,
        direction: strike.call.oi_change > 0 ? 'buy' : 'sell'
      });
    }
    
    if (putOIChange > blockThreshold) {
      detectedBlocks.push({
        strike: strikePrice,
        type: 'PE',
        size: putOIChange,
        direction: strike.put.oi_change > 0 ? 'buy' : 'sell'
      });
    }
  });
  
  return {
    detected: detectedBlocks.length > 0,
    count: detectedBlocks.length,
    strikes: detectedBlocks.map(b => `${b.strike} ${b.type} ${b.direction}`)
  };
}

/**
 * Detect liquidity sweeps
 * Sweep = rapid price movement through multiple strikes
 */
function detectLiquiditySweeps(strikes, spotPrice) {
  // Look for strikes with very low OI (liquidity gaps)
  const lowOIStrikes = strikes.filter(s => {
    const totalOI = (s.call.oi || 0) + (s.put.oi || 0);
    return totalOI < 1000; // Low liquidity
  });
  
  // Check if spot is near low OI strikes
  const nearLowOI = lowOIStrikes.some(s => 
    Math.abs(s.strike - spotPrice) < 50
  );
  
  // Determine sweep direction based on OI distribution
  const aboveSpotOI = strikes
    .filter(s => s.strike > spotPrice)
    .reduce((sum, s) => sum + (s.call.oi || 0) + (s.put.oi || 0), 0);
  
  const belowSpotOI = strikes
    .filter(s => s.strike < spotPrice)
    .reduce((sum, s) => sum + (s.call.oi || 0) + (s.put.oi || 0), 0);
  
  let direction = null;
  if (nearLowOI) {
    direction = aboveSpotOI > belowSpotOI ? 'up' : 'down';
  }
  
  return {
    direction,
    low_oi_strikes: lowOIStrikes.map(s => s.strike),
    sweep_potential: nearLowOI ? 'high' : 'low'
  };
}

/**
 * Determine institutional sentiment
 */
function determineInstitutionalSentiment(deltaWeightedOI, flowType, smartMoneyIndex, blockTrades) {
  let score = 0;
  
  // Delta-weighted OI (40% weight)
  if (deltaWeightedOI > 10000) score += 40;
  else if (deltaWeightedOI > 5000) score += 20;
  else if (deltaWeightedOI < -10000) score -= 40;
  else if (deltaWeightedOI < -5000) score -= 20;
  
  // Flow type (30% weight)
  if (flowType.net === 'bullish') score += 30;
  else if (flowType.net === 'bearish') score -= 30;
  
  // Smart money index (20% weight)
  score += (smartMoneyIndex / 100) * 20;
  
  // Block trades (10% weight)
  if (blockTrades.detected) {
    const bullishBlocks = blockTrades.strikes.filter(s => s.includes('buy')).length;
    const bearishBlocks = blockTrades.strikes.filter(s => s.includes('sell')).length;
    if (bullishBlocks > bearishBlocks) score += 10;
    else if (bearishBlocks > bullishBlocks) score -= 10;
  }
  
  // Classify sentiment
  if (score > 50) return 'strongly_bullish';
  if (score > 20) return 'bullish';
  if (score < -50) return 'strongly_bearish';
  if (score < -20) return 'bearish';
  return 'neutral';
}

/**
 * Calculate flow strength (0-100)
 */
function calculateFlowStrength(deltaWeightedOI, smartMoneyIndex) {
  const oiStrength = Math.min(100, Math.abs(deltaWeightedOI) / 200);
  const smiStrength = Math.abs(smartMoneyIndex);
  
  return Math.round((oiStrength + smiStrength) / 2);
}

/**
 * Get trading implications
 */
function getTradingImplication(sentiment, flowNet) {
  if (sentiment === 'strongly_bullish' && flowNet === 'bullish') {
    return 'Strong institutional buying - favor long positions, expect upward momentum';
  }
  if (sentiment === 'strongly_bearish' && flowNet === 'bearish') {
    return 'Strong institutional selling - favor short positions, expect downward pressure';
  }
  if (sentiment === 'bullish') {
    return 'Moderate bullish flow - consider long positions with tight stops';
  }
  if (sentiment === 'bearish') {
    return 'Moderate bearish flow - consider short positions with tight stops';
  }
  return 'Neutral flow - wait for clearer directional signal';
}

/**
 * Calculate order flow score for master algorithm (0-100)
 */
function calculateOrderFlowScore(orderFlowData, direction) {
  if (!orderFlowData) return 50; // Neutral
  
  let score = 50; // Start neutral
  
  // 1. Institutional sentiment alignment (40 points)
  if (direction === 'bullish') {
    if (orderFlowData.institutional_sentiment === 'strongly_bullish') score += 40;
    else if (orderFlowData.institutional_sentiment === 'bullish') score += 25;
    else if (orderFlowData.institutional_sentiment.includes('bearish')) score -= 20;
  } else if (direction === 'bearish') {
    if (orderFlowData.institutional_sentiment === 'strongly_bearish') score += 40;
    else if (orderFlowData.institutional_sentiment === 'bearish') score += 25;
    else if (orderFlowData.institutional_sentiment.includes('bullish')) score -= 20;
  }
  
  // 2. Flow strength (30 points)
  const flowStrength = orderFlowData.flow_strength || 0;
  score += (flowStrength / 100) * 30;
  
  // 3. Smart money index alignment (20 points)
  const smi = orderFlowData.smart_money_index || 0;
  if (direction === 'bullish' && smi > 30) score += 20;
  else if (direction === 'bearish' && smi < -30) score += 20;
  else if (direction === 'bullish' && smi < -30) score -= 15;
  else if (direction === 'bearish' && smi > 30) score -= 15;
  
  // 4. Block trades confirmation (10 points)
  if (orderFlowData.block_trades_detected) {
    score += 10;
  }
  
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  analyzeOrderFlow,
  calculateOrderFlowScore
};
