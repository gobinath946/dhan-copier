/**
 * Dhan Bypass service - Direct API access to ticks.dhan.co
 */
const axios = require('axios');
const qs = require('qs');
const logger = require('../utils/logger');

const DHAN_TICKS_URL = 'https://ticks.dhan.co/getData';
const DHAN_SCANX_URL = 'https://scanx.dhan.co/scanx/optchain';
const DHAN_FUTOPTSUM_URL = 'https://scanx.dhan.co/scanx/futoptsum';

/**
 * Helper function to retry API calls with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in ms
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on certain errors
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw error;
      }
      
      // Check if it's a network error that we should retry
      const isRetryableError = 
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        (error.response?.status >= 500 && error.response?.status < 600);
      
      if (!isRetryableError || attempt === maxRetries - 1) {
        throw error;
      }
      
      const delay = initialDelay * Math.pow(2, attempt);
      logger.warn({ 
        attempt: attempt + 1,
        maxRetries,
        delay,
        error: error.message,
        code: error.code
      }, 'Retrying API call after error');
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Fetch historical data from Dhan Bypass API
 * @param {string} authKey - Auth key for Dhan Bypass
 * @param {object} params - Request parameters
 */
async function getDhanBypassData(authKey, params) {
  try {
    const {
      securityId = 13,
      exchange = 'IDX',
      segment = 'I',
      instrument = 'IDX',
      startTime,
      endTime,
      interval = '1',
    } = params;

    const payload = {
      EXCH: exchange,
      SEG: segment,
      INST: instrument,
      SEC_ID: parseInt(securityId),
      START: startTime,
      END: endTime,
      START_TIME: new Date(startTime * 1000).toString(),
      END_TIME: new Date(endTime * 1000).toString(),
      INTERVAL: interval,
    };

    logger.info({ 
      payload, 
      hasAuthKey: !!authKey,
      url: DHAN_TICKS_URL 
    }, 'Fetching data from Dhan Bypass API');

    const response = await retryWithBackoff(async () => {
      return await axios.post(DHAN_TICKS_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Auth': authKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 30000, // 30 seconds for large data
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
      });
    }, 3, 2000);

    logger.info({ 
      success: response.data.success,
      dataKeys: Object.keys(response.data.data || {}),
      nextTime: response.data.nextTime 
    }, 'Dhan Bypass API response received');

    if (!response.data.success) {
      throw new Error('Dhan Bypass API returned unsuccessful response');
    }

    // Transform data to our format
    const data = response.data.data;
    const candles = [];

    // Handle both 't' and 'Time' keys (API may return either)
    const timeArray = data.Time || data.t;
    
    if (timeArray && data.o && data.h && data.l && data.c) {
      const length = timeArray.length;
      
      logger.info({ 
        length,
        sampleTime: timeArray[0],
        sampleTimeType: typeof timeArray[0],
        sampleOpen: data.o[0],
        sampleClose: data.c[0]
      }, 'Processing Dhan Bypass data arrays');
      
      for (let i = 0; i < length; i++) {
        // Convert time to Unix timestamp (seconds)
        let timestamp;
        if (typeof timeArray[i] === 'string') {
          // ISO string format - convert to Unix timestamp
          timestamp = Math.floor(new Date(timeArray[i]).getTime() / 1000);
        } else {
          // Already a number (Unix timestamp)
          timestamp = timeArray[i];
        }
        
        candles.push({
          time: timestamp,
          open: parseFloat(data.o[i]),
          high: parseFloat(data.h[i]),
          low: parseFloat(data.l[i]),
          close: parseFloat(data.c[i]),
          volume: data.v ? parseFloat(data.v[i]) : 0,
        });
      }
    } else {
      logger.warn({ 
        hasTime: !!timeArray,
        hasO: !!data.o,
        hasH: !!data.h,
        hasL: !!data.l,
        hasC: !!data.c,
        dataKeys: Object.keys(data)
      }, 'Missing required data arrays in Dhan Bypass response');
    }

    logger.info({ 
      candleCount: candles.length,
      firstCandle: candles[0],
      lastCandle: candles[candles.length - 1]
    }, 'Transformed Dhan Bypass data');

    return {
      ok: true,
      data: {
        candles,
        nextTime: response.data.nextTime,
        meta: {
          source: 'dhan-bypass',
          securityId,
          exchange,
          segment,
          instrument,
          interval,
        },
      },
    };
  } catch (error) {
    logger.error({ 
      error: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
    }, 'Failed to fetch Dhan Bypass data');

    return {
      ok: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch data from Dhan Bypass API',
    };
  }
}

/**
 * Calculate time range for Dhan Bypass API
 * @param {string} range - Range like '1d', '5d', '1w', etc.
 * @param {number} endTime - Optional end timestamp
 */
function calculateBypassTimeRange(range, endTime = null) {
  let now;
  
  if (endTime) {
    now = new Date(endTime * 1000);
  } else {
    now = new Date();
  }
  
  // Ensure endTime is a trading day (skip weekends)
  let day = now.getDay();
  if (day === 0) { // Sunday
    now.setDate(now.getDate() - 2);
  } else if (day === 6) { // Saturday
    now.setDate(now.getDate() - 1);
  }
  
  const endTimestamp = Math.floor(now.getTime() / 1000);

  const rangeToSeconds = {
    '1d': 86400,           // 1 day
    '5d': 432000,          // 5 days
    '1w': 604800,          // 1 week (7 days)
    '1mo': 2592000,        // 1 month
    '3mo': 7776000,        // 3 months
    '6mo': 15552000,       // 6 months
    '1y': 31536000,        // 1 year
    '2y': 63072000,        // 2 years
    '5y': 157680000,       // 5 years
  };

  const rangeSeconds = rangeToSeconds[range] || 604800; // Default to 1 week
  let startDate = new Date((endTimestamp - rangeSeconds) * 1000);
  
  // Ensure startDate is also a trading day (skip weekends)
  let startDay = startDate.getDay();
  if (startDay === 0) { // Sunday
    startDate.setDate(startDate.getDate() + 1); // Move to Monday
  } else if (startDay === 6) { // Saturday
    startDate.setDate(startDate.getDate() + 2); // Move to Monday
  }
  
  const startTimestamp = Math.floor(startDate.getTime() / 1000);

  return {
    startTime: startTimestamp,
    endTime: endTimestamp,
  };
}

/**
 * Fetch option chain data from Dhan Bypass API
 * @param {string} authKey - Auth key for Dhan Bypass
 * @param {object} params - Request parameters
 */
async function getOptionChainBypass(authKey, params) {
  try {
    const {
      segment = 2, // 2 for NIFTY
      expiry = null, // Expiry timestamp
      securityId = 72259, // NIFTY 50 security ID
    } = params;

    // First, try to get the expiry list from the API
    let expiryTimestamp = expiry;
    
    if (!expiryTimestamp) {
      try {
        // Make a request to get available expiries
        const expiryListPayload = {
          Data: {
            Seg: segment,
            Exp: null, // null to get expiry list
            Sid: securityId,
          }
        };

        logger.info('Fetching expiry list from Dhan Bypass API');

        const expiryResponse = await retryWithBackoff(async () => {
          return await axios.post(DHAN_SCANX_URL, expiryListPayload, {
            headers: {
              'Content-Type': 'application/json',
              'Auth': authKey,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json',
            },
            timeout: 30000,
            httpAgent: new (require('http').Agent)({ 
              keepAlive: true,
              keepAliveMsecs: 1000,
            }),
            httpsAgent: new (require('https').Agent)({ 
              keepAlive: true,
              keepAliveMsecs: 1000,
            }),
          });
        }, 3, 2000);

        logger.info({ 
          code: expiryResponse.data.code,
          hasExplst: !!expiryResponse.data.data?.explst,
          explst: expiryResponse.data.data?.explst
        }, 'Expiry list response');

        // Check if we got expiry list
        if (expiryResponse.data.code === 0 && expiryResponse.data.data.explst && expiryResponse.data.data.explst.length > 0) {
          const expiryList = expiryResponse.data.data.explst;
          logger.info({ expiryList }, 'Available expiries from API');
          
          // Use the first expiry (nearest)
          expiryTimestamp = expiryList[0].Exp;
          logger.info({ 
            selectedExpiry: expiryTimestamp,
            expiryDate: new Date(expiryTimestamp * 1000).toISOString()
          }, 'Selected nearest expiry');
        }
      } catch (expiryError) {
        logger.warn({ error: expiryError.message }, 'Failed to fetch expiry list, will use calculated expiry');
      }
    }

    // If still no expiry, calculate next Thursday
    if (!expiryTimestamp) {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0 = Sunday, 4 = Thursday
      let daysUntilThursday = (4 - dayOfWeek + 7) % 7;
      
      if (daysUntilThursday === 0) {
        // If today is Thursday, check time
        if (now.getHours() >= 15 && now.getMinutes() >= 30) {
          // After 3:30 PM, use next Thursday
          daysUntilThursday = 7;
        }
      }
      
      if (daysUntilThursday === 0) {
        daysUntilThursday = 7; // Use next Thursday
      }
      
      const expiryDate = new Date(now);
      expiryDate.setDate(now.getDate() + daysUntilThursday);
      expiryDate.setHours(15, 30, 0, 0); // Set to 3:30 PM IST
      expiryTimestamp = Math.floor(expiryDate.getTime() / 1000);
      
      logger.info({ 
        calculatedExpiry: expiryTimestamp,
        expiryDate: expiryDate.toISOString(),
        daysUntilThursday
      }, 'Calculated expiry timestamp');
    }

    // Now fetch the actual option chain with the expiry
    const payload = {
      Data: {
        Seg: 0,
        Exp: expiryTimestamp,
        Sid: 13,
      }
    };

    logger.info({ 
      payload,
      expiryDate: new Date(expiryTimestamp * 1000).toISOString(),
      hasAuthKey: !!authKey,
      url: DHAN_SCANX_URL 
    }, 'Fetching option chain from Dhan Bypass API');

    const response = await retryWithBackoff(async () => {
      return await axios.post(DHAN_SCANX_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Auth': authKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 30000,
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
      });
    }, 3, 2000);

    logger.info({ 
      code: response.data.code,
      hasData: !!response.data.data,
      dataKeys: response.data.data ? Object.keys(response.data.data) : [],
      strikeCount: response.data.data?.oc ? Object.keys(response.data.data.oc).length : 0
    }, 'Dhan Bypass option chain response received');

    if (response.data.code !== 0) {
      throw new Error('Dhan Bypass API returned error code: ' + response.data.code);
    }

    // Check if oc exists and has data
    if (!response.data.data.oc || Object.keys(response.data.data.oc).length === 0) {
      logger.warn({ 
        expiry: expiryTimestamp,
        expiryDate: new Date(expiryTimestamp * 1000).toISOString()
      }, 'No option chain data returned - possibly invalid expiry');
      
      return {
        ok: false,
        error: 'No option chain data available for the selected expiry',
      };
    }

    // Transform data to our format
    const optionChainData = response.data.data.oc;
    const strikes = [];

    // Log a sample strike to see the data structure
    const sampleStrike = Object.entries(optionChainData)[0];
    if (sampleStrike) {
      logger.info({
        sampleStrikePrice: sampleStrike[0],
        sampleCallLtp: sampleStrike[1]?.ce?.ltp,
        samplePutLtp: sampleStrike[1]?.pe?.ltp,
        sampleCallOI: sampleStrike[1]?.ce?.OI,
        samplePutOI: sampleStrike[1]?.pe?.OI,
      }, 'Sample option chain strike data');
    }

    for (const [strikePrice, strikeData] of Object.entries(optionChainData)) {
      const strike = parseFloat(strikePrice);
      
      strikes.push({
        strike,
        expiry: strikeData.exptype,
        call: {
          securityId: strikeData.ce.sid,
          symbol: strikeData.ce.sym,
          displaySymbol: strikeData.ce.disp_sym,
          ltp: strikeData.ce.ltp,
          change: strikeData.ce.p_chng,
          changePercent: strikeData.ce.p_pchng,
          volume: strikeData.ce.vol,
          oi: strikeData.ce.OI,
          oiChange: strikeData.ce.oichng,
          oiChangePercent: strikeData.ce.oiperchnge,
          iv: strikeData.ce.iv,
          bid: strikeData.ce.bid,
          ask: strikeData.ce.ask,
          bidQty: strikeData.ce.bid_qty,
          askQty: strikeData.ce.ask_qty,
          greeks: {
            delta: strikeData.ce.optgeeks?.delta || 0,
            theta: strikeData.ce.optgeeks?.theta || 0,
            gamma: strikeData.ce.optgeeks?.gamma || 0,
            vega: strikeData.ce.optgeeks?.vega || 0,
            rho: strikeData.ce.optgeeks?.rho || 0,
          },
          moneyness: strikeData.ce.mness,
          builtupType: strikeData.ce.btyp,
          builtupName: strikeData.ce.BuiltupName,
        },
        put: {
          securityId: strikeData.pe.sid,
          symbol: strikeData.pe.sym,
          displaySymbol: strikeData.pe.disp_sym,
          ltp: strikeData.pe.ltp,
          change: strikeData.pe.p_chng,
          changePercent: strikeData.pe.p_pchng,
          volume: strikeData.pe.vol,
          oi: strikeData.pe.OI,
          oiChange: strikeData.pe.oichng,
          oiChangePercent: strikeData.pe.oiperchnge,
          iv: strikeData.pe.iv,
          bid: strikeData.pe.bid,
          ask: strikeData.pe.ask,
          bidQty: strikeData.pe.bid_qty,
          askQty: strikeData.pe.ask_qty,
          greeks: {
            delta: strikeData.pe.optgeeks?.delta || 0,
            theta: strikeData.pe.optgeeks?.theta || 0,
            gamma: strikeData.pe.optgeeks?.gamma || 0,
            vega: strikeData.pe.optgeeks?.vega || 0,
            rho: strikeData.pe.optgeeks?.rho || 0,
          },
          moneyness: strikeData.pe.mness,
          builtupType: strikeData.pe.btyp,
          builtupName: strikeData.pe.BuiltupName,
        },
        pcr: {
          volume: strikeData.volpcr,
          oi: strikeData.oipcr,
        },
        maxPainLoss: strikeData.mploss,
      });
    }

    // Sort strikes by strike price
    strikes.sort((a, b) => a.strike - b.strike);

    logger.info({ 
      strikeCount: strikes.length,
      firstStrike: strikes[0]?.strike,
      lastStrike: strikes[strikes.length - 1]?.strike
    }, 'Transformed option chain data');

    return {
      ok: true,
      data: {
        strikes,
        meta: {
          source: 'dhan-bypass',
          segment,
          expiry: expiryTimestamp,
          securityId,
        },
      },
    };
  } catch (error) {
    logger.error({ 
      error: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
    }, 'Failed to fetch option chain from Dhan Bypass');

    return {
      ok: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch option chain from Dhan Bypass API',
    };
  }
}

/**
 * Helper function to retry API calls with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in ms
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on certain errors
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw error;
      }
      
      // Check if it's a network error that we should retry
      const isRetryableError = 
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND' ||
        (error.response?.status >= 500 && error.response?.status < 600);
      
      if (!isRetryableError || attempt === maxRetries - 1) {
        throw error;
      }
      
      const delay = initialDelay * Math.pow(2, attempt);
      logger.warn({ 
        attempt: attempt + 1,
        maxRetries,
        delay,
        error: error.message,
        code: error.code
      }, 'Retrying API call after error');
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Get expiry list from Dhan Bypass API
 * @param {string} authKey - Auth key for Dhan Bypass
 * @param {object} params - Request parameters
 */
async function getExpiryListBypass(authKey, params) {
  try {
    const {
      segment = 0, // 2 for NIFTY
      securityId = 13, // NIFTY 50 security ID
    } = params;

    // The API expects nested Data object
    const payload = {
      Data: {
        Seg: 0,
        Sid: 13,
      }
    };

    logger.info({ 
      payload,
      hasAuthKey: !!authKey,
      url: DHAN_FUTOPTSUM_URL 
    }, 'Fetching expiry list from Dhan Bypass API');

    const response = await retryWithBackoff(async () => {
      return await axios.post(DHAN_FUTOPTSUM_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Auth': authKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 30000,
        // Add connection keep-alive and retry settings
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
          rejectUnauthorized: false, // Only if SSL issues
        }),
      });
    }, 3, 2000); // 3 retries with 2 second initial delay

    logger.info({ 
      code: response.data.code,
      hasData: !!response.data.data,
      dataKeys: response.data.data ? Object.keys(response.data.data) : [],
    }, 'Dhan Bypass expiry list response received');

    if (response.data.code !== 0) {
      logger.error({
        code: response.data.code,
        remarks: response.data.remarks,
        fullResponse: response.data
      }, 'Dhan Bypass API error');
      throw new Error(`Dhan Bypass API returned error: ${response.data.remarks || 'Unknown error'}`);
    }

    // Extract expiry list from opsum
    const opsum = response.data.data.opsum;
    const expiryList = [];

    logger.info({
      opsumKeys: Object.keys(opsum).slice(0, 5),
      firstOpsumEntry: Object.entries(opsum)[0],
      opsumCount: Object.keys(opsum).length,
    }, 'Raw opsum data from Dhan API');

    for (const [expiryTimestamp, expiryData] of Object.entries(opsum)) {
      const exp = parseInt(expiryTimestamp);
      const expiryDateObj = new Date(exp * 1000);
      
      logger.info({
        rawTimestamp: expiryTimestamp,
        parsedExp: exp,
        expiryDateISO: expiryDateObj.toISOString(),
        daysToExpiry: expiryData.daystoexp,
        expiryType: expiryData.exptype,
      }, 'Processing expiry entry');
      
      expiryList.push({
        exp,
        expiry: exp,
        expiryDate: expiryDateObj.toISOString(),
        expiryType: expiryData.exptype, // M = Monthly, W = Weekly
        daysToExpiry: expiryData.daystoexp,
        atmIV: expiryData.atmiv,
        pcr: expiryData.pcr,
        displayName: `${expiryData.exptype === 'M' ? 'Monthly' : 'Weekly'} - ${expiryDateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} (${expiryData.daystoexp}d)`,
      });
    }

    // Sort by expiry date (nearest first)
    // Use daystoexp from the API to find the nearest valid expiry
    // NOTE: The Dhan futoptsum API may return non-standard timestamps — use daystoexp to sort
    expiryList.sort((a, b) => (a.daysToExpiry || 999) - (b.daysToExpiry || 999));

    // Filter: keep only expiries with daysToExpiry >= 0 (today or future)
    const validExpiries = expiryList.filter(e => (e.daysToExpiry || 0) >= 0);

    if (validExpiries.length === 0) {
      logger.warn({ 
        totalExpiries: expiryList.length,
        firstDays: expiryList[0]?.daysToExpiry,
      }, 'No valid future expiries from API — calculating next Thursday');

      // Calculate next Thursday (weekly expiry) as the correct expiry
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun, 4=Thu
      let daysUntilThursday = (4 - dayOfWeek + 7) % 7;
      if (daysUntilThursday === 0) {
        daysUntilThursday = (now.getHours() < 15 || (now.getHours() === 15 && now.getMinutes() < 30)) ? 0 : 7;
      }
      const expiryDate = new Date(now);
      expiryDate.setDate(now.getDate() + daysUntilThursday);
      expiryDate.setHours(15, 30, 0, 0);
      const calculatedExp = Math.floor(expiryDate.getTime() / 1000);

      expiryList.length = 0;
      expiryList.push({
        exp: calculatedExp,
        expiry: calculatedExp,
        expiryDate: expiryDate.toISOString(),
        expiryType: 'W',
        daysToExpiry: daysUntilThursday,
        atmIV: null,
        pcr: null,
        displayName: `Weekly - ${expiryDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} (${daysUntilThursday}d) [calculated]`,
      });
      logger.info({ calculatedExp, expiryDate: expiryDate.toISOString(), daysUntilThursday }, 'Using calculated next Thursday expiry');
    } else {
      expiryList.length = 0;
      expiryList.push(...validExpiries);
    }

    logger.info({ 
      expiryCount: expiryList.length,
      firstExpiry: expiryList[0]?.displayName,
      firstExp: expiryList[0]?.exp,
      firstDaysToExpiry: expiryList[0]?.daysToExpiry,
      firstExpDate: expiryList[0]?.expiryDate,
    }, 'Transformed expiry list');

    return {
      ok: true,
      data: {
        expiries: expiryList,
        meta: {
          source: 'dhan-bypass',
          segment,
          securityId,
        },
      },
    };
  } catch (error) {
    logger.error({ 
      error: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
    }, 'Failed to fetch expiry list from Dhan Bypass');

    return {
      ok: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch expiry list from Dhan Bypass API',
    };
  }
}

module.exports = {
  getDhanBypassData,
  calculateBypassTimeRange,
  getOptionChainBypass,
  getExpiryListBypass,
};


/**
 * Get OI Analysis data from Dhan Static API
 * @param {string} authKey - Auth key for Dhan Bypass
 * @param {object} params - Request parameters
 */
async function getOIAnalysis(authKey, params) {
  try {
    const {
      segment = 0,
      securityId = 13,
      expiry,
      timeframe = '1m',
      strikes = 30,
      startTime,
      requiredData = ['oi', 'vol', 'pcr_oi', 'pcr_vol'],
    } = params;

    const payload = {
      u_seg_id: segment,
      u_id: securityId,
      expj: [expiry],
      timeframe,
      strikes,
      start_time: startTime,
      required_data: requiredData,
    };

    logger.info({ 
      payload,
      hasAuthKey: !!authKey,
      url: 'https://static-scanx.dhan.co/staticscanx/oi_analysis'
    }, 'Fetching OI analysis from Dhan Static API');

    const response = await retryWithBackoff(async () => {
      return await axios.post('https://static-scanx.dhan.co/staticscanx/oi_analysis', payload, {
        headers: {
          'Content-Type': 'application/json',
          'Auth': authKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 30000,
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
      });
    }, 3, 2000);

    logger.info({ 
      code: response.data.code,
      hasData: !!response.data.data,
      dataKeys: response.data.data ? Object.keys(response.data.data) : [],
    }, 'Dhan OI analysis response received');

    if (response.data.code !== 0) {
      throw new Error(`Dhan OI Analysis API returned error: ${response.data.remarks || 'Unknown error'}`);
    }

    return {
      ok: true,
      data: response.data.data,
    };
  } catch (error) {
    logger.error({ 
      error: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
    }, 'Failed to fetch OI analysis from Dhan');

    return {
      ok: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch OI analysis',
    };
  }
}

/**
 * Get OI Change data from Dhan Static API
 * @param {string} authKey - Auth key for Dhan Bypass
 * @param {object} params - Request parameters
 */
async function getOIChange(authKey, params) {
  try {
    const {
      segment = 0,
      securityId = 13,
      expiry,
      timeframe = '1m',
      strikes = 30,
      startTime,
      endTime,
    } = params;

    const payload = {
      u_seg_id: segment,
      u_id: securityId,
      expj: [expiry],
      timeframe,
      strikes,
      start_time: startTime,
      end_time: endTime,
      required_data: ['oi_change'],
    };

    logger.info({ 
      payload,
      hasAuthKey: !!authKey,
      url: 'https://static-scanx.dhan.co/staticscanx/oi_analysis'
    }, 'Fetching OI change from Dhan Static API');

    const response = await retryWithBackoff(async () => {
      return await axios.post('https://static-scanx.dhan.co/staticscanx/oi_analysis', payload, {
        headers: {
          'Content-Type': 'application/json',
          'Auth': authKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 30000,
        httpAgent: new (require('http').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
        httpsAgent: new (require('https').Agent)({ 
          keepAlive: true,
          keepAliveMsecs: 1000,
        }),
      });
    }, 3, 2000);

    logger.info({ 
      code: response.data.code,
      hasData: !!response.data.data,
      dataKeys: response.data.data ? Object.keys(response.data.data) : [],
    }, 'Dhan OI change response received');

    if (response.data.code !== 0) {
      throw new Error(`Dhan OI Change API returned error: ${response.data.remarks || 'Unknown error'}`);
    }

    return {
      ok: true,
      data: response.data.data,
    };
  } catch (error) {
    logger.error({ 
      error: error.message,
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
    }, 'Failed to fetch OI change from Dhan');

    return {
      ok: false,
      error: error.response?.data?.message || error.message || 'Failed to fetch OI change',
    };
  }
}

module.exports = {
  getDhanBypassData,
  calculateBypassTimeRange,
  getOptionChainBypass,
  getExpiryListBypass,
  getOIAnalysis,
  getOIChange,
};
