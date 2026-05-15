/**
 * Dhan Market Data service - fetches historical data from Dhan API
 */
const axios = require('axios');
const logger = require('../utils/logger');
const env = require('../config/env');

// Dhan API configuration from environment
const DHAN_ACCESS_TOKEN = env.dhanAccessToken;
const DHAN_CLIENT_ID = env.dhanClientId;
const DHAN_MODE = env.dhanMode;
const DHAN_API_BASE_URL = DHAN_MODE === 'production' ? env.dhanProdBaseUrl : env.dhanSandboxBaseUrl;

logger.info({ 
  mode: DHAN_MODE, 
  baseUrl: DHAN_API_BASE_URL,
  hasToken: !!DHAN_ACCESS_TOKEN,
  clientId: DHAN_CLIENT_ID 
}, 'Dhan Market Data service initialized');

// Security IDs for indices
const SECURITY_IDS = {
  NIFTY: 13,      // NIFTY 50
  BANKNIFTY: 25,  // BANK NIFTY
  FINNIFTY: 27,   // FIN NIFTY
  MIDCPNIFTY: 28, // MIDCAP NIFTY
};

// Exchange segment
const EXCHANGE_SEGMENT = {
  IDX_I: 'IDX_I', // Index segment
};

/**
 * Convert interval format from Yahoo Finance style to Dhan API style
 * @param {string} interval - 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
 * @returns {object} - { interval: string, isIntraday: boolean }
 */
function convertInterval(interval) {
  const intervalMap = {
    '1m': { interval: '1', isIntraday: true },
    '5m': { interval: '5', isIntraday: true },
    '15m': { interval: '15', isIntraday: true },
    '30m': { interval: '25', isIntraday: true }, // Dhan uses 25 instead of 30
    '1h': { interval: '60', isIntraday: true },
    '1d': { interval: 'D', isIntraday: false },
    '1wk': { interval: 'W', isIntraday: false },
    '1mo': { interval: 'M', isIntraday: false },
  };
  return intervalMap[interval] || { interval: '5', isIntraday: true };
}

/**
 * Get the last valid trading day (excluding weekends)
 * @returns {Date} Last trading day
 */
function getLastTradingDay() {
  // Use actual current date from system
  const d = new Date();
  
  // For testing/debugging: log the current date
  logger.info({ currentDate: d.toISOString() }, 'Current system date');
  
  const day = d.getDay();
  const hour = d.getHours();
  
  // If Sunday (0), go back to Friday
  if (day === 0) {
    d.setDate(d.getDate() - 2);
  }
  // If Saturday (6), go back to Friday
  else if (day === 6) {
    d.setDate(d.getDate() - 1);
  }
  // If before market open (9:15 AM) or very early morning, use previous day
  else if (hour < 9) {
    d.setDate(d.getDate() - 1);
    // Check again for weekend
    const newDay = d.getDay();
    if (newDay === 0) d.setDate(d.getDate() - 2);
    if (newDay === 6) d.setDate(d.getDate() - 1);
  }
  
  logger.info({ tradingDay: d.toISOString() }, 'Calculated trading day');
  
  return d;
}

/**
 * Calculate date range based on range parameter
 * @param {string} range - 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 1w (week)
 * @param {number} endTime - Optional end timestamp
 * @param {boolean} isIntraday - Whether this is intraday data
 * @returns {object} - { fromDate, toDate }
 */
function calculateDateRange(range, endTime = null, isIntraday = true) {
  let toDate;
  
  if (endTime) {
    toDate = new Date(endTime * 1000);
  } else {
    toDate = getLastTradingDay();
  }
  
  // Ensure toDate is a trading day (skip weekends)
  let toDay = toDate.getDay();
  if (toDay === 0) { // Sunday
    toDate.setDate(toDate.getDate() - 2);
  } else if (toDay === 6) { // Saturday
    toDate.setDate(toDate.getDate() - 1);
  }
  
  const rangeToMilliseconds = {
    '1d': 86400000,           // 1 day
    '5d': 86400000 * 5,       // 5 days (1 week of trading days)
    '1w': 86400000 * 7,       // 1 week
    '1mo': 86400000 * 30,
    '3mo': 86400000 * 90,
    '6mo': 86400000 * 180,
    '1y': 86400000 * 365,
    '2y': 86400000 * 730,
    '5y': 86400000 * 1825,
    '10y': 86400000 * 3650,
  };
  
  let rangeMs = rangeToMilliseconds[range] || 86400000 * 7; // Default to 1 week
  
  // For intraday data, we need to handle it differently
  // Instead of limiting to 1 day, we'll load week by week
  if (isIntraday) {
    // For intraday, limit each API call to 1 week (5 trading days)
    // This allows us to load historical data week by week
    if (rangeMs > 86400000 * 7) {
      logger.info({ originalRange: range, limitedTo: '1w' }, 'Limiting intraday range to 1 week per API call');
      rangeMs = 86400000 * 7; // Limit to 1 week per call
    }
  }
  
  const fromDate = new Date(toDate.getTime() - rangeMs);
  
  // Ensure fromDate is also a trading day (skip weekends)
  let fromDay = fromDate.getDay();
  if (fromDay === 0) { // Sunday
    fromDate.setDate(fromDate.getDate() + 1); // Move to Monday
  } else if (fromDay === 6) { // Saturday
    fromDate.setDate(fromDate.getDate() + 2); // Move to Monday
  }
  
  if (isIntraday) {
    // Format: "YYYY-MM-DD HH:MM:SS"
    // Set to market hours (9:15 AM to 3:30 PM IST)
    const formatDateTime = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    };
    
    // Set from date to market open (9:15 AM)
    fromDate.setHours(9, 15, 0, 0);
    
    // Set to date to market close (3:30 PM)
    toDate.setHours(15, 30, 0, 0);
    
    return {
      fromDate: formatDateTime(fromDate),
      toDate: formatDateTime(toDate),
    };
  } else {
    // Format: "YYYY-MM-DD"
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    return {
      fromDate: formatDate(fromDate),
      toDate: formatDate(toDate),
    };
  }
}

/**
 * Fetch historical data from Dhan API with automatic fallback to Yahoo Finance
 * @param {string} securityId - Dhan security ID
 * @param {string} exchangeSegment - Exchange segment (IDX_I for indices)
 * @param {string} interval - 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
 * @param {string} range - 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y
 * @param {number} endTime - Optional: Unix timestamp to fetch data before this time
 */
async function getDhanHistoricalData(securityId, exchangeSegment, interval = '5m', range = '5d', endTime = null) {
  try {
    const { interval: dhanInterval, isIntraday } = convertInterval(interval);
    const { fromDate, toDate } = calculateDateRange(range, endTime, isIntraday);
    
    // Choose endpoint based on interval type
    const endpoint = isIntraday ? '/v2/charts/intraday' : '/v2/charts/historical';
    const url = `${DHAN_API_BASE_URL}${endpoint}`;
    
    const payload = {
      securityId: securityId.toString(),
      exchangeSegment,
      instrument: 'INDEX',
      fromDate,
      toDate,
    };
    
    // Add interval for intraday data
    if (isIntraday) {
      payload.interval = dhanInterval;
    }
    
    // Add expiryCode for derivatives (0 for indices)
    if (!isIntraday) {
      payload.expiryCode = 0;
    }
    
    logger.info({ 
      payload, 
      endpoint, 
      interval: dhanInterval,
      baseUrl: DHAN_API_BASE_URL,
      mode: DHAN_MODE 
    }, 'Fetching Dhan historical data');
    
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'access-token': DHAN_ACCESS_TOKEN,
      },
      timeout: 15000,
    });
    
    logger.info({ 
      status: response.status, 
      dataKeys: Object.keys(response.data),
      hasTimestamp: !!response.data.timestamp,
      timestampLength: response.data.timestamp?.length || 0
    }, 'Dhan API response received');
    
    const data = response.data;
    
    if (!data || !data.timestamp || data.timestamp.length === 0) {
      logger.warn({ response: response.data }, 'No data in Dhan API response');
      throw new Error('No data returned from Dhan API');
    }
    
    // Transform to our format
    const candles = data.timestamp.map((time, index) => ({
      time: typeof time === 'number' ? time : Math.floor(new Date(time).getTime() / 1000), // Convert to Unix timestamp if needed
      open: data.open[index],
      high: data.high[index],
      low: data.low[index],
      close: data.close[index],
      volume: data.volume ? data.volume[index] : 0,
    })).filter(candle => 
      // Filter out null/invalid candles
      candle.open !== null && 
      candle.high !== null && 
      candle.low !== null && 
      candle.close !== null
    );
    
    logger.info({ candleCount: candles.length }, 'Transformed candles from Dhan API');
    
    return {
      ok: true,
      data: {
        symbol: `${securityId}_${exchangeSegment}`,
        interval,
        range,
        candles,
        meta: {
          securityId,
          exchangeSegment,
          instrument: 'INDEX',
          fromDate,
          toDate,
          source: 'dhan',
        },
      },
    };
  } catch (error) {
    logger.error({ 
      error: error.message, 
      response: error.response?.data,
      status: error.response?.status,
      securityId, 
      exchangeSegment, 
      interval, 
      range 
    }, 'Failed to fetch Dhan market data');
    
    return {
      ok: false,
      error: error.response?.data?.errorMessage || error.message || 'Failed to fetch market data from Dhan',
      errorCode: error.response?.data?.errorCode,
    };
  }
}

/**
 * Get NIFTY 50 data from Dhan API
 */
async function getNiftyDataFromDhan(interval = '5m', range = '5d', endTime = null) {
  return getDhanHistoricalData(
    SECURITY_IDS.NIFTY,
    EXCHANGE_SEGMENT.IDX_I,
    interval,
    range,
    endTime
  );
}

/**
 * Get Bank NIFTY data from Dhan API
 */
async function getBankNiftyDataFromDhan(interval = '5m', range = '5d', endTime = null) {
  return getDhanHistoricalData(
    SECURITY_IDS.BANKNIFTY,
    EXCHANGE_SEGMENT.IDX_I,
    interval,
    range,
    endTime
  );
}

/**
 * Get real-time quote for NIFTY
 */
async function getNiftyQuote() {
  try {
    const url = `${DHAN_API_BASE_URL}/v2/marketfeed/ltp`;
    
    const payload = {
      IDX_I: [SECURITY_IDS.NIFTY],
    };
    
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'access-token': DHAN_ACCESS_TOKEN,
      },
      timeout: 10000,
    });
    
    return {
      ok: true,
      data: response.data,
    };
  } catch (error) {
    logger.error({ error: error.message, response: error.response?.data }, 'Failed to fetch NIFTY quote');
    return {
      ok: false,
      error: error.message || 'Failed to fetch quote',
    };
  }
}

module.exports = {
  getDhanHistoricalData,
  getNiftyDataFromDhan,
  getBankNiftyDataFromDhan,
  getNiftyQuote,
  SECURITY_IDS,
  EXCHANGE_SEGMENT,
};
