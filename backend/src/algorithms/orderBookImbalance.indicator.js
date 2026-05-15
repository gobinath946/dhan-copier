/**
 * Order Book Imbalance Detection
 * 
 * Purpose: Detect institutional flow and order book pressure
 * Key Concepts:
 *   - Bid/Ask Imbalance: Ratio of buy vs sell pressure
 *   - Order Flow Toxicity: Aggressive vs passive orders
 *   - Institutional Footprint: Large order detection
 *   - Liquidity Imbalance: Supply/demand mismatch
 */

const logger = require('../utils/logger');

/**
 * Calculate Order Book Imbalance from option chain
 * @param {Object} optionChain - Option chain data with strikes
 * @param {number} spotPrice - Current spot price
 * @param {number} atmStrike - ATM strike price
 * @returns {Object} Order book imbalance analysis
 */
function calculateOrderBookImbalance(optionChain, spotPrice, atmStrike) {
  if (!optionChain || !optionChain.strikes || optionChain.strikes.length === 0) {
    logger.warn('[orderBookImbalance] No option chain data available');
    return null;
  }

  try {
    // Focus on ATM ± 3 strikes for order book analysis
    const focusStrikes = optionChain.strikes.filter(s => {
      return Math.abs(s.strike - atmStrike) <= 150; // ±3 strikes (50 point intervals)
    });

    if (focusStrikes.length === 0) {
      return null;
    }

    // Calculate bid/ask imbalance for calls and puts
    let totalCallBidQty = 0;
    let totalCallAskQty = 0;
    let totalPutBidQty = 0;
    let totalPutAskQty = 0;
    let totalCallVolume = 0;
    let totalPutVolume = 0;
    let totalCallOI = 0;
    let totalPutOI = 0;
    let totalCallOIChange = 0;
    let totalPutOIChange = 0;

    focusStrikes.forEach(strike => {
      // Call side
      if (strike.call) {
        const callBid = strike.call.bid || 0;
        const callAsk = strike.call.ask || 0;
        const callBidQty = strike.call.bidQty || strike.call.bid_qty || 0;
        const callAskQty = strike.call.askQty || strike.call.ask_qty || 0;
        
        totalCallBidQty += callBidQty;
        totalCallAskQty += callAskQty;
        totalCallVolume += strike.call.volume || 0;
        totalCallOI += strike.call.oi || 0;
        totalCallOIChange += strike.call.oiChange || strike.call.oi_change || 0;
      }

      // Put side
      if (strike.put) {
        const putBid = strike.put.bid || 0;
        const putAsk = strike.put.ask || 0;
        const putBidQty = strike.put.bidQty || strike.put.bid_qty || 0;
        const putAskQty = strike.put.askQty || strike.put.ask_qty || 0;
        
        totalPutBidQty += putBidQty;
        totalPutAskQty += putAskQty;
        totalPutVolume += strike.put.volume || 0;
        totalPutOI += strike.put.oi || 0;
        totalPutOIChange += strike.put.oiChange || strike.put.oi_change || 0;
      }
    });

    // Calculate imbalance ratios
    const callBidAskRatio = totalCallAskQty > 0 ? totalCallBidQty / totalCallAskQty : 0;
    const putBidAskRatio = totalPutAskQty > 0 ? totalPutBidQty / totalPutAskQty : 0;
    
    // Overall market imbalance (calls vs puts)
    const totalBuyPressure = totalCallBidQty + totalPutAskQty; // Buying calls or selling puts
    const totalSellPressure = totalCallAskQty + totalPutBidQty; // Selling calls or buying puts
    const marketImbalance = totalSellPressure > 0 ? totalBuyPressure / totalSellPressure : 0;
    
    // Volume imbalance
    const volumeImbalance = totalPutVolume > 0 ? totalCallVolume / totalPutVolume : 0;
    
    // OI imbalance
    const oiImbalance = totalPutOI > 0 ? totalCallOI / totalPutOI : 0;
    
    // OI change imbalance (institutional flow)
    const oiChangeImbalance = totalPutOIChange !== 0 ? totalCallOIChange / Math.abs(totalPutOIChange) : 0;
    
    // Determine signal
    let signal = 'neutral';
    let strength = 'weak';
    
    // Market imbalance interpretation
    if (marketImbalance > 1.3) {
      signal = 'bullish';
      strength = marketImbalance > 1.5 ? 'strong' : 'moderate';
    } else if (marketImbalance < 0.7) {
      signal = 'bearish';
      strength = marketImbalance < 0.5 ? 'strong' : 'moderate';
    }
    
    // Institutional flow (OI change)
    let institutionalFlow = 'neutral';
    if (totalCallOIChange > totalPutOIChange * 1.5) {
      institutionalFlow = 'bullish'; // Institutions buying calls
    } else if (totalPutOIChange > totalCallOIChange * 1.5) {
      institutionalFlow = 'bearish'; // Institutions buying puts
    }
    
    // Order flow toxicity (aggressive vs passive)
    // High volume with low OI change = retail (toxic)
    // High OI change with moderate volume = institutional (healthy)
    const callToxicity = totalCallVolume > 0 ? totalCallOIChange / totalCallVolume : 0;
    const putToxicity = totalPutVolume > 0 ? totalPutOIChange / totalPutVolume : 0;
    
    let flowQuality = 'healthy';
    if (Math.abs(callToxicity) < 0.3 && Math.abs(putToxicity) < 0.3) {
      flowQuality = 'toxic'; // High volume, low OI change = day traders
    } else if (Math.abs(callToxicity) > 0.7 || Math.abs(putToxicity) > 0.7) {
      flowQuality = 'institutional'; // High OI change = smart money
    }
    
    const result = {
      market_imbalance: Number(marketImbalance.toFixed(2)),
      signal,
      strength,
      institutional_flow: institutionalFlow,
      flow_quality: flowQuality,
      call_bid_ask_ratio: Number(callBidAskRatio.toFixed(2)),
      put_bid_ask_ratio: Number(putBidAskRatio.toFixed(2)),
      volume_imbalance: Number(volumeImbalance.toFixed(2)),
      oi_imbalance: Number(oiImbalance.toFixed(2)),
      oi_change_imbalance: Number(oiChangeImbalance.toFixed(2)),
      total_call_oi_change: totalCallOIChange,
      total_put_oi_change: totalPutOIChange,
      call_toxicity: Number(callToxicity.toFixed(2)),
      put_toxicity: Number(putToxicity.toFixed(2)),
      confidence: calculateConfidence(marketImbalance, flowQuality, strength),
    };

    logger.info({
      marketImbalance: result.market_imbalance,
      signal: result.signal,
      institutionalFlow: result.institutional_flow,
      flowQuality: result.flow_quality
    }, '[orderBookImbalance] Order book imbalance calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[orderBookImbalance] Error calculating order book imbalance');
    return null;
  }
}

/**
 * Calculate confidence based on imbalance and flow quality
 * @param {number} imbalance - Market imbalance ratio
 * @param {string} flowQuality - Flow quality (toxic/healthy/institutional)
 * @param {string} strength - Signal strength
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(imbalance, flowQuality, strength) {
  let confidence = 50;
  
  // Strong imbalance increases confidence
  if (imbalance > 1.5 || imbalance < 0.5) {
    confidence = 80;
  } else if (imbalance > 1.3 || imbalance < 0.7) {
    confidence = 70;
  }
  
  // Institutional flow increases confidence
  if (flowQuality === 'institutional') {
    confidence += 15;
  } else if (flowQuality === 'toxic') {
    confidence -= 10;
  }
  
  // Strength adjustment
  if (strength === 'strong') {
    confidence += 10;
  }
  
  return Math.min(100, Math.max(0, confidence));
}

/**
 * Analyze order book imbalance for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} Order book imbalance analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const optionChain = aggregator?.payload?.options_chain || aggregator?.optionChain;
    const spotPrice = aggregator?.payload?.spot_data?.ltp || aggregator?.payload?.actual_spot_price;
    const atmStrike = aggregator?.atmStrike || aggregator?.payload?.actual_atm_strike;

    if (!optionChain || !spotPrice || !atmStrike) {
      return {
        order_book_score: 50,
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    const imbalance = calculateOrderBookImbalance(optionChain, spotPrice, atmStrike);

    if (!imbalance) {
      return {
        order_book_score: 50,
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    // Calculate score
    let score = 50;
    
    if (imbalance.signal === 'bullish') {
      score = imbalance.strength === 'strong' ? 75 : 65;
    } else if (imbalance.signal === 'bearish') {
      score = imbalance.strength === 'strong' ? 25 : 35;
    }
    
    // Adjust for institutional flow
    if (imbalance.institutional_flow === 'bullish') {
      score += 10;
    } else if (imbalance.institutional_flow === 'bearish') {
      score -= 10;
    }
    
    // Adjust for flow quality
    if (imbalance.flow_quality === 'institutional') {
      score += 5;
    } else if (imbalance.flow_quality === 'toxic') {
      score -= 5;
    }
    
    score = Math.max(0, Math.min(100, score));

    const result = {
      order_book_score: Number(score.toFixed(1)),
      signal: imbalance.signal === 'bullish' ? 'buy' :
              imbalance.signal === 'bearish' ? 'sell' : 'wait',
      confidence: imbalance.confidence,
      market_imbalance: imbalance.market_imbalance,
      institutional_flow: imbalance.institutional_flow,
      flow_quality: imbalance.flow_quality,
      oi_change_imbalance: imbalance.oi_change_imbalance,
      trading_implication: getTradingImplication(imbalance),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[orderBookImbalance] Error in analyze');
    return {
      order_book_score: 50,
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on order book imbalance
 * @param {Object} imbalance - Order book imbalance data
 * @returns {string} Trading implication
 */
function getTradingImplication(imbalance) {
  if (!imbalance) return 'Insufficient data for order book analysis';

  if (imbalance.flow_quality === 'institutional' && imbalance.institutional_flow === 'bullish') {
    return `Strong institutional buying detected (OI change: ${imbalance.total_call_oi_change}) - smart money accumulating calls, excellent CE setup`;
  }

  if (imbalance.flow_quality === 'institutional' && imbalance.institutional_flow === 'bearish') {
    return `Strong institutional selling detected (OI change: ${imbalance.total_put_oi_change}) - smart money accumulating puts, excellent PE setup`;
  }

  if (imbalance.flow_quality === 'toxic') {
    return `Toxic order flow detected - high retail activity, low institutional participation, avoid trading`;
  }

  if (imbalance.signal === 'bullish' && imbalance.strength === 'strong') {
    return `Strong buy pressure (imbalance: ${imbalance.market_imbalance}) - demand exceeding supply, favor CE entries`;
  }

  if (imbalance.signal === 'bearish' && imbalance.strength === 'strong') {
    return `Strong sell pressure (imbalance: ${imbalance.market_imbalance}) - supply exceeding demand, favor PE entries`;
  }

  if (imbalance.signal === 'bullish') {
    return `Moderate buy pressure - slight bullish bias, consider CE entries`;
  }

  if (imbalance.signal === 'bearish') {
    return `Moderate sell pressure - slight bearish bias, consider PE entries`;
  }

  return 'Order book balanced - no clear directional bias, wait for imbalance';
}

module.exports = {
  calculateOrderBookImbalance,
  analyze,
  name: 'Order Book Imbalance',
  description: 'Institutional flow and order book pressure detection',
};
