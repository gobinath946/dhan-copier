/**
 * Dhan Production API controller — thin HTTP layer over dhanProd.service.
 * Exposes the same endpoints as the bypass controller so the frontend can
 * switch with minimal code churn.
 *
 * All routes use the env-level access token by default; callers may pass
 * `authKey` header to override (same contract as bypass controller).
 */
const dhanProd = require('../services/dhanProd.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');

/** GET /api/dhan-prod/historical */
exports.getHistorical = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const {
    securityId,
    exchange,
    segment,
    instrument,
    interval = '1',
    range = '5d',
    endTime,
  } = req.query;

  const { startTime, endTime: calcEnd } = dhanProd.calculateProdTimeRange(
    range,
    endTime ? parseInt(endTime) : null
  );

  const result = await dhanProd.getDhanProdData(authKey, {
    securityId,
    exchange,
    segment,
    instrument,
    startTime,
    endTime: calcEnd,
    interval,
  });

  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** GET /api/dhan-prod/expiry */
exports.getExpiryList = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const { securityId = 13 } = req.query;

  const result = await dhanProd.getExpiryListProd(authKey, {
    securityId: parseInt(securityId),
  });

  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** GET /api/dhan-prod/option-chain */
exports.getOptionChain = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const { securityId = 13, expiry } = req.query;

  const result = await dhanProd.getOptionChainProd(authKey, {
    securityId: parseInt(securityId),
    expiry: expiry ? parseInt(expiry) : undefined,
  });

  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** POST /api/dhan-prod/ltp */
exports.getLTP = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const instrumentMap = req.body;
  if (!instrumentMap || Object.keys(instrumentMap).length === 0) {
    throw new HttpError(400, 'Request body must contain instrument map, e.g. { "NSE_FNO":[49081] }');
  }
  const result = await dhanProd.getLTP(authKey, instrumentMap);
  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** POST /api/dhan-prod/ohlc */
exports.getOHLC = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const instrumentMap = req.body;
  if (!instrumentMap || Object.keys(instrumentMap).length === 0) {
    throw new HttpError(400, 'Request body must contain instrument map');
  }
  const result = await dhanProd.getOHLC(authKey, instrumentMap);
  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** POST /api/dhan-prod/quote */
exports.getQuote = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const instrumentMap = req.body;
  if (!instrumentMap || Object.keys(instrumentMap).length === 0) {
    throw new HttpError(400, 'Request body must contain instrument map');
  }
  const result = await dhanProd.getQuote(authKey, instrumentMap);
  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** GET /api/dhan-prod/oi-analysis */
exports.getOIAnalysis = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const { securityId = 13, expiry } = req.query;
  const result = await dhanProd.getOIAnalysis(authKey, {
    securityId: parseInt(securityId),
    expiry: expiry ? parseInt(expiry) : undefined,
  });
  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});

/** GET /api/dhan-prod/oi-change */
exports.getOIChange = asyncHandler(async (req, res) => {
  const authKey = req.headers['authkey'] || req.headers['access-token'];
  const { securityId = 13, expiry } = req.query;
  const result = await dhanProd.getOIChange(authKey, {
    securityId: parseInt(securityId),
    expiry: expiry ? parseInt(expiry) : undefined,
  });
  if (!result.ok) throw new HttpError(500, result.error);
  res.json(result.data);
});
