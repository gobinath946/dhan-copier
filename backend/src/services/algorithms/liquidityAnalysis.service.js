/**
 * Liquidity Analysis Algorithm
 * Used by: Institutional traders, Market makers, HFT firms
 * 
 * Analyzes order book imbalance, bid/ask pressure, liquidity sweeps,
 * stop hunt zones, smart money absorption, and spread widening
 * 
 * CRITICAL FOR SCALPING: Liquidity is where the real money is made/lost
 */
const logger = require('../../utils/logger');

/**
 * Analyze liquidity from option chain and order book data
 * @param {Object} optionChain - Option chain with strikes
 * @param {number} spotPrice - Current spot price
 * @param {Object} orderBookData - Order book data (if available)
 * @param {Object} previousData - Previous cycle data for comparison
 */
function analyzeLiquidity(optionChain, spotPrice, orderBookData = null, previousData = null) {
  try {
    if (!optionChain || !optionChain.strikes || !spotPrice) {
      return null;
    }
    
    // 1. Bid/Ask Imbalance Analysis
    const bidAskAnalysis = analyzeBidAskImbalance(optionChain, spotPrice);
    
    // 2. Liquidity Sweep Detection (Stop Hunts)
    const liquiditySweeps = detectLiquiditySweeps(optionChain, spotPrice, previousData);
    
    // 3. Spread Analysis (Widening = Risk)
    const spreadAnalysis = analyzeSpread(optionChain, spotPrice);
    
    // 4. Smart Money Absorption Detection
    const absorption = detectSmartMoneyAbsorption(optionChain, spotPrice, previousData);
    
    // 5. Depth of Market (DOM) Analysis
    const domAnalysis = analyzeDOMDepth(optionChain, spotPrice);
    
    // 6. Liquidity Zones (Support/Resistance based on OI)
    const liquidityZones = identifyLiquidityZones(optionChain, spotPrice);
    
    // 7. Iceberg Order Detection (Hidden liquidity)
    const icebergOrders = detectIcebergOrders(optionChain, previousData);
    
    // 8. Overall Liquidity Health Score
    const liquidityScore = calculateLiquidityScore(
      bidAskAnalysis,
      liquiditySweeps,
      spreadAnalysis,
      absorption,
      domAnalysis
    );
    
    return {
      bid_ask_imbalance: bidAskAnalysis,
      liquidity_sweeps: liquiditySweeps,
      spread_analysis: spreadAnalysis,
      smart_money_absorption: absorption,
      dom_depth: domAnalysis,
      liquidity_zones: liquidityZones,
      iceberg_orders: icebergOrders,
      liquidity_score: liquidityScore,
      liquidity_health: determineLiquidityHealth(liquidityScore),
      trading_implication: getTradingImplication(liquidityScore, liquiditySweeps, absorption)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[liquidityAnalysis] Analysis failed');
    return null;
  }
}

/**
 * 1. Analyze Bid/Ask Imbalance
 * Bid > Ask = Buying pressure (bullish)
 * Ask > Bid = Selling pressure (bearish)
 */
function analyzeBidAskImbalance(optionChain, spotPrice) {
  const atmStrike = Math.round(spotPrice / 50) * 50;
  const atmWindow = optionChain.strikes.filter(s => 
    Math.abs(s.strike - atmStrike) <= 100 // ATM ±2 strikes
  );
  
  let totalBidSize = 0;
  let totalAskSize = 0;
  let totalBidValue = 0;
  let totalAskValue = 0;
  
  atmWindow.forEach(strike => {
    // Call options
    const callBid = strike.call.bid || strike.call.ltp * 0.995; // Estimate if not available
    const callAsk = strike.call.ask || strike.call.ltp * 1.005;
    const callOI = strike.call.oi || 0;
    
    // Put options
    const putBid = strike.put.bid || strike.put.ltp * 0.995;
    const putAsk = strike.put.ask || strike.put.ltp * 1.005;
    const putOI = strike.put.oi || 0;
    
    // Estimate bid/ask sizes based on OI (assumption: 10% of OI is active)
    const callBidSize = callOI * 0.05; // 5% on bid
    const callAskSize = callOI * 0.05; // 5% on ask
    const putBidSize = putOI * 0.05;
    const putAskSize = putOI * 0.05;
    
    totalBidSize += callBidSize + putBidSize;
    totalAskSize += callAskSize + putAskSize;
    totalBidValue += (callBidSize * callBid) + (putBidSize * putBid);
    totalAskValue += (callAskSize * callAsk) + (putAskSize * putAsk);
  });
  
  const bidAskRatio = totalAskSize > 0 ? totalBidSize / totalAskSize : 1;
  const bidAskValueRatio = totalAskValue > 0 ? totalBidValue / totalAskValue : 1;
  
  // Determine pressure
  let pressure = 'neutral';
  let pressureStrength = 0;
  
  if (bidAskRatio > 1.2) {
    pressure = 'buying';
    pressureStrength = Math.min(10, (bidAskRatio - 1) * 10);
  } else if (bidAskRatio < 0.8) {
    pressure = 'selling';
    pressureStrength = Math.min(10, (1 - bidAskRatio) * 10);
  }
  
  return {
    bid_ask_ratio: Number(bidAskRatio.toFixed(2)),
    bid_ask_value_ratio: Number(bidAskValueRatio.toFixed(2)),
    total_bid_size: Math.round(totalBidSize),
    total_ask_size: Math.round(totalAskSize),
    pressure,
    pressure_strength: Math.round(pressureStrength * 10) / 10,
    imbalance_pct: Number(((bidAskRatio - 1) * 100).toFixed(2))
  };
}

/**
 * 2. Detect Liquidity Sweeps (Stop Hunts)
 * Market makers hunt stops at low liquidity zones
 */
function detectLiquiditySweeps(optionChain, spotPrice, previousData) {
  const strikes = optionChain.strikes;
  
  // Find low liquidity strikes (potential sweep targets)
  const lowLiquidityStrikes = strikes.filter(s => {
    const totalOI = (s.call.oi || 0) + (s.put.oi || 0);
    const totalVolume = (s.call.volume || 0) + (s.put.volume || 0);
    return totalOI < 5000 || totalVolume < 100; // Low liquidity threshold
  }).map(s => s.strike);
  
  // Check if spot is near low liquidity zones
  const nearLowLiquidity = lowLiquidityStrikes.filter(strike => 
    Math.abs(strike - spotPrice) < 50
  );
  
  // Detect if price just swept through a low liquidity zone
  let sweepDetected = false;
  let sweepDirection = null;
  let sweptStrikes = [];
  
  if (previousData && previousData.spotPrice) {
    const prevSpot = previousData.spotPrice;
    const priceMove = spotPrice - prevSpot;
    
    // Check if price moved through low liquidity zones
    lowLiquidityStrikes.forEach(strike => {
      if ((prevSpot < strike && spotPrice > strike) || 
          (prevSpot > strike && spotPrice < strike)) {
        sweepDetected = true;
        sweepDirection = priceMove > 0 ? 'upward' : 'downward';
        sweptStrikes.push(strike);
      }
    });
  }
  
  // Identify potential sweep targets (next low liquidity zones)
  const upwardTargets = lowLiquidityStrikes.filter(s => s > spotPrice).slice(0, 3);
  const downwardTargets = lowLiquidityStrikes.filter(s => s < spotPrice).slice(-3);
  
  return {
    sweep_detected: sweepDetected,
    sweep_direction: sweepDirection,
    swept_strikes: sweptStrikes,
    low_liquidity_strikes: lowLiquidityStrikes.slice(0, 10),
    near_low_liquidity: nearLowLiquidity,
    upward_sweep_targets: upwardTargets,
    downward_sweep_targets: downwardTargets,
    sweep_risk: nearLowLiquidity.length > 0 ? 'high' : 'low'
  };
}

/**
 * 3. Analyze Spread (Bid-Ask Spread)
 * Widening spread = Liquidity drying up = Risk
 */
function analyzeSpread(optionChain, spotPrice) {
  const atmStrike = Math.round(spotPrice / 50) * 50;
  const atmRow = optionChain.strikes.find(s => s.strike === atmStrike);
  
  if (!atmRow) {
    return {
      atm_call_spread: null,
      atm_put_spread: null,
      spread_status: 'unknown',
      spread_risk: 'medium'
    };
  }
  
  // Calculate spreads
  const callBid = atmRow.call.bid || atmRow.call.ltp * 0.995;
  const callAsk = atmRow.call.ask || atmRow.call.ltp * 1.005;
  const callSpread = callAsk - callBid;
  const callSpreadPct = (callSpread / atmRow.call.ltp) * 100;
  
  const putBid = atmRow.put.bid || atmRow.put.ltp * 0.995;
  const putAsk = atmRow.put.ask || atmRow.put.ltp * 1.005;
  const putSpread = putAsk - putBid;
  const putSpreadPct = (putSpread / atmRow.put.ltp) * 100;
  
  const avgSpreadPct = (callSpreadPct + putSpreadPct) / 2;
  
  // Determine spread status
  let spreadStatus = 'normal';
  let spreadRisk = 'low';
  
  if (avgSpreadPct > 2.0) {
    spreadStatus = 'very_wide';
    spreadRisk = 'critical';
  } else if (avgSpreadPct > 1.0) {
    spreadStatus = 'wide';
    spreadRisk = 'high';
  } else if (avgSpreadPct > 0.5) {
    spreadStatus = 'normal';
    spreadRisk = 'medium';
  } else {
    spreadStatus = 'tight';
    spreadRisk = 'low';
  }
  
  return {
    atm_call_spread: Number(callSpread.toFixed(2)),
    atm_put_spread: Number(putSpread.toFixed(2)),
    atm_call_spread_pct: Number(callSpreadPct.toFixed(2)),
    atm_put_spread_pct: Number(putSpreadPct.toFixed(2)),
    avg_spread_pct: Number(avgSpreadPct.toFixed(2)),
    spread_status: spreadStatus,
    spread_risk: spreadRisk
  };
}

/**
 * 4. Detect Smart Money Absorption
 * Large orders being absorbed without price movement = Smart money
 */
function detectSmartMoneyAbsorption(optionChain, spotPrice, previousData) {
  if (!previousData || !previousData.optionChain) {
    return {
      absorption_detected: false,
      absorption_type: null,
      absorption_strikes: [],
      absorption_strength: 0
    };
  }
  
  const currentStrikes = optionChain.strikes;
  const prevStrikes = previousData.optionChain.strikes;
  
  const absorptionZones = [];
  
  currentStrikes.forEach(current => {
    const prev = prevStrikes.find(p => p.strike === current.strike);
    if (!prev) return;
    
    // Check for large OI increase with minimal price change
    const callOIChange = (current.call.oi || 0) - (prev.call.oi || 0);
    const putOIChange = (current.put.oi || 0) - (prev.put.oi || 0);
    const callPriceChange = Math.abs((current.call.ltp || 0) - (prev.call.ltp || 0));
    const putPriceChange = Math.abs((current.put.ltp || 0) - (prev.put.ltp || 0));
    
    // Absorption = large OI change + small price change
    const callAbsorption = callOIChange > 5000 && callPriceChange < (prev.call.ltp * 0.02);
    const putAbsorption = putOIChange > 5000 && putPriceChange < (prev.put.ltp * 0.02);
    
    if (callAbsorption) {
      absorptionZones.push({
        strike: current.strike,
        type: 'call',
        oi_change: callOIChange,
        price_change: callPriceChange,
        absorption_type: callOIChange > 0 ? 'buying' : 'selling'
      });
    }
    
    if (putAbsorption) {
      absorptionZones.push({
        strike: current.strike,
        type: 'put',
        oi_change: putOIChange,
        price_change: putPriceChange,
        absorption_type: putOIChange > 0 ? 'buying' : 'selling'
      });
    }
  });
  
  const absorptionDetected = absorptionZones.length > 0;
  const absorptionStrength = Math.min(10, absorptionZones.length * 2);
  
  // Determine overall absorption type
  const buyingAbsorption = absorptionZones.filter(z => z.absorption_type === 'buying').length;
  const sellingAbsorption = absorptionZones.filter(z => z.absorption_type === 'selling').length;
  
  let absorptionType = null;
  if (buyingAbsorption > sellingAbsorption) absorptionType = 'smart_money_buying';
  else if (sellingAbsorption > buyingAbsorption) absorptionType = 'smart_money_selling';
  
  return {
    absorption_detected: absorptionDetected,
    absorption_type: absorptionType,
    absorption_strikes: absorptionZones.map(z => `${z.strike} ${z.type}`),
    absorption_strength: absorptionStrength,
    absorption_zones: absorptionZones.slice(0, 5) // Top 5
  };
}

/**
 * 5. Analyze Depth of Market (DOM)
 * Deep market = Safe to trade
 * Shallow market = Risky
 */
function analyzeDOMDepth(optionChain, spotPrice) {
  const atmStrike = Math.round(spotPrice / 50) * 50;
  const atmWindow = optionChain.strikes.filter(s => 
    Math.abs(s.strike - atmStrike) <= 100
  );
  
  // Calculate total liquidity at ATM levels
  let totalOI = 0;
  let totalVolume = 0;
  let strikeCount = 0;
  
  atmWindow.forEach(strike => {
    totalOI += (strike.call.oi || 0) + (strike.put.oi || 0);
    totalVolume += (strike.call.volume || 0) + (strike.put.volume || 0);
    strikeCount++;
  });
  
  const avgOIPerStrike = strikeCount > 0 ? totalOI / strikeCount : 0;
  const avgVolumePerStrike = strikeCount > 0 ? totalVolume / strikeCount : 0;
  
  // Determine depth quality
  let depthQuality = 'shallow';
  let depthScore = 0;
  
  if (avgOIPerStrike > 50000 && avgVolumePerStrike > 5000) {
    depthQuality = 'very_deep';
    depthScore = 10;
  } else if (avgOIPerStrike > 30000 && avgVolumePerStrike > 3000) {
    depthQuality = 'deep';
    depthScore = 8;
  } else if (avgOIPerStrike > 15000 && avgVolumePerStrike > 1000) {
    depthQuality = 'moderate';
    depthScore = 6;
  } else if (avgOIPerStrike > 5000 && avgVolumePerStrike > 500) {
    depthQuality = 'shallow';
    depthScore = 4;
  } else {
    depthQuality = 'very_shallow';
    depthScore = 2;
  }
  
  return {
    total_oi: Math.round(totalOI),
    total_volume: Math.round(totalVolume),
    avg_oi_per_strike: Math.round(avgOIPerStrike),
    avg_volume_per_strike: Math.round(avgVolumePerStrike),
    depth_quality: depthQuality,
    depth_score: depthScore,
    safe_to_trade: depthScore >= 6
  };
}

/**
 * 6. Identify Liquidity Zones (Support/Resistance based on OI)
 * High OI = Strong support/resistance
 */
function identifyLiquidityZones(optionChain, spotPrice) {
  const strikes = optionChain.strikes;
  
  // Calculate total OI for each strike
  const oiByStrike = strikes.map(s => ({
    strike: s.strike,
    total_oi: (s.call.oi || 0) + (s.put.oi || 0),
    call_oi: s.call.oi || 0,
    put_oi: s.put.oi || 0
  }));
  
  // Sort by total OI
  const sortedByOI = [...oiByStrike].sort((a, b) => b.total_oi - a.total_oi);
  
  // Top 5 liquidity zones
  const topZones = sortedByOI.slice(0, 5);
  
  // Classify as support or resistance
  const liquidityZones = topZones.map(zone => {
    const isAbove = zone.strike > spotPrice;
    const type = isAbove ? 'resistance' : 'support';
    const distance = Math.abs(zone.strike - spotPrice);
    const distancePct = (distance / spotPrice) * 100;
    
    return {
      strike: zone.strike,
      type,
      total_oi: zone.total_oi,
      call_oi: zone.call_oi,
      put_oi: zone.put_oi,
      distance_from_spot: Math.round(distance),
      distance_pct: Number(distancePct.toFixed(2)),
      strength: zone.total_oi > 100000 ? 'very_strong' : 
                zone.total_oi > 50000 ? 'strong' : 
                zone.total_oi > 25000 ? 'moderate' : 'weak'
    };
  });
  
  return {
    zones: liquidityZones,
    nearest_support: liquidityZones.filter(z => z.type === 'support')[0] || null,
    nearest_resistance: liquidityZones.filter(z => z.type === 'resistance')[0] || null
  };
}

/**
 * 7. Detect Iceberg Orders (Hidden Liquidity)
 * Small visible orders but large OI = Iceberg
 */
function detectIcebergOrders(optionChain, previousData) {
  if (!previousData || !previousData.optionChain) {
    return {
      iceberg_detected: false,
      iceberg_strikes: [],
      iceberg_count: 0
    };
  }
  
  const currentStrikes = optionChain.strikes;
  const prevStrikes = previousData.optionChain.strikes;
  
  const icebergStrikes = [];
  
  currentStrikes.forEach(current => {
    const prev = prevStrikes.find(p => p.strike === current.strike);
    if (!prev) return;
    
    // Iceberg = low volume but high OI increase
    const callVolumeRatio = (current.call.volume || 1) / (current.call.oi || 1);
    const putVolumeRatio = (current.put.volume || 1) / (current.put.oi || 1);
    
    const callOIChange = (current.call.oi || 0) - (prev.call.oi || 0);
    const putOIChange = (current.put.oi || 0) - (prev.put.oi || 0);
    
    // Iceberg = OI increase > 5000 but volume ratio < 0.1
    const callIceberg = callOIChange > 5000 && callVolumeRatio < 0.1;
    const putIceberg = putOIChange > 5000 && putVolumeRatio < 0.1;
    
    if (callIceberg) {
      icebergStrikes.push({
        strike: current.strike,
        type: 'call',
        oi_change: callOIChange,
        volume: current.call.volume,
        hidden_size: Math.round(callOIChange * 0.9) // Estimate hidden size
      });
    }
    
    if (putIceberg) {
      icebergStrikes.push({
        strike: current.strike,
        type: 'put',
        oi_change: putOIChange,
        volume: current.put.volume,
        hidden_size: Math.round(putOIChange * 0.9)
      });
    }
  });
  
  return {
    iceberg_detected: icebergStrikes.length > 0,
    iceberg_strikes: icebergStrikes.map(i => `${i.strike} ${i.type}`),
    iceberg_count: icebergStrikes.length,
    iceberg_orders: icebergStrikes.slice(0, 5)
  };
}

/**
 * Calculate overall liquidity score (0-100)
 */
function calculateLiquidityScore(bidAskAnalysis, liquiditySweeps, spreadAnalysis, absorption, domAnalysis) {
  let score = 50; // Start neutral
  
  // 1. Bid/Ask Imbalance (20 points)
  if (bidAskAnalysis.pressure !== 'neutral') {
    score += (bidAskAnalysis.pressure_strength / 10) * 20;
  }
  
  // 2. Liquidity Sweeps (20 points)
  if (liquiditySweeps.sweep_detected) {
    score -= 20; // Sweep detected = risky
  } else if (liquiditySweeps.sweep_risk === 'low') {
    score += 10; // No sweep risk = good
  }
  
  // 3. Spread Analysis (20 points)
  if (spreadAnalysis.spread_status === 'tight') {
    score += 20;
  } else if (spreadAnalysis.spread_status === 'normal') {
    score += 10;
  } else if (spreadAnalysis.spread_status === 'wide') {
    score -= 10;
  } else if (spreadAnalysis.spread_status === 'very_wide') {
    score -= 20;
  }
  
  // 4. Smart Money Absorption (20 points)
  if (absorption.absorption_detected) {
    score += (absorption.absorption_strength / 10) * 20;
  }
  
  // 5. DOM Depth (20 points)
  score += (domAnalysis.depth_score / 10) * 20;
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine liquidity health
 */
function determineLiquidityHealth(liquidityScore) {
  if (liquidityScore >= 80) return 'excellent';
  if (liquidityScore >= 65) return 'good';
  if (liquidityScore >= 50) return 'fair';
  if (liquidityScore >= 35) return 'poor';
  return 'critical';
}

/**
 * Get trading implications
 */
function getTradingImplication(liquidityScore, liquiditySweeps, absorption) {
  if (liquidityScore >= 80) {
    return 'Excellent liquidity - safe to trade with full size';
  }
  
  if (liquidityScore >= 65) {
    return 'Good liquidity - trade with normal size';
  }
  
  if (liquidityScore >= 50) {
    return 'Fair liquidity - reduce size by 25%, use tighter stops';
  }
  
  if (liquiditySweeps.sweep_detected) {
    return 'Liquidity sweep detected - wait for price to stabilize before entry';
  }
  
  if (liquiditySweeps.sweep_risk === 'high') {
    return 'High sweep risk - avoid trading near low liquidity zones';
  }
  
  if (absorption.absorption_detected && absorption.absorption_type === 'smart_money_buying') {
    return 'Smart money buying detected - consider long positions';
  }
  
  if (absorption.absorption_detected && absorption.absorption_type === 'smart_money_selling') {
    return 'Smart money selling detected - consider short positions';
  }
  
  if (liquidityScore < 35) {
    return 'Critical liquidity - avoid trading or use minimal size';
  }
  
  return 'Poor liquidity - reduce size by 50%, widen stops, be cautious';
}

/**
 * Calculate liquidity score for master algorithm (0-100)
 */
function calculateLiquidityScoreForMaster(liquidityData, direction) {
  if (!liquidityData) return 50; // Neutral
  
  let score = liquidityData.liquidity_score; // Start with base score
  
  // 1. Adjust for direction alignment with bid/ask pressure (20 points)
  if (direction === 'bullish' && liquidityData.bid_ask_imbalance.pressure === 'buying') {
    score += 20;
  } else if (direction === 'bearish' && liquidityData.bid_ask_imbalance.pressure === 'selling') {
    score += 20;
  } else if (direction === 'bullish' && liquidityData.bid_ask_imbalance.pressure === 'selling') {
    score -= 15;
  } else if (direction === 'bearish' && liquidityData.bid_ask_imbalance.pressure === 'buying') {
    score -= 15;
  }
  
  // 2. Adjust for smart money absorption alignment (15 points)
  if (liquidityData.smart_money_absorption.absorption_detected) {
    if (direction === 'bullish' && liquidityData.smart_money_absorption.absorption_type === 'smart_money_buying') {
      score += 15;
    } else if (direction === 'bearish' && liquidityData.smart_money_absorption.absorption_type === 'smart_money_selling') {
      score += 15;
    }
  }
  
  // 3. Penalty for sweep risk (10 points)
  if (liquidityData.liquidity_sweeps.sweep_risk === 'high') {
    score -= 10;
  }
  
  // 4. Penalty for poor DOM depth (10 points)
  if (!liquidityData.dom_depth.safe_to_trade) {
    score -= 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeLiquidity,
  calculateLiquidityScoreForMaster
};
