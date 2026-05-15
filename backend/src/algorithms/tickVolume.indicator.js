/**
 * Tick Volume Analysis
 * 
 * Purpose: Analyze volume momentum and confirm price movements
 * Key Concepts:
 *   - Volume Momentum: Rate of volume change
 *   - Volume Confirmation: Volume supporting price direction
 *   - Volume Divergence: Volume contradicting price
 *   - Volume Spikes: Unusual activity indicating breakouts
 */

const logger = require('../utils/logger');

/**
 * Calculate Tick Volume Analysis from candles
 * @param {Array} candles - Array of candle objects with {close, volume, ...}
 * @param {number} period - Period for volume average (default: 20)
 * @returns {Object} Tick volume analysis
 */
function calculateTickVolume(candles, period = 20) {
  if (!candles || candles.length < period) {
    logger.warn({
      candleCount: candles?.length || 0,
      required: period
    }, '[tickVolume] Insufficient candles for tick volume analysis');
    return null;
  }

  try {
    const volumes = candles.map(c => c.volume || c.v || 0);
    const closes = candles.map(c => c.close || c.c);
    
    // Calculate average volume
    const recentVolumes = volumes.slice(-period);
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / period;
    
    // Current volume
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    
    // Volume trend (last 5 candles)
    const last5Volumes = volumes.slice(-5);
    const volumeTrend = last5Volumes[4] > last5Volumes[0] ? 'increasing' : 
                        last5Volumes[4] < last5Volumes[0] ? 'decreasing' : 'stable';
    
    // Volume momentum (rate of change)
    const volumeChange = volumes.length >= 2 ? 
      ((volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2]) * 100 : 0;
    
    // Price direction
    const priceChange = closes.length >= 2 ?
      closes[closes.length - 1] - closes[closes.length - 2] : 0;
    const priceDirection = priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'flat';
    
    // Volume confirmation (volume supporting price direction)
    let volumeConfirmation = 'neutral';
    if (priceDirection === 'up' && volumeTrend === 'increasing') {
      volumeConfirmation = 'confirmed'; // Bullish with volume
    } else if (priceDirection === 'down' && volumeTrend === 'increasing') {
      volumeConfirmation = 'confirmed'; // Bearish with volume
    } else if (priceDirection === 'up' && volumeTrend === 'decreasing') {
      volumeConfirmation = 'divergence'; // Bullish without volume (weak)
    } else if (priceDirection === 'down' && volumeTrend === 'decreasing') {
      volumeConfirmation = 'divergence'; // Bearish without volume (weak)
    }
    
    // Volume spike detection
    let volumeSpike = 'normal';
    if (volumeRatio > 2.0) {
      volumeSpike = 'extreme'; // 200%+ of average
    } else if (volumeRatio > 1.5) {
      volumeSpike = 'high'; // 150%+ of average
    } else if (volumeRatio < 0.5) {
      volumeSpike = 'low'; // 50% of average
    }
    
    // On-Balance Volume (OBV) - cumulative volume based on price direction
    let obv = 0;
    for (let i = 1; i < candles.length; i++) {
      const prevClose = candles[i - 1].close || candles[i - 1].c;
      const currClose = candles[i].close || candles[i].c;
      const currVolume = candles[i].volume || candles[i].v || 0;
      
      if (currClose > prevClose) {
        obv += currVolume;
      } else if (currClose < prevClose) {
        obv -= currVolume;
      }
    }
    
    // OBV trend
    const obvTrend = obv > 0 ? 'bullish' : obv < 0 ? 'bearish' : 'neutral';
    
    // Volume-weighted price momentum
    let volumeWeightedMomentum = 0;
    for (let i = candles.length - 5; i < candles.length; i++) {
      if (i > 0) {
        const priceChg = (candles[i].close || candles[i].c) - (candles[i - 1].close || candles[i - 1].c);
        const vol = candles[i].volume || candles[i].v || 0;
        volumeWeightedMomentum += priceChg * vol;
      }
    }
    
    const momentumDirection = volumeWeightedMomentum > 0 ? 'bullish' : 
                              volumeWeightedMomentum < 0 ? 'bearish' : 'neutral';
    
    // Determine signal
    let signal = 'neutral';
    let strength = 'weak';
    
    if (volumeConfirmation === 'confirmed' && priceDirection === 'up') {
      signal = 'bullish';
      strength = volumeSpike === 'high' || volumeSpike === 'extreme' ? 'strong' : 'moderate';
    } else if (volumeConfirmation === 'confirmed' && priceDirection === 'down') {
      signal = 'bearish';
      strength = volumeSpike === 'high' || volumeSpike === 'extreme' ? 'strong' : 'moderate';
    } else if (volumeConfirmation === 'divergence') {
      signal = 'weak_' + priceDirection;
      strength = 'weak';
    }
    
    const result = {
      current_volume: Number(currentVolume.toFixed(0)),
      avg_volume: Number(avgVolume.toFixed(0)),
      volume_ratio: Number(volumeRatio.toFixed(2)),
      volume_trend: volumeTrend,
      volume_change_pct: Number(volumeChange.toFixed(2)),
      volume_spike: volumeSpike,
      volume_confirmation: volumeConfirmation,
      price_direction: priceDirection,
      obv: Number(obv.toFixed(0)),
      obv_trend: obvTrend,
      volume_weighted_momentum: Number(volumeWeightedMomentum.toFixed(2)),
      momentum_direction: momentumDirection,
      signal,
      strength,
      confidence: calculateConfidence(volumeConfirmation, volumeSpike, strength),
    };

    logger.info({
      volumeRatio: result.volume_ratio,
      volumeSpike: result.volume_spike,
      volumeConfirmation: result.volume_confirmation,
      signal: result.signal
    }, '[tickVolume] Tick volume calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[tickVolume] Error calculating tick volume');
    return null;
  }
}

/**
 * Calculate confidence based on volume confirmation and spike
 * @param {string} confirmation - Volume confirmation status
 * @param {string} spike - Volume spike level
 * @param {string} strength - Signal strength
 * @returns {number} Confidence 0-100
 */
function calculateConfidence(confirmation, spike, strength) {
  let confidence = 50;
  
  // Confirmed volume increases confidence
  if (confirmation === 'confirmed') {
    confidence = 75;
  } else if (confirmation === 'divergence') {
    confidence = 35; // Low confidence on divergence
  }
  
  // Volume spikes increase confidence
  if (spike === 'extreme') {
    confidence += 20;
  } else if (spike === 'high') {
    confidence += 10;
  } else if (spike === 'low') {
    confidence -= 10;
  }
  
  // Strength adjustment
  if (strength === 'strong') {
    confidence += 5;
  }
  
  return Math.min(100, Math.max(0, confidence));
}

/**
 * Analyze tick volume for trading decisions
 * @param {Object} aggregator - Market data aggregator
 * @param {Object} settings - Algorithm settings
 * @returns {Object} Tick volume analysis with trading signals
 */
async function analyze(aggregator, settings) {
  try {
    const candles1m = aggregator?.payload?.candles?.['1m'] || [];
    const candles5m = aggregator?.payload?.candles?.['5m'] || [];
    
    const tv1m = calculateTickVolume(candles1m, 20);
    const tv5m = calculateTickVolume(candles5m, 20);

    if (!tv1m && !tv5m) {
      return {
        tick_volume_score: 50,
        signal: 'wait',
        confidence: 0,
        insufficient_data: true,
      };
    }

    const primaryTV = tv5m || tv1m;
    const confirmTV = tv1m;
    
    // Calculate score
    let score = 50;
    
    if (primaryTV.signal === 'bullish') {
      score = primaryTV.strength === 'strong' ? 75 : 65;
    } else if (primaryTV.signal === 'bearish') {
      score = primaryTV.strength === 'strong' ? 25 : 35;
    } else if (primaryTV.signal === 'weak_up') {
      score = 55; // Weak bullish
    } else if (primaryTV.signal === 'weak_down') {
      score = 45; // Weak bearish
    }
    
    // Adjust for OBV trend
    if (primaryTV.obv_trend === 'bullish') {
      score += 5;
    } else if (primaryTV.obv_trend === 'bearish') {
      score -= 5;
    }
    
    // Adjust for volume spike
    if (primaryTV.volume_spike === 'extreme') {
      score += primaryTV.price_direction === 'up' ? 10 : -10;
    } else if (primaryTV.volume_spike === 'high') {
      score += primaryTV.price_direction === 'up' ? 5 : -5;
    }
    
    // Confirmation from 1m
    if (confirmTV && confirmTV.volume_confirmation === primaryTV.volume_confirmation) {
      score += primaryTV.volume_confirmation === 'confirmed' ? 5 : 0;
    }
    
    score = Math.max(0, Math.min(100, score));

    const result = {
      tick_volume_score: Number(score.toFixed(1)),
      signal: primaryTV.signal === 'bullish' ? 'buy' :
              primaryTV.signal === 'bearish' ? 'sell' : 'wait',
      confidence: primaryTV.confidence,
      tv_1m: tv1m,
      tv_5m: tv5m,
      volume_ratio: primaryTV.volume_ratio,
      volume_spike: primaryTV.volume_spike,
      volume_confirmation: primaryTV.volume_confirmation,
      obv_trend: primaryTV.obv_trend,
      momentum_direction: primaryTV.momentum_direction,
      trading_implication: getTradingImplication(primaryTV, confirmTV),
    };

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[tickVolume] Error in analyze');
    return {
      tick_volume_score: 50,
      signal: 'wait',
      confidence: 0,
      error: error.message,
    };
  }
}

/**
 * Get trading implication based on tick volume
 * @param {Object} primaryTV - Primary tick volume data
 * @param {Object} confirmTV - Confirmation tick volume data
 * @returns {string} Trading implication
 */
function getTradingImplication(primaryTV, confirmTV) {
  if (!primaryTV) return 'Insufficient data for tick volume analysis';

  if (primaryTV.volume_spike === 'extreme' && primaryTV.volume_confirmation === 'confirmed') {
    if (primaryTV.price_direction === 'up') {
      return `Extreme volume spike (${primaryTV.volume_ratio}x avg) with bullish confirmation - strong breakout, excellent CE entry`;
    } else {
      return `Extreme volume spike (${primaryTV.volume_ratio}x avg) with bearish confirmation - strong breakdown, excellent PE entry`;
    }
  }

  if (primaryTV.volume_confirmation === 'divergence') {
    if (primaryTV.price_direction === 'up') {
      return `Bullish price move without volume support - weak rally, likely to fail, avoid CE entries`;
    } else {
      return `Bearish price move without volume support - weak selloff, likely to reverse, avoid PE entries`;
    }
  }

  if (primaryTV.volume_confirmation === 'confirmed' && primaryTV.signal === 'bullish') {
    if (confirmTV && confirmTV.volume_confirmation === 'confirmed') {
      return `Strong volume confirmation on multiple timeframes - sustained bullish momentum, excellent CE setup`;
    }
    return `Volume confirming bullish move - good momentum for CE entries`;
  }

  if (primaryTV.volume_confirmation === 'confirmed' && primaryTV.signal === 'bearish') {
    if (confirmTV && confirmTV.volume_confirmation === 'confirmed') {
      return `Strong volume confirmation on multiple timeframes - sustained bearish momentum, excellent PE setup`;
    }
    return `Volume confirming bearish move - good momentum for PE entries`;
  }

  if (primaryTV.obv_trend === 'bullish') {
    return `OBV showing bullish accumulation - smart money buying, favor CE entries`;
  }

  if (primaryTV.obv_trend === 'bearish') {
    return `OBV showing bearish distribution - smart money selling, favor PE entries`;
  }

  return 'Volume neutral - no clear momentum confirmation, wait for volume spike';
}

module.exports = {
  calculateTickVolume,
  analyze,
  name: 'Tick Volume Analysis',
  description: 'Volume momentum and confirmation indicator',
};
