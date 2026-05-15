/**
 * Dhan Options service - fetches option chain and option data
 */
const axios = require('axios');
const logger = require('../utils/logger');
const env = require('../config/env');

// Dhan API configuration from environment
const DHAN_ACCESS_TOKEN = env.dhanAccessToken;
const DHAN_MODE = env.dhanMode;
const DHAN_API_BASE_URL = DHAN_MODE === 'production' ? env.dhanProdBaseUrl : env.dhanSandboxBaseUrl;

// Exchange segments
const EXCHANGE_SEGMENT = {
  NSE_FNO: 'NSE_FNO', // F&O segment
  IDX_I: 'IDX_I',     // Index segment
};

/**
 * Get option chain data for NIFTY
 * @param {number} spotPrice - Current NIFTY spot price
 * @param {string} expiry - Expiry date in YYYY-MM-DD format
 */
async function getNiftyOptionChain(spotPrice, expiry = null) {
  try {
    // Calculate ATM strike
    const atmStrike = Math.round(spotPrice / 50) * 50;
    
    // Generate strikes around ATM (±10 strikes)
    const strikes = [];
    for (let i = -10; i <= 10; i++) {
      strikes.push(atmStrike + (i * 50));
    }
    
    // If no expiry provided, use current week expiry (Thursday)
    if (!expiry) {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const daysUntilThursday = (4 - dayOfWeek + 7) % 7 || 7;
      const thursday = new Date(today);
      thursday.setDate(today.getDate() + daysUntilThursday);
      expiry = thursday.toISOString().split('T')[0];
    }
    
    logger.info({ atmStrike, expiry, strikeCount: strikes.length }, 'Fetching NIFTY option chain');
    
    // Fetch option chain data from Dhan
    // Note: Dhan API requires security IDs for each option contract
    // For now, we'll return mock data structure
    // TODO: Implement actual Dhan API call when security ID mapping is available
    
    const optionChain = strikes.map(strike => ({
      strike,
      expiry,
      call: {
        securityId: `NIFTY${expiry.replace(/-/g, '')}${strike}CE`,
        ltp: Math.random() * 200,
        oi: Math.floor(Math.random() * 100000),
        volume: Math.floor(Math.random() * 50000),
        iv: 15 + Math.random() * 10,
        delta: 0.5 + Math.random() * 0.5,
        theta: -Math.random() * 5,
        vega: Math.random() * 10,
      },
      put: {
        securityId: `NIFTY${expiry.replace(/-/g, '')}${strike}PE`,
        ltp: Math.random() * 200,
        oi: Math.floor(Math.random() * 100000),
        volume: Math.floor(Math.random() * 50000),
        iv: 15 + Math.random() * 10,
        delta: -(0.5 + Math.random() * 0.5),
        theta: -Math.random() * 5,
        vega: Math.random() * 10,
      },
    }));
    
    return {
      ok: true,
      data: {
        underlying: 'NIFTY',
        spotPrice,
        atmStrike,
        expiry,
        optionChain,
      },
    };
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to fetch option chain');
    return {
      ok: false,
      error: error.message || 'Failed to fetch option chain',
    };
  }
}

/**
 * Get real-time quote for specific option contract
 * @param {string} securityId - Option security ID
 * @param {string} exchangeSegment - Exchange segment (NSE_FNO)
 */
async function getOptionQuote(securityId, exchangeSegment = EXCHANGE_SEGMENT.NSE_FNO) {
  try {
    const url = `${DHAN_API_BASE_URL}/v2/marketfeed/quote`;
    
    const payload = {
      [exchangeSegment]: [securityId],
    };
    
    logger.info({ securityId, exchangeSegment }, 'Fetching option quote');
    
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
    logger.error({ 
      error: error.message, 
      response: error.response?.data,
      securityId 
    }, 'Failed to fetch option quote');
    
    return {
      ok: false,
      error: error.response?.data?.errorMessage || error.message || 'Failed to fetch option quote',
    };
  }
}

/**
 * Get LTP for multiple option contracts
 * @param {Array} securityIds - Array of security IDs
 * @param {string} exchangeSegment - Exchange segment
 */
async function getOptionLTPs(securityIds, exchangeSegment = EXCHANGE_SEGMENT.NSE_FNO) {
  try {
    const url = `${DHAN_API_BASE_URL}/v2/marketfeed/ltp`;
    
    const payload = {
      [exchangeSegment]: securityIds.map(id => Number(id)),
    };
    
    logger.info({ count: securityIds.length, exchangeSegment }, 'Fetching option LTPs');
    
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
    logger.error({ 
      error: error.message, 
      response: error.response?.data 
    }, 'Failed to fetch option LTPs');
    
    return {
      ok: false,
      error: error.response?.data?.errorMessage || error.message || 'Failed to fetch option LTPs',
    };
  }
}

module.exports = {
  getNiftyOptionChain,
  getOptionQuote,
  getOptionLTPs,
  EXCHANGE_SEGMENT,
};
