/**
 * Market Data service - fetches historical data from Dhan API and Yahoo Finance (fallback)
 */
const axios = require('axios');
const logger = require('../utils/logger');
const dhanMarketData = require('./dhanMarketData.service');

/**
 * Fetch historical data from Yahoo Finance (fallback)
 * @param {string} symbol - Yahoo Finance symbol (e.g., ^NSEI for NIFTY 50)
 * @param {string} interval - 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
 * @param {string} range - 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max
 * @param {number} endTime - Optional: Unix timestamp to fetch data before this time
 */
async function getHistoricalDataFromYahoo(symbol, interval = '5m', range = '5d', endTime = null) {
  try {
    // Yahoo Finance API endpoint
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    
    const params = {
      interval,
      range,
    };

    // If endTime is provided, use period1 and period2 instead of range
    if (endTime) {
      // Calculate period1 based on range
      const rangeToSeconds = {
        '1d': 86400,
        '5d': 432000,
        '1mo': 2592000,
        '3mo': 7776000,
        '6mo': 15552000,
        '1y': 31536000,
        '2y': 63072000,
        '5y': 157680000,
        '10y': 315360000,
      };
      
      const rangeSeconds = rangeToSeconds[range] || 432000; // Default to 5 days
      params.period2 = endTime;
      params.period1 = endTime - rangeSeconds;
      delete params.range;
    }

    const response = await axios.get(url, {
      params,
      timeout: 10000,
    });

    const result = response.data.chart.result[0];
    
    if (!result || !result.timestamp) {
      throw new Error('No data returned from Yahoo Finance');
    }

    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    const volumes = quotes.volume || [];

    // Transform to our format
    const candles = timestamps.map((time, index) => ({
      time,
      open: quotes.open[index],
      high: quotes.high[index],
      low: quotes.low[index],
      close: quotes.close[index],
      volume: volumes[index] || 0,
    })).filter(candle => 
      // Filter out null/invalid candles
      candle.open !== null && 
      candle.high !== null && 
      candle.low !== null && 
      candle.close !== null
    );

    return {
      ok: true,
      data: {
        symbol,
        interval,
        range,
        candles,
        meta: {
          currency: result.meta.currency,
          exchangeName: result.meta.exchangeName,
          instrumentType: result.meta.instrumentType,
          regularMarketPrice: result.meta.regularMarketPrice,
          previousClose: result.meta.previousClose,
        },
      },
    };
  } catch (error) {
    logger.error({ error: error.message, symbol, interval, range }, 'Failed to fetch market data from Yahoo');
    return {
      ok: false,
      error: error.message || 'Failed to fetch market data',
    };
  }
}

/**
 * Fetch historical data - uses Dhan API for NIFTY indices, Yahoo Finance for others, or Dhan Bypass
 * @param {string} symbol - Symbol (^NSEI for NIFTY 50, ^NSEBANK for Bank NIFTY)
 * @param {string} interval - 1m, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo
 * @param {string} range - 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y
 * @param {number} endTime - Optional: Unix timestamp to fetch data before this time
 * @param {string} dataSource - Optional: 'dhan', 'yahoo', or 'dhan-bypass' (default: auto-detect)
 */
async function getHistoricalData(symbol, interval = '5m', range = '5d', endTime = null, dataSource = 'auto') {
  // Determine data source
  const shouldUseDhan = dataSource === 'dhan' || (dataSource === 'auto' && (symbol === '^NSEI' || symbol === '^NSEBANK'));
  
  if (shouldUseDhan) {
    // Use Dhan API for NIFTY indices
    if (symbol === '^NSEI') {
      logger.info({ symbol, interval, range, dataSource: 'dhan' }, 'Fetching NIFTY data from Dhan API');
      return dhanMarketData.getNiftyDataFromDhan(interval, range, endTime);
    } else if (symbol === '^NSEBANK') {
      logger.info({ symbol, interval, range, dataSource: 'dhan' }, 'Fetching Bank NIFTY data from Dhan API');
      return dhanMarketData.getBankNiftyDataFromDhan(interval, range, endTime);
    }
  }
  
  // Fallback to Yahoo Finance for other symbols or when explicitly requested
  logger.info({ symbol, interval, range, dataSource: 'yahoo' }, 'Fetching data from Yahoo Finance');
  return getHistoricalDataFromYahoo(symbol, interval, range, endTime);
}

/**
 * Get NIFTY 50 data - can choose between Dhan API and Yahoo Finance with automatic fallback
 */
async function getNiftyData(interval = '5m', range = '5d', endTime = null, dataSource = 'dhan') {
  if (dataSource === 'dhan') {
    const result = await dhanMarketData.getNiftyDataFromDhan(interval, range, endTime);
    
    // If Dhan fails, automatically fallback to Yahoo Finance
    if (!result.ok) {
      logger.warn({ 
        error: result.error, 
        errorCode: result.errorCode 
      }, 'Dhan API failed, falling back to Yahoo Finance');
      
      return getHistoricalDataFromYahoo('^NSEI', interval, range, endTime);
    }
    
    return result;
  }
  
  return getHistoricalDataFromYahoo('^NSEI', interval, range, endTime);
}

/**
 * Get Bank NIFTY data - can choose between Dhan API and Yahoo Finance with automatic fallback
 */
async function getBankNiftyData(interval = '5m', range = '5d', endTime = null, dataSource = 'dhan') {
  if (dataSource === 'dhan') {
    const result = await dhanMarketData.getBankNiftyDataFromDhan(interval, range, endTime);
    
    // If Dhan fails, automatically fallback to Yahoo Finance
    if (!result.ok) {
      logger.warn({ 
        error: result.error, 
        errorCode: result.errorCode 
      }, 'Dhan API failed, falling back to Yahoo Finance');
      
      return getHistoricalDataFromYahoo('^NSEBANK', interval, range, endTime);
    }
    
    return result;
  }
  
  return getHistoricalDataFromYahoo('^NSEBANK', interval, range, endTime);
}

module.exports = {
  getHistoricalData,
  getNiftyData,
  getBankNiftyData,
};
