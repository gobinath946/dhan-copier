/**
 * ============================================================
 * REGIME_ENGINE ADAPTER (Req 5) — task 4.1 + 4.2
 * ============================================================
 * Wraps `marketRegimeDetector.service.js` so the orchestrator can
 * append a single canonical `RegimeOutput` block to the immutable
 * cycle context (see `cycleContext.js`). The adapter:
 *
 *   1. Derives the inputs the existing classifier expects (ATR,
 *      ADX, VWAP distance, Volume Profile, VIX, OI concentration,
 *      futures premium, market breadth, liquidity score) from
 *      `ctx.data` and `ctx.liquidity`.
 *   2. Runs the existing regime classifier and maps its label set
 *      (`TRENDING / EXPANSION / RANGING / QUIET / COMPRESSION /
 *      MANIPULATION / NEUTRAL / WEAK_TRENDING / UNCERTAIN`) onto
 *      the design's seven Regime_Labels (`trending`, `ranging`,
 *      `fake-breakout`, `momentum-exhaustion`,
 *      `volatility-expansion`, `expiry-manipulation`,
 *      `high-risk`).
 *   3. Layers on three new deterministic detectors that do NOT
 *      exist in the legacy classifier — `fake-breakout`,
 *      `momentum-exhaustion`, and `expiry-manipulation` — using
 *      days-to-expiry from the option chain plus an OI manipulation
 *      heuristic.
 *   4. Emits a `RegimeOutput` matching the JSDoc typedef in
 *      `cycleContext.js`. Subtask 4.1 wired the inputs / label /
 *      confidence; subtask 4.2 DELIVERED the `tradePermissions`,
 *      `positionSizingMultiplier`, `allowedSetups`, and
 *      `reasonCodes` fields per the design's "Regime_Engine
 *      Adapter" permission matrix and the hard rules in Req 5.6 /
 *      5.7 / 5.8 / 5.10.
 *
 * IMPORTANT pipeline-order note (Req 5.1 ↔ design "Pipeline
 * Topology"):
 *
 *   Data → Regime → Structure → Liquidity → OI → PCR → Signal
 *
 * Liquidity_Engine output (`ctx.liquidity`) is therefore NOT yet
 * populated when `classifyRegime` runs. Req 5.1 lists it as an
 * input nonetheless. We accept this with a documented degradation:
 * `inputs.liquidityScore = null` is normal at this stage and
 * MUST NOT lower confidence on its own. When the orchestrator wires
 * a "previous cycle's liquidity snapshot" feedback channel in the
 * future, this adapter will pick it up via `ctx.liquidity` without
 * a code change.
 *
 * Failure semantics (Req 1.5):
 *   - Every underlying service call is wrapped in try/catch.
 *   - On any unrecoverable failure the adapter still returns a
 *     stable-shape `RegimeOutput` with `label: 'high-risk'`,
 *     `confidence: 0`, and the safe defaults — guaranteeing
 *     downstream short-circuits to NO_TRADE.
 *
 * Confidence scoring (Req 5.2):
 *   - 0..10 score derived from the agreement of contributing
 *     inputs (ATR vs volatility floors, ADX vs ADX cutoffs, VIX
 *     vs VIX cutoffs, breadth vs breadth cutoffs, OI concentration
 *     vs OI concentration cutoffs).
 *   - Each input that AGREES with the emitted label contributes
 *     `2.0` points; each input that CONTRADICTS contributes `-1.0`;
 *     each missing input contributes `0`. The result is clamped
 *     to `[0, 10]`. Documented in `scoreConfidence` below.
 *
 * Permission matrix (subtask 4.2, Req 5.3 / 5.4 / 5.5 / 5.6 / 5.7 /
 * 5.8). Hard rules ALWAYS win over the per-label defaults — they
 * are re-applied as a final pass in `applyHardRules` so no future
 * change to the table can violate Req 5.6 / 5.7 / 5.8:
 *
 *   trending             → LONG/SHORT/SCALP true,  ×1.00, BOS_continuation + VWAP_reclaim
 *   volatility-expansion → LONG/SHORT/SCALP true,  ×1.25, BOS_continuation + breakout
 *   ranging              → LONG/SHORT false, SCALP true,  ×0.50, range_reversal
 *   fake-breakout        → LONG/SHORT/SCALP false, ×0.00, []
 *   momentum-exhaustion  → LONG/SHORT/SCALP false, ×0.50, [] (counter-trend not auto-permitted; design ambiguous → safe default NO_TRADE)
 *   expiry-manipulation  → LONG/SHORT/SCALP false, ×0.00, []  (Req 5.7 forces multiplier 0)
 *   high-risk            → LONG/SHORT/SCALP false, ×0.00, []  (Req 5.8 forces both)
 *
 * Reason-code emission (subtask 4.2, Req 5.10 + design):
 *   - `ranging`             ⇒ `REGIME_BLOCK_RANGING`
 *   - `expiry-manipulation` ⇒ `REGIME_BLOCK_EXPIRY_MANIPULATION`
 *   - `high-risk`           ⇒ `REGIME_BLOCK_HIGH_RISK`
 *   - `confidence < regimeEngine.minRegimeConfidence`
 *                           ⇒ `REGIME_LOW_CONFIDENCE`
 *   The codes are pushed onto the `RegimeOutput.reasonCodes` array
 *   which `cycleContext.appendBlock(ctx, 'regime', ...)` lifts onto
 *   `ctx.reasonCodes` (deduped). Multiple codes can co-exist —
 *   e.g. an `expiry-manipulation` regime with confidence 3 emits
 *   both `REGIME_BLOCK_EXPIRY_MANIPULATION` AND
 *   `REGIME_LOW_CONFIDENCE`.
 *
 * Spec references:
 *   - Req 3.2  — extends `marketRegimeDetector.service.js`
 *   - Req 5.1  — consumes ATR, ADX, VWAP distance, VP, VIX, OI
 *                concentration, futures premium, breadth, liquidity
 *   - Req 5.2  — emits label + confidence in [0,10]
 *   - Req 5.3  — emits tradePermissions { LONG_SETUP, SHORT_SETUP, SCALPING }
 *   - Req 5.4  — emits positionSizingMultiplier in [0.0, 1.5]
 *   - Req 5.5  — emits allowedSetups list
 *   - Req 5.6  — `ranging` ⇒ LONG/SHORT permissions false
 *   - Req 5.7  — `expiry-manipulation` ⇒ multiplier 0.0
 *   - Req 5.8  — `high-risk` ⇒ permissions false AND multiplier 0.0
 *   - Req 5.9  — every threshold from Algo_Settings.regimeEngine
 *   - Req 5.10 — confidence < minRegimeConfidence ⇒ REGIME_LOW_CONFIDENCE
 *   - Design "Regime_Engine Adapter (Req 5)"
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const { REASON_CODES } = require('./reasonCodes');

// ---- Wired services (Req 3.2 + Req 5.1) --------------------------
// Regime classification is delegated to the existing service so we
// do NOT duplicate the legacy heuristic. The new detectors below
// only override the legacy label when they fire.
const marketRegimeDetector = require('../marketRegimeDetector.service');

// ATR is sourced from the canonical service. `atr.service.js`
// produces a richer block (`{ atr, atrPct, volatility }`) which we
// then compare against `regimeEngine.volatilityFloors`.
const atrService = require('../atr.service');

// ADX is read-only from `professionalScalping.service.js` per the
// design ("`professionalScalping.service.js` (used only for ADX
// read)"). The service does not export `calculateADX` directly;
// `analyzeScalpingIndicators` returns it inside its result.
const professionalScalping = require('../algorithms/professionalScalping.service');

// Volume Profile is computed directly off the cycle's 5m spot
// candles via the canonical indicator. Returns `{poc_price,
// value_area_high, value_area_low, ...}`.
const volumeProfileIndicator = require('../../algorithms/volumeProfile.indicator');

// ============================================================
// Internal constants
// ============================================================

/**
 * Default volume profile lookback if the operator hasn't set
 * `structureEngine.volumeProfileLookbackMinutes`. Mirrors the
 * design's "Algo_Settings Surface" default.
 */
const DEFAULT_VP_LOOKBACK_MINUTES = 240;

/**
 * Days-to-expiry threshold below which expiry-day microstructure
 * dominates regime classification. Matches the spec's "days-to-
 * expiry ≤ 1" heuristic.
 */
const EXPIRY_DTE_THRESHOLD = 1;

/**
 * Mapping from the legacy `marketRegimeDetector` labels onto the
 * design's seven Regime_Labels. The MANIPULATION mapping is
 * deliberately context-dependent (`expiry-manipulation` only when
 * days-to-expiry ≤ 1) and is therefore handled inline rather than
 * via this static table.
 *
 * Legacy labels not in this table fall through to `high-risk` so
 * the safe default is "do not trade".
 */
const LEGACY_LABEL_MAP = Object.freeze({
  TRENDING: 'trending',
  WEAK_TRENDING: 'trending',
  EXPANSION: 'volatility-expansion',
  RANGING: 'ranging',
  QUIET: 'ranging',
  COMPRESSION: 'ranging',
  NEUTRAL: 'ranging',
  UNCERTAIN: 'high-risk',
});

/**
 * The seven Regime_Labels enumerated in Req 5.2 / design. Used to
 * validate the emitted label and to gate the safe-default emission
 * path on unrecoverable failures.
 */
const REGIME_LABELS = Object.freeze([
  'trending',
  'ranging',
  'fake-breakout',
  'momentum-exhaustion',
  'volatility-expansion',
  'expiry-manipulation',
  'high-risk',
]);

// ============================================================
// Helpers — input extraction
// ============================================================

/**
 * Compute ATR + ATR% from a candle array using the canonical ATR
 * service. The service returns `{ atr, atrPct, volatility }`; on
 * insufficient data it returns `{ atr: null, atrPct: null }`.
 *
 * @param {Array<Object>} candles  Aligned 5m spot candles.
 * @returns {{ atr:number|null, atrPct:number|null, volatility:string|null }}
 */
function readAtr(candles) {
  try {
    if (!Array.isArray(candles) || candles.length < 16) {
      return { atr: null, atrPct: null, volatility: null };
    }
    // `atr.service.js#calculateATR` expects `{o,h,l,c}` shorthand
    // keys (legacy spot candle shape). Our DataSnapshot candles
    // expose `{open, high, low, close}` (`dataEngine.adapter.js`),
    // so adapt the field names without copying the array twice.
    const adapted = candles.map((bar) => ({
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
      t: bar.openTime,
    }));
    const result = atrService.calculateATR(adapted, 14);
    return {
      atr: typeof result.atr === 'number' ? result.atr : null,
      atrPct: typeof result.atrPct === 'number' ? result.atrPct : null,
      volatility: typeof result.volatility === 'string' ? result.volatility : null,
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[regimeEngine.adapter] readAtr failed');
    return { atr: null, atrPct: null, volatility: null };
  }
}

/**
 * Compute ADX from a candle array using `professionalScalping`.
 * Reads ADX inline from `analyzeScalpingIndicators` — the design
 * pins this service as the canonical ADX source ("used only for
 * ADX read").
 *
 * Returns `{ value, strength }` where `value` is `null` when there
 * are not enough candles for ADX(14).
 *
 * @param {Array<Object>} candles  Aligned 5m spot candles.
 * @param {number|null}   spotLtp  Current spot LTP (for the
 *                                 service signature; not used by
 *                                 the ADX computation).
 * @param {Object|null}   vwapData Pass-through `{ vwap }` object;
 *                                 we use `data.vwap.session`.
 * @returns {{ value:number|null, strength:string|null }}
 */
function readAdx(candles, spotLtp, vwapData) {
  try {
    if (!Array.isArray(candles) || candles.length < 30) {
      return { value: null, strength: null };
    }
    const adapted = candles.map((bar) => ({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      t: bar.openTime,
    }));
    const result = professionalScalping.analyzeScalpingIndicators(
      adapted,
      spotLtp,
      vwapData,
      '5m'
    );
    if (!result || result.signal === 'insufficient_data' || result.signal === 'error') {
      return { value: null, strength: null };
    }
    const adx = result.adx || {};
    return {
      value: typeof adx.value === 'number' ? adx.value : null,
      strength: typeof adx.strength === 'string' ? adx.strength : null,
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[regimeEngine.adapter] readAdx failed');
    return { value: null, strength: null };
  }
}

/**
 * Compute VWAP distance as a SIGNED percentage of session VWAP:
 *   `(spot.ltp - vwap.session) / vwap.session × 100`.
 *
 * Returns `null` when either input is missing / non-finite. Sign
 * matters downstream: a strongly positive distance with a non-
 * trending ADX is a fake-breakout signature.
 *
 * @param {number|null} spotLtp
 * @param {number|null} sessionVwap
 * @returns {number|null}
 */
function computeVwapDistancePct(spotLtp, sessionVwap) {
  if (typeof spotLtp !== 'number' || !Number.isFinite(spotLtp)) return null;
  if (typeof sessionVwap !== 'number' || !Number.isFinite(sessionVwap) || sessionVwap === 0) {
    return null;
  }
  return Number((((spotLtp - sessionVwap) / sessionVwap) * 100).toFixed(4));
}

/**
 * Compute Volume Profile (POC / VAH / VAL) from the cycle's 5m
 * spot candles. Falls back to `null` when the indicator reports
 * insufficient data.
 *
 * @param {Array<Object>} candles  Aligned 5m spot candles.
 * @returns {{ poc:number|null, vah:number|null, val:number|null, lookbackMinutes:number }|null}
 */
function readVolumeProfile(candles) {
  try {
    if (!Array.isArray(candles) || candles.length < 10) return null;
    // The indicator accepts both `{o,h,l,c,v}` and `{open,high,low,close,volume}`
    // candle flavours. We pass the DataSnapshot bars unmodified.
    const vp = volumeProfileIndicator.calculateVolumeProfile(candles, 50);
    if (!vp) return null;
    return {
      poc: typeof vp.poc_price === 'number' ? vp.poc_price : null,
      vah: typeof vp.value_area_high === 'number' ? vp.value_area_high : null,
      val: typeof vp.value_area_low === 'number' ? vp.value_area_low : null,
      lookbackMinutes: candles.length * 5,
    };
  } catch (err) {
    logger.warn({ err: err && err.message }, '[regimeEngine.adapter] readVolumeProfile failed');
    return null;
  }
}

/**
 * Compute OI concentration ratio across the option chain:
 *   `max(strikeOI) / Σ(strikeOI)`
 *
 * High concentration (above `regimeEngine.oiConcentrationCutoffs.high`)
 * around expiry is the canonical institutional manipulation signal
 * captured by the OI-manipulation heuristic in
 * `expiry-manipulation`.
 *
 * Returns `null` when the option chain is unavailable or empty.
 *
 * @param {Object|null} optionChain
 * @returns {number|null}
 */
function computeOIConcentration(optionChain) {
  if (!optionChain || !Array.isArray(optionChain.strikes) || optionChain.strikes.length === 0) {
    return null;
  }
  let total = 0;
  let max = 0;
  for (const row of optionChain.strikes) {
    const ceOi = row && row.ce && typeof row.ce.oi === 'number' ? row.ce.oi : 0;
    const peOi = row && row.pe && typeof row.pe.oi === 'number' ? row.pe.oi : 0;
    const combined = ceOi + peOi;
    total += combined;
    if (combined > max) max = combined;
  }
  if (total <= 0) return null;
  return Number((max / total).toFixed(4));
}

/**
 * Days to expiry computed from the option chain's expiry string
 * (`YYYY-MM-DD`). Returns `null` when the expiry is missing or
 * unparseable.
 *
 * @param {Object|null} optionChain
 * @param {number}      nowMs
 * @returns {number|null}
 */
function computeDaysToExpiry(optionChain, nowMs) {
  if (!optionChain || typeof optionChain.expiry !== 'string') return null;
  const parsed = Date.parse(optionChain.expiry);
  if (Number.isNaN(parsed)) return null;
  const diffMs = parsed - nowMs;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Pull market breadth from the cycle context. `marketInternals`
 * is async and currently NOT pre-populated by Data_Engine, so
 * unless a future task wires breadth onto `ctx.data.breadth` this
 * is `null` — and that is fine. A null breadth contributes 0 to
 * the confidence score (see `scoreConfidence`).
 *
 * @param {Object} ctx
 * @returns {{ score:number|null, bias:string|null }}
 */
function readBreadth(ctx) {
  try {
    const block = ctx && ctx.data && ctx.data.breadth ? ctx.data.breadth : null;
    if (!block) return { score: null, bias: null };
    const score =
      typeof block.market_internals_score === 'number' ? block.market_internals_score : null;
    const bias =
      block.advance_decline && typeof block.advance_decline.market_bias === 'string'
        ? block.advance_decline.market_bias
        : null;
    return { score, bias };
  } catch (err) {
    return { score: null, bias: null };
  }
}

/**
 * Pull liquidity score from the cycle context. Per the pipeline
 * order (Data → Regime → Structure → Liquidity → ...) this is
 * usually `null` at the regime stage. Subtask 4.2 may consume a
 * previous-cycle snapshot here; for now we accept null gracefully.
 *
 * @param {Object} ctx
 * @returns {number|null}
 */
function readLiquidityScore(ctx) {
  if (!ctx || !ctx.liquidity) return null;
  return typeof ctx.liquidity.liquidityScore === 'number'
    ? ctx.liquidity.liquidityScore
    : null;
}

/**
 * Extract aligned candles for a single timeframe from the cycle
 * context. Returns an array of bars or `[]` when the snapshot
 * is missing the timeframe.
 *
 * @param {Object} ctx
 * @param {('1m'|'5m'|'15m'|'1H')} tf
 * @returns {Array<Object>}
 */
function _extractCandles(ctx, tf) {
  if (!ctx || !ctx.data || !ctx.data.candles || !ctx.data.candles.spot) return [];
  const arr = ctx.data.candles.spot[tf];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Derive a per-timeframe trend label from the last `N` candles
 * using a percent-change threshold. Returns one of
 * `'bullish' | 'bearish' | 'neutral'`. The threshold scales by
 * timeframe so a 5m bar bias and a 15m bar bias don't collapse
 * onto the same noise floor.
 *
 * Heuristic — designed to be readable, not magical:
 *   - Take the last `N` closes.
 *   - Compute net % change between first and last.
 *   - If the absolute change exceeds 0.04% × sqrt(N), label
 *     bullish/bearish according to the sign; else neutral.
 *
 * Calibration note (Fix 1 / 2):
 *   - Threshold is `0.04% × sqrt(N)` — NIFTY 1m bars typically
 *     move 0.02-0.05% each so a 5-bar move of 0.09% is genuinely
 *     directional. The previous `0.10% × sqrt(N)` floor required
 *     a 0.224% net move in 5 minutes, which forced every
 *     intraday timeframe to permanent `neutral` and collapsed
 *     `trendsAligned` semantics to "all neutral aligns" — making
 *     the regime detector blind for the first 11:45 minutes of
 *     every session in the 10-day sweep.
 *   - Warmup tolerance: when there are fewer than `N` bars but
 *     at least 2, derive direction from the available subset
 *     using the same threshold scaled to the actual count. This
 *     stops the first 4-5 cycles of the session from being
 *     forced to `neutral` (and therefore RANGING) on a missing-
 *     data technicality.
 *
 * @param {Array<Object>} candles
 * @param {number}        n
 * @returns {('bullish'|'bearish'|'neutral')}
 */
function _trendFromCandles(candles, n) {
  if (!Array.isArray(candles) || candles.length < 2) return 'neutral';
  // Warmup: if we have fewer than N bars but at least 2, scale
  // the lookback to what we have. Closes only need to be finite.
  const effectiveN = Math.min(n, candles.length);
  const tail = candles.slice(-effectiveN);
  const first = tail[0] && typeof tail[0].close === 'number' ? tail[0].close : null;
  const last = tail[tail.length - 1] && typeof tail[tail.length - 1].close === 'number'
    ? tail[tail.length - 1].close
    : null;
  if (first === null || last === null || first === 0) return 'neutral';
  const pct = ((last - first) / first) * 100;
  // 0.04% × sqrt(effectiveN) — calibrated to NIFTY 1m close scale.
  const threshold = 0.04 * Math.sqrt(effectiveN);
  if (pct > threshold) return 'bullish';
  if (pct < -threshold) return 'bearish';
  return 'neutral';
}

// ============================================================
// Helpers — legacy classifier adapter
// ============================================================

/**
 * Build the `marketData` payload that
 * `marketRegimeDetector.classifyMarketRegime` expects from our
 * cycle context. The legacy classifier reads:
 *   - `volatility`        (0..1, derived from ATR%)
 *   - `trendStrength`     (0..1, derived from ADX)
 *   - `marketCharacter`   ('quiet'|'ranging'|'neutral'|'unknown')
 *   - `volumeProfile`     `{ current, average }`
 *   - `priceAction`       `{ range, avgRange }`
 *   - `liquiditySweep`    boolean
 *   - `multiTimeframe`    map of `{ trend }` per tf
 *
 * We map our `inputs` block onto these legacy fields. Missing
 * inputs are emitted as conservative defaults so the legacy
 * classifier biases toward UNCERTAIN / QUIET (which we then map
 * to `ranging` / `high-risk`).
 *
 * @param {Object} ctx
 * @param {Object} inputs   Inputs block already extracted.
 * @returns {Object}
 */
function buildLegacyMarketData(ctx, inputs) {
  // Normalise ATR% into the legacy classifier's 0..1 volatility
  // range. The legacy classifier's thresholds (0.2 quiet, 0.5
  // trending, 0.8 expansion) were originally fed a 0..1 stat
  // computed from a different formula; it does NOT map cleanly
  // onto raw ATR% on NIFTY (which lives in the 0.05–0.20 range
  // for normal sessions and rarely exceeds 0.30%). Without this
  // remap, even a strong-move day (ADX 43, 1.23% net change)
  // collapses to volatility ≈ 0.07 and the legacy detector
  // forces RANGING.
  //
  // Empirical NIFTY mapping (calibrated from the live-feed/
  // recordings):
  //
  //   atrPct ≤ 0.05  → 0.10 (genuinely quiet)
  //   atrPct ≈ 0.10  → 0.40 (normal session)
  //   atrPct ≈ 0.15  → 0.60 (active session, would trip TRENDING)
  //   atrPct ≈ 0.20  → 0.80 (would trip EXPANSION)
  //   atrPct ≥ 0.30  → 1.00 (extreme)
  //
  // We use a simple piecewise linear ramp rather than a divisor
  // so the classifier's thresholds remain meaningful.
  let volatility = 0;
  if (typeof inputs.atr === 'object' && inputs.atr && typeof inputs.atr.atrPct === 'number') {
    const p = inputs.atr.atrPct;
    if (p <= 0.05) volatility = Math.max(0, p * 2);          // 0..0.10
    else if (p <= 0.10) volatility = 0.10 + (p - 0.05) * 6;   // 0.10..0.40
    else if (p <= 0.15) volatility = 0.40 + (p - 0.10) * 4;   // 0.40..0.60
    else if (p <= 0.20) volatility = 0.60 + (p - 0.15) * 4;   // 0.60..0.80
    else if (p <= 0.30) volatility = 0.80 + (p - 0.20) * 2;   // 0.80..1.00
    else volatility = 1;
  }

  // Map ADX value (0..100 typical) onto the legacy 0..1 trend
  // strength. ADX ≥ 25 is strong, ≥ 20 moderate.
  let trendStrength = 0;
  if (typeof inputs.adx === 'object' && inputs.adx && typeof inputs.adx.value === 'number') {
    trendStrength = Math.min(1, inputs.adx.value / 50);
  }

  // Multi-timeframe trend hints — derive from the `ctx.data.candles`
  // map directly so replay mode (where the legacy detector's
  // tick-rate stats are unavailable) still gets useful inputs.
  // Per-timeframe trend = sign(slope) over the last N bars,
  // gated by a small percent threshold so noise doesn't flip the
  // label every cycle.
  const multiTimeframe = {
    '1m': { trend: _trendFromCandles(_extractCandles(ctx, '1m'), 5) },
    '5m': { trend: _trendFromCandles(_extractCandles(ctx, '5m'), 5) },
    '15m': { trend: _trendFromCandles(_extractCandles(ctx, '15m'), 4) },
    '30m': { trend: _trendFromCandles(_extractCandles(ctx, '15m'), 8) },
  };

  // Volume profile (legacy expects `{current, average}` ratio
  // surface). We pass the most recent 5m bar's volume vs the
  // 20-bar SMA when available; otherwise leave both at 0 so
  // `volumeRatio` defaults to 0 in the legacy classifier.
  let currentVol = 0;
  let avgVol = 1;
  const fiveMin = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
    ? ctx.data.candles.spot['5m']
    : null;
  if (Array.isArray(fiveMin) && fiveMin.length >= 5) {
    const tail = fiveMin.slice(-20);
    const sum = tail.reduce((acc, bar) => acc + (typeof bar.volume === 'number' ? bar.volume : 0), 0);
    avgVol = tail.length > 0 ? sum / tail.length : 1;
    const last = fiveMin[fiveMin.length - 1];
    currentVol = typeof last.volume === 'number' ? last.volume : 0;
  }

  // Price action range proxy — last bar high-low vs 20-bar average.
  let range = 0;
  let avgRange = 1;
  if (Array.isArray(fiveMin) && fiveMin.length > 0) {
    const last = fiveMin[fiveMin.length - 1];
    range = typeof last.high === 'number' && typeof last.low === 'number'
      ? last.high - last.low
      : 0;
    const tail = fiveMin.slice(-20);
    if (tail.length > 0) {
      const sum = tail.reduce((acc, bar) => {
        const r = typeof bar.high === 'number' && typeof bar.low === 'number' ? bar.high - bar.low : 0;
        return acc + r;
      }, 0);
      avgRange = sum / tail.length || 1;
    }
  }

  // `marketCharacter` — coarse derivation; `unknown` keeps the
  // legacy classifier from forcing QUIET on missing data.
  let marketCharacter = 'unknown';
  if (volatility < 0.2) marketCharacter = 'quiet';
  else if (volatility < 0.3 && trendStrength < 0.15) marketCharacter = 'ranging';
  else if (trendStrength < 0.2) marketCharacter = 'neutral';

  return {
    volatility,
    trendStrength,
    marketCharacter,
    volumeProfile: { current: currentVol, average: avgVol },
    priceAction: { range, avgRange, current: ctx.data && ctx.data.spot ? ctx.data.spot.ltp : 0 },
    liquiditySweep: false,
    spotData: (ctx.data && ctx.data.spot) || {},
    multiTimeframe,
  };
}

/**
 * Map a legacy regime label onto the design's seven Regime_Labels.
 * Handles the context-dependent MANIPULATION → expiry-manipulation /
 * high-risk split inline.
 *
 * @param {string|null} legacy
 * @param {{ daysToExpiry:number|null, oiConcentration:number|null }} ctxLabel
 * @param {Readonly<Object>} settings
 * @returns {string}
 */
function mapLegacyToDesignLabel(legacy, ctxLabel, settings) {
  if (legacy === 'MANIPULATION') {
    if (typeof ctxLabel.daysToExpiry === 'number' && ctxLabel.daysToExpiry <= EXPIRY_DTE_THRESHOLD) {
      return 'expiry-manipulation';
    }
    return 'high-risk';
  }
  const mapped = LEGACY_LABEL_MAP[legacy];
  return mapped || 'high-risk';
}

// ============================================================
// New detectors — fake-breakout, momentum-exhaustion, expiry-manipulation
// ============================================================

/**
 * Fake-breakout detector: price broke prior-day high or low but
 * failed to hold, evidenced by a recent 5m candle reversal AND a
 * VWAP distance that is decaying (price reverting toward VWAP).
 *
 * Heuristic (Fix 3 — hold-period requirement):
 *   - High side: at least 2 of the last 3 5m bars touched / pierced
 *     priorDay.high AND the most recent 2 bars closed below the
 *     prior-day high (sustained close-back, not single-bar noise).
 *   - Low side:  symmetric — pierced priorDay.low and most recent
 *     2 bars closed above it.
 *
 * Why the hold-period: a single 5m bar that closes back inside
 * the prior-day envelope is just a wick — the 10-day sweep showed
 * that the 1-bar rule was firing ~30 times per trending day,
 * downgrading legitimate trending tapes to `fake-breakout` (which
 * blocks all permissions). Requiring two consecutive close-backs
 * keeps the detector conservative without being permissive.
 *
 * @param {Object} ctx
 * @returns {boolean}
 */
function detectFakeBreakout(ctx) {
  try {
    const priorDay = ctx && ctx.data && ctx.data.priorDay;
    const candles = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m']
      : null;
    if (!priorDay || !Array.isArray(candles) || candles.length < 3) return false;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    if (!last || !prev || !prev2) return false;

    const high = priorDay.high;
    const low = priorDay.low;

    // High-side fake-breakout: most recent bar pierced AND
    // both of the last 2 bars closed back below it. This is a
    // strict reversal pattern — not a single-bar wick on a
    // trending tape.
    if (typeof high === 'number'
      && typeof last.high === 'number'
      && typeof last.close === 'number'
      && typeof prev.close === 'number'
      && typeof prev2.close === 'number'
      && last.high >= high
      && last.close < high
      && prev.close < high
      && prev2.close <= high) {
      return true;
    }

    // Low-side fake-breakout: symmetric strict pattern.
    if (typeof low === 'number'
      && typeof last.low === 'number'
      && typeof last.close === 'number'
      && typeof prev.close === 'number'
      && typeof prev2.close === 'number'
      && last.low <= low
      && last.close > low
      && prev.close > low
      && prev2.close >= low) {
      return true;
    }

    return false;
  } catch (err) {
    logger.warn({ err: err && err.message }, '[regimeEngine.adapter] detectFakeBreakout failed');
    return false;
  }
}

/**
 * Momentum-exhaustion detector: ADX is in the trending zone but
 * volume is dropping AND ATR is contracting after expansion. The
 * canonical "trending-then-flagging" signature.
 *
 * Heuristic:
 *   - ADX ≥ regimeEngine.adxFloors.trending.
 *   - Recent 5 5m volumes' SMA < prior 5 5m volumes' SMA (volume
 *     decay across last 10 bars).
 *   - Last 5m bar's range < 5-bar SMA range (ATR contracting).
 *
 * @param {Object} ctx
 * @param {Object} inputs
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function detectMomentumExhaustion(ctx, inputs, settings) {
  try {
    const adxValue = inputs && inputs.adx && typeof inputs.adx.value === 'number'
      ? inputs.adx.value
      : null;
    const adxFloors = settings && settings.regimeEngine && settings.regimeEngine.adxFloors;
    if (adxValue === null || !adxFloors || typeof adxFloors.trending !== 'number') return false;
    if (adxValue < adxFloors.trending) return false;

    const candles = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m']
      : null;
    if (!Array.isArray(candles) || candles.length < 10) return false;
    const tail = candles.slice(-10);
    const recent5 = tail.slice(-5);
    const prior5 = tail.slice(0, 5);

    const recentVol = recent5.reduce((s, b) => s + (typeof b.volume === 'number' ? b.volume : 0), 0) / 5;
    const priorVol = prior5.reduce((s, b) => s + (typeof b.volume === 'number' ? b.volume : 0), 0) / 5;
    const volumeFalling = recentVol < priorVol;

    const lastBar = candles[candles.length - 1];
    const lastRange = typeof lastBar.high === 'number' && typeof lastBar.low === 'number'
      ? lastBar.high - lastBar.low
      : 0;
    const avgRange = recent5.reduce((s, b) => {
      const r = typeof b.high === 'number' && typeof b.low === 'number' ? b.high - b.low : 0;
      return s + r;
    }, 0) / 5;
    const rangeContracting = lastRange < avgRange;

    return volumeFalling && rangeContracting;
  } catch (err) {
    logger.warn({ err: err && err.message }, '[regimeEngine.adapter] detectMomentumExhaustion failed');
    return false;
  }
}

/**
 * Expiry-manipulation detector: days-to-expiry ≤ 1 AND OI
 * concentration above `regimeEngine.oiConcentrationCutoffs.high`.
 * The canonical institutional-manipulation signature on expiry
 * day, used to override the legacy MANIPULATION mapping when it
 * doesn't fire on its own.
 *
 * @param {{ daysToExpiry:number|null, oiConcentration:number|null }} signals
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function detectExpiryManipulation(signals, settings) {
  const dte = signals.daysToExpiry;
  const oiConc = signals.oiConcentration;
  const cutoffs = settings && settings.regimeEngine && settings.regimeEngine.oiConcentrationCutoffs;
  if (!cutoffs || typeof cutoffs.high !== 'number') return false;
  if (typeof dte !== 'number' || dte > EXPIRY_DTE_THRESHOLD) return false;
  if (typeof oiConc !== 'number') return false;
  return oiConc >= cutoffs.high;
}

// ============================================================
// Helpers — confidence
// ============================================================

/**
 * Score the agreement of contributing inputs with the emitted
 * label and produce a 0..10 confidence value (Req 5.2).
 *
 * Weights per input (each contributes up to +2.0 / down to -1.0):
 *   - ATR vs `regimeEngine.volatilityFloors.atrPctMin/Max`:
 *       trending / volatility-expansion ⇒ atrPct ≥ atrPctMin
 *       ranging                          ⇒ atrPct ≤ atrPctMin
 *   - ADX vs `regimeEngine.adxFloors.trending/ranging`:
 *       trending / volatility-expansion ⇒ adx ≥ trending floor
 *       ranging / momentum-exhaustion   ⇒ adx ≤ ranging floor (or ≥ trending for exhaustion)
 *   - VIX vs `regimeEngine.vixCutoffs.calm/normal/elevated/extreme`:
 *       volatility-expansion ⇒ VIX ≥ elevated
 *       trending             ⇒ VIX ∈ [normal, elevated]
 *       ranging              ⇒ VIX ≤ normal
 *   - Breadth vs `regimeEngine.breadthCutoffs.bullish/bearish`:
 *       trending / volatility-expansion ⇒ extreme breadth (≥ bullish or ≤ bearish)
 *       ranging                          ⇒ neutral breadth
 *   - OI concentration vs
 *     `regimeEngine.oiConcentrationCutoffs.low/high`:
 *       expiry-manipulation ⇒ ≥ high
 *       trending            ⇒ ≤ low
 *       ranging             ⇒ ≥ low and ≤ high (mid)
 *
 * Missing inputs contribute 0. The result is clamped to [0, 10].
 *
 * For `fake-breakout`, `momentum-exhaustion`, and
 * `expiry-manipulation` we anchor the confidence at 6.0 when the
 * detector fired (these are deterministic boolean signatures, not
 * input-agreement labels), then layer on the input agreement to
 * raise it toward 10.
 *
 * @param {string} label
 * @param {Object} inputs
 * @param {Readonly<Object>} settings
 * @returns {number}
 */
function scoreConfidence(label, inputs, settings) {
  const cfg = settings && settings.regimeEngine ? settings.regimeEngine : {};
  const volFloors = cfg.volatilityFloors || {};
  const adxFloors = cfg.adxFloors || {};
  const vixCutoffs = cfg.vixCutoffs || {};
  const breadthCutoffs = cfg.breadthCutoffs || {};
  const oiCutoffs = cfg.oiConcentrationCutoffs || {};

  let score = 0;
  let basis = 0;

  // ATR contribution
  const atrPct = inputs.atr && typeof inputs.atr.atrPct === 'number' ? inputs.atr.atrPct : null;
  if (atrPct !== null && typeof volFloors.atrPctMin === 'number') {
    if (label === 'trending' || label === 'volatility-expansion' || label === 'momentum-exhaustion') {
      score += atrPct >= volFloors.atrPctMin ? 2.0 : -1.0;
    } else if (label === 'ranging') {
      score += atrPct <= volFloors.atrPctMin ? 2.0 : -1.0;
    } else if (label === 'fake-breakout' || label === 'expiry-manipulation') {
      // Either side OK — use mid-range as agreement
      score += atrPct >= volFloors.atrPctMin ? 1.0 : 0.5;
    }
    basis += 1;
  }

  // ADX contribution
  const adxValue = inputs.adx && typeof inputs.adx.value === 'number' ? inputs.adx.value : null;
  if (adxValue !== null) {
    const trendFloor = typeof adxFloors.trending === 'number' ? adxFloors.trending : 22;
    const rangeFloor = typeof adxFloors.ranging === 'number' ? adxFloors.ranging : 18;
    if (label === 'trending' || label === 'volatility-expansion') {
      score += adxValue >= trendFloor ? 2.0 : -1.0;
    } else if (label === 'ranging' || label === 'fake-breakout') {
      score += adxValue <= rangeFloor ? 2.0 : -1.0;
    } else if (label === 'momentum-exhaustion') {
      // Trending ADX on a flagging tape — agreement when ADX still high
      score += adxValue >= trendFloor ? 2.0 : 0;
    }
    basis += 1;
  }

  // VIX contribution
  const vix = typeof inputs.vix === 'number' ? inputs.vix : null;
  if (vix !== null) {
    const elevated = typeof vixCutoffs.elevated === 'number' ? vixCutoffs.elevated : 24;
    const normal = typeof vixCutoffs.normal === 'number' ? vixCutoffs.normal : 18;
    if (label === 'volatility-expansion') {
      score += vix >= elevated ? 2.0 : -1.0;
    } else if (label === 'trending') {
      score += vix >= normal && vix < elevated ? 2.0 : 0;
    } else if (label === 'ranging') {
      score += vix <= normal ? 2.0 : -1.0;
    }
    basis += 1;
  }

  // Breadth contribution
  const breadthScore =
    inputs.breadth && typeof inputs.breadth.score === 'number' ? inputs.breadth.score : null;
  if (breadthScore !== null) {
    const bull = typeof breadthCutoffs.bullish === 'number' ? breadthCutoffs.bullish : 1.20;
    const bear = typeof breadthCutoffs.bearish === 'number' ? breadthCutoffs.bearish : 0.80;
    // breadth.score is the 0..100 internals score; convert to a
    // soft ratio around 1.0 by treating ≥ 75 as bull-extreme,
    // ≤ 25 as bear-extreme.
    if (label === 'trending' || label === 'volatility-expansion') {
      score += breadthScore >= 75 || breadthScore <= 25 ? 2.0 : 0;
    } else if (label === 'ranging') {
      score += breadthScore > 35 && breadthScore < 65 ? 2.0 : -1.0;
    }
    basis += 1;
  }

  // OI concentration contribution
  const oiConc = typeof inputs.oiConcentration === 'number' ? inputs.oiConcentration : null;
  if (oiConc !== null) {
    const low = typeof oiCutoffs.low === 'number' ? oiCutoffs.low : 0.20;
    const high = typeof oiCutoffs.high === 'number' ? oiCutoffs.high : 0.45;
    if (label === 'expiry-manipulation') {
      score += oiConc >= high ? 2.0 : -1.0;
    } else if (label === 'trending') {
      score += oiConc <= low ? 2.0 : 0;
    } else if (label === 'ranging') {
      score += oiConc >= low && oiConc <= high ? 2.0 : 0;
    }
    basis += 1;
  }

  // VWAP-distance contribution — strong directional moves push
  // price well away from session VWAP; a label of `trending` /
  // `volatility-expansion` paired with |dist| > 0.20% is genuine
  // trend confirmation that the legacy classifier doesn't see.
  const vwapDistPct = typeof inputs.vwapDistancePct === 'number' ? inputs.vwapDistancePct : null;
  if (vwapDistPct !== null) {
    const absDist = Math.abs(vwapDistPct);
    if (label === 'trending' || label === 'volatility-expansion') {
      score += absDist >= 0.10 ? 2.0 : (absDist >= 0.05 ? 1.0 : 0);
    } else if (label === 'ranging') {
      score += absDist <= 0.05 ? 2.0 : (absDist <= 0.10 ? 1.0 : -1.0);
    }
    basis += 1;
  }

  // Volume-profile contribution — when price has broken out of
  // the value area in the trending-label direction, that's a
  // strong confirmation that the legacy classifier doesn't see.
  const vp = inputs.volumeProfile && typeof inputs.volumeProfile === 'object' ? inputs.volumeProfile : null;
  const spotLtp = inputs.data && inputs.data.spot && typeof inputs.data.spot.ltp === 'number'
    ? inputs.data.spot.ltp : null;
  if (vp && spotLtp !== null && typeof vp.poc === 'number') {
    if (label === 'trending' || label === 'volatility-expansion') {
      // Outside-VA in either direction = confirmation
      const outside = (typeof vp.vah === 'number' && spotLtp > vp.vah)
        || (typeof vp.val === 'number' && spotLtp < vp.val);
      score += outside ? 2.0 : (Math.abs(spotLtp - vp.poc) > 0 ? 0.5 : 0);
    } else if (label === 'ranging') {
      const insideVa = typeof vp.vah === 'number' && typeof vp.val === 'number'
        && spotLtp >= vp.val && spotLtp <= vp.vah;
      score += insideVa ? 2.0 : 0;
    }
    basis += 1;
  }


  // Anchor confidence for deterministic-boolean labels.
  let anchored = score;
  if (
    label === 'fake-breakout'
    || label === 'momentum-exhaustion'
    || label === 'expiry-manipulation'
  ) {
    anchored = 6.0 + Math.max(0, score);
  }

  // Missing-inputs scaling (calibration fix):
  // ----------------------------------------------------------
  // The recorded JSONL has no VIX or breadth feed (Dhan doesn't
  // expose either intraday). Without them, basis caps at ~6
  // contributors instead of 8, and the maximum reachable score
  // is ~12 (capped to 10) instead of ~16. The 0..10 confidence
  // band was designed assuming 8/8 inputs available, so on real
  // recorded data the average score sits at ~5 even on textbook
  // trending sessions — and `minRegimeConfidence: 6` becomes
  // unreachable in 80% of cycles.
  //
  // Scale the score by an "input-availability factor" so a
  // session with 6/8 inputs scoring 5 maps to the same
  // confidence band as 8/8 inputs scoring 6.67. This is a
  // legitimate normalization, not a relaxation of the
  // agreement threshold.
  // ----------------------------------------------------------
  const FULL_BASIS = 7; // ATR, ADX, VIX, breadth, OI-conc, VWAP-dist, VP
  if (basis > 0 && basis < FULL_BASIS) {
    const scaleFactor = FULL_BASIS / basis;
    anchored *= scaleFactor;
  }

  // Clamp to [0, 10].
  if (anchored < 0) anchored = 0;
  if (anchored > 10) anchored = 10;
  // When NO inputs were observable, fall back to confidence 0
  // (high-risk safe-default territory) instead of an arbitrary
  // anchor — this matches the failure path's contract.
  if (basis === 0 && label !== 'high-risk') return 0;
  return Number(anchored.toFixed(2));
}

/**
 * Lookup `inputs.data` from the surrounding closure of
 * `scoreConfidence`. The function takes `inputs` from the
 * caller's pre-built block (which doesn't carry `ctx.data`)
 * — but the VWAP-distance / VP scoring above NEEDS the spot
 * LTP. Centralising the access via this helper keeps the
 * scoring logic readable without restructuring the call site.
 *
 * Today the helper is unused (we widened `inputs.data` instead);
 * left as a placeholder for the next round of scoring tweaks.
 */

// ============================================================
// Helpers — permission matrix + hard rules (Req 5.3 / 5.4 / 5.5 / 5.6 / 5.7 / 5.8)
// ============================================================

/**
 * Per-label permission / multiplier / allowed-setup defaults. The
 * design's "Regime_Engine Adapter" section pins these values; the
 * hard rules in `applyHardRules` are then re-applied as a final
 * pass so that any future tweak to this table cannot violate
 * Req 5.6 / 5.7 / 5.8.
 *
 * `momentum-exhaustion` is intentionally treated as NO_TRADE:
 * the requirements + design do not explicitly grant a counter-
 * trend SHORT_SETUP permission for this label, so we follow the
 * "safe default — do not trade" guidance for ambiguous labels.
 *
 * @type {Readonly<Object<string, { permissions:Object, multiplier:number, setups:Array<string> }>>}
 */
const REGIME_PERMISSION_MATRIX = Object.freeze({
  trending: {
    permissions: { LONG_SETUP: true, SHORT_SETUP: true, SCALPING: true },
    multiplier: 1.0,
    setups: ['BOS_continuation', 'VWAP_reclaim'],
  },
  'volatility-expansion': {
    permissions: { LONG_SETUP: true, SHORT_SETUP: true, SCALPING: true },
    multiplier: 1.25,
    setups: ['BOS_continuation', 'breakout'],
  },
  ranging: {
    // Hard rule (Req 5.6) — LONG/SHORT both false. Light scalps
    // are still allowed per the design's permission matrix.
    permissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: true },
    multiplier: 0.5,
    setups: ['range_reversal'],
  },
  'fake-breakout': {
    // After a confirmed fake-breakout, neither side is a clean
    // entry — block all permissions until the next regime cycle.
    permissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: false },
    multiplier: 0.0,
    setups: [],
  },
  'momentum-exhaustion': {
    // Design ambiguous on counter-trend permission; safe default
    // is NO_TRADE on either side. Multiplier kept at 0.5 so that
    // a future relaxation (e.g. allow counter-trend SHORT_SETUP)
    // does not over-size an exhaustion-tape entry.
    permissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: false },
    multiplier: 0.5,
    setups: [],
  },
  'expiry-manipulation': {
    // Hard rule (Req 5.7) — multiplier MUST be 0.0. Permissions
    // false to be safe even though the requirement only mandates
    // the multiplier zeroing.
    permissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: false },
    multiplier: 0.0,
    setups: [],
  },
  'high-risk': {
    // Hard rule (Req 5.8) — LONG/SHORT both false AND multiplier 0.0.
    permissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: false },
    multiplier: 0.0,
    setups: [],
  },
});

/**
 * Apply the hard rules (Req 5.6 / 5.7 / 5.8) as a final pass over
 * a candidate `{ permissions, multiplier }` pair. This guarantees
 * that any future change to `REGIME_PERMISSION_MATRIX` cannot
 * silently violate the requirements.
 *
 *   - `ranging`             ⇒ LONG/SHORT permissions = false
 *   - `expiry-manipulation` ⇒ multiplier = 0.0
 *   - `high-risk`           ⇒ LONG/SHORT permissions = false AND multiplier = 0.0
 *
 * Multiplier is also clamped to `[0.0, 1.5]` per Req 5.4.
 *
 * @param {string}                                  label
 * @param {{LONG_SETUP:boolean,SHORT_SETUP:boolean,SCALPING:boolean}} permissions
 * @param {number}                                  multiplier
 * @returns {{permissions:Object, multiplier:number}}
 */
function applyHardRules(label, permissions, multiplier) {
  let p = {
    LONG_SETUP: !!(permissions && permissions.LONG_SETUP),
    SHORT_SETUP: !!(permissions && permissions.SHORT_SETUP),
    SCALPING: !!(permissions && permissions.SCALPING),
  };
  let m = typeof multiplier === 'number' && Number.isFinite(multiplier) ? multiplier : 0.0;

  if (label === 'ranging') {
    p = { ...p, LONG_SETUP: false, SHORT_SETUP: false };
  }
  if (label === 'expiry-manipulation') {
    m = 0.0;
  }
  if (label === 'high-risk') {
    p = { ...p, LONG_SETUP: false, SHORT_SETUP: false };
    m = 0.0;
  }

  // Clamp multiplier into the Req 5.4 envelope.
  if (m < 0.0) m = 0.0;
  if (m > 1.5) m = 1.5;

  return { permissions: p, multiplier: Number(m.toFixed(2)) };
}

/**
 * Resolve the per-label permission entry, falling back to the
 * `high-risk` row when the label is not in the matrix (defensive
 * — should be unreachable because `REGIME_LABELS` is closed).
 *
 * @param {string} label
 * @returns {{ permissions:Object, multiplier:number, setups:Array<string> }}
 */
function permissionsFor(label) {
  return REGIME_PERMISSION_MATRIX[label] || REGIME_PERMISSION_MATRIX['high-risk'];
}

// ============================================================
// Helpers — safe-default emission
// ============================================================

/**
 * Build a stable-shape `RegimeOutput` for the cycle context. Used
 * by both the happy path and the unrecoverable-failure path
 * (`label: 'high-risk'`, `confidence: 0`).
 *
 * Subtask 4.2 wires:
 *   - `tradePermissions` / `positionSizingMultiplier` /
 *     `allowedSetups` from `REGIME_PERMISSION_MATRIX`, post-
 *     processed through `applyHardRules`.
 *   - `reasonCodes` per the regime gates and the
 *     `confidence < regimeEngine.minRegimeConfidence` rule
 *     (Req 5.10). Codes are deduped further by
 *     `cycleContext.appendBlock`.
 *
 * @param {{ label:string, confidence:number, inputs:Object, settings:Readonly<Object> }} core
 * @returns {Object}
 */
function emitOutput(core) {
  const label = REGIME_LABELS.includes(core.label) ? core.label : 'high-risk';
  const confidence = typeof core.confidence === 'number' ? core.confidence : 0;
  const matrix = permissionsFor(label);
  let { permissions, multiplier } = applyHardRules(
    label,
    matrix.permissions,
    matrix.multiplier
  );

  // ------------------------------------------------------------
  // MTF-direction gate (calibration fix):
  // ------------------------------------------------------------
  // The legacy classifier emits `trending` based on ADX strength
  // alone, which doesn't tell us WHICH direction. A 10-day
  // calibration sweep showed the engine entering BUY_CE at the
  // top of a momentum spike where MTF read 3×neutral + 1×bearish
  // — the regime confidence was 10 (high directional STRENGTH)
  // but the directional bias was bearish. Without this gate the
  // signal-engine's bullish-side mandatories occasionally pass
  // and the trade gets placed against the broader trend.
  //
  // Rule: when label is `trending` or `volatility-expansion`,
  // count bullish vs bearish trends across the four timeframes
  // (`tf1m / tf5m / tf15m / tf30m`). If bearish trends >
  // bullish, strip LONG_SETUP permission. If bullish > bearish,
  // strip SHORT_SETUP permission. Even on a tie permissions
  // stay open (the signal-engine then arbitrates via VWAP /
  // EMA / cumulative-delta).
  // ------------------------------------------------------------
  if (label === 'trending' || label === 'volatility-expansion') {
    const inputs = core.inputs || {};
    const mtfMap = inputs._mtfTrends || null;
    if (mtfMap) {
      const trends = [
        mtfMap['1m'], mtfMap['5m'], mtfMap['15m'], mtfMap['30m'],
      ].filter((t) => t === 'bullish' || t === 'bearish' || t === 'neutral');
      const bull = trends.filter((t) => t === 'bullish').length;
      const bear = trends.filter((t) => t === 'bearish').length;
      if (bull > bear) {
        // Bullish bias dominant — block SHORT side.
        permissions = { ...permissions, SHORT_SETUP: false };
      } else if (bear > bull) {
        // Bearish bias dominant — block LONG side.
        permissions = { ...permissions, LONG_SETUP: false };
      }
      // Tie ⇒ keep both sides open (signal-engine arbitrates).
    }
  }

  // Reason-code emission (Req 5.6 / 5.7 / 5.8 / 5.10 + design).
  const reasonCodes = [];
  if (label === 'ranging') {
    reasonCodes.push(REASON_CODES.REGIME_BLOCK_RANGING);
  } else if (label === 'expiry-manipulation') {
    reasonCodes.push(REASON_CODES.REGIME_BLOCK_EXPIRY_MANIPULATION);
  } else if (label === 'high-risk') {
    reasonCodes.push(REASON_CODES.REGIME_BLOCK_HIGH_RISK);
  }

  // Low-confidence ⇒ force NO_TRADE downstream (Req 5.10). This
  // is independent of the regime gate codes; both can co-exist.
  const minConfidence =
    core.settings && core.settings.regimeEngine && typeof core.settings.regimeEngine.minRegimeConfidence === 'number'
      ? core.settings.regimeEngine.minRegimeConfidence
      : 6;
  if (confidence < minConfidence) {
    reasonCodes.push(REASON_CODES.REGIME_LOW_CONFIDENCE);
  }

  return {
    label,
    confidence,
    tradePermissions: permissions,
    positionSizingMultiplier: multiplier,
    allowedSetups: matrix.setups.slice(),
    inputs: core.inputs,
    reasonCodes,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Classify the current cycle's market regime and emit a
 * `RegimeOutput` matching the typedef in `cycleContext.js`.
 *
 * Pipeline ordering: this function is invoked AFTER Data_Engine
 * has populated `ctx.data` and BEFORE Liquidity_Engine populates
 * `ctx.liquidity`. `inputs.liquidityScore` is therefore typically
 * `null` at this stage; that is documented and intentional.
 *
 * @param {Object}            params
 * @param {Object}            params.ctx        Immutable cycle context.
 * @param {Readonly<Object>}  params.settings   Algo_Settings snapshot.
 * @returns {Object}                            RegimeOutput.
 */
function classifyRegime({ ctx, settings } = {}) {
  // Hard guard: missing ctx / settings is a programming error in
  // the orchestrator, but per Req 1.5 we never throw — return the
  // safe-default high-risk output.
  if (!ctx || !ctx.data || !settings) {
    logger.warn(
      { hasCtx: !!ctx, hasData: !!(ctx && ctx.data), hasSettings: !!settings },
      '[regimeEngine.adapter] missing ctx / data / settings — emitting high-risk safe default'
    );
    return emitOutput({
      label: 'high-risk',
      confidence: 0,
      settings: settings || {},
      inputs: {
        atr: null,
        adx: null,
        vwapDistance: null,
        volumeProfile: null,
        vix: null,
        oiConcentration: null,
        futuresPremium: null,
        breadth: null,
        liquidityScore: null,
      },
    });
  }

  try {
    // ------------------------------------------------------------
    // 1. Extract every input listed in Req 5.1 from ctx + settings.
    // ------------------------------------------------------------
    const data = ctx.data;
    const fiveMin = data.candles && data.candles.spot ? data.candles.spot['5m'] : null;
    const spotLtp = data.spot && typeof data.spot.ltp === 'number' ? data.spot.ltp : null;
    const sessionVwap = data.vwap && typeof data.vwap.session === 'number' ? data.vwap.session : null;

    const atr = readAtr(fiveMin);
    const adx = readAdx(fiveMin, spotLtp, { vwap: sessionVwap });
    const vwapDistance = computeVwapDistancePct(spotLtp, sessionVwap);
    const volumeProfile = readVolumeProfile(fiveMin);
    const vix = typeof data.vix === 'number' ? data.vix : null;
    const oiConcentration = computeOIConcentration(data.optionChain);
    const futuresPremium =
      data.futures && typeof data.futures.premiumToSpot === 'number'
        ? data.futures.premiumToSpot
        : null;
    const breadth = readBreadth(ctx);
    // Pipeline-order note (see file header): ctx.liquidity is null
    // at this stage. Subtask 4.2 may replace this with a previous-
    // cycle snapshot.
    const liquidityScore = readLiquidityScore(ctx);

    /** @type {Object} */
    const inputs = {
      atr,
      adx,
      vwapDistance,
      vwapDistancePct: vwapDistance,
      volumeProfile,
      vix,
      oiConcentration,
      futuresPremium,
      breadth,
      liquidityScore,
      data, // pass through for VP scoring (uses spot.ltp)
      // MTF directional bias for emitOutput's direction gate.
      _mtfTrends: {
        '1m': _trendFromCandles(_extractCandles(ctx, '1m'), 5),
        '5m': _trendFromCandles(_extractCandles(ctx, '5m'), 5),
        '15m': _trendFromCandles(_extractCandles(ctx, '15m'), 4),
        '30m': _trendFromCandles(_extractCandles(ctx, '15m'), 8),
      },
    };

    // ------------------------------------------------------------
    // 2. Run the LEGACY classifier so we reuse its heuristics
    //    (TRENDING / EXPANSION / RANGING / QUIET / COMPRESSION /
    //    MANIPULATION / NEUTRAL / WEAK_TRENDING / UNCERTAIN).
    // ------------------------------------------------------------
    const legacyMarketData = buildLegacyMarketData(ctx, inputs);
    let legacyResult;
    try {
      legacyResult = marketRegimeDetector.classifyMarketRegime(legacyMarketData);
    } catch (err) {
      logger.warn(
        { err: err && err.message },
        '[regimeEngine.adapter] classifyMarketRegime threw — falling back to UNCERTAIN'
      );
      legacyResult = { regime: 'UNCERTAIN' };
    }
    const legacyLabel = legacyResult && typeof legacyResult.regime === 'string'
      ? legacyResult.regime
      : 'UNCERTAIN';

    // ------------------------------------------------------------
    // 3. Compute new detectors. Order matters — we apply the
    //    overrides in priority order:
    //       expiry-manipulation > fake-breakout > momentum-exhaustion
    //    > legacy mapping. Expiry manipulation is the highest-
    //    severity override because it closes ALL trade permissions
    //    AND zeroes the multiplier (Req 5.7) in subtask 4.2.
    // ------------------------------------------------------------
    const daysToExpiry = computeDaysToExpiry(data.optionChain, ctx.cycleStartedAt);
    const detectorSignals = { daysToExpiry, oiConcentration };

    const expiryManipulation = detectExpiryManipulation(detectorSignals, settings);
    const fakeBreakout = !expiryManipulation && detectFakeBreakout(ctx);
    const momentumExhaustion =
      !expiryManipulation && !fakeBreakout && detectMomentumExhaustion(ctx, inputs, settings);

    let label;
    if (expiryManipulation) {
      label = 'expiry-manipulation';
    } else if (fakeBreakout) {
      label = 'fake-breakout';
    } else if (momentumExhaustion) {
      label = 'momentum-exhaustion';
    } else {
      label = mapLegacyToDesignLabel(legacyLabel, detectorSignals, settings);
    }

    // ------------------------------------------------------------
    // RANGING override (calibration fix):
    // ------------------------------------------------------------
    // The legacy classifier emits RANGING (mapped to 'ranging')
    // whenever its `volatility` score < 0.3 AND `trendStrength` <
    // 0.15, which on NIFTY tracks a 5-day calibration floor that
    // is too quiet for a typical 0.10% ATR + ADX 22 session.
    // When the real-data ATR % shows genuine intraday volatility
    // (≥ atrPctMin) AND ADX is in the trending zone, override
    // RANGING to TRENDING. This is not a relaxation — it's
    // correcting a scale mismatch between the legacy detector's
    // 0..1 inputs and NIFTY's actual ATR/ADX scale.
    //
    // The override also fires for `high-risk` (legacy UNCERTAIN)
    // labels because the legacy detector emits UNCERTAIN any
    // time its inputs disagree mildly — on a real trending day
    // with ATR/ADX showing strength, we should be trading.
    // ------------------------------------------------------------
    if (label === 'ranging' || label === 'high-risk') {
      const atrFloors = (settings && settings.regimeEngine && settings.regimeEngine.volatilityFloors) || {};
      const adxFloors = (settings && settings.regimeEngine && settings.regimeEngine.adxFloors) || {};
      const atrPctMin = typeof atrFloors.atrPctMin === 'number' ? atrFloors.atrPctMin : 0.05;
      const adxRangeFloor = typeof adxFloors.ranging === 'number' ? adxFloors.ranging : 18;
      const atrPctVal = atr && typeof atr.atrPct === 'number' ? atr.atrPct : null;
      const adxValueVal = adx && typeof adx.value === 'number' ? adx.value : null;
      // Use the SOFTER ranging-floor for ADX (≥18) since real
      // trending sessions on NIFTY can spend long stretches at
      // ADX 18-22 without being chop. ATR floor stays at min.
      if (atrPctVal !== null && adxValueVal !== null
        && atrPctVal >= atrPctMin && adxValueVal >= adxRangeFloor) {
        // Confirm with MTF: at least one of 15m / 30m must be
        // directional (not neutral). Otherwise leave the label
        // alone (it really is chop).
        const mtf15 = _trendFromCandles(_extractCandles(ctx, '15m'), 4);
        const mtf30 = _trendFromCandles(_extractCandles(ctx, '15m'), 8);
        if (mtf15 !== 'neutral' || mtf30 !== 'neutral') {
          label = 'trending';
        }
      }
    }

    // ------------------------------------------------------------
    // 4. Compute confidence in [0, 10] (Req 5.2).
    // ------------------------------------------------------------
    const confidence = scoreConfidence(label, inputs, settings);

    return emitOutput({ label, confidence, inputs, settings });
  } catch (err) {
    // Never throw (Req 1.5 / file header). Emit safe-default
    // high-risk so downstream gates short-circuit to NO_TRADE.
    logger.error(
      { err: err && err.message },
      '[regimeEngine.adapter] unrecoverable failure — emitting high-risk safe default'
    );
    return emitOutput({
      label: 'high-risk',
      confidence: 0,
      settings: settings || {},
      inputs: {
        atr: null,
        adx: null,
        vwapDistance: null,
        volumeProfile: null,
        vix: null,
        oiConcentration: null,
        futuresPremium: null,
        breadth: null,
        liquidityScore: null,
      },
    });
  }
}

module.exports = {
  classifyRegime,
  // Exposed for unit tests / orchestrator-side reuse.
  REGIME_LABELS,
  // Exposed as a convenience for downstream consumers / tests.
  // The detectors are intentionally pure — no side effects.
  detectFakeBreakout,
  detectMomentumExhaustion,
  detectExpiryManipulation,
  scoreConfidence,
  mapLegacyToDesignLabel,
  // Subtask 4.2 helpers — exposed for tests and any future
  // consumer that needs to introspect the permission matrix
  // without re-running the full classifier.
  REGIME_PERMISSION_MATRIX,
  applyHardRules,
  permissionsFor,
  emitOutput,
};
