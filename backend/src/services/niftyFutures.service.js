/**
 * NIFTY Futures Service
 * Fetches and analyzes NIFTY Futures data for better market direction confirmation
 * 
 * Benefits of using Futures data:
 * 1. Leading indicator - Futures often move before spot
 * 2. Better volume - More institutional participation
 * 3. Trend confirmation - Validates spot movement
 * 4. Premium/Discount analysis - Market sentiment indicator
 */

const axios = require('axios');
const logger = require('../utils/logger');

const NIFTY_FUTURES_SECURITY_ID = 66071; // NIFTY Futures current month
const DHAN_TICKS_URL = 'https://ticks.dhan.co/getData';

// Cache for futures data
let futuresCache = {
  data: null,
  timestamp: 0,
  ttl: 60000, // 1 minute cache
};

/**
 * Fetch NIFTY Futures data from Dhan Ticks API
 * @param {string} interval - '1' (1min), '5' (5min), '15' (15min), etc.
 * @param {number} lookback - Number of candles to fetch (default: 100)
 * @returns {Object} Futures data
 */
async function fetchFuturesData(interval = '5', lookback = 100) {
  try {
    // Check cache
    const now = Date.now();
    if (futuresCache.data && (now - futuresCache.timestamp) < futuresCache.ttl) {
      logger.debug('[niftyFutures] Using cached data');
      return { ok: true, data: futuresCache.data };
    }
    
    // Calculate time range
    const endTime = Math.floor(now / 1000);
    const startTime = endTime - (lookback * parseInt(interval) * 60);
    
    const payload = {
      EXCH: 'NSE',
      SEG: 'D', // Derivatives
      INST: 'FUTIDX', // Futures Index
      SEC_ID: NIFTY_FUTURES_SECURITY_ID,
      START: startTime,
      END: endTime,
      INTERVAL: interval,
    };
    
    logger.debug({ payload }, '[niftyFutures] Fetching futures data');
    
    const response = await axios.post(DHAN_TICKS_URL, payload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.data || !response.data.success) {
      throw new Error('Invalid response from Dhan Ticks API');
    }
    
    const futuresData = parseFuturesData(response.data.data);
    
    // Update cache
    futuresCache = {
      data: futuresData,
      timestamp: now,
      ttl: 60000,
    };
    
    logger.info({ 
      candles: futuresData.candles.length,
      lastPrice: futuresData.lastPrice 
    }, '[niftyFutures] Futures data fetched successfully');
    
    return { ok: true, data: futuresData };
  } catch (error) {
    logger.error({ error: error.message }, '[niftyFutures] Failed to fetch futures data');
    return { ok: false, error: error.message };
  }
}

/**
 * Parse raw futures data from Dhan API
 * @param {Object} rawData - Raw data from API
 * @returns {Object} Parsed futures data
 */
function parseFuturesData(rawData) {
  const candles = [];
  
  if (!rawData || !rawData.Time || !rawData.c) {
    return { candles: [], lastPrice: 0 };
  }
  
  const times = rawData.Time;
  const closes = rawData.c;
  const opens = rawData.o || [];
  const highs = rawData.h || [];
  const lows = rawData.l || [];
  const volumes = rawData.v || [];
  const ois = rawData.oi || [];
  
  for (let i = 0; i < times.length; i++) {
    candles.push({
      time: times[i] * 1000, // Convert to milliseconds
      open: opens[i] || closes[i],
      high: highs[i] || closes[i],
      low: lows[i] || closes[i],
      close: closes[i],
      volume: volumes[i] || 0,
      oi: ois[i] || 0,
    });
  }
  
  const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
  
  return {
    candles,
    lastPrice,
    totalCandles: candles.length,
  };
}

/**
 * Analyze futures data for market direction
 * @param {Object} futuresData - Parsed futures data
 * @param {number} spotPrice - Current NIFTY spot price
 * @returns {Object} Analysis result
 */
function analyzeFuturesDirection(futuresData, spotPrice) {
  try {
    if (!futuresData || !futuresData.candles || futuresData.candles.length < 10) {
      return {
        direction: 'neutral',
        confidence: 0,
        premium: 0,
        trend: 'unknown',
        strength: 0,
      };
    }
    
    const candles = futuresData.candles;
    const lastCandle = candles[candles.length - 1];
    const futuresPrice = lastCandle.close;
    
    // 1. Premium/Discount analysis
    const premium = futuresPrice - spotPrice;
    const premiumPct = (premium / spotPrice) * 100;
    
    // Premium > 0 = Bullish sentiment (futures trading at premium)
    // Premium < 0 = Bearish sentiment (futures trading at discount)
    
    // 2. Trend analysis (last 10 candles)
    const last10 = candles.slice(-10);
    const ema5 = calculateEMA(last10.map(c => c.close), 5);
    const ema10 = calculateEMA(last10.map(c => c.close), 10);
    
    let trend = 'neutral';
    let trendStrength = 0;
    
    if (ema5 > ema10) {
      trend = 'bullish';
      trendStrength = ((ema5 - ema10) / ema10) * 100;
    } else if (ema5 < ema10) {
      trend = 'bearish';
      trendStrength = ((ema10 - ema5) / ema10) * 100;
    }
    
    // 3. Volume analysis
    const avgVolume = last10.reduce((sum, c) => sum + c.volume, 0) / last10.length;
    const currentVolume = lastCandle.volume;
    const volumeSpike = currentVolume > avgVolume * 1.5;
    
    // 4. OI analysis
    const oiChange = candles.length >= 2 
      ? ((lastCandle.oi - candles[candles.length - 2].oi) / candles[candles.length - 2].oi) * 100
      : 0;
    
    // 5. Determine direction and confidence
    let direction = 'neutral';
    let confidence = 0;
    
    // Bullish signals
    if (premium > 0 && trend === 'bullish' && oiChange > 0) {
      direction = 'bullish';
      confidence = Math.min(10, 5 + (premiumPct * 10) + (trendStrength * 2) + (volumeSpike ? 2 : 0));
    }
    // Bearish signals
    else if (premium < 0 && trend === 'bearish' && oiChange > 0) {
      direction = 'bearish';
      confidence = Math.min(10, 5 + (Math.abs(premiumPct) * 10) + (trendStrength * 2) + (volumeSpike ? 2 : 0));
    }
    // Weak signals
    else if (trend !== 'neutral') {
      direction = trend;
      confidence = Math.min(6, 3 + (trendStrength * 2));
    }
    
    return {
      direction, // 'bullish', 'bearish', 'neutral'
      confidence: Number(confidence.toFixed(1)), // 0-10
      premium: Number(premium.toFixed(2)),
      premiumPct: Number(premiumPct.toFixed(3)),
      trend,
      trendStrength: Number(trendStrength.toFixed(2)),
      volumeSpike,
      oiChange: Number(oiChange.toFixed(2)),
      futuresPrice,
      spotPrice,
      ema5: Number(ema5.toFixed(2)),
      ema10: Number(ema10.toFixed(2)),
    };
  } catch (error) {
    logger.error({ error: error.message }, '[niftyFutures] Analysis failed');
    return {
      direction: 'neutral',
      confidence: 0,
      premium: 0,
      trend: 'unknown',
      strength: 0,
    };
  }
}

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {Array} prices - Array of prices
 * @param {number} period - EMA period
 * @returns {number} EMA value
 */
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Get futures confirmation for trade entry
 * @param {string} spotDirection - 'bullish' or 'bearish' from spot analysis
 * @param {number} spotPrice - Current NIFTY spot price
 * @returns {Object} Confirmation result
 */
async function getFuturesConfirmation(spotDirection, spotPrice) {
  try {
    // Fetch futures data
    const futuresResult = await fetchFuturesData('5', 50);
    
    if (!futuresResult.ok) {
      return {
        confirmed: false,
        confidence: 0,
        reason: 'Futures data unavailable',
      };
    }
    
    // Analyze futures direction
    const analysis = analyzeFuturesDirection(futuresResult.data, spotPrice);
    
    // Check if futures confirm spot direction
    const confirmed = analysis.direction === spotDirection && analysis.confidence >= 5;
    
    return {
      confirmed,
      confidence: analysis.confidence,
      futuresDirection: analysis.direction,
      spotDirection,
      premium: analysis.premium,
      premiumPct: analysis.premiumPct,
      trend: analysis.trend,
      trendStrength: analysis.trendStrength,
      reason: confirmed 
        ? `Futures confirm ${spotDirection} (confidence: ${analysis.confidence}/10)`
        : `Futures divergence: Futures ${analysis.direction} vs Spot ${spotDirection}`,
    };
  } catch (error) {
    logger.error({ error: error.message }, '[niftyFutures] Confirmation failed');
    return {
      confirmed: false,
      confidence: 0,
      reason: 'Futures confirmation error',
    };
  }
}

module.exports = {
  fetchFuturesData,
  analyzeFuturesDirection,
  getFuturesConfirmation,
};
