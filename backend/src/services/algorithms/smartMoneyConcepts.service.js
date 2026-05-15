/**
 * Smart Money Concepts (SMC) / Inner Circle Trader (ICT) Algorithm
 * Used by: Institutional traders, Prop firms, Professional day traders
 * 
 * Analyzes order blocks, fair value gaps, liquidity zones, break of structure,
 * change of character, and mitigation blocks
 * 
 * CRITICAL FOR INSTITUTIONAL-LEVEL TRADING
 */
const logger = require('../../utils/logger');

/**
 * Analyze Smart Money Concepts from candle data and option chain
 * @param {Array} candles - 1-minute candles (last 30-60 minutes)
 * @param {Object} optionChain - Option chain data
 * @param {number} spotPrice - Current spot price
 * @param {Object} previousAnalysis - Previous cycle analysis for comparison
 */
function analyzeSmartMoneyConcepts(candles, optionChain, spotPrice, previousAnalysis = null) {
  try {
    if (!candles || candles.length < 10 || !spotPrice) {
      return null;
    }
    
    // 1. Order Blocks (Institutional Zones)
    const orderBlocks = detectOrderBlocks(candles, optionChain, spotPrice);
    
    // 2. Fair Value Gaps (FVG) - Price imbalances
    const fairValueGaps = detectFairValueGaps(candles, spotPrice);
    
    // 3. Liquidity Zones (Stop Hunt Areas)
    const liquidityZones = identifyLiquidityZones(candles, optionChain, spotPrice);
    
    // 4. Break of Structure (BOS) - Trend continuation
    const breakOfStructure = detectBreakOfStructure(candles, previousAnalysis);
    
    // 5. Change of Character (CHoCH) - Trend reversal
    const changeOfCharacter = detectChangeOfCharacter(candles, previousAnalysis);
    
    // 6. Mitigation Blocks - Institutional retest zones
    const mitigationBlocks = identifyMitigationBlocks(candles, orderBlocks, spotPrice);
    
    // 7. Inducement - Fake moves to trap retail
    const inducement = detectInducement(candles, liquidityZones, spotPrice);
    
    // 8. Market Structure - Overall trend direction
    const marketStructure = analyzeMarketStructure(candles, breakOfStructure, changeOfCharacter);
    
    // 9. Smart Money Score (0-100)
    const smcScore = calculateSMCScore(
      orderBlocks,
      fairValueGaps,
      liquidityZones,
      breakOfStructure,
      changeOfCharacter,
      marketStructure
    );
    
    return {
      order_blocks: orderBlocks,
      fair_value_gaps: fairValueGaps,
      liquidity_zones: liquidityZones,
      break_of_structure: breakOfStructure,
      change_of_character: changeOfCharacter,
      mitigation_blocks: mitigationBlocks,
      inducement: inducement,
      market_structure: marketStructure,
      smc_score: smcScore,
      smc_bias: determineSMCBias(marketStructure, orderBlocks, fairValueGaps),
      trading_implication: getTradingImplication(marketStructure, orderBlocks, fairValueGaps, spotPrice)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[smartMoneyConcepts] Analysis failed');
    return null;
  }
}

/**
 * 1. Detect Order Blocks (Institutional Zones)
 * Order Block = Last bullish/bearish candle before strong move
 * Institutions leave "footprints" at these zones
 */
function detectOrderBlocks(candles, optionChain, spotPrice) {
  const orderBlocks = [];
  
  // Look for strong moves (>0.15% in 1 minute - REDUCED for more detection)
  for (let i = 5; i < candles.length - 1; i++) {
    const current = candles[i];
    const next = candles[i + 1];
    const prev = candles[i - 1];
    
    const currentRange = Math.abs(current.close - current.open);
    const nextRange = Math.abs(next.close - next.open);
    const avgPrice = (current.high + current.low) / 2;
    
    // Strong bullish move after this candle (REDUCED threshold from 0.003 to 0.0015)
    const strongBullishMove = next.close > next.open && 
                              nextRange > currentRange * 1.5 &&  // REDUCED from 2x to 1.5x
                              ((next.close - next.open) / next.open) > 0.0015;
    
    // Strong bearish move after this candle (REDUCED threshold from 0.003 to 0.0015)
    const strongBearishMove = next.close < next.open && 
                              nextRange > currentRange * 1.5 &&  // REDUCED from 2x to 1.5x
                              ((next.open - next.close) / next.open) > 0.0015;
    
    if (strongBullishMove) {
      // Bullish Order Block (last bearish candle before bullish move)
      if (current.close < current.open) {
        orderBlocks.push({
          type: 'bullish',
          high: current.high,
          low: current.low,
          open: current.open,
          close: current.close,
          timestamp: current.timestamp,
          zone_high: current.high,
          zone_low: current.low,
          distance_from_spot: Math.abs(avgPrice - spotPrice),
          distance_pct: ((avgPrice - spotPrice) / spotPrice) * 100,
          strength: calculateOrderBlockStrength(current, next, optionChain),
          status: spotPrice > current.high ? 'above' : spotPrice < current.low ? 'below' : 'inside'
        });
      }
    }
    
    if (strongBearishMove) {
      // Bearish Order Block (last bullish candle before bearish move)
      if (current.close > current.open) {
        orderBlocks.push({
          type: 'bearish',
          high: current.high,
          low: current.low,
          open: current.open,
          close: current.close,
          timestamp: current.timestamp,
          zone_high: current.high,
          zone_low: current.low,
          distance_from_spot: Math.abs(avgPrice - spotPrice),
          distance_pct: ((avgPrice - spotPrice) / spotPrice) * 100,
          strength: calculateOrderBlockStrength(current, next, optionChain),
          status: spotPrice > current.high ? 'above' : spotPrice < current.low ? 'below' : 'inside'
        });
      }
    }
  }
  
  // Sort by distance from spot (nearest first)
  orderBlocks.sort((a, b) => a.distance_from_spot - b.distance_from_spot);
  
  // Return top 5 nearest order blocks
  return {
    blocks: orderBlocks.slice(0, 5),
    bullish_blocks: orderBlocks.filter(b => b.type === 'bullish').slice(0, 3),
    bearish_blocks: orderBlocks.filter(b => b.type === 'bearish').slice(0, 3),
    nearest_block: orderBlocks[0] || null,
    inside_block: orderBlocks.find(b => b.status === 'inside') || null
  };
}

/**
 * Calculate order block strength based on volume and OI
 */
function calculateOrderBlockStrength(candle, nextCandle, optionChain) {
  let strength = 5; // Base strength
  
  // Volume confirmation
  const volumeRatio = (nextCandle.volume || 1) / (candle.volume || 1);
  if (volumeRatio > 2) strength += 2; // Strong volume
  if (volumeRatio > 3) strength += 1; // Very strong volume
  
  // OI confirmation (if available)
  if (optionChain && optionChain.strikes) {
    const nearestStrike = Math.round(candle.close / 50) * 50;
    const strikeData = optionChain.strikes.find(s => s.strike === nearestStrike);
    
    if (strikeData) {
      const totalOI = (strikeData.call.oi || 0) + (strikeData.put.oi || 0);
      if (totalOI > 50000) strength += 2; // High OI = strong zone
    }
  }
  
  return Math.min(10, strength);
}

/**
 * 2. Detect Fair Value Gaps (FVG)
 * FVG = Price gap with no trading (imbalance)
 * Market tends to fill these gaps
 */
function detectFairValueGaps(candles, spotPrice) {
  const fvgs = [];
  
  // Look for 3-candle patterns with gaps
  for (let i = 2; i < candles.length; i++) {
    const candle1 = candles[i - 2];
    const candle2 = candles[i - 1];
    const candle3 = candles[i];
    
    // Bullish FVG: Gap between candle1 high and candle3 low
    const bullishGap = candle3.low > candle1.high;
    if (bullishGap) {
      const gapSize = candle3.low - candle1.high;
      const gapPct = (gapSize / candle1.high) * 100;
      
      // Only consider significant gaps (>0.05% - REDUCED for more detection)
      if (gapPct > 0.05) {
        fvgs.push({
          type: 'bullish',
          gap_high: candle3.low,
          gap_low: candle1.high,
          gap_size: gapSize,
          gap_pct: Number(gapPct.toFixed(2)),
          timestamp: candle3.timestamp,
          filled: spotPrice < candle3.low,
          distance_from_spot: Math.abs(((candle3.low + candle1.high) / 2) - spotPrice),
          status: spotPrice > candle3.low ? 'above' : spotPrice < candle1.high ? 'below' : 'filling'
        });
      }
    }
    
    // Bearish FVG: Gap between candle1 low and candle3 high
    const bearishGap = candle3.high < candle1.low;
    if (bearishGap) {
      const gapSize = candle1.low - candle3.high;
      const gapPct = (gapSize / candle1.low) * 100;
      
      if (gapPct > 0.05) {  // REDUCED for more detection
        fvgs.push({
          type: 'bearish',
          gap_high: candle1.low,
          gap_low: candle3.high,
          gap_size: gapSize,
          gap_pct: Number(gapPct.toFixed(2)),
          timestamp: candle3.timestamp,
          filled: spotPrice > candle1.low,
          distance_from_spot: Math.abs(((candle1.low + candle3.high) / 2) - spotPrice),
          status: spotPrice > candle1.low ? 'above' : spotPrice < candle3.high ? 'below' : 'filling'
        });
      }
    }
  }
  
  // Sort by distance from spot
  fvgs.sort((a, b) => a.distance_from_spot - b.distance_from_spot);
  
  // Filter unfilled gaps
  const unfilledFVGs = fvgs.filter(f => !f.filled);
  
  return {
    gaps: fvgs.slice(0, 5),
    unfilled_gaps: unfilledFVGs.slice(0, 3),
    bullish_gaps: fvgs.filter(f => f.type === 'bullish').slice(0, 3),
    bearish_gaps: fvgs.filter(f => f.type === 'bearish').slice(0, 3),
    nearest_gap: fvgs[0] || null,
    filling_gap: fvgs.find(f => f.status === 'filling') || null
  };
}

/**
 * 3. Identify Liquidity Zones (Stop Hunt Areas)
 * Liquidity = Areas where stops are clustered
 * Smart money hunts these stops before reversing
 */
function identifyLiquidityZones(candles, optionChain, spotPrice) {
  const liquidityZones = [];
  
  // Find swing highs and lows (potential stop zones)
  for (let i = 5; i < candles.length - 5; i++) {
    const current = candles[i];
    const leftCandles = candles.slice(i - 5, i);
    const rightCandles = candles.slice(i + 1, i + 6);
    
    // Swing High (resistance - sell stops above)
    const isSwingHigh = leftCandles.every(c => c.high < current.high) &&
                        rightCandles.every(c => c.high < current.high);
    
    if (isSwingHigh) {
      liquidityZones.push({
        type: 'sell_side', // Sell stops above this level
        level: current.high,
        timestamp: current.timestamp,
        distance_from_spot: Math.abs(current.high - spotPrice),
        distance_pct: ((current.high - spotPrice) / spotPrice) * 100,
        swept: spotPrice > current.high, // Has price swept this level?
        status: spotPrice > current.high ? 'swept' : 'active'
      });
    }
    
    // Swing Low (support - buy stops below)
    const isSwingLow = leftCandles.every(c => c.low > current.low) &&
                       rightCandles.every(c => c.low > current.low);
    
    if (isSwingLow) {
      liquidityZones.push({
        type: 'buy_side', // Buy stops below this level
        level: current.low,
        timestamp: current.timestamp,
        distance_from_spot: Math.abs(current.low - spotPrice),
        distance_pct: ((current.low - spotPrice) / spotPrice) * 100,
        swept: spotPrice < current.low,
        status: spotPrice < current.low ? 'swept' : 'active'
      });
    }
  }
  
  // Sort by distance from spot
  liquidityZones.sort((a, b) => a.distance_from_spot - b.distance_from_spot);
  
  return {
    zones: liquidityZones.slice(0, 10),
    sell_side_liquidity: liquidityZones.filter(z => z.type === 'sell_side' && !z.swept).slice(0, 3),
    buy_side_liquidity: liquidityZones.filter(z => z.type === 'buy_side' && !z.swept).slice(0, 3),
    recently_swept: liquidityZones.filter(z => z.swept).slice(0, 3),
    nearest_liquidity: liquidityZones[0] || null
  };
}

/**
 * 4. Detect Break of Structure (BOS)
 * BOS = Price breaks previous high/low in trend direction
 * Confirms trend continuation
 */
function detectBreakOfStructure(candles, previousAnalysis) {
  if (candles.length < 10) return null;
  
  const recentCandles = candles.slice(-10);
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);
  
  const currentHigh = highs[highs.length - 1];
  const currentLow = lows[lows.length - 1];
  const prevHigh = Math.max(...highs.slice(0, -1));
  const prevLow = Math.min(...lows.slice(0, -1));
  
  let bosDetected = false;
  let bosType = null;
  let bosLevel = null;
  
  // Bullish BOS: Current high breaks previous high
  if (currentHigh > prevHigh) {
    bosDetected = true;
    bosType = 'bullish';
    bosLevel = prevHigh;
  }
  
  // Bearish BOS: Current low breaks previous low
  if (currentLow < prevLow) {
    bosDetected = true;
    bosType = 'bearish';
    bosLevel = prevLow;
  }
  
  // Check if this is a new BOS (not detected in previous cycle)
  const isNewBOS = !previousAnalysis || 
                   !previousAnalysis.break_of_structure ||
                   previousAnalysis.break_of_structure.level !== bosLevel;
  
  return {
    detected: bosDetected,
    type: bosType,
    level: bosLevel,
    is_new: isNewBOS,
    timestamp: candles[candles.length - 1].timestamp,
    confirmation: bosDetected ? 'trend_continuation' : null
  };
}

/**
 * 5. Detect Change of Character (CHoCH)
 * CHoCH = Price breaks structure in opposite direction
 * Signals potential trend reversal
 */
function detectChangeOfCharacter(candles, previousAnalysis) {
  if (candles.length < 15) return null;
  
  const recentCandles = candles.slice(-15);
  
  // Identify recent trend
  const closes = recentCandles.map(c => c.close);
  const firstClose = closes[0];
  const lastClose = closes[closes.length - 1];
  const trendDirection = lastClose > firstClose ? 'bullish' : 'bearish';
  
  // Look for structure break in opposite direction
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);
  
  const recentHigh = Math.max(...highs.slice(-5));
  const prevHigh = Math.max(...highs.slice(0, -5));
  const recentLow = Math.min(...lows.slice(-5));
  const prevLow = Math.min(...lows.slice(0, -5));
  
  let chochDetected = false;
  let chochType = null;
  let chochLevel = null;
  
  // Bearish CHoCH in bullish trend: Recent low breaks previous low
  if (trendDirection === 'bullish' && recentLow < prevLow) {
    chochDetected = true;
    chochType = 'bearish';
    chochLevel = prevLow;
  }
  
  // Bullish CHoCH in bearish trend: Recent high breaks previous high
  if (trendDirection === 'bearish' && recentHigh > prevHigh) {
    chochDetected = true;
    chochType = 'bullish';
    chochLevel = prevHigh;
  }
  
  // Check if this is a new CHoCH
  const isNewCHoCH = !previousAnalysis || 
                     !previousAnalysis.change_of_character ||
                     previousAnalysis.change_of_character.level !== chochLevel;
  
  return {
    detected: chochDetected,
    type: chochType,
    level: chochLevel,
    is_new: isNewCHoCH,
    previous_trend: trendDirection,
    timestamp: candles[candles.length - 1].timestamp,
    confirmation: chochDetected ? 'potential_reversal' : null
  };
}

/**
 * 6. Identify Mitigation Blocks
 * Mitigation = Retest of order block before continuation
 * High probability entry zone
 */
function identifyMitigationBlocks(candles, orderBlocks, spotPrice) {
  if (!orderBlocks.blocks || orderBlocks.blocks.length === 0) {
    return {
      blocks: [],
      active_mitigation: null,
      pending_mitigation: []
    };
  }
  
  const mitigationBlocks = [];
  
  orderBlocks.blocks.forEach(ob => {
    // Check if price has returned to this order block
    const priceInZone = spotPrice >= ob.zone_low && spotPrice <= ob.zone_high;
    const priceNearZone = Math.abs(spotPrice - ((ob.zone_high + ob.zone_low) / 2)) < 20;
    
    if (priceInZone || priceNearZone) {
      mitigationBlocks.push({
        type: ob.type,
        zone_high: ob.zone_high,
        zone_low: ob.zone_low,
        status: priceInZone ? 'active' : 'pending',
        distance_from_spot: Math.abs(((ob.zone_high + ob.zone_low) / 2) - spotPrice),
        strength: ob.strength,
        expected_reaction: ob.type === 'bullish' ? 'bounce_up' : 'rejection_down'
      });
    }
  });
  
  return {
    blocks: mitigationBlocks,
    active_mitigation: mitigationBlocks.find(m => m.status === 'active') || null,
    pending_mitigation: mitigationBlocks.filter(m => m.status === 'pending')
  };
}

/**
 * 7. Detect Inducement (Fake Moves)
 * Inducement = Fake breakout to trap retail before reversal
 * Smart money uses this to enter opposite direction
 */
function detectInducement(candles, liquidityZones, spotPrice) {
  if (candles.length < 10 || !liquidityZones.zones) {
    return {
      detected: false,
      type: null,
      level: null
    };
  }
  
  const recentCandles = candles.slice(-10);
  const recentSwept = liquidityZones.recently_swept || [];
  
  // Check if price recently swept liquidity and reversed
  for (const swept of recentSwept) {
    const sweptRecently = recentCandles.some(c => 
      (swept.type === 'sell_side' && c.high > swept.level) ||
      (swept.type === 'buy_side' && c.low < swept.level)
    );
    
    if (sweptRecently) {
      // Check for reversal
      const lastCandle = recentCandles[recentCandles.length - 1];
      const reversalDetected = 
        (swept.type === 'sell_side' && lastCandle.close < swept.level) ||
        (swept.type === 'buy_side' && lastCandle.close > swept.level);
      
      if (reversalDetected) {
        return {
          detected: true,
          type: swept.type === 'sell_side' ? 'bearish_inducement' : 'bullish_inducement',
          level: swept.level,
          swept_level: swept.level,
          reversal_confirmed: true,
          expected_direction: swept.type === 'sell_side' ? 'down' : 'up'
        };
      }
    }
  }
  
  return {
    detected: false,
    type: null,
    level: null
  };
}

/**
 * 8. Analyze Market Structure
 * Overall trend based on BOS and CHoCH
 */
function analyzeMarketStructure(candles, breakOfStructure, changeOfCharacter) {
  let structure = 'ranging';
  let trend = 'neutral';
  let strength = 5;
  
  // BOS confirms trend
  if (breakOfStructure && breakOfStructure.detected) {
    structure = 'trending';
    trend = breakOfStructure.type;
    strength = 8;
  }
  
  // CHoCH signals reversal
  if (changeOfCharacter && changeOfCharacter.detected) {
    structure = 'reversing';
    trend = changeOfCharacter.type;
    strength = 7;
  }
  
  // Both detected = conflicting signals
  if (breakOfStructure && breakOfStructure.detected && 
      changeOfCharacter && changeOfCharacter.detected) {
    structure = 'conflicting';
    trend = 'neutral';
    strength = 3;
  }
  
  return {
    structure,
    trend,
    strength,
    confidence: strength >= 7 ? 'high' : strength >= 5 ? 'medium' : 'low'
  };
}

/**
 * Calculate SMC Score (0-100)
 */
function calculateSMCScore(orderBlocks, fairValueGaps, liquidityZones, breakOfStructure, changeOfCharacter, marketStructure) {
  let score = 50; // Start neutral
  
  // 1. Order Blocks (25 points)
  if (orderBlocks.inside_block) {
    score += 25; // Inside order block = high probability zone
  } else if (orderBlocks.nearest_block && orderBlocks.nearest_block.distance_pct < 0.2) {
    score += 15; // Near order block
  }
  
  // 2. Fair Value Gaps (20 points)
  if (fairValueGaps.filling_gap) {
    score += 20; // Filling FVG = high probability
  } else if (fairValueGaps.nearest_gap && fairValueGaps.nearest_gap.distance_pct < 0.3) {
    score += 10; // Near FVG
  }
  
  // 3. Market Structure (25 points)
  if (marketStructure.structure === 'trending') {
    score += 25; // Clear trend
  } else if (marketStructure.structure === 'reversing') {
    score += 20; // Reversal setup
  } else if (marketStructure.structure === 'conflicting') {
    score -= 15; // Conflicting signals
  }
  
  // 4. Break of Structure (15 points)
  if (breakOfStructure && breakOfStructure.detected && breakOfStructure.is_new) {
    score += 15; // New BOS = strong signal
  }
  
  // 5. Change of Character (15 points)
  if (changeOfCharacter && changeOfCharacter.detected && changeOfCharacter.is_new) {
    score += 15; // New CHoCH = reversal signal
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine SMC Bias (bullish/bearish/neutral)
 */
function determineSMCBias(marketStructure, orderBlocks, fairValueGaps) {
  let bullishSignals = 0;
  let bearishSignals = 0;
  
  // Market structure
  if (marketStructure.trend === 'bullish') bullishSignals += 3;
  if (marketStructure.trend === 'bearish') bearishSignals += 3;
  
  // Order blocks
  if (orderBlocks.inside_block) {
    if (orderBlocks.inside_block.type === 'bullish') bullishSignals += 2;
    if (orderBlocks.inside_block.type === 'bearish') bearishSignals += 2;
  }
  
  // Fair value gaps
  if (fairValueGaps.filling_gap) {
    if (fairValueGaps.filling_gap.type === 'bullish') bullishSignals += 2;
    if (fairValueGaps.filling_gap.type === 'bearish') bearishSignals += 2;
  }
  
  if (bullishSignals > bearishSignals + 2) return 'bullish';
  if (bearishSignals > bullishSignals + 2) return 'bearish';
  return 'neutral';
}

/**
 * Get trading implications
 */
function getTradingImplication(marketStructure, orderBlocks, fairValueGaps, spotPrice) {
  if (marketStructure.structure === 'conflicting') {
    return 'Conflicting SMC signals - wait for clarity';
  }
  
  if (orderBlocks.inside_block) {
    const ob = orderBlocks.inside_block;
    if (ob.type === 'bullish') {
      return `Inside bullish order block (${ob.zone_low}-${ob.zone_high}) - expect bounce up`;
    } else {
      return `Inside bearish order block (${ob.zone_low}-${ob.zone_high}) - expect rejection down`;
    }
  }
  
  if (fairValueGaps.filling_gap) {
    const fvg = fairValueGaps.filling_gap;
    if (fvg.type === 'bullish') {
      return `Filling bullish FVG (${fvg.gap_low}-${fvg.gap_high}) - expect continuation up after fill`;
    } else {
      return `Filling bearish FVG (${fvg.gap_low}-${fvg.gap_high}) - expect continuation down after fill`;
    }
  }
  
  if (marketStructure.structure === 'trending') {
    return `Clear ${marketStructure.trend} trend - trade with structure`;
  }
  
  if (marketStructure.structure === 'reversing') {
    return `Potential ${marketStructure.trend} reversal - wait for confirmation`;
  }
  
  return 'No clear SMC setup - wait for better opportunity';
}

/**
 * Calculate SMC score for master algorithm (0-100)
 */
function calculateSMCScoreForMaster(smcData, direction) {
  if (!smcData) return 50; // Neutral
  
  let score = smcData.smc_score; // Start with base score
  
  // 1. Bias alignment (25 points)
  if (direction === 'bullish' && smcData.smc_bias === 'bullish') {
    score += 25;
  } else if (direction === 'bearish' && smcData.smc_bias === 'bearish') {
    score += 25;
  } else if (direction === 'bullish' && smcData.smc_bias === 'bearish') {
    score -= 20;
  } else if (direction === 'bearish' && smcData.smc_bias === 'bullish') {
    score -= 20;
  }
  
  // 2. Market structure alignment (15 points)
  if (smcData.market_structure.structure === 'trending' && 
      smcData.market_structure.trend === direction) {
    score += 15;
  } else if (smcData.market_structure.structure === 'conflicting') {
    score -= 15;
  }
  
  // 3. Order block proximity (10 points)
  if (smcData.order_blocks.inside_block && 
      smcData.order_blocks.inside_block.type === direction) {
    score += 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeSmartMoneyConcepts,
  calculateSMCScoreForMaster
};
