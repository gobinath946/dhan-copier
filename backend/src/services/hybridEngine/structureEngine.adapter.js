/**
 * ============================================================
 * STRUCTURE_ENGINE ADAPTER (Req 6) — tasks 5.1 + 5.2
 * ============================================================
 * Wraps the existing structure-analysis services so the orchestrator
 * can append a single canonical `StructureOutput` block (see the
 * JSDoc typedef in `cycleContext.js`) onto the immutable cycle
 * context. The adapter is SYNC — every input it needs is already
 * present on `ctx.data` after `dataEngine.adapter.fetchDataSnapshot`
 * has run.
 *
 * Subtask 5.1 wires:
 *   1. SMC / structure detection via
 *      `services/algorithms/smartMoneyConcepts.service.js` —
 *      consumes 1m spot candles + option chain + spot price and
 *      reports HH/HL/LH/LL, BOS, CHoCH (Req 6.1).
 *   2. Fixed Range Volume Profile via
 *      `algorithms/volumeProfile.indicator.js` — sliced to the
 *      most recent `Algo_Settings.structureEngine
 *      .volumeProfileLookbackMinutes` minutes of 5m spot bars
 *      and emitted as `{ poc, vah, val, lookbackMinutes }`
 *      (Req 6.3).
 *   3. Multi-timeframe alignment block — emits
 *      `mtfAlignment { '1H', '15m', '5m', '1m', aligned }` derived
 *      directly from the already-aligned candles on
 *      `ctx.data.candles.spot.*` (Req 6.4). The canonical
 *      `services/algorithms/multiTimeframe.service.js` exports
 *      `analyzeMultiTimeframe(authKey, spotPrice)` which makes
 *      its OWN outbound Dhan calls and re-fetches candles per
 *      timeframe — that violates the "no extra API hits during
 *      a cycle" / "never throw" contract this adapter must
 *      uphold (Req 1.5). We therefore mirror the existing
 *      service's `close-vs-EMA20 + slope` trend rule INLINE on
 *      the cycle's pre-aligned candles. The label set
 *      (`bullish | bearish | neutral`) is the same the legacy
 *      service produces, so downstream consumers (Req 6.5/6.6,
 *      Signal_Engine LONG/SHORT mandatory checks) see the same
 *      semantic value either way.
 *   4. AVWAP pass-through — `ctx.data.vwap.anchors` is already
 *      computed by Data_Engine (Req 4.3 / 6.2); we copy it onto
 *      the StructureOutput so subtask 5.2's bias rule has a
 *      single source of truth (Req 6.2).
 *
 * Subtask 5.2 delivered (rules implemented in `computeBiasBlock`
 * below):
 *   - `bias` rule combining VWAP side + POC side + 15m structure
 *     + 1H bias (Req 6.5 / 6.6).
 *   - `biasConfidence` = Σ (factor × `biasWeights[factor]`),
 *     emitted as `0` whenever bias is `'neutral'` because the
 *     VWAP-side gate has rejected directional bias (Req 6.5/6.6).
 *   - `trendContinuation = true` iff BOS aligned with 1H bias
 *     (Req 6.7).
 *   - `potentialReversal = true` iff CHoCH against 1H bias
 *     (Req 6.8).
 *   - VWAP-side gate that suppresses any directional bias when
 *     price is on the wrong side of session VWAP (Req 6.9). The
 *     bullish branch already requires `price > VWAP` and the
 *     bearish branch requires `price < VWAP`, so the gate is the
 *     same conjunction the bias rule enforces.
 *
 * Failure semantics (Req 1.5):
 *   - Every underlying service call is wrapped in try/catch.
 *   - On any unrecoverable failure the adapter still returns a
 *     stable-shape `StructureOutput` with `bias: 'neutral'`,
 *     `biasConfidence: 0`, both `bos` / `choch` flags false, an
 *     empty volume profile, an empty MTF alignment, and a copy
 *     of whatever AVWAPs Data_Engine produced. NO_TRADE is the
 *     downstream consequence — exactly what we want when
 *     structure is unknowable.
 *
 * Spec references:
 *   - Req 3.3   — extends smartMoneyConcepts / multiTimeframe / volumeProfile
 *   - Req 6.1   — HH/HL/LH/LL, BOS, CHoCH detection
 *   - Req 6.2   — four AVWAPs, anchored per `structureEngine.avwapAnchors`
 *   - Req 6.3   — Fixed Range Volume Profile (POC / VAH / VAL)
 *   - Req 6.4   — `mtfAlignment` block
 *   - Req 6.5/6.6/6.7/6.8/6.9 — bias rule + flags (delivered by 5.2)
 *   - Design "Structure_Engine Adapter (Req 6)"
 *   - StructureOutput typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');

// ---- Wired services (Req 3.3 + Req 6.1/6.3/6.4) ------------------
// We import the canonical implementations rather than re-deriving
// any indicator. Each service is invoked through a thin try/catch
// wrapper so a failure in one block never aborts the cycle.
const smartMoneyConcepts = require('../algorithms/smartMoneyConcepts.service');
const volumeProfileIndicator = require('../../algorithms/volumeProfile.indicator');
// `multiTimeframe.service.js` is the canonical home of MTF logic.
// We reuse its EMA20 / slope / close-vs-EMA pattern inline (see
// `deriveMtfTrend` below) because its public `analyzeMultiTimeframe`
// fetches its own candles via Dhan and is therefore unsuitable for
// a sync, network-free adapter.
// const multiTimeframe = require('../algorithms/multiTimeframe.service');

// ============================================================
// Constants
// ============================================================

/**
 * Default volume-profile lookback used when the operator hasn't
 * set `structureEngine.volumeProfileLookbackMinutes`. Mirrors the
 * design's "Algo_Settings Surface" default.
 */
const DEFAULT_VP_LOOKBACK_MINUTES = 240;

/**
 * Bar width per timeframe in minutes — used to slice `ctx.data
 * .candles.spot['5m']` down to the operator-configured volume-
 * profile lookback (`volumeProfileLookbackMinutes`).
 */
const TIMEFRAME_MINUTES = Object.freeze({
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1H': 60,
});

/**
 * The four AVWAP anchors enumerated in the design. Used when
 * building the pass-through `avwap` block to ensure every key is
 * present even if `ctx.data.vwap.anchors` is missing one.
 */
const AVWAP_KEYS = Object.freeze([
  'sessionOpen',
  'priorDayHigh',
  'priorDayLow',
  'weeklyAnchor',
]);

// ============================================================
// Helpers — input extraction + safe defaults
// ============================================================

/**
 * Build the empty `StructureOutput` returned on unrecoverable
 * failure or when there is not enough data to run any sub-block.
 * The shape matches the JSDoc typedef in `cycleContext.js` exactly
 * so downstream code never has to null-check sub-fields.
 *
 * @param {Object} ctx  Used only to harvest the AVWAP pass-through
 *                      so we never lose the anchors Data_Engine
 *                      already computed (Req 6.2).
 * @returns {Object}    Stable-shape StructureOutput.
 */
function buildSafeDefault(ctx) {
  return {
    bias: 'neutral',
    biasConfidence: 0, // VWAP-side gate forces 0 when bias is neutral (Req 6.5/6.6/6.9)
    bos: { detected: false, direction: null, candleAt: null },
    choch: { detected: false, direction: null, candleAt: null },
    trendContinuation: false, // BOS aligned with 1H bias (Req 6.7)
    potentialReversal: false, // CHoCH against 1H bias (Req 6.8)
    avwap: extractAvwap(ctx),
    volumeProfile: {
      poc: null,
      vah: null,
      val: null,
      lookbackMinutes: 0,
    },
    mtfAlignment: {
      '1H': 'neutral',
      '15m': 'neutral',
      '5m': 'neutral',
      '1m': 'neutral',
      aligned: false,
    },
  };
}

/**
 * Pull the four AVWAP anchors off `ctx.data.vwap.anchors`. Missing
 * anchors are emitted as `null` so the StructureOutput shape is
 * always stable — Signal_Engine's mandatory checks (Req 8.1.1 /
 * 9.1.1) read from session VWAP, not these anchors, so a null here
 * does not on its own block a setup.
 *
 * @param {Object} ctx
 * @returns {{ sessionOpen:number|null, priorDayHigh:number|null, priorDayLow:number|null, weeklyAnchor:number|null }}
 */
function extractAvwap(ctx) {
  const anchors =
    ctx && ctx.data && ctx.data.vwap && ctx.data.vwap.anchors
      ? ctx.data.vwap.anchors
      : {};
  /** @type {Record<string, number|null>} */
  const out = {};
  for (const key of AVWAP_KEYS) {
    const value = anchors[key];
    out[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return out;
}

/**
 * Resolve the configured volume-profile lookback in minutes,
 * falling back to the documented default if the operator has not
 * set it (Req 6.3, Algo_Settings Surface).
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}
 */
function resolveVpLookbackMinutes(settings) {
  const cfg = settings && settings.structureEngine ? settings.structureEngine : {};
  const value = cfg.volumeProfileLookbackMinutes;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return DEFAULT_VP_LOOKBACK_MINUTES;
}

/**
 * Adapt a candle from the DataSnapshot shape (`{open, high, low,
 * close, volume, openTime, closeTime, ...}`) to the legacy SMC
 * service shape (`{open, high, low, close, volume, timestamp}`),
 * which expects `timestamp` in milliseconds. We keep the original
 * field names where the service accepts them; only `timestamp` is
 * mapped from `openTime`.
 *
 * @param {Array<Object>|null} bars
 * @returns {Array<Object>}
 */
function adaptCandlesForSmc(bars) {
  if (!Array.isArray(bars)) return [];
  const out = [];
  for (const bar of bars) {
    if (!bar || typeof bar.close !== 'number') continue;
    out.push({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: typeof bar.volume === 'number' ? bar.volume : 0,
      timestamp:
        typeof bar.openTime === 'number'
          ? bar.openTime
          : typeof bar.t === 'number'
            ? bar.t
            : Date.now(),
    });
  }
  return out;
}

// ============================================================
// Helpers — sub-block computation
// ============================================================

/**
 * Run `smartMoneyConcepts.analyzeSmartMoneyConcepts` on the cycle's
 * 1m spot candles + option chain + spot price and surface ONLY the
 * BOS / CHoCH fields the design requires for subtask 5.1.
 *
 * The legacy service emits a richer structure (order blocks, FVGs,
 * liquidity zones, mitigation, inducement) that subtask 5.2 will
 * NOT consume — those fields are intentionally dropped here so the
 * StructureOutput stays small and matches the typedef.
 *
 * Failure semantics: any throw inside the legacy service or
 * insufficient candles ⇒ stable-shape "no detection" output. We
 * never raise.
 *
 * @param {Object} ctx
 * @returns {{ bos:Object, choch:Object }}
 */
function computeBosAndChoch(ctx) {
  const safe = {
    bos: { detected: false, direction: null, candleAt: null },
    choch: { detected: false, direction: null, candleAt: null },
  };
  try {
    const candles =
      ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
        ? ctx.data.candles.spot['1m']
        : null;
    const optionChain =
      ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain : null;
    const spotLtp =
      ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
        ? ctx.data.spot.ltp
        : null;
    if (!Array.isArray(candles) || candles.length < 10 || spotLtp === null) {
      return safe;
    }

    const adapted = adaptCandlesForSmc(candles);
    const smc = smartMoneyConcepts.analyzeSmartMoneyConcepts(
      adapted,
      optionChain,
      spotLtp,
      null
    );
    if (!smc) return safe;

    // Map the legacy service's `{detected, type, level, timestamp}`
    // shape onto the design's `{detected, direction, candleAt}`
    // shape. `direction` is one of 'bullish' | 'bearish' | null;
    // `candleAt` is the millisecond timestamp of the breaking
    // candle (the legacy service emits the LATEST candle's
    // timestamp here, which is fine for the audit row).
    const bosBlock = smc.break_of_structure || {};
    const chochBlock = smc.change_of_character || {};

    return {
      bos: {
        detected: !!bosBlock.detected,
        direction: typeof bosBlock.type === 'string' ? bosBlock.type : null,
        candleAt:
          typeof bosBlock.timestamp === 'number' ? bosBlock.timestamp : null,
      },
      choch: {
        detected: !!chochBlock.detected,
        direction: typeof chochBlock.type === 'string' ? chochBlock.type : null,
        candleAt:
          typeof chochBlock.timestamp === 'number' ? chochBlock.timestamp : null,
      },
    };
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[structureEngine.adapter] computeBosAndChoch failed — using safe defaults'
    );
    return safe;
  }
}

/**
 * Compute Fixed Range Volume Profile (POC / VAH / VAL) over the
 * most recent `lookbackMinutes` of 5m spot bars (Req 6.3).
 *
 * Slicing rule: we keep the last `Math.ceil(lookbackMinutes / 5)`
 * bars from `ctx.data.candles.spot['5m']`. The 5m timeframe is the
 * design's chosen Volume Profile granularity (also matches what
 * `regimeEngine.adapter` consumes and what
 * `volumeProfile.indicator.calculateVolumeProfile` is documented to
 * accept).
 *
 * Failure semantics: insufficient bars OR indicator returns null ⇒
 * stable-shape "no profile" output with `lookbackMinutes: 0`.
 *
 * @param {Object}            ctx
 * @param {Readonly<Object>}  settings
 * @returns {{ poc:number|null, vah:number|null, val:number|null, lookbackMinutes:number }}
 */
function computeVolumeProfile(ctx, settings) {
  const safe = { poc: null, vah: null, val: null, lookbackMinutes: 0 };
  try {
    const lookbackMinutes = resolveVpLookbackMinutes(settings);
    const fiveMinAll =
      ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
        ? ctx.data.candles.spot['5m']
        : null;
    if (!Array.isArray(fiveMinAll) || fiveMinAll.length === 0) return safe;

    const barsNeeded = Math.max(
      1,
      Math.ceil(lookbackMinutes / TIMEFRAME_MINUTES['5m'])
    );
    const slice = fiveMinAll.slice(-barsNeeded);
    if (slice.length < 10) {
      // The indicator itself requires ≥ 10 bars; emit safe default
      // with `lookbackMinutes` reflecting what we actually had so
      // the audit row can show "we asked for 240m but had < 50m".
      return {
        ...safe,
        lookbackMinutes: slice.length * TIMEFRAME_MINUTES['5m'],
      };
    }

    const vp = volumeProfileIndicator.calculateVolumeProfile(slice, 50);
    if (!vp) {
      return {
        ...safe,
        lookbackMinutes: slice.length * TIMEFRAME_MINUTES['5m'],
      };
    }

    return {
      poc: typeof vp.poc_price === 'number' ? vp.poc_price : null,
      vah: typeof vp.value_area_high === 'number' ? vp.value_area_high : null,
      val: typeof vp.value_area_low === 'number' ? vp.value_area_low : null,
      lookbackMinutes: slice.length * TIMEFRAME_MINUTES['5m'],
    };
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[structureEngine.adapter] computeVolumeProfile failed — using safe defaults'
    );
    return safe;
  }
}

/**
 * Compute the Exponential Moving Average of the supplied closes
 * for the requested period. Returns `null` when there are not
 * enough closes (`length < period`).
 *
 * Inlined here (rather than imported from `atr.service` or the
 * legacy MTF service) to keep the structure adapter sync, pure,
 * and free of any further service hops. The formula is the
 * standard `EMA = α × close + (1 − α) × prevEMA, α = 2/(period+1)`
 * — identical to the calculation in `multiTimeframe.service.js`
 * which we are conceptually mirroring.
 *
 * @param {Array<number>} closes
 * @param {number} period
 * @returns {number|null}
 */
function computeEma(closes, period) {
  if (!Array.isArray(closes) || closes.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i += 1) {
    const c = closes[i];
    if (typeof c !== 'number' || !Number.isFinite(c)) return null;
    ema = c * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Derive a coarse trend label for a single timeframe from the
 * cycle's already-aligned candles. Mirrors the rule used by the
 * legacy `multiTimeframe.service.analyzeTimeframe`:
 *
 *   bullish iff close > EMA20 AND EMA20 slope > 0
 *   bearish iff close < EMA20 AND EMA20 slope < 0
 *   neutral otherwise
 *
 * Insufficient bars (`< 21`) ⇒ neutral. Slope is approximated as
 * `EMA(closes) − EMA(closes.slice(0, -1))`; positive slope means
 * the EMA is rising on the most recent bar.
 *
 * @param {Array<Object>|null} bars
 * @returns {('bullish'|'bearish'|'neutral')}
 */
function deriveMtfTrend(bars) {
  if (!Array.isArray(bars) || bars.length < 21) return 'neutral';
  /** @type {Array<number>} */
  const closes = [];
  for (const bar of bars) {
    if (!bar || typeof bar.close !== 'number' || !Number.isFinite(bar.close)) {
      return 'neutral';
    }
    closes.push(bar.close);
  }
  const ema = computeEma(closes, 20);
  const emaPrev = computeEma(closes.slice(0, -1), 20);
  if (ema === null || emaPrev === null) return 'neutral';
  const lastClose = closes[closes.length - 1];
  const slope = ema - emaPrev;
  if (lastClose > ema && slope > 0) return 'bullish';
  if (lastClose < ema && slope < 0) return 'bearish';
  return 'neutral';
}

/**
 * Compute the `mtfAlignment` block for the StructureOutput.
 *
 *   - Per-timeframe trend label is derived from the cycle's
 *     pre-aligned spot candles (`ctx.data.candles.spot.{1m,5m,
 *     15m,1H}`) using `deriveMtfTrend`.
 *   - `aligned = true` iff all four timeframes share the SAME
 *     non-neutral label (i.e. either all bullish or all bearish).
 *     Mixed / any-neutral ⇒ `false`. This matches the design's
 *     "all timeframes agree" intent (Req 6.4) and is what
 *     subtask 5.2's bias rule will rely on for the 15m and 1H
 *     factors.
 *
 * Failure semantics: missing candle bucket ⇒ that timeframe is
 * `'neutral'` and `aligned` becomes `false`.
 *
 * @param {Object} ctx
 * @returns {{ '1H':string, '15m':string, '5m':string, '1m':string, aligned:boolean }}
 */
function computeMtfAlignment(ctx) {
  const safe = {
    '1H': 'neutral',
    '15m': 'neutral',
    '5m': 'neutral',
    '1m': 'neutral',
    aligned: false,
  };
  try {
    const spotCandles =
      ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
        ? ctx.data.candles.spot
        : null;
    if (!spotCandles) return safe;

    const trends = {
      '1H': deriveMtfTrend(spotCandles['1H']),
      '15m': deriveMtfTrend(spotCandles['15m']),
      '5m': deriveMtfTrend(spotCandles['5m']),
      '1m': deriveMtfTrend(spotCandles['1m']),
    };

    const labels = Object.values(trends);
    const allBullish = labels.every((l) => l === 'bullish');
    const allBearish = labels.every((l) => l === 'bearish');
    const aligned = allBullish || allBearish;

    return { ...trends, aligned };
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[structureEngine.adapter] computeMtfAlignment failed — using safe defaults'
    );
    return safe;
  }
}

// ============================================================
// Helpers — bias / continuation / reversal (subtask 5.2, Req 6.5–6.9)
// ============================================================

/**
 * Default bias-factor weights mirrored from the documented
 * Algo_Settings surface (`structureEngine.biasWeights`). Used as
 * the fallback when the operator has not configured weights or has
 * supplied a non-finite / negative value for one of them.
 *
 * The four factors must sum to 1.0 so `biasConfidence` lands in
 * `[0, 1]` regardless of which subset of factors agree. The
 * default split (vwap 0.30, poc 0.25, mtf15m 0.25, mtf1H 0.20)
 * mirrors the order of importance documented in the design.
 */
const DEFAULT_BIAS_WEIGHTS = Object.freeze({
  vwap: 0.30,
  poc: 0.25,
  mtf15m: 0.25,
  mtf1H: 0.20,
});

/**
 * Resolve the bias-factor weights from `settings.structureEngine
 * .biasWeights`, falling back per-key to the documented defaults
 * when a value is missing, non-finite, or negative. We intentionally
 * do NOT renormalise the weights here — the operator-supplied values
 * are validated for sum-to-1 by `algoSettings.validateSettings`, and
 * any partial-config fallback should still emit a confidence in the
 * documented range without silently drifting the weighting model.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {{ vwap:number, poc:number, mtf15m:number, mtf1H:number }}
 */
function resolveBiasWeights(settings) {
  const cfg =
    settings && settings.structureEngine && settings.structureEngine.biasWeights
      ? settings.structureEngine.biasWeights
      : {};
  /** @type {{vwap:number,poc:number,mtf15m:number,mtf1H:number}} */
  const out = { ...DEFAULT_BIAS_WEIGHTS };
  for (const key of Object.keys(DEFAULT_BIAS_WEIGHTS)) {
    const value = cfg[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Extract the spot LTP, session VWAP, and POC from the inputs the
 * bias rule depends on. Returns `null` for any value that is not a
 * finite number; the bias rule treats `null` as "factor cannot
 * agree", which collapses to neutral by Req 6.9 (gate cannot be
 * proven on either side).
 *
 * @param {Object} ctx
 * @param {Object} volumeProfile  Already-computed VP block.
 * @returns {{ price:number|null, vwap:number|null, poc:number|null }}
 */
function extractBiasInputs(ctx, volumeProfile) {
  const spot = ctx && ctx.data && ctx.data.spot ? ctx.data.spot : null;
  const vwap = ctx && ctx.data && ctx.data.vwap ? ctx.data.vwap : null;
  const price =
    spot && typeof spot.ltp === 'number' && Number.isFinite(spot.ltp)
      ? spot.ltp
      : null;
  const sessionVwap =
    vwap && typeof vwap.session === 'number' && Number.isFinite(vwap.session)
      ? vwap.session
      : null;
  const poc =
    volumeProfile &&
    typeof volumeProfile.poc === 'number' &&
    Number.isFinite(volumeProfile.poc)
      ? volumeProfile.poc
      : null;
  return { price, vwap: sessionVwap, poc };
}

/**
 * Compute the four bias-block fields required by Req 6.5–6.9:
 *
 *   - `bias`              one of `bullish | bearish | neutral`.
 *   - `biasConfidence`    Σ (factor × biasWeights[factor]) for
 *                          agreeing factors when bias is non-neutral;
 *                          forced to `0` whenever bias is `neutral`
 *                          (Req 6.9 — VWAP-side gate has rejected
 *                          directional bias).
 *   - `trendContinuation` `true` iff BOS detected AND BOS direction
 *                          equals 1H MTF bias (Req 6.7).
 *   - `potentialReversal` `true` iff CHoCH detected AND CHoCH
 *                          direction is OPPOSITE 1H MTF bias
 *                          (Req 6.8).
 *
 * Bias rule (Req 6.5 / 6.6 / 6.9):
 *   bullish iff
 *     price > session VWAP        (factor: vwap)
 *     AND price > POC              (factor: poc)
 *     AND mtfAlignment['15m'] === 'bullish'   (factor: mtf15m)
 *     AND mtfAlignment['1H']  === 'bullish'   (factor: mtf1H)
 *   bearish iff
 *     price < session VWAP
 *     AND price < POC
 *     AND mtfAlignment['15m'] === 'bearish'
 *     AND mtfAlignment['1H']  === 'bearish'
 *   otherwise neutral.
 *
 * Because each branch already requires the price to be on the
 * favourable side of session VWAP, the explicit VWAP-side gate
 * from Req 6.9 reduces to: "neutral whenever the four-factor
 * conjunction is not satisfied". We additionally collapse to
 * neutral when any of the inputs is missing (`null`) so the
 * output is deterministic on incomplete data.
 *
 * @param {Object}            ctx
 * @param {Object}            volumeProfile  POC source (Req 6.5/6.6).
 * @param {Object}            mtfAlignment   15m / 1H source (Req 6.5/6.6).
 * @param {Object}            bos            BOS detection block (Req 6.7).
 * @param {Object}            choch          CHoCH detection block (Req 6.8).
 * @param {Readonly<Object>}  settings       Algo_Settings snapshot (biasWeights).
 * @returns {{ bias:('bullish'|'bearish'|'neutral'), biasConfidence:number, trendContinuation:boolean, potentialReversal:boolean }}
 */
function computeBiasBlock(ctx, volumeProfile, mtfAlignment, bos, choch, settings) {
  const safe = {
    bias: /** @type {'neutral'} */ ('neutral'),
    biasConfidence: 0,
    trendContinuation: false,
    potentialReversal: false,
  };

  try {
    const weights = resolveBiasWeights(settings);
    const { price, vwap: sessionVwap, poc } = extractBiasInputs(ctx, volumeProfile);
    const mtf15m = mtfAlignment && mtfAlignment['15m'];
    const mtf1H = mtfAlignment && mtfAlignment['1H'];

    // -----------------------------------------------------
    // Bias rule (Req 6.5 / 6.6 / 6.9). Missing input ⇒ no
    // factor can agree on that side, so bias falls through
    // to neutral and confidence stays 0.
    // -----------------------------------------------------
    let bias = /** @type {'bullish'|'bearish'|'neutral'} */ ('neutral');
    let biasConfidence = 0;

    if (
      price !== null &&
      sessionVwap !== null &&
      poc !== null &&
      price > sessionVwap &&
      price > poc &&
      mtf15m === 'bullish' &&
      mtf1H === 'bullish'
    ) {
      bias = 'bullish';
      biasConfidence =
        weights.vwap + weights.poc + weights.mtf15m + weights.mtf1H;
    } else if (
      price !== null &&
      sessionVwap !== null &&
      poc !== null &&
      price < sessionVwap &&
      price < poc &&
      mtf15m === 'bearish' &&
      mtf1H === 'bearish'
    ) {
      bias = 'bearish';
      biasConfidence =
        weights.vwap + weights.poc + weights.mtf15m + weights.mtf1H;
    } else {
      // VWAP-side gate (Req 6.9) — directional bias rejected.
      bias = 'neutral';
      biasConfidence = 0;
    }

    // Clamp to [0, 1] defensively. Operator-supplied weights are
    // validated to sum to 1.0 in algoSettings, but a per-key
    // fallback could in theory push the sum above 1 — clamping
    // here keeps the contract that biasConfidence ∈ [0, 1].
    if (biasConfidence < 0) biasConfidence = 0;
    if (biasConfidence > 1) biasConfidence = 1;

    // -----------------------------------------------------
    // BOS / CHoCH flags (Req 6.7 / 6.8). These are independent
    // of the VWAP-side gate — a BOS aligned with 1H bias is
    // still informative even when the four-factor bias rule
    // collapsed to neutral, because the orchestrator may use
    // `trendContinuation` for sizing and confidence boosts.
    // -----------------------------------------------------
    const bosDetected = !!(bos && bos.detected);
    const bosDirection = bos && bos.direction;
    const chochDetected = !!(choch && choch.detected);
    const chochDirection = choch && choch.direction;

    const trendContinuation =
      bosDetected &&
      (bosDirection === 'bullish' || bosDirection === 'bearish') &&
      bosDirection === mtf1H;

    // CHoCH against 1H bias ⇒ reversal candidate. We only set
    // the flag when 1H bias itself is non-neutral, otherwise
    // "against neutral" has no meaning. CHoCH direction is the
    // direction of the new structure (opposite of the prior
    // trend), so reversal-up = bullish CHoCH while 1H is
    // bearish, and reversal-down = bearish CHoCH while 1H is
    // bullish.
    const potentialReversal =
      chochDetected &&
      (chochDirection === 'bullish' || chochDirection === 'bearish') &&
      (mtf1H === 'bullish' || mtf1H === 'bearish') &&
      chochDirection !== mtf1H;

    return { bias, biasConfidence, trendContinuation, potentialReversal };
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[structureEngine.adapter] computeBiasBlock failed — using safe defaults'
    );
    return safe;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Analyse market structure for the current cycle and emit a
 * `StructureOutput` matching the typedef in `cycleContext.js`.
 *
 * Pipeline ordering: this function is invoked AFTER `Data_Engine`
 * (so `ctx.data` is populated) and AFTER `Regime_Engine` (which
 * does not feed structure inputs) but BEFORE Liquidity_Engine /
 * OI_Engine / PCR_Engine / Signal_Engine.
 *
 * Subtask 5.1 + 5.2 contract:
 *   - Returns a fully-shaped object even on failure (Req 1.5).
 *   - Populates `bos`, `choch`, `avwap`, `volumeProfile`, and
 *     `mtfAlignment` from the wired services (Req 6.1–6.4).
 *   - Populates `bias`, `biasConfidence`, `trendContinuation`,
 *     and `potentialReversal` per Req 6.5 / 6.6 / 6.7 / 6.8 /
 *     6.9 via `computeBiasBlock`. Bias is `neutral` and
 *     confidence is `0` whenever the VWAP-side gate or any
 *     other factor disagrees, which is what downstream
 *     Signal_Engine LONG/SHORT mandatory checks require to
 *     short-circuit to NO_TRADE.
 *
 * @param {Object}            params
 * @param {Object}            params.ctx        Immutable cycle context.
 * @param {Readonly<Object>}  params.settings   Algo_Settings snapshot.
 * @returns {Object}                            StructureOutput.
 */
function analyzeStructure({ ctx, settings } = {}) {
  // Hard guard: missing ctx / settings is a programming error in
  // the orchestrator. Per Req 1.5 we never throw — emit the
  // safe-default neutral block so downstream gates short-circuit
  // to NO_TRADE.
  if (!ctx || !ctx.data || !settings) {
    logger.warn(
      { hasCtx: !!ctx, hasData: !!(ctx && ctx.data), hasSettings: !!settings },
      '[structureEngine.adapter] missing ctx / data / settings — emitting neutral safe default'
    );
    return buildSafeDefault(ctx);
  }

  try {
    // --------------------------------------------------------
    // 1. BOS / CHoCH (Req 6.1) — wraps SMC service.
    // --------------------------------------------------------
    const { bos, choch } = computeBosAndChoch(ctx);

    // --------------------------------------------------------
    // 2. Volume Profile (Req 6.3) — sliced to the configured
    //    lookback in minutes off the 5m spot bars.
    // --------------------------------------------------------
    const volumeProfile = computeVolumeProfile(ctx, settings);

    // --------------------------------------------------------
    // 3. Multi-timeframe alignment (Req 6.4) — derived inline
    //    from the cycle's pre-aligned spot candles. See file
    //    header for why we do not call the legacy MTF service
    //    directly here.
    // --------------------------------------------------------
    const mtfAlignment = computeMtfAlignment(ctx);

    // --------------------------------------------------------
    // 4. AVWAP pass-through (Req 6.2) — Data_Engine has already
    //    computed the four anchors; we surface them unchanged
    //    so subtask 5.2's bias rule has a single source of
    //    truth.
    // --------------------------------------------------------
    const avwap = extractAvwap(ctx);

    // --------------------------------------------------------
    // 5. Bias rule + BOS/CHoCH flags + VWAP-side gate
    //    (Req 6.5 / 6.6 / 6.7 / 6.8 / 6.9). Computed last so
    //    the helper can read VP / MTF / BOS / CHoCH directly
    //    from the already-built sub-blocks (single source of
    //    truth, no re-derivation).
    // --------------------------------------------------------
    const { bias, biasConfidence, trendContinuation, potentialReversal } =
      computeBiasBlock(ctx, volumeProfile, mtfAlignment, bos, choch, settings);

    return {
      bias,
      biasConfidence,
      bos,
      choch,
      trendContinuation,
      potentialReversal,
      avwap,
      volumeProfile,
      mtfAlignment,
    };
  } catch (err) {
    // Unrecoverable — never throw (Req 1.5). Emit safe-default
    // neutral so downstream gates short-circuit to NO_TRADE.
    logger.error(
      { err: err && err.message },
      '[structureEngine.adapter] unrecoverable failure — emitting neutral safe default'
    );
    return buildSafeDefault(ctx);
  }
}

module.exports = {
  analyzeStructure,
  // Exposed for unit tests / orchestrator-side reuse. Subtask
  // 5.2's `computeBiasBlock` reads `mtfAlignment` directly from
  // the same source so callers can re-derive the bias factors
  // without re-running the full pipeline.
  computeBosAndChoch,
  computeVolumeProfile,
  computeMtfAlignment,
  computeBiasBlock,
  resolveBiasWeights,
  deriveMtfTrend,
  extractAvwap,
  buildSafeDefault,
};
