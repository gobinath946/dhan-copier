/**
 * Professional NIFTY 50 Scalping Indicators
 * 
 * Core Setup:
 * - 9 EMA + 20 EMA (momentum)
 * - VWAP (institutional bias)
 * - Supertrend (trend confirmation)
 * - ATR (volatility detection)
 * - RSI (divergence + timing)
 * - ADX (trend strength filter)
 * 
 * Priority: HIGH - Used for trend detection and holding decisions
 *
 * HybridEngine: removed per Req 3.11 — overfitted thresholds replaced with
 * `Algo_Settings.signalEngine.*` reads. ADX read-only access is preserved
 * (the Hybrid_Engine `regimeEngine.adapter.js` consumes ADX from this
 * service, so the ADX numerical surface remains untouched and only its
 * threshold value is sourced from `signalEngine` when available).
 */

const logger = require('../../utils/logger');

// HybridEngine: removed per Req 3.11 — Algo_Settings is the single source of
// truth for thresholds. We `require` lazily inside the helper to avoid a
// circular dependency at module load.
function _readSignalSetting(key, fallback) {
  try {
    // eslint-disable-next-line global-require
    const algoSettings = require('../../config/algoSettings');
    const settings = typeof algoSettings.get === 'function' ? algoSettings.get() : null;
    const signalEngine = settings && settings.signalEngine ? settings.signalEngine : null;
    if (!signalEngine) return fallback;
    const v = signalEngine[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  } catch (_err) {
    return fallback;
  }
}

// Configuration
//
// HybridEngine: removed per Req 3.11 — overfitted threshold literals replaced
// with `Algo_Settings.signalEngine.*` reads via `_readSignalSetting`. ADX
// thresholds (`strongTrend` / `weakTrend`) preserve read-only access — they
// are sourced from `signalEngine.minADX` when available, otherwise the
// historical 25 / 20 floors are kept as fallbacks. Volume / RSI / ATR
// numeric literals are now sourced from the corresponding signalEngine keys
// where they exist, with safe fallbacks when the operator has not configured
// the optional key yet.
const SCALPING_CONFIG = {
  ema: {
    // HybridEngine: removed per Req 3.11 — threshold sourced from Algo_Settings.
    fast: _readSignalSetting('emaFast', 9),
    // HybridEngine: removed per Req 3.11 — threshold sourced from Algo_Settings.
    slow: _readSignalSetting('emaSlow', 20)
  },
  rsi: {
    period: 14,
    // HybridEngine: removed per Req 3.11 — threshold sourced from Algo_Settings.
    overbought: _readSignalSetting('rsiOverbought', 70),
    // HybridEngine: removed per Req 3.11 — threshold sourced from Algo_Settings.
    oversold: _readSignalSetting('rsiOversold', 30)
  },
  atr: {
    period: 14,
    // HybridEngine: removed per Req 3.11 — threshold sourced from Algo_Settings.
    lowThreshold: _readSignalSetting('atrLowThreshold', 20),    // Low volatility threshold
    // HybridEngine: removed per Req 3.11 — threshold sourced from Algo_Settings.
    highThreshold: _readSignalSetting('atrHighThreshold', 50)   // High volatility threshold
  },
  supertrend: {
    atrPeriod: 10,
    multiplier: 3
  },
  adx: {
    period: 14,
    // HybridEngine: ADX read-only access preserved per Req 3.11 — threshold
    // routed through Algo_Settings.signalEngine.minADX when configured;
    // otherwise the historical 25 floor stays as a fallback.
    strongTrend: _readSignalSetting('minADX', 25),     // ADX > 25 = strong trend
    // HybridEngine: ADX read-only access preserved per Req 3.11 — threshold
    // routed through Algo_Settings.signalEngine.minADXWeak when configured.
    weakTrend: _readSignalSetting('minADXWeak', 20)    // ADX < 20 = avoid
  }
};

/**
 * Analyze professional scalping indicators
 * @param {Array} candles - OHLCV candles (1m, 5m, or 15m)
 * @param {number} spotPrice - Current spot price
 * @param {Object} vwapData - VWAP data from spot_data
 * @param {string} timeframe - Timeframe (1m, 5m, 15m)
 * @returns {Object} - Complete scalping analysis
 */
function analyzeScalpingIndicators(candles, spotPrice, vwapData, timeframe = '5m') {
  if (!candles || candles.length < 30) {
    return {
      signal: 'insufficient_data',
      confidence: 0,
      reason: 'Not enough candles for analysis'
    };
  }

  try {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume || 0);

    // 1. Calculate EMAs (9 and 20)
    const ema9 = calculateEMA(closes, SCALPING_CONFIG.ema.fast);
    const ema20 = calculateEMA(closes, SCALPING_CONFIG.ema.slow);
    const currentEMA9 = ema9[ema9.length - 1];
    const currentEMA20 = ema20[ema20.length - 1];

    // 2. VWAP Analysis
    const vwapAnalysis = analyzeVWAP(spotPrice, vwapData);

    // 3. ATR (Volatility Detection)
    const atrAnalysis = calculateATR(candles, SCALPING_CONFIG.atr.period);

    // 4. RSI (Timing + Divergence)
    const rsiAnalysis = calculateRSI(closes, SCALPING_CONFIG.rsi.period);

    // 5. Supertrend (Trend Confirmation)
    const supertrendAnalysis = calculateSupertrend(
      candles,
      SCALPING_CONFIG.supertrend.atrPeriod,
      SCALPING_CONFIG.supertrend.multiplier
    );

    // 6. ADX (Trend Strength Filter)
    const adxAnalysis = calculateADX(candles, SCALPING_CONFIG.adx.period);

    // 7. Volume Analysis
    const volumeAnalysis = analyzeVolume(volumes);

    // 8. Generate Trading Signals
    const signals = generateScalpingSignals({
      spotPrice,
      ema9: currentEMA9,
      ema20: currentEMA20,
      vwap: vwapAnalysis,
      atr: atrAnalysis,
      rsi: rsiAnalysis,
      supertrend: supertrendAnalysis,
      adx: adxAnalysis,
      volume: volumeAnalysis,
      timeframe
    });

    return {
      timeframe,
      
      // Core Indicators
      ema: {
        fast: Math.round(currentEMA9 * 100) / 100,
        slow: Math.round(currentEMA20 * 100) / 100,
        crossover: currentEMA9 > currentEMA20 ? 'bullish' : 'bearish',
        momentum: currentEMA9 - currentEMA20
      },
      
      vwap: vwapAnalysis,
      atr: atrAnalysis,
      rsi: rsiAnalysis,
      supertrend: supertrendAnalysis,
      adx: adxAnalysis,
      volume: volumeAnalysis,
      
      // Trading Signals
      signal: signals.signal,
      confidence: signals.confidence,
      strength: signals.strength,
      conditions: signals.conditions,
      
      // Entry/Exit Recommendations
      recommendation: signals.recommendation,
      stopLoss: signals.stopLoss,
      target: signals.target,
      
      // Risk Assessment
      risk: signals.risk,
      
      // Metadata
      candle_count: candles.length,
      timestamp: Date.now()
    };

  } catch (error) {
    logger.error({ error: error.message }, '[professionalScalping] Analysis failed');
    return {
      signal: 'error',
      confidence: 0,
      reason: error.message
    };
  }
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  
  return ema;
}

/**
 * Analyze VWAP (Volume Weighted Average Price)
 * MANDATORY: Institutional bias filter
 */
function analyzeVWAP(spotPrice, vwapData) {
  if (!vwapData || !vwapData.vwap) {
    return {
      value: null,
      position: 'unknown',
      bias: 'neutral',
      distance: 0,
      strength: 0
    };
  }

  const vwap = vwapData.vwap;
  const distance = spotPrice - vwap;
  const distancePercent = (distance / vwap) * 100;

  let position = 'at';
  let bias = 'neutral';
  let strength = 0;

  if (spotPrice > vwap) {
    position = 'above';
    bias = 'bullish';
    strength = Math.min(100, Math.abs(distancePercent) * 20); // 0-100 scale
  } else if (spotPrice < vwap) {
    position = 'below';
    bias = 'bearish';
    strength = Math.min(100, Math.abs(distancePercent) * 20);
  }

  return {
    value: Math.round(vwap * 100) / 100,
    position,
    bias,
    distance: Math.round(distance * 100) / 100,
    distancePercent: Math.round(distancePercent * 100) / 100,
    strength: Math.round(strength)
  };
}

/**
 * Calculate ATR (Average True Range)
 * Volatility detector - avoid dead markets, detect breakouts
 */
function calculateATR(candles, period) {
  const trueRanges = [];
  
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    
    trueRanges.push(tr);
  }
  
  const atr = calculateEMA(trueRanges, period);
  const currentATR = atr[atr.length - 1];
  const prevATR = atr[atr.length - 2];
  
  // Determine volatility state
  let state = 'normal';
  let recommendation = 'trade';
  
  if (currentATR < SCALPING_CONFIG.atr.lowThreshold) {
    state = 'low';
    recommendation = 'avoid'; // Dead market
  } else if (currentATR > SCALPING_CONFIG.atr.highThreshold) {
    state = 'high';
    recommendation = 'caution'; // High volatility
  }
  
  const isExpanding = currentATR > prevATR;
  
  return {
    value: Math.round(currentATR * 100) / 100,
    state,
    expanding: isExpanding,
    recommendation,
    change: Math.round((currentATR - prevATR) * 100) / 100
  };
}

/**
 * Calculate RSI (Relative Strength Index)
 * Entry timing + divergence detection
 */
function calculateRSI(closes, period) {
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);
  
  const avgGain = calculateEMA(gains, period);
  const avgLoss = calculateEMA(losses, period);
  
  const rsi = [];
  for (let i = 0; i < avgGain.length; i++) {
    if (avgLoss[i] === 0) {
      rsi.push(100);
    } else {
      const rs = avgGain[i] / avgLoss[i];
      rsi.push(100 - (100 / (1 + rs)));
    }
  }
  
  const currentRSI = rsi[rsi.length - 1];
  
  // Determine RSI state
  let state = 'neutral';
  let signal = 'hold';
  
  if (currentRSI > SCALPING_CONFIG.rsi.overbought) {
    state = 'overbought';
    signal = 'sell';
  } else if (currentRSI < SCALPING_CONFIG.rsi.oversold) {
    state = 'oversold';
    signal = 'buy';
  }
  
  // Detect divergence (simplified)
  const divergence = detectRSIDivergence(closes, rsi);
  
  return {
    value: Math.round(currentRSI * 100) / 100,
    state,
    signal,
    divergence
  };
}

/**
 * Detect RSI Divergence
 */
function detectRSIDivergence(closes, rsi) {
  if (closes.length < 10 || rsi.length < 10) {
    return 'none';
  }
  
  const recentCloses = closes.slice(-10);
  const recentRSI = rsi.slice(-10);
  
  // Bullish divergence: price making lower lows, RSI making higher lows
  const priceLowerLow = recentCloses[recentCloses.length - 1] < recentCloses[0];
  const rsiHigherLow = recentRSI[recentRSI.length - 1] > recentRSI[0];
  
  if (priceLowerLow && rsiHigherLow) {
    return 'bullish';
  }
  
  // Bearish divergence: price making higher highs, RSI making lower highs
  const priceHigherHigh = recentCloses[recentCloses.length - 1] > recentCloses[0];
  const rsiLowerHigh = recentRSI[recentRSI.length - 1] < recentRSI[0];
  
  if (priceHigherHigh && rsiLowerHigh) {
    return 'bearish';
  }
  
  return 'none';
}

/**
 * Calculate Supertrend
 * Trend confirmation + trailing SL
 */
function calculateSupertrend(candles, atrPeriod, multiplier) {
  const atrValues = calculateATR(candles, atrPeriod);
  const supertrend = [];
  const trend = [];
  
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const atr = atrValues[i] || atrValues[atrValues.length - 1] || 0;
    
    const upperBand = hl2 + (multiplier * atr);
    const lowerBand = hl2 - (multiplier * atr);
    
    let st = 0;
    let tr = 0;
    
    if (i === 0) {
      st = lowerBand;
      tr = 1;
    } else {
      const prevST = supertrend[i - 1];
      const prevTrend = trend[i - 1];
      
      if (candles[i].close > prevST) {
        st = lowerBand;
        tr = 1;
      } else if (candles[i].close < prevST) {
        st = upperBand;
        tr = -1;
      } else {
        st = prevST;
        tr = prevTrend;
      }
    }
    
    supertrend.push(st);
    trend.push(tr);
  }
  
  const currentTrend = trend[trend.length - 1];
  const currentST = supertrend[supertrend.length - 1];
  
  return {
    value: Math.round(currentST * 100) / 100,
    trend: currentTrend === 1 ? 'bullish' : 'bearish',
    color: currentTrend === 1 ? 'green' : 'red',
    signal: currentTrend === 1 ? 'buy' : 'sell'
  };
}

/**
 * Calculate ADX (Average Directional Index)
 * Trend strength filter - avoid sideways markets
 */
function calculateADX(candles, period) {
  if (candles.length < period + 1) {
    return {
      value: 0,
      strength: 'unknown',
      recommendation: 'insufficient_data'
    };
  }
  
  const plusDM = [];
  const minusDM = [];
  const tr = [];
  
  for (let i = 1; i < candles.length; i++) {
    const highDiff = candles[i].high - candles[i - 1].high;
    const lowDiff = candles[i - 1].low - candles[i].low;
    
    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    tr.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));
  }
  
  const smoothPlusDM = calculateEMA(plusDM, period);
  const smoothMinusDM = calculateEMA(minusDM, period);
  const smoothTR = calculateEMA(tr, period);
  
  const plusDI = smoothPlusDM.map((dm, i) => (dm / smoothTR[i]) * 100);
  const minusDI = smoothMinusDM.map((dm, i) => (dm / smoothTR[i]) * 100);
  
  const dx = plusDI.map((pdi, i) => {
    const sum = pdi + minusDI[i];
    return sum === 0 ? 0 : (Math.abs(pdi - minusDI[i]) / sum) * 100;
  });
  
  const adx = calculateEMA(dx, period);
  const currentADX = adx[adx.length - 1];
  
  // Determine trend strength
  let strength = 'weak';
  let recommendation = 'avoid';
  
  if (currentADX > SCALPING_CONFIG.adx.strongTrend) {
    strength = 'strong';
    recommendation = 'trade';
  } else if (currentADX > SCALPING_CONFIG.adx.weakTrend) {
    strength = 'moderate';
    recommendation = 'caution';
  }
  
  return {
    value: Math.round(currentADX * 100) / 100,
    strength,
    recommendation,
    plusDI: Math.round(plusDI[plusDI.length - 1] * 100) / 100,
    minusDI: Math.round(minusDI[minusDI.length - 1] * 100) / 100
  };
}

/**
 * Analyze Volume
 */
function analyzeVolume(volumes) {
  if (volumes.length < 20) {
    return {
      current: 0,
      average: 0,
      spike: false,
      strength: 0
    };
  }
  
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  
  const ratio = currentVolume / avgVolume;
  const spike = ratio > 1.5; // 50% above average
  const strength = Math.min(100, (ratio - 1) * 100);
  
  return {
    current: Math.round(currentVolume),
    average: Math.round(avgVolume),
    ratio: Math.round(ratio * 100) / 100,
    spike,
    strength: Math.round(strength)
  };
}

/**
 * Generate Scalping Signals
 * Combines all indicators for high-probability setups
 */
function generateScalpingSignals(data) {
  const {
    spotPrice,
    ema9,
    ema20,
    vwap,
    atr,
    rsi,
    supertrend,
    adx,
    volume,
    timeframe
  } = data;
  
  // Initialize scoring
  let bullishScore = 0;
  let bearishScore = 0;
  const conditions = {
    bullish: [],
    bearish: [],
    neutral: []
  };
  
  // 1. EMA Momentum (Weight: 15)
  if (ema9 > ema20) {
    bullishScore += 15;
    conditions.bullish.push('9 EMA > 20 EMA');
  } else if (ema9 < ema20) {
    bearishScore += 15;
    conditions.bearish.push('9 EMA < 20 EMA');
  }
  
  // 2. VWAP Bias (Weight: 20) - MANDATORY FILTER
  if (vwap.position === 'above') {
    bullishScore += 20;
    conditions.bullish.push('Price above VWAP');
  } else if (vwap.position === 'below') {
    bearishScore += 20;
    conditions.bearish.push('Price below VWAP');
  } else {
    conditions.neutral.push('Price at VWAP');
  }
  
  // 3. Supertrend (Weight: 15)
  if (supertrend.trend === 'bullish') {
    bullishScore += 15;
    conditions.bullish.push('Supertrend green');
  } else if (supertrend.trend === 'bearish') {
    bearishScore += 15;
    conditions.bearish.push('Supertrend red');
  }
  
  // 4. ADX Trend Strength (Weight: 15)
  if (adx.strength === 'strong') {
    // Add to whichever direction is winning
    if (bullishScore > bearishScore) {
      bullishScore += 15;
      conditions.bullish.push(`ADX strong (${adx.value})`);
    } else if (bearishScore > bullishScore) {
      bearishScore += 15;
      conditions.bearish.push(`ADX strong (${adx.value})`);
    }
  } else if (adx.strength === 'weak') {
    conditions.neutral.push(`ADX weak (${adx.value}) - avoid`);
  }
  
  // 5. ATR Volatility (Weight: 10)
  if (atr.expanding && atr.state !== 'low') {
    if (bullishScore > bearishScore) {
      bullishScore += 10;
      conditions.bullish.push('ATR expanding');
    } else if (bearishScore > bullishScore) {
      bearishScore += 10;
      conditions.bearish.push('ATR expanding');
    }
  } else if (atr.state === 'low') {
    conditions.neutral.push('ATR low - dead market');
  }
  
  // 6. RSI (Weight: 10)
  if (rsi.divergence === 'bullish') {
    bullishScore += 10;
    conditions.bullish.push('RSI bullish divergence');
  } else if (rsi.divergence === 'bearish') {
    bearishScore += 10;
    conditions.bearish.push('RSI bearish divergence');
  }
  
  if (rsi.state === 'oversold') {
    bullishScore += 5;
    conditions.bullish.push(`RSI oversold (${rsi.value})`);
  } else if (rsi.state === 'overbought') {
    bearishScore += 5;
    conditions.bearish.push(`RSI overbought (${rsi.value})`);
  }
  
  // 7. Volume Spike (Weight: 10)
  if (volume.spike) {
    if (bullishScore > bearishScore) {
      bullishScore += 10;
      conditions.bullish.push('Volume spike');
    } else if (bearishScore > bullishScore) {
      bearishScore += 10;
      conditions.bearish.push('Volume spike');
    }
  }
  
  // Calculate final signal
  const totalScore = bullishScore + bearishScore;
  const confidence = Math.round((Math.max(bullishScore, bearishScore) / 100) * 100);
  
  let signal = 'neutral';
  let strength = 'weak';
  let recommendation = 'hold';
  
  if (bullishScore >= 70 && bullishScore > bearishScore) {
    signal = 'strong_buy';
    strength = 'strong';
    recommendation = 'BUY';
  } else if (bullishScore >= 50 && bullishScore > bearishScore) {
    signal = 'buy';
    strength = 'moderate';
    recommendation = 'BUY';
  } else if (bearishScore >= 70 && bearishScore > bullishScore) {
    signal = 'strong_sell';
    strength = 'strong';
    recommendation = 'SELL';
  } else if (bearishScore >= 50 && bearishScore > bullishScore) {
    signal = 'sell';
    strength = 'moderate';
    recommendation = 'SELL';
  } else {
    signal = 'neutral';
    strength = 'weak';
    recommendation = 'HOLD';
  }
  
  // Risk assessment
  let risk = 'medium';
  if (adx.strength === 'weak' || atr.state === 'low') {
    risk = 'high'; // Choppy/dead market
  } else if (adx.strength === 'strong' && atr.state === 'normal') {
    risk = 'low'; // Trending market
  }
  
  // Stop loss and target (based on ATR and Supertrend)
  const stopLoss = supertrend.value;
  const atrValue = atr.value;
  const target = signal.includes('buy') 
    ? spotPrice + (atrValue * 2) 
    : spotPrice - (atrValue * 2);
  
  return {
    signal,
    confidence,
    strength,
    conditions,
    recommendation,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target: Math.round(target * 100) / 100,
    risk,
    scores: {
      bullish: bullishScore,
      bearish: bearishScore,
      total: totalScore
    }
  };
}

/**
 * Calculate professional scalping score for master algorithm
 * @param {Object} scalpingData - Professional scalping analysis
 * @param {string} direction - Trade direction ('bullish' or 'bearish')
 * @returns {number} - Score (0-100)
 */
function calculateProfessionalScalpingScore(scalpingData, direction) {
  if (!scalpingData || scalpingData.signal === 'insufficient_data') {
    return 50; // Neutral
  }
  
  let score = 50; // Start neutral
  
  // 1. Signal alignment (40 points)
  if (direction === 'bullish') {
    if (scalpingData.signal === 'strong_buy') score += 40;
    else if (scalpingData.signal === 'buy') score += 30;
    else if (scalpingData.signal.includes('sell')) score -= 30;
  } else if (direction === 'bearish') {
    if (scalpingData.signal === 'strong_sell') score += 40;
    else if (scalpingData.signal === 'sell') score += 30;
    else if (scalpingData.signal.includes('buy')) score -= 30;
  }
  
  // 2. Confidence bonus (30 points)
  score += (scalpingData.confidence / 100) * 30;
  
  // 3. Risk penalty (20 points)
  if (scalpingData.risk === 'low') score += 20;
  else if (scalpingData.risk === 'high') score -= 20;
  
  // 4. ADX filter (10 points)
  if (scalpingData.adx && scalpingData.adx.strength === 'strong') {
    score += 10;
  } else if (scalpingData.adx && scalpingData.adx.strength === 'weak') {
    score -= 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeScalpingIndicators,
  calculateProfessionalScalpingScore,
  SCALPING_CONFIG
};
