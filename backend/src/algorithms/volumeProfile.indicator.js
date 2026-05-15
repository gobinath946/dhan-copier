/**
 * Volume Profile Analysis
 * 
 * Purpose: Identify support/resistance levels based on volume distribution
 * Key Concepts:
 *   - Point of Control (POC): Price level with highest volume
 *   - Value Area: Price range containing 70% of volume
 *   - High Volume Nodes (HVN): Strong support/resistance
 *   - Low Volume Nodes (LVN): Weak areas, price moves through quickly
 */

const logger = require('../utils/logger');

/**
 * Calculate Volume Profile from candles
 * @param {Array} candles - Array of candle objects with {high, low, close, volume, ...}
 * @param {number} priceBuckets - Number of price levels to analyze (default: 50)
 * @returns {Object} Volume profile analysis
 */
function calculateVolumeProfile(candles, priceBuckets = 50) {
  if (!candles || candles.length < 10) {
    logger.warn({
      candleCount: candles?.length || 0,
      required: 10
    }, '[volumeProfile] Insufficient candles for volume profile');
    return null;
  }

  try {
    // Find price range
    const prices = candles.map(c => c.close || c.c);
    const volumes = candles.map(c => c.volume || c.v || 0);
    const highs = candles.map(c => c.high || c.h);
    const lows = candles.map(c => c.low || c.l);
    
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);
    const priceRange = maxPrice - minPrice;
    const bucketSize = priceRange / priceBuckets;
    
    // Initialize volume buckets
    const volumeBuckets = new Array(priceBuckets).fill(0);
    
    // Distribute volume across price levels
    candles.forEach(candle => {
      const high = candle.high || candle.h;
      const low = candle.low || candle.l;
      const volume = candle.volume || candle.v || 0;
      
      // Distribute volume evenly across the candle's price range
      const candleRange = high - low;
      if (candleRange === 0) {
        // Single price point
        const bucketIndex = Math.floor((low - minPrice) / bucketSize);
        if (bucketIndex >= 0 && bucketIndex < priceBuckets) {
          volumeBuckets[bucketIndex] += volume;
        }
      } else {
        // Distribute across range
        const startBucket = Math.floor((low - minPrice) / bucketSize);
        const endBucket = Math.floor((high - minPrice) / bucketSize);
        const bucketsInRange = endBucket - startBucket + 1;
        const volumePerBucket = volume / bucketsInRange;
        
        for (let i = startBucket; i <= endBucket && i < priceBuckets; i++) {
          if (i >= 0) {
            volumeBuckets[i] += volumePerBucket;
          }
        }
      }
    });
    
    // Find Point of Control (POC) - highest volume price level
    let pocIndex = 0;
    let maxVolume = 0;
    volumeBuckets.forEach((vol, idx) => {
      if (vol > maxVolume) {
        maxVolume = vol;
        pocIndex = idx;
      }
    });
    
    const pocPrice = minPrice + (pocIndex * bucketSize) + (bucketSize / 2);
    
    // Calculate total volume
    const totalVolume = volumeBuckets.reduce((sum, vol) => sum + vol, 0);
    
    // Find Value Area (70% of volume around POC)
    const targetVolume = totalVolume * 0.70;
    let valueAreaVolume = volumeBuckets[pocIndex];
    let vaLowIndex = pocIndex;
    let vaHighIndex = pocIndex;
    
    while (valueAreaVolume < targetVolume && (vaLowIndex > 0 || vaHighIndex < priceBuckets - 1)) {
      const lowVol = vaLowIndex > 0 ? volumeBuckets[vaLowIndex - 1] : 0;
      const highVol = vaHighIndex < priceBuckets - 1 ? volumeBuckets[vaHighIndex + 1] : 0;
      
      if (lowVol > highVol) {
        vaLowIndex--;
        valueAreaVolume += lowVol;
      } else {
        vaHighIndex++;
        valueAreaVolume += highVol;
      }
    }
    
    const vaLow = minPrice + (vaLowIndex * bucketSize);
    const vaHigh = minPrice + ((vaHighIndex + 1) * bucketSize);
    
    // Identify High Volume Nodes (HVN) - support/resistance
    const avgVolume = totalVolume / priceBuckets;
    const hvnThreshold = avgVolume * 1.5; // 150% of average
    const lvnThreshold = avgVolume * 0.5; // 50% of average
    
    const highVolumeNodes = [];
    const lowVolumeNodes = [];
    
    volumeBuckets.forEach((vol, idx) => {
      const price = minPrice + (idx * bucketSize) + (bucketSize / 2);
      if (vol > hvnThreshold) {
        highVolumeNodes.push({ price: Number(price.toFixed(2)), volume: vol });
      } else if (vol < lvnThreshold && vol > 0) {
        lowVolumeNodes.push({ price: Number(price.toFixed(2)), volume: vol });
      }
    });
    
    // Current price position
    const currentPrice = prices[prices.length - 1];
    const priceVsPOC = currentPrice > pocPrice ? 'above' : currentPrice < pocPrice ? 'below' : 'at';
    const priceVsVA = currentPrice > vaHigh ? 'above_va' : 
                      currentPrice < vaLow ? 'below_va' : 'inside_va';
    
    // Find nearest HVN (support/resistance)
    let nearestSupport = null;
    let nearestResistance = null;
    
    highVolumeNodes.forEach(node => {
      if (node.price < currentPrice) {
        if (!nearestSupport || node.price > nearestSupport.price) {
          nearestSupport = node;
        }
      } else if (node.price > currentPrice) {
        if (!nearestResistance || node.price < nearestResistance.price) {
          nearestResistance = node;
        }
      }
    });
    
    const result = {
      poc_price: Number(pocPrice.toFixed(2)),
      poc_volume: Number(maxVolume.toFixed(0)),
      value_area_high: Number(vaHigh.toFixed(2)),
      value_area_low: Number(vaLow.toFixed(2)),
      current_price: Number(currentPrice.toFixed(2)),
      price_vs_poc: priceVsPOC,
      price_vs_va: priceVsVA,
      high_volume_nodes: highVolumeNodes.slice(0, 5), // Top 5 HVNs
      low_volume_nodes: lowVolumeNodes.slice(0, 3), // Top 3 LVNs
      nearest_support: nearestSupport,
      nearest_resistance: nearestResistance,
      total_volume: Number(totalVolume.toFixed(0)),
      avg_volume_per_level: Number(avgVolume.toFixed(0)),
      confidence: calculateConfidence(priceVsVA, highVolumeNodes.length),
    };

    logger.info({
      pocPrice: result.poc_price,
      currentPrice: result.current_price,
      priceVsPOC: result.price_vs_poc,
      priceVsVA: result.price_vs_va,
      hvnCount: highVolumeNodes.length
    }, '[volumeProfile] Volume profile calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[volumeProfile] Error calculating volume profile');
    return null;
  }
}

/**
 * Calculate confidence based on volume profile position
 * @param {string} priceVsVA - Price position vs value area
 * @param {number} hvnCount - Number of high volume nodes
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(priceVsVA, hvnCount) {
  let confidence = 50;
  
  // Price outside value area is significant
  if (priceVsVA === 'above_va' || priceVsVA === 'below_va') {
    confidence = 75;
  }
  
  // More HVNs = better defined levels
  if (hvnCount >= 5) confidence += 15;
  else if (hvnCount >= 3) confidence += 10;
  else if (hvnCount >= 1) confidence += 5;
  
  return Math.min(100, confidence);
}

/**
 * Analyze volume profile for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} Volume profile analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const candles5m = aggregator?.payload?.candles?.['5m'] || [];
    const candles15m = aggregator?.payload?.candles?.['15m'] || [];
    
    const vp5m = calculateVolumeProfile(candles5m, 50);
    const vp15m = calculateVolumeProfile(candles15m, 50);

    if (!vp5m && !vp15m) {
      return {
        volume_profile_score: 50,
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    const primaryVP = vp15m || vp5m;
    const currentPrice = primaryVP.current_price;
    
    // Calculate score based on position
    let score = 50;
    
    if (primaryVP.price_vs_va === 'below_va') {
      score = 70; // Below value area - bullish setup (mean reversion)
    } else if (primaryVP.price_vs_va === 'above_va') {
      score = 30; // Above value area - bearish setup (mean reversion)
    } else if (primaryVP.price_vs_poc === 'below') {
      score = 55; // Below POC - slight bullish bias
    } else if (primaryVP.price_vs_poc === 'above') {
      score = 45; // Above POC - slight bearish bias
    }
    
    // Adjust for support/resistance proximity
    if (primaryVP.nearest_support) {
      const distanceToSupport = ((currentPrice - primaryVP.nearest_support.price) / currentPrice) * 100;
      if (distanceToSupport < 0.5) score += 10; // Very close to support
    }
    
    if (primaryVP.nearest_resistance) {
      const distanceToResistance = ((primaryVP.nearest_resistance.price - currentPrice) / currentPrice) * 100;
      if (distanceToResistance < 0.5) score -= 10; // Very close to resistance
    }
    
    score = Math.max(0, Math.min(100, score));

    const result = {
      volume_profile_score: Number(score.toFixed(1)),
      signal: primaryVP.price_vs_va === 'below_va' ? 'buy' :
              primaryVP.price_vs_va === 'above_va' ? 'sell' : 'wait',
      confidence: primaryVP.confidence,
      vp_5m: vp5m,
      vp_15m: vp15m,
      poc_price: primaryVP.poc_price,
      value_area_high: primaryVP.value_area_high,
      value_area_low: primaryVP.value_area_low,
      price_position: primaryVP.price_vs_va,
      nearest_support: primaryVP.nearest_support,
      nearest_resistance: primaryVP.nearest_resistance,
      trading_implication: getTradingImplication(primaryVP),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[volumeProfile] Error in analyze');
    return {
      volume_profile_score: 50,
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on volume profile
 * @param {Object} vp - Volume profile data
 * @returns {string} Trading implication
 */
function getTradingImplication(vp) {
  if (!vp) return 'Insufficient data for volume profile analysis';

  if (vp.price_vs_va === 'below_va') {
    return `Price below value area (${vp.value_area_low}) - strong support zone, excellent mean reversion setup for CE`;
  }

  if (vp.price_vs_va === 'above_va') {
    return `Price above value area (${vp.value_area_high}) - strong resistance zone, excellent mean reversion setup for PE`;
  }

  if (vp.nearest_support && vp.nearest_resistance) {
    const distToSupport = vp.current_price - vp.nearest_support.price;
    const distToResistance = vp.nearest_resistance.price - vp.current_price;
    
    if (distToSupport < distToResistance) {
      return `Price near support at ${vp.nearest_support.price} (HVN) - bounce likely, favor CE entries`;
    } else {
      return `Price near resistance at ${vp.nearest_resistance.price} (HVN) - rejection likely, favor PE entries`;
    }
  }

  if (vp.price_vs_poc === 'below') {
    return `Price below POC (${vp.poc_price}) - below fair value, slight bullish bias`;
  }

  if (vp.price_vs_poc === 'above') {
    return `Price above POC (${vp.poc_price}) - above fair value, slight bearish bias`;
  }

  return 'Price inside value area - balanced market, wait for clearer signal';
}

module.exports = {
  calculateVolumeProfile,
  analyze,
  name: 'Volume Profile',
  description: 'Support/resistance from volume distribution',
};
