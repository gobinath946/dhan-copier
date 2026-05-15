/**
 * NIFTY Futures — production edition
 * =================================
 * Resolves the current-month (near) NIFTY index futures contract from Dhan's
 * scrip master CSV and exposes:
 *   - getSecurityId()        → cached integer security id
 *   - getIntradayCandles()   → OHLC via /v2/charts/intraday
 *   - getMarketQuote()       → live LTP + OI via /v2/marketfeed/quote
 *   - subscribeLiveFeed()    → hook into dhanLiveFeedProd WebSocket
 *
 * The scrip master CSV is ~20MB so we fetch ONCE per process (cached) and
 * filter for SEM_TRADING_SYMBOL starting with 'NIFTY' + INSTRUMENT='FUTIDX' +
 * earliest future expiry date.
 *
 * All functions are production-ready — no bypass endpoints.
 */
const axios = require('axios');
const logger = require('../utils/logger');
const dhanProd = require('./dhanProd.service');
const { instance: liveFeedProd } = require('./dhanLiveFeedProd.service');

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const FUTURES_CACHE_TTL = 12 * 60 * 60 * 1000; // 12h — scrip master updates overnight

let cached = {
  expiresAt: 0,
  nearFut: null,    // { securityId, tradingSymbol, expiryDate, lotSize }
  nextFut: null,
};

// ---------------------------------------------------------------------------
// Parse the Dhan detailed scrip master CSV to find the NIFTY futures line
// ---------------------------------------------------------------------------
function parseScripMasterCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].split(',');
  const idx = (name) => header.indexOf(name);

  const iExch = idx('EXCH_ID');
  const iSeg = idx('SEGMENT');
  const iSid = idx('SECURITY_ID')              >= 0 ? idx('SECURITY_ID')            : idx('SEM_SMST_SECURITY_ID');
  const iInst = idx('INSTRUMENT');
  const iSymbol = idx('UNDERLYING_SYMBOL');
  const iDisplay = idx('DISPLAY_NAME')         >= 0 ? idx('DISPLAY_NAME')           : idx('SEM_CUSTOM_SYMBOL');
  const iExpiry = idx('SM_EXPIRY_DATE')        >= 0 ? idx('SM_EXPIRY_DATE')         : idx('SEM_EXPIRY_DATE');
  const iLot = idx('LOT_SIZE')                 >= 0 ? idx('LOT_SIZE')               : idx('SEM_LOT_UNITS');

  const out = [];
  // CSV is huge — only keep NIFTY FUTIDX lines
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols[iExch] !== 'NSE') continue;
    if (cols[iInst] !== 'FUTIDX') continue;
    const sym = cols[iSymbol] || '';
    if (sym.toUpperCase() !== 'NIFTY') continue;
    const secId = parseInt(cols[iSid], 10);
    if (!Number.isFinite(secId)) continue;
    out.push({
      securityId: secId,
      tradingSymbol: cols[iDisplay] || '',
      expiryDate: cols[iExpiry] || '',
      lotSize: parseInt(cols[iLot], 10) || 75,
    });
  }
  return out;
}

function byExpiryAsc(a, b) {
  return String(a.expiryDate).localeCompare(String(b.expiryDate));
}

async function loadFromScripMaster() {
  logger.info({ url: SCRIP_MASTER_URL }, '[niftyFuturesProd] Fetching Dhan scrip master CSV');
  const { data } = await axios.get(SCRIP_MASTER_URL, {
    timeout: 60000,
    responseType: 'text',
  });
  const all = parseScripMasterCsv(data);
  if (!all.length) throw new Error('No NIFTY FUTIDX rows found in scrip master');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = all
    .filter(r => {
      const d = new Date(r.expiryDate);
      return !Number.isNaN(d.getTime()) && d >= today;
    })
    .sort(byExpiryAsc);

  if (!upcoming.length) throw new Error('No upcoming NIFTY futures found');

  const nearFut = upcoming[0];
  const nextFut = upcoming[1] || null;

  cached = {
    expiresAt: Date.now() + FUTURES_CACHE_TTL,
    nearFut,
    nextFut,
  };

  logger.info({
    near: { sid: nearFut.securityId, expiry: nearFut.expiryDate, symbol: nearFut.tradingSymbol, lot: nearFut.lotSize },
    next: nextFut ? { sid: nextFut.securityId, expiry: nextFut.expiryDate } : null,
  }, '[niftyFuturesProd] Resolved NIFTY futures contracts');

  return cached;
}

async function ensureResolved() {
  if (cached.nearFut && Date.now() < cached.expiresAt) return cached;
  return loadFromScripMaster();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function getNearContract() {
  const r = await ensureResolved();
  return r.nearFut;
}

async function getNextContract() {
  const r = await ensureResolved();
  return r.nextFut;
}

async function getSecurityId() {
  const c = await getNearContract();
  return c?.securityId;
}

/**
 * Fetch intraday OHLC candles for NIFTY Futures near contract.
 * @param {object} opts - { interval: '1'|'5'|'15', startTime, endTime }
 * @returns {Promise<{ok, data:{candles, meta}}>}
 */
async function getIntradayCandles({ interval = '1', startTime, endTime } = {}) {
  const c = await getNearContract();
  if (!c) return { ok: false, error: 'Could not resolve NIFTY futures contract' };

  const nowSec = Math.floor(Date.now() / 1000);
  const end = endTime || nowSec;
  const start = startTime || end - 30 * 60;

  return dhanProd.getDhanProdData(null, {
    securityId: c.securityId,
    exchange: 'NSE',
    segment: 'D',
    instrument: 'FUTIDX',
    startTime: start,
    endTime: end,
    interval,
  });
}

/**
 * Live market quote for NIFTY Futures — LTP, OI, depth.
 */
async function getMarketQuote() {
  const c = await getNearContract();
  if (!c) return { ok: false, error: 'Could not resolve NIFTY futures contract' };

  const res = await dhanProd.getQuote(null, {
    NSE_FNO: [c.securityId],
  });
  if (!res.ok) return res;

  const row = res.data?.NSE_FNO?.[String(c.securityId)];
  return {
    ok: true,
    data: {
      securityId: c.securityId,
      tradingSymbol: c.tradingSymbol,
      expiryDate: c.expiryDate,
      lotSize: c.lotSize,
      ltp: row?.last_price || 0,
      oi: row?.oi || 0,
      oiDayHigh: row?.oi_day_high || 0,
      oiDayLow: row?.oi_day_low || 0,
      volume: row?.volume || 0,
      open: row?.ohlc?.open || 0,
      high: row?.ohlc?.high || 0,
      low: row?.ohlc?.low || 0,
      close: row?.ohlc?.close || 0,
      buyQty: row?.buy_quantity || 0,
      sellQty: row?.sell_quantity || 0,
      avgPrice: row?.average_price || 0,
      upperCircuit: row?.upper_circuit_limit || 0,
      lowerCircuit: row?.lower_circuit_limit || 0,
    },
  };
}

/**
 * Subscribe the near-month contract to the live WebSocket feed.
 * Returns the security id that was subscribed so callers can fetch ticks later.
 */
async function subscribeLiveFeed(mode = 'FULL') {
  const c = await getNearContract();
  if (!c) return null;
  liveFeedProd.subscribe(
    [{ exchangeSegment: 'NSE_FNO', securityId: c.securityId }],
    mode
  );
  logger.info({ sid: c.securityId, mode }, '[niftyFuturesProd] Subscribed futures to live feed');
  return c.securityId;
}

/**
 * Read the latest tick from the live WebSocket snapshot.
 * Returns null if no tick available or if the tick is older than 5 seconds.
 */
async function getLiveTick() {
  const c = await getNearContract();
  if (!c) return null;
  const tick = liveFeedProd.getTick('NSE_FNO', c.securityId);
  if (!tick || typeof tick.ltp !== 'number') return null;
  if (!tick.updatedAt || Date.now() - tick.updatedAt > 5000) return null;
  return {
    ...tick,
    expiryDate: c.expiryDate,
    lotSize: c.lotSize,
  };
}

/**
 * Compute a few lightweight analytics from candles — premium over spot,
 * trend direction, and momentum — so the entry/monitor engines get a
 * concise summary instead of every candle.
 */
function analyzeCandles(candles, spotLtp) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return { trend: 'unknown', momentum: 0, premium: 0, lastClose: null };
  }
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;

  let trend = 'neutral';
  if (pctChange > 0.15) trend = 'bullish';
  else if (pctChange < -0.15) trend = 'bearish';

  // Very short-term momentum — last 5 closes up or down
  let up = 0, down = 0;
  for (let i = Math.max(1, closes.length - 5); i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) up++;
    else if (closes[i] < closes[i - 1]) down++;
  }
  const momentum = up - down; // -5..+5

  const premium = spotLtp ? last - spotLtp : 0;

  return {
    trend,
    momentum,
    premium: Number(premium.toFixed(2)),
    lastClose: last,
    sessionHigh: Math.max(...candles.map(c => c.high)),
    sessionLow: Math.min(...candles.map(c => c.low)),
    candleCount: candles.length,
  };
}

module.exports = {
  getSecurityId,
  getNearContract,
  getNextContract,
  getIntradayCandles,
  getMarketQuote,
  subscribeLiveFeed,
  getLiveTick,
  analyzeCandles,
  // exposed for tests
  _parseScripMasterCsv: parseScripMasterCsv,
};
