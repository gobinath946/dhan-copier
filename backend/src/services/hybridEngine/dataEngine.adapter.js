/**
 * ============================================================
 * DATA_ENGINE ADAPTER (Req 4) — tasks 3.1 + 3.2 + 3.3
 * ============================================================
 * Composes a single normalised `DataSnapshot` per cycle by wiring the
 * existing data services together. The orchestrator (task 16.2) calls
 * `fetchDataSnapshot({ settings, now })` once at the top of each cycle
 * and feeds the result into the pipeline via `cycleContext.appendBlock`.
 *
 * Source priority (Req 4.4):
 *   1. Recorded JSONL under `live-feed/<date>_NIFTY_50/` via
 *      `liveFeedDataProvider.service.js` — preferred when same-day
 *      data exists, in order to respect Dhan rate limits.
 *   2. Dhan WebSocket via `dhanLiveFeedProd.service.js` — segments
 *      `IDX_I` (NIFTY spot, security id 13) and `NSE_FNO` (NIFTY
 *      futures, current near-month contract).
 *   3. `hybridLiveFeed.service.js` — polling fallback used when the
 *      WebSocket has dropped (option chain / off-index legs).
 *
 * Prior-day context (Req 4.5):
 *   - `historicalContext.service.js` returns yesterday's high/low/close,
 *     opening range, weekly high/low, and clustered swing levels.
 *
 * Subtask 3.1 delivered:
 *   - Wired every data service with defensive try/catch so the smoke
 *     check passes locally without Dhan credentials (Req 1.5).
 *   - Composed a `DataSnapshot` carrying every top-level field of the
 *     design typedef (`./cycleContext.js`).
 *   - Resolved `recordedToday` from `liveFeedDataProvider.getStats()`.
 *
 * Subtask 3.2 delivered:
 *   - Multi-timeframe candle alignment for spot 1m/5m/15m/1H and the
 *     symmetric futures map. 1m / 5m / 15m are loaded directly from
 *     the recorded JSONL via `liveFeedDataProvider.readCandlesFromFile`
 *     (which is itself the same path `scalpingDataAggregator` and
 *     `futuresCandleAggregator` write to). 1H is derived by aggregating
 *     15m bars on session boundaries — no recorded 1H file exists.
 *   - Each timeframe is sorted ASC by close timestamp, partial /
 *     in-progress bars are excluded (`closeTime > now` ⇒ dropped), and
 *     the per-timeframe lookback comes from
 *     `settings.dataEngine.multiTimeframe[tf]` (Req 4.3).
 *   - Session VWAP and the four AVWAP anchors (`sessionOpen`,
 *     `priorDayHigh`, `priorDayLow`, `weeklyAnchor`) are computed off
 *     the aligned 1m spot bars and gated by
 *     `settings.structureEngine.avwapAnchors` so the operator can
 *     disable any anchor via config (Req 6.2).
 *
 * Subtask 3.3 delivered (this file):
 *   - Tick-staleness propagation (Req 4.6): `tickStale = true` when
 *     `(now - tickAt) > settings.dataEngine.maxTickAgeMs`, and the
 *     snapshot carries `DATA_TICK_STALE` on its `reasonCodes` array.
 *   - Candle recording (Req 4.7): `ensureRecording(settings)` makes
 *     sure `feedRecorder` is initialised when
 *     `settings.dataEngine.recordCandles === true` so spot ticks,
 *     futures ticks, and 1m / 5m / 15m candles continue to land in
 *     `live-feed/<date>_NIFTY_50/`. Idempotent.
 *   - Option-chain failure (Req 4.8): when `readOptionChain` returns
 *     `null`, the snapshot's `reasonCodes` carries
 *     `OPTION_CHAIN_UNAVAILABLE`.
 *   - Dhan-unreachable degradation (Req 1.5): when both spot and
 *     futures ticks are missing AND no recorded JSONL exists for
 *     today, an info-level event is logged via `engineLogger` and
 *     the cycle still resolves to a fully-shaped snapshot (with
 *     `tickStale = true` so downstream gates short-circuit).
 *
 * Spec references:
 *   - Req 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8 (Data_Engine)
 *   - Req 6.2 (Structure_Engine consumes the AVWAPs)
 *   - Req 1.5 (graceful degradation when Dhan unreachable)
 *   - Req 3.1 (service reuse, no duplication)
 *   - Design "Data_Engine Adapter (Req 4)"
 *   - DataSnapshot typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../../utils/logger');

// ---- Wired data services (Req 3.1) -------------------------------
// Each `require` is a thin wiring point. The adapter never touches
// the underlying transport directly; if a service is unavailable
// (missing env / network down) the per-source helper below catches
// the failure and degrades to a partial snapshot (Req 1.5).
const { instance: dhanLiveFeedProd } = require('../dhanLiveFeedProd.service');
const hybridLiveFeed = require('../hybridLiveFeed.service');
const liveFeedDataProvider = require('../liveFeedDataProvider.service');
const historicalContextService = require('../historicalContext.service');
const niftyFuturesProd = require('../niftyFuturesProd.service');
const dhanOptions = require('../dhanOptions.service');
const { instance: feedRecorder } = require('../feedRecorder.service');
const engineLogger = require('../engineLogger.service');

const { REASON_CODES } = require('./reasonCodes');

// ---- Constants ---------------------------------------------------
// NIFTY 50 spot is published on `IDX_I` with security id 13 (see
// `dhanLiveFeedProd.service.js`). The futures security id is
// resolved per-month via `niftyFuturesProd.service.js`.
const NIFTY_SPOT_SEGMENT = 'IDX_I';
const NIFTY_SPOT_SECURITY_ID = 13;

// The four canonical timeframes the design exposes through the
// `DataSnapshot.candles` map (Req 4.3). Order is significant — every
// timeframe map exposed by this adapter iterates in this order so
// downstream consumers can rely on stable key ordering for hashing
// and audit-row reproducibility (Req 18.4).
const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '1H']);

// Per-timeframe minute width used by the 1H aggregator and by the
// "fully closed bar" gate (`closeTime <= now`).
const TIMEFRAME_MINUTES = Object.freeze({
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1H': 60,
});

// Session window in IST. Used as the AVWAP `sessionOpen` anchor and
// to delimit "today's 1m bars" for the session VWAP (Req 6.2).
// 09:15 IST → 03:45 UTC, 15:30 IST → 10:00 UTC.
const SESSION_OPEN_IST_HHMM = { hour: 9, minute: 15 };
const SESSION_CLOSE_IST_HHMM = { hour: 15, minute: 30 };
// ============================================================
// Helpers
// ============================================================

/**
 * Normalise a raw recorded candle row onto the design's typedef shape.
 *
 * Handles both candle JSONL flavours found in `live-feed/`:
 *   - Spot candles (`candles-1m.jsonl`, written by `feedRecorder`):
 *     `{ t: epochSeconds, o, h, l, c, v }` (no OI).
 *   - Futures candles (`futures-1m.jsonl`, written by
 *     `futuresCandleAggregator`): `{ t: epochMillis, o, h, l, c, v, oi, premium }`.
 *
 * Both flavours surface `t` as the bar's OPEN timestamp. For the
 * adapter's "alignment at close" semantics we expose `closeTime` =
 * `openTime + timeframeMs`. Volume / OI / premium fall back to `0` /
 * `null` consistently. Returned shape is:
 *   `{ openTime, closeTime, open, high, low, close, volume, oi, premium }`.
 *
 * @param {Object} raw         A single JSONL row.
 * @param {number} timeframeMs Bar width in milliseconds (1m → 60_000).
 * @param {('spot'|'futures')} kind Which flavour we're parsing.
 * @returns {Object|null}      Normalised bar or `null` when the row is
 *                             malformed (missing `t` / `c`).
 */
function normaliseRecordedCandle(raw, timeframeMs, kind) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.t !== 'number' || typeof raw.c !== 'number') return null;
  // Spot candles record `t` in seconds (legacy `feedRecorder` format),
  // futures candles record `t` in milliseconds. Detect by magnitude:
  // anything below 1e12 is treated as seconds.
  const openTimeMs = raw.t < 1e12 ? raw.t * 1000 : raw.t;
  const closeTimeMs = openTimeMs + timeframeMs;
  return {
    openTime: openTimeMs,
    closeTime: closeTimeMs,
    open: typeof raw.o === 'number' ? raw.o : raw.c,
    high: typeof raw.h === 'number' ? raw.h : raw.c,
    low: typeof raw.l === 'number' ? raw.l : raw.c,
    close: raw.c,
    volume: typeof raw.v === 'number' ? raw.v : 0,
    oi: kind === 'futures' && typeof raw.oi === 'number' ? raw.oi : null,
    premium: kind === 'futures' && typeof raw.premium === 'number' ? raw.premium : null,
  };
}

/**
 * Aggregate a sorted-ascending array of N-minute bars into M-minute
 * bars (used to derive 1H from 15m, since no recorded 1H file exists).
 *
 * Buckets are aligned to UNIX epoch boundaries — the same convention
 * `futuresCandleAggregator` uses — so the rolled-up 1H bars line up
 * across the spot and futures sides without further normalisation.
 *
 * @param {Array<Object>} sourceBars  Already-normalised bars (closeTime ASC).
 * @param {number}        sourceMin   Source timeframe in minutes (e.g. 15).
 * @param {number}        targetMin   Target timeframe in minutes (e.g. 60).
 * @returns {Array<Object>}           Aggregated bars on the target grid.
 */
function rollupBars(sourceBars, sourceMin, targetMin) {
  if (!Array.isArray(sourceBars) || sourceBars.length === 0) return [];
  if (targetMin <= sourceMin || targetMin % sourceMin !== 0) return [];
  const targetMs = targetMin * 60 * 1000;
  const buckets = new Map();
  for (const bar of sourceBars) {
    if (!bar || typeof bar.openTime !== 'number') continue;
    const bucketStart = Math.floor(bar.openTime / targetMs) * targetMs;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, {
        openTime: bucketStart,
        closeTime: bucketStart + targetMs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
        oi: bar.oi !== null && bar.oi !== undefined ? bar.oi : null,
        premium: bar.premium !== null && bar.premium !== undefined ? bar.premium : null,
      });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
      existing.volume += bar.volume || 0;
      if (typeof bar.oi === 'number') existing.oi = bar.oi;
      if (typeof bar.premium === 'number') existing.premium = bar.premium;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.openTime - b.openTime);
}

/**
 * Align an array of bars at their close timestamps and return only
 * the most recent `lookback` fully-closed bars (Req 4.3).
 *
 * Rules:
 *   - Bars are sorted ASC by `closeTime`.
 *   - "Fully closed" means `closeTime <= now`. An in-progress / partial
 *     bar (whose close timestamp is in the future) is dropped so
 *     downstream EMA / ATR / VWAP calculations operate on stable bars.
 *   - When `lookback` is a positive integer the array is trimmed to
 *     the last `lookback` entries; otherwise the full set is returned.
 *
 * @param {Array<Object>} bars     Normalised bars.
 * @param {number}        nowMs    Current epoch ms (cycle anchor).
 * @param {number}        lookback Desired bar count from
 *                                 `settings.dataEngine.multiTimeframe[tf]`.
 * @returns {Array<Object>}
 */
function alignAndTrim(bars, nowMs, lookback) {
  if (!Array.isArray(bars)) return [];
  const closed = [];
  for (const bar of bars) {
    if (!bar || typeof bar.closeTime !== 'number') continue;
    if (bar.closeTime > nowMs) continue;
    closed.push(bar);
  }
  closed.sort((a, b) => a.closeTime - b.closeTime);
  if (Number.isInteger(lookback) && lookback > 0 && closed.length > lookback) {
    return closed.slice(-lookback);
  }
  return closed;
}

/**
 * Get the IST-day boundary (midnight Asia/Kolkata) preceding `nowMs`,
 * expressed as epoch milliseconds. Used to scope "today's 1m bars"
 * for the session VWAP and the `sessionOpen` AVWAP anchor.
 *
 * Asia/Kolkata is fixed UTC+05:30 with no DST, so a static offset is
 * accurate. Computing it without `Intl.DateTimeFormat` keeps this
 * helper synchronous and cheap.
 *
 * @param {number} nowMs
 * @returns {number} Epoch ms of 00:00 IST on the day containing `nowMs`.
 */
function istDayStart(nowMs) {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  const istNow = nowMs + IST_OFFSET_MS;
  const istMidnight = Math.floor(istNow / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
  return istMidnight - IST_OFFSET_MS;
}

/**
 * Get the IST timestamp (epoch ms) for `09:15` on the same IST day as
 * `nowMs`. The session VWAP and `sessionOpen` AVWAP both anchor here.
 *
 * @param {number} nowMs
 * @returns {number}
 */
function sessionOpenMs(nowMs) {
  return istDayStart(nowMs)
    + (SESSION_OPEN_IST_HHMM.hour * 60 + SESSION_OPEN_IST_HHMM.minute) * 60 * 1000;
}

/**
 * Get the IST timestamp (epoch ms) for the most recent ISO-week start
 * (Monday 00:00 IST) at or before `nowMs`. Used as the `weeklyAnchor`
 * AVWAP anchor (Req 6.2). `Date#getUTCDay` returns 0 for Sunday … 6
 * for Saturday; ISO-week treats Monday as 1.
 *
 * @param {number} nowMs
 * @returns {number}
 */
function weeklyAnchorMs(nowMs) {
  const istMidnight = istDayStart(nowMs);
  const dayOfWeek = new Date(istMidnight + (5 * 60 + 30) * 60 * 1000).getUTCDay();
  // Convert to Mon=0..Sun=6; subtract that many IST-days to land on
  // Monday 00:00 IST.
  const offsetFromMonday = (dayOfWeek + 6) % 7;
  return istMidnight - offsetFromMonday * 24 * 60 * 60 * 1000;
}

/**
 * Compute a typical-price-weighted VWAP from `anchorMs` (inclusive)
 * onwards across an array of 1m bars. Returns `null` when no bar
 * crosses the anchor (e.g. anchor is in the future, or the bar set
 * is empty).
 *
 * Formula (Req 6.2): `Σ((H+L+C)/3 × V) / Σ V`. When all volumes are
 * zero (rare with NIFTY but possible in synthetic / pre-market data)
 * the function falls back to a simple typical-price average so the
 * AVWAP is still defined.
 *
 * @param {Array<Object>} oneMinBars Aligned 1m bars (closeTime ASC).
 * @param {number}        anchorMs   Epoch ms; bars whose `openTime >=
 *                                   anchorMs` participate.
 * @returns {number|null}
 */
function vwapFromAnchor(oneMinBars, anchorMs) {
  if (!Array.isArray(oneMinBars) || oneMinBars.length === 0) return null;
  if (typeof anchorMs !== 'number' || !Number.isFinite(anchorMs)) return null;
  let pv = 0;
  let v = 0;
  let tpSum = 0;
  let tpCount = 0;
  for (const bar of oneMinBars) {
    if (!bar || typeof bar.close !== 'number') continue;
    if (typeof bar.openTime !== 'number' || bar.openTime < anchorMs) continue;
    const tp = (bar.high + bar.low + bar.close) / 3;
    const vol = typeof bar.volume === 'number' ? bar.volume : 0;
    pv += tp * vol;
    v += vol;
    tpSum += tp;
    tpCount += 1;
  }
  if (tpCount === 0) return null;
  if (v > 0) return Number((pv / v).toFixed(4));
  return Number((tpSum / tpCount).toFixed(4));
}

/**
 * Locate the bar in which the prior-day high (or low) printed, so the
 * AVWAP anchor lands on a real bar inside the lookback window. The
 * input is the 1m bar array we already aligned for this cycle (which
 * spans only "today" from `liveFeedDataProvider`); when the prior-day
 * extreme is not represented inside the array we fall back to the
 * earliest available bar's `openTime`. That keeps the anchor inside
 * the data window and matches the design's pragmatic AVWAP semantics.
 *
 * @param {Array<Object>} oneMinBars   Aligned 1m bars (closeTime ASC).
 * @param {number|null}   priorExtreme Prior-day high or low.
 * @returns {number|null}
 */
function resolvePriorDayAnchor(oneMinBars, priorExtreme) {
  if (!Array.isArray(oneMinBars) || oneMinBars.length === 0) return null;
  if (typeof priorExtreme !== 'number' || !Number.isFinite(priorExtreme)) {
    return oneMinBars[0].openTime;
  }
  // Try to find the bar that traded through the prior extreme. We
  // accept the first bar whose [low, high] envelope contains the
  // extreme — this is exactly the bar where the level was respected
  // (or breached) for the first time today.
  for (const bar of oneMinBars) {
    if (typeof bar.low !== 'number' || typeof bar.high !== 'number') continue;
    if (bar.low <= priorExtreme && bar.high >= priorExtreme) {
      return bar.openTime;
    }
  }
  // Anchor not represented in the available window ⇒ use the earliest
  // bar so the VWAP is still defined.
  return oneMinBars[0].openTime;
}

/**
 * Compute the session VWAP and the four AVWAP anchors required by
 * Structure_Engine (Req 6.2). Anchors not enabled in
 * `settings.structureEngine.avwapAnchors` are emitted as `null`,
 * letting the operator disable any anchor at runtime.
 *
 * Output shape (matches the design typedef):
 *   `{ session, anchors: { sessionOpen, priorDayHigh, priorDayLow, weeklyAnchor } }`
 *
 * Each value is either a finite number (the latest cumulative VWAP
 * from anchor → most recent 1m bar) or `null` when there is not
 * enough data to compute it.
 *
 * @param {Array<Object>} spotOneMinBars  Aligned 1m spot bars.
 * @param {number}        nowMs
 * @param {Readonly<Object>} settings
 * @param {Object}        priorDay        Prior-day OHLC block.
 * @returns {{ session: number|null, anchors: { sessionOpen: number|null, priorDayHigh: number|null, priorDayLow: number|null, weeklyAnchor: number|null } }}
 */
function computeVwapBlock(spotOneMinBars, nowMs, settings, priorDay) {
  const enabled = new Set(
    Array.isArray(settings && settings.structureEngine && settings.structureEngine.avwapAnchors)
      ? settings.structureEngine.avwapAnchors
      : []
  );

  const sessionAnchor = sessionOpenMs(nowMs);
  const session = vwapFromAnchor(spotOneMinBars, sessionAnchor);

  const sessionOpenAnchor = enabled.has('sessionOpen')
    ? vwapFromAnchor(spotOneMinBars, sessionAnchor)
    : null;

  const priorDayHighAnchor = enabled.has('priorDayHigh')
    ? vwapFromAnchor(spotOneMinBars, resolvePriorDayAnchor(spotOneMinBars, priorDay && priorDay.high))
    : null;

  const priorDayLowAnchor = enabled.has('priorDayLow')
    ? vwapFromAnchor(spotOneMinBars, resolvePriorDayAnchor(spotOneMinBars, priorDay && priorDay.low))
    : null;

  const weeklyAnchorAnchor = enabled.has('weeklyAnchor')
    ? vwapFromAnchor(spotOneMinBars, weeklyAnchorMs(nowMs))
    : null;

  return {
    session,
    anchors: {
      sessionOpen: sessionOpenAnchor,
      priorDayHigh: priorDayHighAnchor,
      priorDayLow: priorDayLowAnchor,
      weeklyAnchor: weeklyAnchorAnchor,
    },
  };
}

/**
 * Load and align the multi-timeframe candle map for a single side
 * (`spot` or `futures`). Wraps the file reader in try/catch so a
 * missing or corrupt JSONL file degrades to an empty array for that
 * timeframe rather than blowing up the cycle (Req 1.5, Req 4.4).
 *
 * Source layout:
 *   - 1m / 5m / 15m: `live-feed/<date>_NIFTY_50/<kind>-<tf>.jsonl`
 *     written by `scalpingDataAggregator` (spot) and
 *     `futuresCandleAggregator` (futures).
 *   - 1H: rolled up from 15m on epoch boundaries, since no recorded
 *     1H file exists in the live-feed layout.
 *
 * Returns both the trimmed `tf` map (the snapshot view) and the
 * `oneMinFull` array (every closed 1m bar of the day, untrimmed),
 * so the caller can compute the session VWAP / AVWAP anchors against
 * the full intraday window even when the snapshot lookback is small.
 *
 * @param {('candles'|'futures')} kind  File prefix (`candles` for spot).
 * @param {string} todayIst             YYYY-MM-DD, IST.
 * @param {number} nowMs                Cycle anchor (ms).
 * @param {Readonly<Object>} settings   Algo_Settings snapshot.
 * @returns {{ tf: { '1m': Array, '5m': Array, '15m': Array, '1H': Array }, oneMinFull: Array }}
 */
function loadAlignedCandles(kind, todayIst, nowMs, settings) {
  const lookbacks = (settings && settings.dataEngine && settings.dataEngine.multiTimeframe) || {};
  const flavour = kind === 'futures' ? 'futures' : 'spot';
  const tf = { '1m': [], '5m': [], '15m': [], '1H': [] };
  let oneMinFull = [];

  for (const key of ['1m', '5m', '15m']) {
    let raw;
    try {
      raw = liveFeedDataProvider.readCandlesFromFile(todayIst, key, kind);
    } catch (err) {
      logger.warn(
        { err: err && err.message, kind, tf: key },
        '[dataEngine.adapter] readCandlesFromFile failed'
      );
      raw = [];
    }
    if (!Array.isArray(raw)) raw = [];
    const tfMs = TIMEFRAME_MINUTES[key] * 60 * 1000;
    const normalised = [];
    for (const row of raw) {
      // `liveFeedDataProvider.readCandlesFromFile` already maps
      // `{t,o,h,l,c,v,oi}` onto `{time, open, high, low, close,
      // volume, oi}`, but it strips the `premium` field and uses
      // its own `time` key. Re-normalise via a synthetic row that
      // matches the JSONL schema so we keep one canonical mapper.
      const synthetic = {
        t: row.time,
        o: row.open,
        h: row.high,
        l: row.low,
        c: row.close,
        v: row.volume,
        oi: row.oi,
      };
      const bar = normaliseRecordedCandle(synthetic, tfMs, flavour);
      if (bar) normalised.push(bar);
    }
    tf[key] = alignAndTrim(normalised, nowMs, lookbacks[key]);
    if (key === '1m') {
      // Untrimmed full-day 1m slice for session VWAP / AVWAP anchors.
      // We still drop in-progress bars and sort ASC by closeTime so
      // anchor resolution is deterministic.
      oneMinFull = alignAndTrim(normalised, nowMs, undefined);
    }
  }

  // 1H is derived from the 15m series; we roll up BEFORE trimming so
  // the 1H bars include partial-day context, then trim to the
  // requested lookback.
  let raw15;
  try {
    raw15 = liveFeedDataProvider.readCandlesFromFile(todayIst, '15m', kind);
  } catch (err) {
    logger.warn(
      { err: err && err.message, kind },
      '[dataEngine.adapter] readCandlesFromFile (15m for 1H rollup) failed'
    );
    raw15 = [];
  }
  if (!Array.isArray(raw15)) raw15 = [];
  const fifteenMin = [];
  for (const row of raw15) {
    const synthetic = {
      t: row.time,
      o: row.open,
      h: row.high,
      l: row.low,
      c: row.close,
      v: row.volume,
      oi: row.oi,
    };
    const bar = normaliseRecordedCandle(synthetic, 15 * 60 * 1000, flavour);
    if (bar) fifteenMin.push(bar);
  }
  const oneHour = rollupBars(
    fifteenMin.sort((a, b) => a.openTime - b.openTime),
    15,
    60
  );
  tf['1H'] = alignAndTrim(oneHour, nowMs, lookbacks['1H']);

  return { tf, oneMinFull };
}

/**
 * Build the multi-timeframe candle map for both sides per the design
 * typedef. Keys are `1m | 5m | 15m | 1H` (Req 4.3); values are arrays
 * of fully-closed bars sorted ASC by close timestamp.
 *
 * In addition to the snapshot-shaped `spot` / `futures` maps the
 * function returns the untrimmed full-day 1m spot bars, used by
 * `computeVwapBlock` so the session VWAP and AVWAP anchors span the
 * entire intraday window even when the snapshot lookback is short.
 *
 * The function never throws — failures inside `loadAlignedCandles`
 * collapse to empty timeframe arrays and are logged.
 *
 * @param {string} todayIst
 * @param {number} nowMs
 * @param {Readonly<Object>} settings
 * @returns {{ spot: Object, futures: Object, spotOneMinFull: Array }}
 */
function buildTimeframeCandles(todayIst, nowMs, settings) {
  let spotResult = { tf: { '1m': [], '5m': [], '15m': [], '1H': [] }, oneMinFull: [] };
  let futuresResult = { tf: { '1m': [], '5m': [], '15m': [], '1H': [] }, oneMinFull: [] };
  try {
    spotResult = loadAlignedCandles('candles', todayIst, nowMs, settings);
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] buildTimeframeCandles spot failed');
  }
  try {
    futuresResult = loadAlignedCandles('futures', todayIst, nowMs, settings);
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] buildTimeframeCandles futures failed');
  }
  return {
    spot: spotResult.tf,
    futures: futuresResult.tf,
    spotOneMinFull: spotResult.oneMinFull,
  };
}

/**
 * ============================================================
 * REPLAY-MODE READERS (subtask 18.1 enhancement)
 * ============================================================
 * The original 18.1 wiring only changed the IST date used for
 * prior-day lookups. It did NOT redirect the spot / futures /
 * option-chain readers to the recorded JSONL — they still hit
 * the live WebSocket / Dhan API which obviously returns
 * nothing on a closed-market / out-of-session day.
 *
 * The replay readers below load each block from the same
 * `live-feed/<date>_NIFTY_50/` folder the orchestrator pointed
 * Data_Engine at:
 *
 *   - `spot.jsonl`         → `_loadReplaySpotTicks`
 *   - `option-chain.jsonl` → `_loadReplayOptionChain`
 *   - `futures-ticks.jsonl` (preferred) / `futures-1m.jsonl`
 *                          → `_loadReplayFuturesTicks`
 *
 * Each reader caches its file contents per cycle by mtime so we
 * pay the disk read cost once per file change rather than once
 * per cycle. The cache is keyed by absolute path so multiple
 * concurrent replay folders don't collide.
 *
 * Time-coordinate shape for the replay path: the orchestrator
 * passes `now` as today's epoch (Date.now()). We translate that
 * into a "session offset" against the recorded session's
 * 09:15 IST boundary so cycles tick through the recorded ticks
 * proportionally. This is implemented inside
 * `_resolveReplayClock` further below.
 *
 * Heavy redaction is NOT performed here — `auditLog.js` already
 * strips the candle arrays before persistence.
 * ============================================================
 */

/**
 * Per-process JSONL cache keyed by absolute file path. Each
 * entry stores `{ mtimeMs, lines }` so re-reads only fire when
 * the underlying file has changed (which never happens during a
 * backtest, so the cost is one disk read per file per backtest).
 *
 * @type {Map<string, { mtimeMs: number, lines: Object[] }>}
 */
const _replayJsonlCache = new Map();

/**
 * Parse a JSONL file with simple per-process caching. Returns
 * the parsed lines as an array of plain objects. Malformed
 * lines are silently skipped.
 *
 * @param {string} absPath
 * @returns {Object[]}
 */
function _readJsonl(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (_) {
    return [];
  }
  const cached = _replayJsonlCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.lines;
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line));
    } catch (_) {
      /* skip malformed line */
    }
  }
  _replayJsonlCache.set(absPath, { mtimeMs: stat.mtimeMs, lines });
  return lines;
}

/**
 * Find the index of the last entry in `lines` whose `t` field
 * (epoch ms OR seconds) is `<= cursorMs`. Returns `-1` when
 * `cursorMs` precedes the first row. Both ms / s `t` shapes are
 * handled — values < 1e12 are treated as seconds.
 *
 * @param {Object[]} lines
 * @param {number}   cursorMs
 * @returns {number}
 */
function _findIndexAtOrBefore(lines, cursorMs) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = lines[mid] && typeof lines[mid].t === 'number'
      ? (lines[mid].t < 1e12 ? lines[mid].t * 1000 : lines[mid].t)
      : NaN;
    if (!Number.isFinite(t)) return -1;
    if (t <= cursorMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Resolve the active "replay clock" — the epoch ms inside the
 * recorded session that the current cycle should pretend to be
 * "now". The orchestrator's `tNow = Date.now()` is mapped onto
 * the recorded session's 09:15 IST → 15:30 IST window
 * proportionally based on the replay run's wall-clock progress.
 *
 * The mapping rule:
 *   - The first call after a backtest start "anchors" the wall
 *     clock to the recorded session's open (09:15 IST of the
 *     replay date).
 *   - Subsequent calls advance the replay clock by `(tNow -
 *     anchorWall)` so the recorded session plays back at 1×
 *     speed by default. (Operator-driven 10× speed-up is a
 *     follow-up: it would just multiply the elapsed time.)
 *
 * State is per-`replayFolder` so two backtests against
 * different recorded days don't share an anchor.
 *
 * @type {Map<string, { wallAnchor: number, replayAnchor: number }>}
 */
const _replayClockState = new Map();

/**
 * Compute the start-of-session IST 09:15 epoch ms for a YYYY-MM-DD.
 *
 * @param {string} replayDate  YYYY-MM-DD (IST trading session date).
 * @returns {number}           Epoch ms at 09:15 IST.
 */
function _sessionOpenEpoch(replayDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(replayDate)) return Date.now();
  const [y, m, d] = replayDate.split('-').map(Number);
  // 09:15 IST = 03:45 UTC.
  return Date.UTC(y, m - 1, d, 3, 45, 0);
}

/**
 * Resolve the replay clock for the current cycle.
 *
 * Called once per cycle. Returns the epoch-ms cursor inside the
 * recorded session that the readers should treat as "now".
 *
 * @param {string} replayFolder
 * @param {string} replayDate     YYYY-MM-DD
 * @param {number} wallNowMs      `Date.now()` at the cycle boundary.
 * @returns {number}              Epoch ms cursor inside the session.
 */
function _resolveReplayClock(replayFolder, replayDate, wallNowMs) {
  const sessionOpen = _sessionOpenEpoch(replayDate);
  const sessionClose = sessionOpen + (6 * 60 + 15) * 60 * 1000; // 09:15 → 15:30 IST
  let state = _replayClockState.get(replayFolder);
  if (!state) {
    state = { wallAnchor: wallNowMs, replayAnchor: sessionOpen };
    _replayClockState.set(replayFolder, state);
  }
  const elapsed = wallNowMs - state.wallAnchor;
  // Speed multiplier — operator-controlled compression of wall-clock
  // to session-time. `setReplaySpeedMultiplier(N)` makes the cursor
  // advance N× faster than wall-clock, so a 6h15m session finishes
  // in roughly 6h15m / N. Default 1× (real-time replay).
  const cursor0 = state.replayAnchor + elapsed * _replaySpeedMultiplier;
  let cursor = cursor0;
  if (cursor < sessionOpen) cursor = sessionOpen;
  if (cursor > sessionClose) cursor = sessionClose;
  return cursor;
}

/**
 * Operator-controlled replay-speed multiplier. `1` = real-time;
 * `2` = 2× faster than wall-clock; `10` = 10× faster, etc. Used
 * by `_resolveReplayClock` to compress a 6h15m session window
 * into a shorter wall-clock window. Default: 1×.
 *
 * Bounds: `[1, 100]` — anything outside that range is clamped so
 * a typo can't peg the prediction loop or stall the cursor.
 *
 * @type {number}
 */
let _replaySpeedMultiplier = 1;

/**
 * Set the replay-speed multiplier. Returns the value that was
 * actually applied (after clamping). The orchestrator's
 * `setReplaySpeedMultiplier` setter forwards the operator's
 * choice here on `start()`.
 *
 * @param {number} n
 * @returns {number}
 */
function setReplaySpeedMultiplier(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 1;
  _replaySpeedMultiplier = Math.max(1, Math.min(100, v));
  return _replaySpeedMultiplier;
}

function getReplaySpeedMultiplier() {
  return _replaySpeedMultiplier;
}

/**
 * Reset the replay-clock anchor for a folder. Invoked by the
 * backtest driver on `start()` so each run begins at session
 * open even if the same folder was just replayed.
 *
 * @param {string} [replayFolder]  When omitted, clears all state.
 * @returns {void}
 */
function resetReplayClock(replayFolder) {
  if (!replayFolder) {
    _replayClockState.clear();
    return;
  }
  _replayClockState.delete(replayFolder);
}

/**
 * Load the spot block for the replay cursor from `spot.jsonl`.
 * The file is the raw `feedRecorder.appendSpotTick` stream:
 *
 *   `{ t: epochMs, ltp, ltt, volume, open, high, low, close, ... }`
 *
 * Returns the same shape `readSpotFromWebSocket` produces so the
 * caller doesn't have to branch.
 *
 * @param {string} replayFolder
 * @param {number} cursorMs
 * @returns {{ o:number|null, h:number|null, l:number|null, c:number|null, ltp:number|null, tickAt:number|null }}
 */
function _loadReplaySpotTick(replayFolder, cursorMs) {
  const file = path.join(replayFolder, 'spot.jsonl');
  const lines = _readJsonl(file);
  if (lines.length === 0) {
    return { o: null, h: null, l: null, c: null, ltp: null, tickAt: null };
  }
  const idx = _findIndexAtOrBefore(lines, cursorMs);
  if (idx < 0) {
    // Use the very first row so the snapshot has a non-null LTP
    // even at session open (better than null and forces tickStale
    // anyway because the cursor will be pre-row).
    const first = lines[0];
    const t = typeof first.t === 'number'
      ? (first.t < 1e12 ? first.t * 1000 : first.t)
      : null;
    return {
      o: typeof first.open === 'number' ? first.open : null,
      h: typeof first.high === 'number' ? first.high : null,
      l: typeof first.low === 'number' ? first.low : null,
      c: typeof first.close === 'number' ? first.close : null,
      ltp: typeof first.ltp === 'number' ? first.ltp : null,
      tickAt: t,
    };
  }
  const row = lines[idx];
  const t = typeof row.t === 'number'
    ? (row.t < 1e12 ? row.t * 1000 : row.t)
    : null;
  return {
    o: typeof row.open === 'number' ? row.open : null,
    h: typeof row.high === 'number' ? row.high : null,
    l: typeof row.low === 'number' ? row.low : null,
    c: typeof row.close === 'number' ? row.close : null,
    ltp: typeof row.ltp === 'number' ? row.ltp : null,
    tickAt: t,
  };
}

/**
 * Load the futures block for the replay cursor. Prefer
 * `futures-ticks.jsonl` (per-tick stream, written by 2026-05-14
 * onwards) and fall back to the latest `futures-1m.jsonl` row
 * when the tick file is absent for older recordings.
 *
 * @param {string} replayFolder
 * @param {number} cursorMs
 * @param {{ ltp:number|null }} spotBlock
 * @returns {{ o:number|null, h:number|null, l:number|null, c:number|null, ltp:number|null, oi:number|null, oiChange:number|null, premiumToSpot:number|null, tickAt:number|null }}
 */
function _loadReplayFuturesTick(replayFolder, cursorMs, spotBlock) {
  const tickFile = path.join(replayFolder, 'futures-ticks.jsonl');
  const candleFile1m = path.join(replayFolder, 'futures-1m.jsonl');
  const candleFile5m = path.join(replayFolder, 'futures-5m.jsonl');
  const candleFile15m = path.join(replayFolder, 'futures-15m.jsonl');
  let row = null;
  let tickAt = null;
  const tickLines = _readJsonl(tickFile);
  if (tickLines.length > 0) {
    const idx = _findIndexAtOrBefore(tickLines, cursorMs);
    if (idx >= 0) {
      row = tickLines[idx];
      tickAt = typeof row.t === 'number'
        ? (row.t < 1e12 ? row.t * 1000 : row.t)
        : null;
    }
  }
  // Fall back to 1m candles, then 5m, then 15m (some Dhan backfill
  // days only land 5m / 15m because the 1m endpoint hit a rate
  // limit). This keeps `premiumToSpot` populated whenever ANY
  // futures candle file exists for the day.
  if (!row) {
    for (const file of [candleFile1m, candleFile5m, candleFile15m]) {
      const candleLines = _readJsonl(file);
      if (candleLines.length === 0) continue;
      const idx = _findIndexAtOrBefore(candleLines, cursorMs);
      if (idx < 0) continue;
      row = candleLines[idx];
      tickAt = typeof row.t === 'number'
        ? (row.t < 1e12 ? row.t * 1000 : row.t)
        : null;
      break;
    }
  }
  if (!row) {
    return {
      o: null, h: null, l: null, c: null, ltp: null,
      oi: null, oiChange: null, premiumToSpot: null, tickAt: null,
    };
  }
  const ltp = typeof row.ltp === 'number'
    ? row.ltp
    : (typeof row.c === 'number' ? row.c : null);
  const oi = typeof row.oi === 'number' ? row.oi : null;
  // Prefer the recorded `premium` field (futures premium-to-spot
  // written per-bar by `futuresCandleAggregator` / backfill) when
  // present; otherwise fall back to (futures.ltp - spot.ltp).
  let premiumToSpot = typeof row.premium === 'number' ? row.premium : null;
  if (premiumToSpot === null
    && spotBlock && typeof spotBlock.ltp === 'number'
    && typeof ltp === 'number') {
    premiumToSpot = Number((ltp - spotBlock.ltp).toFixed(2));
  }
  return {
    o: typeof row.o === 'number' ? row.o : ltp,
    h: typeof row.h === 'number' ? row.h : ltp,
    l: typeof row.l === 'number' ? row.l : ltp,
    c: typeof row.c === 'number' ? row.c : ltp,
    ltp,
    oi,
    oiChange: null, // Not directly recorded; OI_Engine derives Δ from per-strike data.
    premiumToSpot,
    tickAt,
  };
}

/**
 * Load the option-chain snapshot for the replay cursor from
 * `option-chain.jsonl`. The recorder writes one line per ATM-snap
 * with the shape:
 *
 *   `{ t: epochMs, spot, atm, expiry, strikes: [{ strike, ce: {...}, pe: {...} }] }`
 *
 * which is already aligned with the design's option-chain typedef
 * — we just normalise the per-strike shape to the `{ strike, ce,
 * pe }` form that `readOptionChain` returns.
 *
 * @param {string} replayFolder
 * @param {number} cursorMs
 * @returns {Object|null}
 */
function _loadReplayOptionChain(replayFolder, cursorMs) {
  const file = path.join(replayFolder, 'option-chain.jsonl');
  const lines = _readJsonl(file);
  if (lines.length === 0) return null;
  const idx = _findIndexAtOrBefore(lines, cursorMs);
  if (idx < 0) return null;
  const snap = lines[idx];
  if (!snap || !Array.isArray(snap.strikes) || snap.strikes.length === 0) return null;
  return {
    atmStrike: typeof snap.atm === 'number' ? snap.atm : null,
    expiry: typeof snap.expiry === 'string' ? snap.expiry : null,
    strikes: snap.strikes.map((row) => ({
      strike: row.strike,
      ce: row.ce ? {
        ltp: row.ce.ltp,
        oi: row.ce.oi,
        oiChange: typeof row.ce.oiChg === 'number' ? row.ce.oiChg : (typeof row.ce.oiChange === 'number' ? row.ce.oiChange : null),
        iv: row.ce.iv,
        delta: typeof row.ce.delta === 'number' ? row.ce.delta : null,
        gamma: typeof row.ce.gamma === 'number' ? row.ce.gamma : null,
      } : null,
      pe: row.pe ? {
        ltp: row.pe.ltp,
        oi: row.pe.oi,
        oiChange: typeof row.pe.oiChg === 'number' ? row.pe.oiChg : (typeof row.pe.oiChange === 'number' ? row.pe.oiChange : null),
        iv: row.pe.iv,
        delta: typeof row.pe.delta === 'number' ? row.pe.delta : null,
        gamma: typeof row.pe.gamma === 'number' ? row.pe.gamma : null,
      } : null,
    })),
  };
}

/**
 * Read the current NIFTY 50 spot tick from the WebSocket snapshot.
 * Returns a normalised `{ o, h, l, c, ltp }` block.
 *
 * Falls back to `{ ltp: null, ... }` when the snapshot is empty (no
 * connection / pre-market) so the snapshot shape stays consistent.
 *
 * @returns {{ o:number|null, h:number|null, l:number|null, c:number|null, ltp:number|null, tickAt:number|null }}
 */
function readSpotFromWebSocket() {
  try {
    const tick = dhanLiveFeedProd.getTick(NIFTY_SPOT_SEGMENT, NIFTY_SPOT_SECURITY_ID);
    if (!tick || typeof tick.ltp !== 'number') {
      return { o: null, h: null, l: null, c: null, ltp: null, tickAt: null };
    }
    return {
      o: typeof tick.open === 'number' ? tick.open : null,
      h: typeof tick.high === 'number' ? tick.high : null,
      l: typeof tick.low === 'number' ? tick.low : null,
      c: typeof tick.close === 'number' ? tick.close : null,
      ltp: tick.ltp,
      tickAt: typeof tick.updatedAt === 'number' ? tick.updatedAt : null,
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] readSpotFromWebSocket failed');
    return { o: null, h: null, l: null, c: null, ltp: null, tickAt: null };
  }
}

/**
 * Read the current NIFTY futures tick + analytics from
 * `niftyFuturesProd.service.js`. Returns a normalised futures block
 * carrying `oi`, `oiChange`, and `premiumToSpot` per the design
 * typedef. All three are emitted as `null` when the live tick is
 * unavailable so Signal_Engine can detect missing data via the
 * standard null-check rather than a special enum.
 *
 * @param {{ ltp: number|null }} spotBlock  Spot LTP used for premium calc.
 * @returns {Promise<{ o:number|null, h:number|null, l:number|null, c:number|null, ltp:number|null, oi:number|null, oiChange:number|null, premiumToSpot:number|null, tickAt:number|null }>}
 */
async function readFuturesBlock(spotBlock) {
  // If we don't have a live spot LTP, skip the futures fetch entirely.
  // `niftyFuturesProd.getLiveTick()` resolves the near-month contract
  // via the Dhan scrip-master CSV which is a 20MB outbound fetch — we
  // do NOT want to incur that on a cycle that's already going to be
  // marked DATA_TICK_STALE downstream (Req 4.6). The same short-circuit
  // applies in the smoke check, where no WebSocket is connected.
  if (!spotBlock || typeof spotBlock.ltp !== 'number') {
    return {
      o: null, h: null, l: null, c: null, ltp: null,
      oi: null, oiChange: null, premiumToSpot: null, tickAt: null,
    };
  }
  try {
    const live = await niftyFuturesProd.getLiveTick();
    if (!live || typeof live.ltp !== 'number') {
      return {
        o: null, h: null, l: null, c: null, ltp: null,
        oi: null, oiChange: null, premiumToSpot: null, tickAt: null,
      };
    }
    const oi = typeof live.oi === 'number' ? live.oi : null;
    const prevOi = typeof live.prevOi === 'number' ? live.prevOi : null;
    const oiChange = oi !== null && prevOi !== null ? oi - prevOi : null;
    const premiumToSpot = spotBlock && typeof spotBlock.ltp === 'number'
      ? Number((live.ltp - spotBlock.ltp).toFixed(2))
      : null;
    return {
      o: typeof live.open === 'number' ? live.open : null,
      h: typeof live.high === 'number' ? live.high : null,
      l: typeof live.low === 'number' ? live.low : null,
      c: typeof live.close === 'number' ? live.close : null,
      ltp: live.ltp,
      oi,
      oiChange,
      premiumToSpot,
      tickAt: typeof live.updatedAt === 'number' ? live.updatedAt : null,
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] readFuturesBlock failed');
    return {
      o: null, h: null, l: null, c: null, ltp: null,
      oi: null, oiChange: null, premiumToSpot: null, tickAt: null,
    };
  }
}

/**
 * Best-effort option-chain fetch via `dhanOptions.service.js`. The
 * option chain is mandatory for OI_Engine / PCR_Engine / Signal_Engine
 * (Req 4.8) — when this returns `null`, the caller (`fetchDataSnapshot`)
 * pushes `OPTION_CHAIN_UNAVAILABLE` onto the snapshot's `reasonCodes`
 * so the orchestrator's downstream gates can short-circuit to
 * NO_TRADE. This helper just returns the best-effort value.
 *
 * @param {{ ltp:number|null }} spotBlock
 * @returns {Promise<Object|null>}
 */
async function readOptionChain(spotBlock) {
  try {
    const spotPrice = spotBlock && typeof spotBlock.ltp === 'number' ? spotBlock.ltp : null;
    if (spotPrice === null) return null;
    const res = await dhanOptions.getNiftyOptionChain(spotPrice);
    if (!res || res.ok !== true || !res.data) return null;
    const { atmStrike, expiry, optionChain } = res.data;
    if (!Array.isArray(optionChain) || optionChain.length === 0) return null;
    return {
      atmStrike: typeof atmStrike === 'number' ? atmStrike : null,
      expiry: typeof expiry === 'string' ? expiry : null,
      // Map `dhanOptions` row shape onto the design's per-strike shape.
      strikes: optionChain.map((row) => ({
        strike: row.strike,
        ce: row.call ? {
          ltp: row.call.ltp,
          oi: row.call.oi,
          oiChange: typeof row.call.oiChange === 'number' ? row.call.oiChange : null,
          iv: row.call.iv,
          delta: row.call.delta,
          gamma: typeof row.call.gamma === 'number' ? row.call.gamma : null,
        } : null,
        pe: row.put ? {
          ltp: row.put.ltp,
          oi: row.put.oi,
          oiChange: typeof row.put.oiChange === 'number' ? row.put.oiChange : null,
          iv: row.put.iv,
          delta: row.put.delta,
          gamma: typeof row.put.gamma === 'number' ? row.put.gamma : null,
        } : null,
      })),
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] readOptionChain failed');
    return null;
  }
}

/**
 * Resolve the prior-day block from `historicalContext.service.js`.
 * Maps the service's snake_case fields onto the design's camelCase
 * typedef. Always returns the documented shape — missing pieces are
 * surfaced as `null` so downstream gates can detect them.
 *
 * @param {string} todayIst  YYYY-MM-DD (Asia/Kolkata).
 * @returns {Promise<{ high:number|null, low:number|null, close:number|null, openingRange:Object|null, weeklyHigh:number|null, weeklyLow:number|null, swings:Array }>}
 */
async function readPriorDayContext(todayIst) {
  try {
    const ctx = await historicalContextService.getHistoricalContext(todayIst);
    if (!ctx || ctx.available !== true) {
      return {
        high: null, low: null, close: null, openingRange: null,
        weeklyHigh: null, weeklyLow: null, swings: [],
      };
    }
    const yest = ctx.yesterday || null;
    return {
      high: yest && typeof yest.high === 'number' ? yest.high : null,
      low: yest && typeof yest.low === 'number' ? yest.low : null,
      close: yest && typeof yest.close === 'number' ? yest.close : null,
      openingRange: ctx.opening_range
        ? {
            h: ctx.opening_range.high,
            l: ctx.opening_range.low,
          }
        : null,
      weeklyHigh: typeof ctx.weekly_high === 'number' ? ctx.weekly_high : null,
      weeklyLow: typeof ctx.weekly_low === 'number' ? ctx.weekly_low : null,
      swings: yest
        ? [
            ...(Array.isArray(yest.key_swing_highs) ? yest.key_swing_highs : []),
            ...(Array.isArray(yest.key_swing_lows) ? yest.key_swing_lows : []),
          ]
        : [],
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] readPriorDayContext failed');
    return {
      high: null, low: null, close: null, openingRange: null,
      weeklyHigh: null, weeklyLow: null, swings: [],
    };
  }
}

/**
 * Decide whether today's data is being served from the recorded
 * JSONL replay (`recordedToday = true`) or sourced live (`false`).
 * Per Req 4.4, JSONL is preferred when present.
 *
 * `liveFeedDataProvider.getStats()` reports both the existence of
 * the dated folder and per-interval line counts; we treat any
 * non-empty 1m candles file as evidence of same-day recording.
 *
 * @returns {boolean}
 */
function resolveRecordedToday() {
  try {
    const stats = liveFeedDataProvider.getStats();
    if (!stats || stats.folderExists !== true) return false;
    const onem = stats.files && stats.files['candles-1m'];
    return !!(onem && onem.exists && onem.lines > 0);
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] resolveRecordedToday failed');
    return false;
  }
}

/**
 * Acknowledge the polling fallback (`hybridLiveFeed`) is wired and
 * report its WebSocket state. The orchestrator uses this only for
 * audit; the actual fallback routing happens inside
 * `hybridLiveFeed.subscribe()` when the WebSocket is down.
 *
 * @returns {{ websocketConnected: boolean }|null}
 */
function probePollingFallback() {
  try {
    if (!hybridLiveFeed || typeof hybridLiveFeed.getStatus !== 'function') return null;
    const status = hybridLiveFeed.getStatus();
    return {
      websocketConnected: !!(status && status.websocketConnected),
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[dataEngine.adapter] probePollingFallback failed');
    return null;
  }
}

// ============================================================
// Recording lifecycle (Req 4.7)
// ============================================================

// Tracks whether `feedRecorder` has been initialised for the current
// process. The `init()` call schedules the day-rollover timer and
// prunes stale folders; we only want to do that once. Subsequent
// `ensureRecording()` calls become no-ops.
let recordingInitialised = false;
// Tracks the last `recordCandles` toggle we honoured so we can log a
// transition event (start / stop) instead of spamming on every cycle.
let recordingEnabled = false;

/**
 * Make sure the existing candle / tick recording pipeline is live for
 * this process when `settings.dataEngine.recordCandles === true`
 * (Req 4.7). Calling this on every cycle is intentional: it lets the
 * orchestrator hot-flip the toggle through `algoSettings.updateSettings`
 * without a process restart (Req 2.4).
 *
 * The actual writes happen inside `feedRecorder.service.js` (spot ticks
 * via `dhanLiveFeedProd`, futures ticks via the same path, and
 * 1m / 5m / 15m candles fed by `scalpingDataAggregator` /
 * `futuresCandleAggregator`). This adapter just ensures the recorder
 * has been initialised — once `init()` runs, every tick the live feed
 * receives during market hours is streamed to disk.
 *
 * When `recordCandles === false` we deliberately do NOT shut down the
 * recorder; tearing the streams down mid-cycle would race with the
 * write paths above. Instead we log a single transition event and let
 * `_isMarketHours()` short-circuit the writes inside the recorder
 * itself.
 *
 * @param {Readonly<Object>} settings  Frozen Algo_Settings snapshot.
 */
function ensureRecording(settings) {
  const wantRecord = !!(settings && settings.dataEngine && settings.dataEngine.recordCandles);

  if (wantRecord && !recordingInitialised) {
    try {
      if (feedRecorder && typeof feedRecorder.init === 'function') {
        feedRecorder.init();
      }
      recordingInitialised = true;
    } catch (err) {
      logger.warn(
        { err: err && err.message },
        '[dataEngine.adapter] feedRecorder.init failed'
      );
    }
  }

  if (wantRecord !== recordingEnabled) {
    recordingEnabled = wantRecord;
    logger.info(
      { recordCandles: wantRecord },
      wantRecord
        ? '[dataEngine.adapter] candle recording enabled (Req 4.7)'
        : '[dataEngine.adapter] candle recording disabled (Req 4.7)'
    );
  }
}

// ============================================================
// Dhan-unreachable degradation (Req 1.5)
// ============================================================

// We only want one info-level event per "outage", not one per cycle —
// otherwise the audit log becomes unreadable. Track the previous state
// so we log on transitions only.
let dhanUnreachable = false;

/**
 * Detect "Dhan unreachable AND no cached data" and emit a single
 * info-level `EngineEventLog` event when the state transitions. The
 * cycle continues in deterministic-only mode using whatever
 * `live-feed/` data is available (Req 1.5).
 *
 * The model `EngineEventLog.sessionId` is required, so when the
 * adapter is invoked outside an active scalping session (smoke
 * checks, dry runs) we fall back to the standard `logger` only — the
 * DB write is best-effort.
 *
 * @param {{ tickAt:number|null }} spotBlock
 * @param {{ tickAt:number|null }} futuresBlock
 * @param {boolean} recordedToday
 */
function noteDhanUnreachable(spotBlock, futuresBlock, recordedToday) {
  const noSpot = !spotBlock || typeof spotBlock.ltp !== 'number';
  const noFutures = !futuresBlock || typeof futuresBlock.ltp !== 'number';
  const isUnreachable = noSpot && noFutures && !recordedToday;

  if (isUnreachable && !dhanUnreachable) {
    dhanUnreachable = true;
    logger.info(
      { recordedToday, spotLtp: null, futuresLtp: null },
      '[dataEngine.adapter] Dhan unreachable — degrading to deterministic-only (Req 1.5)'
    );
    // Best-effort EngineEventLog persistence. `sessionId` is required
    // by the model; the orchestrator (task 17) wires the active session
    // id once available. When unset, we skip the DB write rather than
    // throw — the standard logger above is the audit-of-last-resort.
    try {
      if (engineLogger && typeof engineLogger.logEvent === 'function') {
        // We pass `sessionId: null`; the model will reject and the
        // logger swallows the error internally. That's intentional —
        // the cycle must keep ticking even when the audit channel is
        // unavailable.
        engineLogger.logEvent({
          sessionId: null,
          eventType: 'data_engine_dhan_unreachable',
          level: 'info',
          message: 'Dhan unreachable; running on cached live-feed/ data only.',
          data: { recordedToday: false },
        });
      }
    } catch (_) { /* swallow */ }
  } else if (!isUnreachable && dhanUnreachable) {
    dhanUnreachable = false;
    logger.info(
      { recordedToday },
      '[dataEngine.adapter] Dhan reachable again'
    );
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse the IST date from a replay-folder absolute path. The
 * documented folder shape (Req 4.4) is
 * `<YYYY-MM-DD>_NIFTY_50` — the same convention `feedRecorder`
 * uses to write candles. We accept any path that ends in such a
 * basename and return the date prefix; anything else returns
 * `null` so the caller falls through to today's IST date.
 *
 * Subtask 18.1.
 *
 * @param {string|null|undefined} replayFolder
 * @returns {string|null}  YYYY-MM-DD on success, `null` otherwise.
 */
function _resolveReplayFolderDate(replayFolder) {
  if (typeof replayFolder !== 'string' || replayFolder.length === 0) return null;
  // Normalise both `/` and `\` separators so the helper is
  // platform-agnostic (Windows, where this engine is hosted, uses
  // backslashes).
  const normalised = replayFolder.replace(/\\/g, '/');
  const lastSlash = normalised.lastIndexOf('/');
  const basename = lastSlash >= 0 ? normalised.slice(lastSlash + 1) : normalised;
  const match = /^(\d{4}-\d{2}-\d{2})_NIFTY_50$/.exec(basename);
  if (!match) {
    try {
      logger.warn(
        { replayFolder },
        '[dataEngine.adapter] replayFolder basename does not match <YYYY-MM-DD>_NIFTY_50; falling back to today IST'
      );
    } catch (_) {
      /* swallow */
    }
    return null;
  }
  return match[1];
}

/**
 * Build the per-cycle `DataSnapshot` consumed by every downstream
 * stage in the pipeline. Every field of the design typedef is
 * present on the returned object.
 *
 * Failure semantics:
 *   - Individual data sources are wrapped in try/catch above. A
 *     crash in any one source degrades that field to `null` and is
 *     logged via the standard logger; the function still resolves
 *     to a fully-shaped snapshot. This matches Req 1.5 (degrade to
 *     deterministic-only mode using cached `live-feed/` data when
 *     external dependencies are unreachable).
 *   - The function itself never throws. The orchestrator's loop
 *     must keep ticking even when Dhan is offline.
 *
 * Subtask 18.1 — accepts an optional `replayFolder` that points at
 * a recorded JSONL folder (e.g. `/abs/path/live-feed/2026-04-30_NIFTY_50`).
 * When supplied:
 *   - The IST date used to look up candle files is derived from the
 *     folder basename (the prefix before `_NIFTY_50`); this is the
 *     same convention `feedRecorder` uses, so the existing
 *     `liveFeedDataProvider.readCandlesFromFile(date, interval, type)`
 *     reads back the right files when the folder lives under the
 *     repo's `live-feed/` root.
 *   - `recordedToday` is forced to `true` regardless of whether
 *     today's session has produced any rows, so downstream consumers
 *     attribute the snapshot to JSONL replay (Req 4.4).
 *   - When the folder basename does not match the documented
 *     `<YYYY-MM-DD>_NIFTY_50` shape, we fall through to today's IST
 *     date and log a warning — the smoke check still observes
 *     `replayFolder` on the call, and the operator gets a clear
 *     diagnostic.
 *
 * @param {Object}            params
 * @param {Readonly<Object>}  params.settings     Frozen Algo_Settings snapshot for this cycle.
 * @param {number}            [params.now]        Override for `Date.now()` (used by smoke tests).
 * @param {string|null}       [params.replayFolder] 18.1: absolute path to a recorded
 *                                                  `<YYYY-MM-DD>_NIFTY_50` folder.
 * @returns {Promise<import('./cycleContext').DataSnapshot>}
 */
async function fetchDataSnapshot({ settings, now, replayFolder } = {}) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('fetchDataSnapshot: `settings` (Algo_Settings snapshot) is required.');
  }

  const tNow = typeof now === 'number' ? now : Date.now();

  // 0. Recording lifecycle (Req 4.7). Idempotent — kicks `feedRecorder`
  //    once when `settings.dataEngine.recordCandles` flips true and
  //    logs a transition event when the toggle changes.
  ensureRecording(settings);

  // 1. Resolve source preference (Req 4.4 / subtask 18.1). When the
  //    operator has set a replay folder, force the snapshot to come
  //    from JSONL replay regardless of the `recordedToday` heuristic.
  //    Otherwise, fall back to the live/recorded auto-detection.
  const replayDate = _resolveReplayFolderDate(replayFolder);
  const recordedToday = replayDate !== null ? true : resolveRecordedToday();

  // 18.1-replay: when a replay folder is set, the spot / futures /
  // option-chain readers must come from the recorded JSONL — the
  // live WebSocket / Dhan API obviously doesn't carry historical
  // ticks. We compute a per-cycle replay clock (epoch ms inside the
  // recorded session) and pass it into the JSONL readers below.
  const replayCursor = replayDate !== null
    ? _resolveReplayClock(replayFolder, replayDate, tNow)
    : null;

  // 2. Spot block — JSONL replay when set, else live WebSocket.
  const spotBlock = replayCursor !== null
    ? _loadReplaySpotTick(replayFolder, replayCursor)
    : readSpotFromWebSocket();

  // 3. Futures block — JSONL replay when set, else live tick.
  const futuresBlock = replayCursor !== null
    ? _loadReplayFuturesTick(replayFolder, replayCursor, spotBlock)
    : await readFuturesBlock(spotBlock);

  // 4. Option chain — JSONL replay when set, else best-effort
  //    `dhanOptions` API call.
  const optionChain = replayCursor !== null
    ? _loadReplayOptionChain(replayFolder, replayCursor)
    : await readOptionChain(spotBlock);

  // 5. Prior-day context (Req 4.5) keyed by today's IST date so it
  //    aligns with the recorded folder layout. 18.1: when a replay
  //    folder is set, swap the date so we read prior-day context
  //    relative to the replayed session.
  const todayIst = replayDate !== null ? replayDate : liveFeedDataProvider.getTodayIST();
  const priorDay = await readPriorDayContext(todayIst);

  // 6. Polling-fallback probe — included on the snapshot so the
  //    audit row can confirm the hybrid feed was reachable. Not part
  //    of the design typedef itself; orchestrator will not pass this
  //    through to downstream stages.
  const pollingProbe = probePollingFallback();
  if (pollingProbe) {
    logger.debug(
      { websocketConnected: pollingProbe.websocketConnected },
      '[dataEngine.adapter] hybridLiveFeed probe'
    );
  }

  // 7. Multi-timeframe candle alignment (Req 4.3 / subtask 3.2).
  //    Each timeframe is sorted ASC by close timestamp, partial bars
  //    are dropped (`closeTime > tNow`), and trimmed to the lookback
  //    declared in `settings.dataEngine.multiTimeframe[tf]`.
  //    18.1-replay: when in replay mode, use the replay cursor as
  //    "now" so the partial-bar gate keeps the right bars relative
  //    to the recorded session, not the wall clock.
  const candleNowMs = replayCursor !== null ? replayCursor : tNow;
  const tfResult = buildTimeframeCandles(todayIst, candleNowMs, settings);
  const candles = { spot: tfResult.spot, futures: tfResult.futures };

  // 8. Session VWAP + four AVWAP anchors (Req 4.2 / 6.2 / subtask 3.2).
  //    Computed off the UNTRIMMED full-day 1m spot bars so the session
  //    VWAP truly spans "session open → current bar" — independent of
  //    the snapshot lookback (which is short, e.g. 60 bars).
  //    Anchors not enabled in `settings.structureEngine.avwapAnchors`
  //    are emitted as null so the operator can disable any anchor.
  const vwap = computeVwapBlock(tfResult.spotOneMinFull, candleNowMs, settings, priorDay);

  // 9. Tick freshness (Req 4.6). Pick the freshest of spot / futures
  //    tick timestamps. When neither side reported a tick, fall back
  //    to `tNow` so the snapshot still has a finite `tickAt`. The
  //    "no tick at all" case is detected separately below — using
  //    `tickAt = tNow` would otherwise mask staleness.
  const tickAtCandidates = [spotBlock.tickAt, futuresBlock.tickAt].filter(
    (v) => typeof v === 'number'
  );
  const haveAnyTick = tickAtCandidates.length > 0;
  // 18.1-replay: when in replay mode, the staleness check must be
  // relative to the replay cursor — the recorded ticks are
  // intentionally hours/days old by wall-clock standards.
  const stalenessNowMs = replayCursor !== null ? replayCursor : tNow;
  const tickAt = haveAnyTick ? Math.max(...tickAtCandidates) : stalenessNowMs;

  // `tickStale` is true when:
  //   - We have a tick but it's older than `maxTickAgeMs`, OR
  //   - We have NO tick at all from either side (Dhan unreachable).
  // Both branches push `DATA_TICK_STALE` so downstream gates fire.
  let maxTickAgeMs =
    settings.dataEngine && typeof settings.dataEngine.maxTickAgeMs === 'number'
      ? settings.dataEngine.maxTickAgeMs
      : 1500;
  // 18.1-replay: recorded JSONL files vary by capture cadence —
  // some sessions were sampled at sub-second granularity, others
  // at one-minute intervals (e.g. days when feedRecorder ran at a
  // reduced rate). Live mode's 1.5s freshness threshold would mark
  // those minute-sampled sessions as stale every cycle. Inflate
  // the threshold to the recorded sampling interval (90s tolerates
  // a one-minute cadence with 50% headroom) when in replay mode.
  if (replayCursor !== null) {
    const replayMaxTickAgeMs =
      settings.dataEngine && typeof settings.dataEngine.replayMaxTickAgeMs === 'number'
        ? settings.dataEngine.replayMaxTickAgeMs
        : 90000;
    maxTickAgeMs = Math.max(maxTickAgeMs, replayMaxTickAgeMs);
  }
  // 18.1-replay: when a recorded tick has been loaded (haveAnyTick),
  // measure its age against the replay cursor not the wall clock.
  // This keeps the gate's intent (tick freshness inside the session)
  // intact regardless of when the backtest is being run.
  const tickStale = !haveAnyTick || (stalenessNowMs - tickAt) > maxTickAgeMs;

  // 10. Snapshot-level reason codes. The orchestrator's
  //     `appendBlock(ctx, 'data', snapshot)` lifts these onto the
  //     top-level `ctx.reasonCodes` (see cycleContext.js).
  const reasonCodes = [];
  if (tickStale) reasonCodes.push(REASON_CODES.DATA_TICK_STALE);
  if (optionChain === null) reasonCodes.push(REASON_CODES.OPTION_CHAIN_UNAVAILABLE);

  // 11. Dhan-unreachable degradation (Req 1.5). When neither side has
  //     a live tick AND no recorded JSONL exists for today, log a
  //     single info-level event on the transition. The cycle still
  //     emits a fully-shaped (mostly-null) snapshot; downstream gates
  //     short-circuit on `tickStale`.
  noteDhanUnreachable(spotBlock, futuresBlock, recordedToday);

  // 12. VIX (Req 4.2). Today's `dhanLiveFeedProd` does NOT subscribe
  //     to the INDIA VIX security id, and `niftyFuturesProd` /
  //     `dhanOptions` do not surface it either. Rather than fabricate
  //     a value, we emit `null`; Regime_Engine treats missing VIX as
  //     "use ATR / ADX cut-offs only". When a VIX subscription is
  //     added in a future task, this is the place to wire it.
  const vix = null;

  /** @type {import('./cycleContext').DataSnapshot} */
  const snapshot = {
    tickAt,
    tickStale,
    spot: {
      o: spotBlock.o,
      h: spotBlock.h,
      l: spotBlock.l,
      c: spotBlock.c,
      ltp: spotBlock.ltp,
    },
    futures: {
      o: futuresBlock.o,
      h: futuresBlock.h,
      l: futuresBlock.l,
      c: futuresBlock.c,
      ltp: futuresBlock.ltp,
      oi: futuresBlock.oi,
      oiChange: futuresBlock.oiChange,
      premiumToSpot: futuresBlock.premiumToSpot,
    },
    optionChain,
    candles,
    vwap,
    vix,
    priorDay,
    recordedToday,
    reasonCodes,
  };

  return snapshot;
}

module.exports = {
  fetchDataSnapshot,
  // Exposed for unit tests / orchestrator-side reuse.
  buildTimeframeCandles,
  loadAlignedCandles,
  computeVwapBlock,
  rollupBars,
  normaliseRecordedCandle,
  readSpotFromWebSocket,
  readFuturesBlock,
  readOptionChain,
  probePollingFallback,
  readPriorDayContext,
  resolveRecordedToday,
  noteDhanUnreachable,
  ensureRecording,
  // 18.1
  _resolveReplayFolderDate,
  // 18.1-replay (JSONL readers + replay clock)
  resetReplayClock,
  setReplaySpeedMultiplier,
  getReplaySpeedMultiplier,
  _loadReplaySpotTick,
  _loadReplayFuturesTick,
  _loadReplayOptionChain,
  _resolveReplayClock,
};
