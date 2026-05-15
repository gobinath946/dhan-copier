/**
 * Dhan REST API service layer.
 *
 * Notes:
 * - Endpoints below target the public DhanHQ v2 REST docs.
 *   If your account uses a different version or partner endpoints,
 *   adjust the path constants in DHAN_PATHS.
 * - All functions accept a decoded `account` object containing:
 *     { clientId, accessToken (decrypted), mode }
 * - Returns { ok, status, data, error } shape so callers don't need try/catch
 *   for expected failures.
 */
const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const env = require('../config/env');
const logger = require('../utils/logger');

const DHAN_PATHS = {
  orders: '/v2/orders',
  orderById: (id) => `/v2/orders/${encodeURIComponent(id)}`,
  positions: '/v2/positions',
  holdings: '/v2/holdings',
  orderBook: '/v2/orders',
  fundLimit: '/v2/fundlimit',
  // Quote endpoints (Dhan: marketfeed). Adjust if your subscription differs.
  ltp: '/v2/marketfeed/ltp',
  quote: '/v2/marketfeed/quote',
};

function baseUrlFor(mode) {
  return mode === 'production' ? env.dhanProdBaseUrl : env.dhanSandboxBaseUrl;
}

function buildClient(account) {
  const client = axios.create({
    baseURL: baseUrlFor(account.mode),
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'access-token': account.accessToken,
      'client-id': account.clientId,
    },
  });

  axiosRetry(client, {
    retries: 3,
    retryDelay: (retryCount) => 250 * Math.pow(3, retryCount - 1), // 250, 750, 2250
    retryCondition: (err) => {
      // Retry on network errors and 5xx; never on 4xx (validation/auth)
      if (axiosRetry.isNetworkError(err)) return true;
      const status = err.response && err.response.status;
      return status >= 500 && status < 600;
    },
    onRetry: (retryCount, err, requestConfig) => {
      logger.warn(
        { retryCount, url: requestConfig.url, status: err.response && err.response.status },
        'Dhan request retry'
      );
    },
  });

  return client;
}

function normalizeError(err) {
  if (err.response) {
    return {
      ok: false,
      status: err.response.status,
      data: null,
      error:
        (err.response.data && (err.response.data.errorMessage || err.response.data.message)) ||
        `Dhan API error ${err.response.status}`,
      raw: err.response.data,
    };
  }
  return {
    ok: false,
    status: 0,
    data: null,
    error: err.message || 'Network error',
    raw: null,
  };
}

async function placeOrder(account, order) {
  /**
   * order shape (Dhan v2):
   *   { transactionType, exchangeSegment, productType, orderType,
   *     securityId, quantity, price, triggerPrice, validity, ... }
   */
  const client = buildClient(account);
  try {
    const res = await client.post(DHAN_PATHS.orders, {
      dhanClientId: account.clientId,
      ...order,
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function modifyOrder(account, orderId, patch) {
  const client = buildClient(account);
  try {
    const res = await client.put(DHAN_PATHS.orderById(orderId), {
      dhanClientId: account.clientId,
      orderId,
      ...patch,
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function cancelOrder(account, orderId) {
  const client = buildClient(account);
  try {
    const res = await client.delete(DHAN_PATHS.orderById(orderId));
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function getPositions(account) {
  const client = buildClient(account);
  try {
    const res = await client.get(DHAN_PATHS.positions);
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function getHoldings(account) {
  const client = buildClient(account);
  try {
    const res = await client.get(DHAN_PATHS.holdings);
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function getOrderBook(account) {
  const client = buildClient(account);
  try {
    const res = await client.get(DHAN_PATHS.orderBook);
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

/**
 * Quote helper. Dhan's marketfeed expects a payload like:
 *   { "NSE_EQ": [11536], "BSE_EQ": [500325] }
 * Pass { exchangeSegment, securityId } and we'll wrap it.
 */
async function getLtp(account, { exchangeSegment, securityId }) {
  const client = buildClient(account);
  try {
    const res = await client.post(DHAN_PATHS.ltp, {
      [exchangeSegment]: [Number(securityId)],
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function getQuote(account, { exchangeSegment, securityId }) {
  const client = buildClient(account);
  try {
    const res = await client.post(DHAN_PATHS.quote, {
      [exchangeSegment]: [Number(securityId)],
    });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

async function getFundLimit(account) {
  const client = buildClient(account);
  try {
    const res = await client.get(DHAN_PATHS.fundLimit);
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    return normalizeError(err);
  }
}

module.exports = {
  placeOrder,
  modifyOrder,
  cancelOrder,
  getPositions,
  getHoldings,
  getOrderBook,
  getLtp,
  getQuote,
  getFundLimit,
};
