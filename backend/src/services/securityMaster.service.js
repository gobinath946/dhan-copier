/**
 * Security Master Service
 * Provides security IDs for NSE stocks
 * 
 * Security IDs are Dhan-specific identifiers for each stock/index
 * These can be obtained from:
 * 1. Dhan's security master CSV file
 * 2. Dhan API symbol search
 * 3. Manual mapping (used here for top NIFTY stocks)
 */

const logger = require('../utils/logger');

/**
 * NIFTY 50 Top 10 Stocks by Weight (as of 2024)
 * 
 * Security IDs extracted from: api-scrip-master-detailed.csv
 * Source: Dhan Security Master (NSE Equity segment)
 * Last Updated: 2026-05-11
 */
const NIFTY_TOP_10_STOCKS = [
  { 
    name: 'Reliance Industries', 
    symbol: 'RELIANCE',
    securityId: 2885, // ✅ Verified from Dhan CSV
    sector: 'Energy',
    weight: 10.5 // Approximate weight in NIFTY 50
  },
  { 
    name: 'HDFC Bank', 
    symbol: 'HDFCBANK',
    securityId: 1333, // ✅ Verified from Dhan CSV
    sector: 'Banking',
    weight: 9.8
  },
  { 
    name: 'ICICI Bank', 
    symbol: 'ICICIBANK',
    securityId: 4963, // ✅ Verified from Dhan CSV
    sector: 'Banking',
    weight: 8.2
  },
  { 
    name: 'Infosys', 
    symbol: 'INFY',
    securityId: 1594, // ✅ Verified from Dhan CSV
    sector: 'IT',
    weight: 6.5
  },
  { 
    name: 'TCS', 
    symbol: 'TCS',
    securityId: 11536, // ✅ Verified from Dhan CSV
    sector: 'IT',
    weight: 6.2
  },
  { 
    name: 'ITC', 
    symbol: 'ITC',
    securityId: 1660, // ✅ Verified from Dhan CSV
    sector: 'FMCG',
    weight: 4.8
  },
  { 
    name: 'Bharti Airtel', 
    symbol: 'BHARTIARTL',
    securityId: 10604, // ✅ Verified from Dhan CSV
    sector: 'Telecom',
    weight: 4.5
  },
  { 
    name: 'Kotak Mahindra Bank', 
    symbol: 'KOTAKBANK',
    securityId: 1922, // ✅ Verified from Dhan CSV
    sector: 'Banking',
    weight: 4.2
  },
  { 
    name: 'Hindustan Unilever', 
    symbol: 'HINDUNILVR',
    securityId: 1394, // ✅ Verified from Dhan CSV
    sector: 'FMCG',
    weight: 4.0
  },
  { 
    name: 'Axis Bank', 
    symbol: 'AXISBANK',
    securityId: 5900, // ✅ Verified from Dhan CSV
    sector: 'Banking',
    weight: 3.8
  }
];

/**
 * Known Index Security IDs (verified)
 */
const INDEX_SECURITY_IDS = {
  NIFTY: 13,
  BANKNIFTY: 25,
  FINNIFTY: 27,
  MIDCPNIFTY: 35,
  SENSEX: 51
};

/**
 * Get NIFTY top 10 stocks
 * @returns {Array} Array of stock objects with security IDs
 */
function getNiftyTop10() {
  return NIFTY_TOP_10_STOCKS;
}

/**
 * Get index security ID
 * @param {string} indexName - Index name (NIFTY, BANKNIFTY, etc.)
 * @returns {number|null} Security ID or null if not found
 */
function getIndexSecurityId(indexName) {
  return INDEX_SECURITY_IDS[indexName.toUpperCase()] || null;
}

/**
 * Get stock by symbol
 * @param {string} symbol - Stock symbol
 * @returns {Object|null} Stock object or null if not found
 */
function getStockBySymbol(symbol) {
  return NIFTY_TOP_10_STOCKS.find(
    stock => stock.symbol.toUpperCase() === symbol.toUpperCase()
  ) || null;
}

/**
 * Get stocks by sector
 * @param {string} sector - Sector name
 * @returns {Array} Array of stocks in the sector
 */
function getStocksBySector(sector) {
  return NIFTY_TOP_10_STOCKS.filter(
    stock => stock.sector.toLowerCase() === sector.toLowerCase()
  );
}

/**
 * TODO: Fetch security IDs from Dhan API
 * This function should be implemented to fetch real-time security IDs
 * from Dhan's security master API
 * 
 * @param {string} symbol - Stock symbol
 * @returns {Promise<number|null>} Security ID or null
 */
async function fetchSecurityIdFromDhan(symbol) {
  try {
    // TODO: Implement Dhan API call
    // const response = await axios.get('https://api.dhan.co/v2/securitylist', {
    //   params: { symbol: symbol, exchange: 'NSE' }
    // });
    // return response.data.securityId;
    
    logger.warn({ symbol }, '[securityMaster] fetchSecurityIdFromDhan not implemented - using placeholder');
    return null;
  } catch (error) {
    logger.error({ error: error.message, symbol }, '[securityMaster] Failed to fetch security ID');
    return null;
  }
}

/**
 * Validate if all security IDs are populated
 * @returns {boolean} True if all IDs are valid
 */
function validateSecurityIds() {
  const missingIds = NIFTY_TOP_10_STOCKS.filter(stock => !stock.securityId);
  
  if (missingIds.length > 0) {
    logger.warn({ 
      missingCount: missingIds.length,
      missingStocks: missingIds.map(s => s.symbol)
    }, '[securityMaster] Some security IDs are missing');
    return false;
  }
  
  return true;
}

module.exports = {
  getNiftyTop10,
  getIndexSecurityId,
  getStockBySymbol,
  getStocksBySector,
  fetchSecurityIdFromDhan,
  validateSecurityIds,
  INDEX_SECURITY_IDS
};
