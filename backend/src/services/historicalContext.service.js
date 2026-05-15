/**
 * Historical Context Service
 * ===========================
 * Loads and analyzes historical market data from live-feed storage
 * to provide swing highs/lows, support/resistance, and trend context
 * for better AI decision-making.
 * 
 * PROVIDES:
 * - Previous day's high/low/close
 * - Last 5 days' swing levels
 * - Opening range (first 15min of today)
 * - Key support/resistance from historical data
 * - Futures premium/discount trends
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const LIVE_FEED_DIR = path.join(__dirname, '../../live-feed');

/**
 * Get list of available historical dates (sorted newest first)
 */
async function getAvailableDates() {
  try {
    const entries = await fs.readdir(LIVE_FEED_DIR, { withFileTypes: true });
    const dates = entries
      .filter(e => e.isDirectory() && e.name.match(/^\d{4}-\d{2}-\d{2}_NIFTY_50$/))
      .map(e => e.name.split('_')[0])
      .sort()
      .reverse();
    return dates;
  } catch (err) {
    logger.error({ err: err.message }, '[historicalContext] Failed to read live-feed directory');
    return [];
  }
}

/**
 * Load metadata for a specific date
 */
async function loadMetadata(date) {
  try {
    const metaPath = path.join(LIVE_FEED_DIR, `${date}_NIFTY_50`, 'metadata.json');
    const content = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    logger.warn({ date, err: err.message }, '[historicalContext] Failed to load metadata');
    return null;
  }
}

/**
 * Load candles from a specific date and timeframe
 * @param {string} date - YYYY-MM-DD
 * @param {string} timeframe - '1m', '5m', '15m'
 * @param {number} limit - max candles to load (default 100)
 */
async function loadCandles(date, timeframe, limit = 100) {
  try {
    const candlePath = path.join(LIVE_FEED_DIR, `${date}_NIFTY_50`, `candles-${timeframe}.jsonl`);
    const content = await fs.readFile(candlePath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    const candles = lines.slice(-limit).map(line => JSON.parse(line));
    return candles;
  } catch (err) {
    logger.warn({ date, timeframe, err: err.message }, '[historicalContext] Failed to load candles');
    return [];
  }
}

/**
 * Load futures data from a specific date and timeframe
 */
async function loadFutures(date, timeframe, limit = 100) {
  try {
    const futuresPath = path.join(LIVE_FEED_DIR, `${date}_NIFTY_50`, `futures-${timeframe}.jsonl`);
    const content = await fs.readFile(futuresPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    const futures = lines.slice(-limit).map(line => JSON.parse(line));
    return futures;
  } catch (err) {
    logger.warn({ date, timeframe, err: err.message }, '[historicalContext] Failed to load futures');
    return [];
  }
}

/**
 * Calculate swing highs and lows from candle data
 */
function calculateSwingLevels(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return { swingHighs: [], swingLows: [] };

  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];
    
    // Check if it's a swing high (higher than surrounding candles)
    let isSwingHigh = true;
    let isSwingLow = true;
    
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= current.h) isSwingHigh = false;
      if (candles[j].l <= current.l) isSwingLow = false;
    }
    
    if (isSwingHigh) {
      swingHighs.push({ price: current.h, time: current.t, type: 'swing_high' });
    }
    if (isSwingLow) {
      swingLows.push({ price: current.l, time: current.t, type: 'swing_low' });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * Get comprehensive historical context for AI decision-making
 * @param {string} currentDate - YYYY-MM-DD (today)
 * @returns {Object} Historical context with previous days' data
 */
async function getHistoricalContext(currentDate) {
  try {
    const dates = await getAvailableDates();
    if (dates.length === 0) {
      logger.warn('[historicalContext] No historical data available');
      return { available: false };
    }

    // Get today's metadata (for opening range)
    const todayMeta = await loadMetadata(currentDate);
    const todayCandles15m = await loadCandles(currentDate, '15m', 200);
    const todayCandles5m = await loadCandles(currentDate, '5m', 200);
    const todayFutures15m = await loadFutures(currentDate, '15m', 200);

    // Get previous trading days (up to 5 days)
    const previousDates = dates.filter(d => d < currentDate).slice(0, 5);
    const previousDaysData = [];

    for (const date of previousDates) {
      const meta = await loadMetadata(date);
      const candles15m = await loadCandles(date, '15m', 200);
      const candles5m = await loadCandles(date, '5m', 200);
      
      if (candles15m.length > 0) {
        const dayHigh = Math.max(...candles15m.map(c => c.h));
        const dayLow = Math.min(...candles15m.map(c => c.l));
        const dayClose = candles15m[candles15m.length - 1].c;
        const dayOpen = candles15m[0].o;
        const dayVolume = candles15m.reduce((sum, c) => sum + (c.v || 0), 0);

        const swingLevels = calculateSwingLevels(candles15m, 10);

        previousDaysData.push({
          date,
          open: dayOpen,
          high: dayHigh,
          low: dayLow,
          close: dayClose,
          volume: dayVolume,
          range: dayHigh - dayLow,
          swingHighs: swingLevels.swingHighs.slice(-3), // Last 3 swing highs
          swingLows: swingLevels.swingLows.slice(-3),   // Last 3 swing lows
        });
      }
    }

    // Calculate opening range (first 15 minutes of today)
    let openingRange = null;
    if (todayCandles15m.length > 0) {
      const firstCandle = todayCandles15m[0];
      openingRange = {
        high: firstCandle.h,
        low: firstCandle.l,
        open: firstCandle.o,
        close: firstCandle.c,
        range: firstCandle.h - firstCandle.l,
      };
    }

    // Get yesterday's key levels
    const yesterday = previousDaysData[0] || null;

    // Calculate support/resistance from previous days
    const allSwingHighs = previousDaysData.flatMap(d => d.swingHighs.map(s => s.price));
    const allSwingLows = previousDaysData.flatMap(d => d.swingLows.map(s => s.price));
    
    // Cluster nearby levels (within 20 points)
    const resistanceLevels = clusterLevels(allSwingHighs, 20).slice(0, 5);
    const supportLevels = clusterLevels(allSwingLows, 20).slice(0, 5);

    // Analyze futures premium/discount trend
    let futuresPremiumTrend = 'neutral';
    if (todayFutures15m.length > 5) {
      const recentPremiums = todayFutures15m.slice(-5).map(f => f.premium || 0);
      const avgPremium = recentPremiums.reduce((a, b) => a + b, 0) / recentPremiums.length;
      futuresPremiumTrend = avgPremium > 20 ? 'strong_premium' : avgPremium > 10 ? 'premium' : avgPremium < -10 ? 'discount' : 'neutral';
    }

    const context = {
      available: true,
      current_date: currentDate,
      opening_range: openingRange,
      yesterday: yesterday ? {
        date: yesterday.date,
        high: yesterday.high,
        low: yesterday.low,
        close: yesterday.close,
        range: yesterday.range,
        key_swing_highs: yesterday.swingHighs,
        key_swing_lows: yesterday.swingLows,
      } : null,
      previous_5_days: previousDaysData.map(d => ({
        date: d.date,
        high: d.high,
        low: d.low,
        close: d.close,
        range: d.range,
      })),
      key_resistance_levels: resistanceLevels,
      key_support_levels: supportLevels,
      futures_premium_trend: futuresPremiumTrend,
      weekly_high: previousDaysData.length > 0 ? Math.max(...previousDaysData.map(d => d.high)) : null,
      weekly_low: previousDaysData.length > 0 ? Math.min(...previousDaysData.map(d => d.low)) : null,
    };

    logger.info({
      currentDate,
      previousDays: previousDaysData.length,
      resistanceLevels: resistanceLevels.length,
      supportLevels: supportLevels.length,
    }, '[historicalContext] Historical context loaded');

    return context;

  } catch (err) {
    logger.error({ err: err.message }, '[historicalContext] Failed to build historical context');
    return { available: false, error: err.message };
  }
}

/**
 * Cluster nearby price levels (within threshold points)
 * Returns array of clustered levels sorted by frequency
 */
function clusterLevels(levels, threshold = 20) {
  if (!levels || levels.length === 0) return [];

  const clusters = [];
  const sorted = [...levels].sort((a, b) => a - b);

  let currentCluster = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - currentCluster[0] <= threshold) {
      currentCluster.push(sorted[i]);
    } else {
      // Save current cluster
      const avg = currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length;
      clusters.push({ level: Math.round(avg), count: currentCluster.length });
      currentCluster = [sorted[i]];
    }
  }
  
  // Save last cluster
  if (currentCluster.length > 0) {
    const avg = currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length;
    clusters.push({ level: Math.round(avg), count: currentCluster.length });
  }

  // Sort by count (most touched levels first)
  return clusters.sort((a, b) => b.count - a.count);
}

/**
 * Get current day's intraday levels (for real-time analysis)
 * @param {string} currentDate - YYYY-MM-DD
 * @returns {Object} Today's high, low, VWAP, pivot levels
 */
async function getIntradayLevels(currentDate) {
  try {
    const candles5m = await loadCandles(currentDate, '5m', 200);
    if (candles5m.length === 0) return null;

    const dayHigh = Math.max(...candles5m.map(c => c.h));
    const dayLow = Math.min(...candles5m.map(c => c.l));
    const dayOpen = candles5m[0].o;
    const currentClose = candles5m[candles5m.length - 1].c;

    // Calculate VWAP from candles
    let sumPV = 0;
    let sumV = 0;
    for (const candle of candles5m) {
      const typical = (candle.h + candle.l + candle.c) / 3;
      sumPV += typical * (candle.v || 0);
      sumV += (candle.v || 0);
    }
    const vwap = sumV > 0 ? sumPV / sumV : currentClose;

    // Calculate pivot levels
    const pivot = (dayHigh + dayLow + currentClose) / 3;
    const r1 = 2 * pivot - dayLow;
    const s1 = 2 * pivot - dayHigh;
    const r2 = pivot + (dayHigh - dayLow);
    const s2 = pivot - (dayHigh - dayLow);

    return {
      day_high: dayHigh,
      day_low: dayLow,
      day_open: dayOpen,
      current_close: currentClose,
      vwap: vwap,
      pivot: pivot,
      resistance_1: r1,
      resistance_2: r2,
      support_1: s1,
      support_2: s2,
    };
  } catch (err) {
    logger.error({ err: err.message }, '[historicalContext] Failed to get intraday levels');
    return null;
  }
}

module.exports = {
  getHistoricalContext,
  getIntradayLevels,
  loadCandles,
  loadFutures,
  calculateSwingLevels,
};
