/**
 * ============================================================
 * MASTER SCORE (Req 16) — task 9.1
 * ============================================================
 * Pure deterministic weighted-combine that produces the per-cycle
 * `masterScore ∈ [0, 100]` consumed by Signal_Engine and the
 * audit row. The module is SYNC, has NO external dependencies
 * other than `engineLogger.service.js` for the renormalisation
 * audit event, and NEVER throws — every failure mode degrades to
 * a stable-shape `{ score: 0, ... }` emission so the orchestrator
 * can always log a CYCLE_AUDIT row.
 *
 * ------------------------------------------------------------
 * Eight contributor keys (Req 16.2)
 * ------------------------------------------------------------
 * The eight keys read from `Algo_Settings.indicatorWeights`
 * (excluding the `oiShortCoveringBoost` multiplier) are:
 *
 *   oiBuildup        0.25
 *   vwapAvwap        0.20
 *   volumeProfile    0.15
 *   deltaOrderflow   0.15
 *   liquidity        0.10
 *   ivVix            0.05
 *   breadth          0.05
 *   pcrWeight        0.05    // hard-clamped <= 0.10 (Req 11.6, Req 16.5)
 *
 * The ninth key in the settings group, `oiShortCoveringBoost`,
 * is NOT a contributor weight — it is a multiplicative boost
 * applied to the `oiBuildup` contribution value before
 * normalisation (Req 10.2 / Req 16.5). See the
 * "shortCoveringBoost" section below.
 *
 * ------------------------------------------------------------
 * Indicator priority order (Req 16.1)
 * ------------------------------------------------------------
 * Req 16.1 enumerates ten institutional priorities. We collapse
 * them onto the eight contributor keys per the design's
 * documented mapping ("Master score" subsection of design.md):
 *
 *   1. OI + OI Change          → oiBuildup
 *   2. VWAP + AVWAP             → vwapAvwap
 *   3. Volume Profile           → volumeProfile
 *   4. Liquidity Structure      → liquidity
 *   5. Price Action             → (folded into structure-driven contributions
 *                                  upstream; not a standalone weight)
 *   6. Delta / Orderflow        → deltaOrderflow
 *   7. Futures Correlation      → (folded into oiBuildup / deltaOrderflow upstream)
 *   8. ATR Expansion            → ivVix         (volatility regime contributor)
 *   9. Breadth                  → breadth
 *  10. EMA Confirmation         → pcrWeight     (last, secondary-only confirmation)
 *
 * The `EVALUATION_ORDER` constant below encodes the eight keys
 * in priority order. We iterate in this order so that the
 * "short-circuit on missing inputs" semantics required by the
 * task description fall out naturally: a missing earlier
 * contributor is registered as skipped and the iteration moves on
 * to the next key. The score itself does not actually short-
 * circuit (every key gets evaluated so we know exactly which set
 * to renormalise over), but the LOGGING and `contributionsSkipped`
 * audit list reflect the priority order.
 *
 * ------------------------------------------------------------
 * Contribution shape
 * ------------------------------------------------------------
 * Each entry of the `contributions` map is one of:
 *
 *   { value: number ∈ [0, 1], stale?: false }   // usable
 *   { value: ..., stale: true }                  // explicitly stale
 *   null | undefined                             // missing
 *
 * Non-finite values, negative values, values > 1, and explicit
 * `stale: true` records all behave as MISSING. The contribution
 * is excluded from the score and its weight is redistributed
 * among the remaining contributors via renormalisation
 * (Req 16.4).
 *
 * ------------------------------------------------------------
 * Score formula (Req 16.2 / 16.3 / 16.4)
 * ------------------------------------------------------------
 * Let `K` be the set of usable contributor keys for this cycle
 * and `w_k` the operator-supplied weight for key `k`. Define:
 *
 *   sumW   = Σ_{k ∈ ALL_KEYS} w_k
 *   sumW_K = Σ_{k ∈ K}        w_k
 *
 * Step A — operator-validated full vector:
 *   When K = ALL_KEYS AND |sumW − 1| ≤ 0.001 the weighted
 *   combine is computed directly:
 *
 *     score01 = Σ_{k ∈ K} w_k · c_k
 *
 * Step B — renormalisation path:
 *   When K ⊊ ALL_KEYS (some contributors missing/stale) we
 *   renormalise the weights of the remaining contributors so
 *   they sum to 1.00 within tolerance 0.001:
 *
 *     w'_k = w_k / sumW_K        for k ∈ K
 *     score01 = Σ_{k ∈ K} w'_k · c_k
 *
 *   When `sumW_K ≤ 0` (every remaining weight is zero or
 *   non-finite) we treat the cycle as "no usable
 *   contributors" and return `score = 0`.
 *
 * Step C — clamp:
 *   `score = clamp(score01 × 100, 0, 100)`.
 *
 * ------------------------------------------------------------
 * shortCoveringBoost (Req 10.2 / Req 16.5)
 * ------------------------------------------------------------
 * `shortCoveringBoost` is a multiplier ≥ 1.0 (validated by
 * `algoSettings.validateSettings`). It is applied to the
 * `oiBuildup` contribution VALUE before normalisation:
 *
 *   c_oiBuildup ← min(1, c_oiBuildup × shortCoveringBoost)
 *
 * The clamp to `[0, 1]` matters: a boost of 2.0 against
 * `c_oiBuildup = 0.5` yields `1.0` (the maximum contribution).
 * Without the clamp the boosted contribution could drive the
 * weighted sum above 1.0 even though every w_k stays valid;
 * we'd then have to clamp the final score anyway. Clamping at
 * the contribution level keeps the per-contributor invariant
 * `c_k ∈ [0, 1]` intact, which is what every downstream
 * audit-row consumer expects.
 *
 * Missing / non-finite / `< 1.0` boost values default to `1.0`
 * (no boost) — `algoSettings.validateSettings` already rejects
 * out-of-range candidates at load / hot-reload, but we re-apply
 * the floor at runtime as a defensive safety net so a future
 * code path that bypasses validation cannot let the boost
 * become a damping factor.
 *
 * ------------------------------------------------------------
 * Renormalisation logging (Req 16.4)
 * ------------------------------------------------------------
 * When the cycle takes the renormalisation path we emit ONE
 * info-level event via `engineLogger.logEvent({ ... })` with
 * `eventType = 'master_score_renormalised'`, including the
 * `cycleId` (when supplied), the keys that were skipped, the
 * normalised weights actually used, and the resulting score.
 *
 * The orchestrator owns the active `ScalpingSession._id` and
 * threads it via `params.sessionId`. When `sessionId` is missing
 * we still call `engineLogger.logEvent` — the model rejects the
 * missing required field internally and the standard logger
 * captures the event as the audit-of-last-resort.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - On invalid inputs (null/undefined `params`, non-object
 *     contributions, non-object weights) the function returns
 *     `{ score: 0, contributionsUsed: 0, normalisedWeights: {},
 *        contributionsSkipped: [...all keys...], renormalised: false }`.
 *   - When every contribution is missing/stale the function
 *     returns `{ score: 0, contributionsUsed: 0, ... }` and DOES
 *     NOT emit a renormalisation log (there is nothing to
 *     renormalise).
 *   - The function NEVER throws; any unexpected runtime error
 *     is caught at the outer boundary and degraded to the empty
 *     emission shape above.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 16.1 — indicator priority order, encoded by
 *                `EVALUATION_ORDER`.
 *   - Req 16.2 — Σ w_i × c_i with default weights.
 *   - Req 16.3 — Σ weights = 1.00 ± 0.001 (validated upstream
 *                by `algoSettings.validateSettings`; we re-check
 *                at runtime so a misuse degrades to safe-default).
 *   - Req 16.4 — renormalise + log on missing/stale contributors.
 *   - Req 16.5 — pcrWeight ≤ 0.10 (clamped upstream); short-
 *                covering boost ≥ 1.0 (clamped here as a safety
 *                net).
 *   - Req 10.2 — shortCoveringBoost applied multiplicatively to
 *                oiBuildup BEFORE normalisation.
 *   - Req 1.5  — degrade gracefully; never throw.
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const engineLogger = require('../engineLogger.service');

// ============================================================
// Constants
// ============================================================

/**
 * The eight contributor keys consumed by the master score.
 * Frozen so callers can rely on identity and the priority
 * ordering used by `EVALUATION_ORDER` below.
 */
const CONTRIBUTOR_KEYS = Object.freeze([
  'oiBuildup',
  'vwapAvwap',
  'volumeProfile',
  'deltaOrderflow',
  'liquidity',
  'ivVix',
  'breadth',
  'pcrWeight',
]);

/**
 * Indicator priority order (Req 16.1) collapsed onto the eight
 * contributor keys per the design's "Master score" subsection.
 * Used as the iteration order so `contributionsSkipped` and the
 * renormalisation log preserve the documented institutional
 * priority.
 */
const EVALUATION_ORDER = Object.freeze([
  'oiBuildup',       // 1. OI + OI Change                  (highest priority)
  'vwapAvwap',       // 2. VWAP + AVWAP
  'volumeProfile',   // 3. Volume Profile
  'liquidity',       // 4. Liquidity Structure
  'deltaOrderflow',  // 5. Delta / Orderflow
  'ivVix',           // 6. ATR Expansion / IV regime
  'breadth',         // 7. Breadth
  'pcrWeight',       // 8. EMA Confirmation / PCR (secondary, lowest)
]);

/**
 * Tolerance for "weights sum to 1" checks (Req 16.3 / Req 16.4).
 * Mirrors the tolerance used by `algoSettings.validateSettings`.
 */
const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * Hard ceiling on `pcrWeight` per Req 11.6 / Req 16.5. Re-clamped
 * at runtime as a defensive safety net on top of validation.
 */
const PCR_WEIGHT_CEILING = 0.10;

/**
 * Floor on `shortCoveringBoost` per Req 10.2 — the boost is a
 * multiplier, never a damping factor. Defaults to no-boost when
 * the supplied value is missing / non-finite / below the floor.
 */
const SHORT_COVERING_BOOST_FLOOR = 1.0;

// ============================================================
// Helpers — input validation
// ============================================================

/**
 * Test whether `v` is a finite JavaScript number (excludes
 * `NaN`, `Infinity`, `-Infinity`, and non-numeric values).
 *
 * @param {*} v
 * @returns {boolean}
 */
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Clamp `x` to the closed interval `[lo, hi]`. Non-finite
 * inputs return `lo` so downstream arithmetic never sees a NaN.
 *
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(x, lo, hi) {
  if (!isFiniteNum(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Resolve the operator-supplied weight for `key`, runtime-clamped
 * defensively:
 *   - non-finite / negative ⇒ 0
 *   - `pcrWeight > 0.10`    ⇒ 0.10 (Req 11.6 / Req 16.5)
 *
 * `algoSettings.validateSettings` already rejects out-of-range
 * candidates at load / hot-reload — this is a safety net so a
 * code path that bypasses validation cannot let a single
 * contributor exceed its documented role.
 *
 * @param {Readonly<Object>|null|undefined} weights
 * @param {string} key
 * @returns {number}  Clamped weight in `[0, +∞)`.
 */
function resolveWeight(weights, key) {
  if (!weights || typeof weights !== 'object') return 0;
  const v = weights[key];
  if (!isFiniteNum(v) || v < 0) return 0;
  if (key === 'pcrWeight' && v > PCR_WEIGHT_CEILING) return PCR_WEIGHT_CEILING;
  return v;
}

/**
 * Resolve the `shortCoveringBoost` multiplier, runtime-clamped
 * to `≥ 1.0`. Missing / non-finite / < 1.0 values default to
 * `1.0` (no boost).
 *
 * @param {*} boost
 * @returns {number}
 */
function resolveShortCoveringBoost(boost) {
  if (!isFiniteNum(boost)) return SHORT_COVERING_BOOST_FLOOR;
  if (boost < SHORT_COVERING_BOOST_FLOOR) return SHORT_COVERING_BOOST_FLOOR;
  return boost;
}

/**
 * Read the contribution VALUE for `key` off the `contributions`
 * map, applying the documented "missing/stale" semantics:
 *
 *   - `null` / `undefined`           → null (missing)
 *   - non-object record              → null (missing)
 *   - `record.stale === true`        → null (missing)
 *   - `record.value` non-finite      → null (missing)
 *   - `record.value` clamped to [0, 1] (defensive — out-of-range
 *     contributions are NOT silently dropped because the upstream
 *     adapter has already promised `[0, 1]` per the contributor
 *     contract; clamping is a defensive safety net)
 *
 * @param {Readonly<Object>|null|undefined} contributions
 * @param {string} key
 * @returns {number|null}
 */
function readContribution(contributions, key) {
  if (!contributions || typeof contributions !== 'object') return null;
  const rec = contributions[key];
  if (rec === null || rec === undefined) return null;
  if (typeof rec !== 'object') return null;
  if (rec.stale === true) return null;
  const v = rec.value;
  if (!isFiniteNum(v)) return null;
  return clamp(v, 0, 1);
}

// ============================================================
// Helpers — empty / safe-default emission
// ============================================================

/**
 * Build the stable-shape "no-master-score" emission used when
 * `params` is malformed, when an unexpected error is caught at
 * the outer boundary, or when every contribution is
 * missing/stale.
 *
 * @returns {{score:number, normalisedWeights:Object, contributionsUsed:number, contributionsSkipped:string[], renormalised:boolean}}
 */
function buildEmptyEmission() {
  return {
    score: 0,
    normalisedWeights: {},
    contributionsUsed: 0,
    contributionsSkipped: CONTRIBUTOR_KEYS.slice(),
    renormalised: false,
  };
}

// ============================================================
// Helpers — renormalisation logging
// ============================================================

/**
 * Emit a single info-level `EngineEventLog` event recording
 * that this cycle took the renormalisation path (Req 16.4). The
 * event is best-effort: a missing `engineLogger`, a missing
 * `sessionId`, or a model-level rejection MUST NOT block the
 * pipeline. The standard logger is the audit-of-last-resort.
 *
 * The orchestrator (task 17) is responsible for invoking
 * `computeMasterScore` with the active `ScalpingSession._id` as
 * `params.sessionId` so this event is correlated with the cycle
 * audit row.
 *
 * @param {Object} payload
 * @param {string|null} payload.cycleId
 * @param {string|null} payload.sessionId
 * @param {string[]}    payload.skipped            keys excluded this cycle
 * @param {string[]}    payload.used               keys used this cycle
 * @param {Object}      payload.normalisedWeights  the w' actually applied
 * @param {number}      payload.score              the resulting 0..100 score
 * @returns {void}
 */
function logRenormalisationEvent(payload) {
  const { cycleId, sessionId, skipped, used, normalisedWeights, score } = payload;
  // No sessionId yet (very first cycles after start, smoke check, or
  // dry-run) — fall back to plain logger so we don't generate a
  // Mongoose validation error every cycle. The model requires a
  // valid sessionId; persisting without one is impossible.
  if (!sessionId) {
    try {
      logger.info(
        { cycleId, skipped, used, normalisedWeights, score },
        '[masterScore] renormalised (no sessionId — not persisted)'
      );
    } catch (_) { /* swallow */ }
    return;
  }
  try {
    if (engineLogger && typeof engineLogger.logEvent === 'function') {
      engineLogger.logEvent({
        sessionId,
        eventType: 'master_score_renormalised',
        level: 'info',
        message:
          'Master score renormalised — '
          + `${skipped.length} of ${CONTRIBUTOR_KEYS.length} contributors `
          + 'missing or stale; remaining weights rescaled to sum to 1.00.',
        data: {
          cycleId: cycleId || null,
          skipped,
          used,
          normalisedWeights,
          score,
        },
      });
    } else {
      // Fallback: standard logger so the event is never lost.
      logger.info(
        { cycleId, skipped, used, normalisedWeights, score },
        '[masterScore] renormalised (engineLogger unavailable)'
      );
    }
  } catch (err) {
    // Logging must never break the pipeline.
    try {
      logger.warn(
        { err: err && err.message },
        '[masterScore] failed to emit renormalisation event'
      );
    } catch (_) { /* swallow */ }
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Compute the per-cycle master score (Req 16).
 *
 * @param {Object} params
 * @param {Readonly<Object>} params.contributions   Map of contributor → `{ value, stale }`.
 *                                                  Keys: `oiBuildup`, `vwapAvwap`, `volumeProfile`,
 *                                                  `deltaOrderflow`, `liquidity`, `ivVix`, `breadth`,
 *                                                  `pcrWeight`.
 * @param {Readonly<Object>} params.weights         Map of contributor → number ∈ [0, 1].
 *                                                  Sourced from `Algo_Settings.indicatorWeights`.
 * @param {number}  [params.shortCoveringBoost=1]   Multiplier ≥ 1.0 applied to `oiBuildup`
 *                                                  contribution BEFORE normalisation
 *                                                  (Req 10.2 / Req 16.5). Sourced from
 *                                                  `Algo_Settings.indicatorWeights.oiShortCoveringBoost`.
 * @param {string}  [params.sessionId]              Active `ScalpingSession._id` used for the
 *                                                  renormalisation audit event. Optional —
 *                                                  the orchestrator wires this once available.
 * @param {string}  [params.cycleId]                Cycle ULID for the renormalisation audit
 *                                                  event. Optional.
 * @returns {{score:number, normalisedWeights:Object, contributionsUsed:number, contributionsSkipped:string[], renormalised:boolean}}
 *          Stable-shape result. `score` is in `[0, 100]`.
 */
function computeMasterScore(params) {
  // ----------------------------------------------------------
  // Input validation — degrade to safe-default on malformed input.
  // ----------------------------------------------------------
  if (!params || typeof params !== 'object') {
    return buildEmptyEmission();
  }

  const {
    contributions,
    weights,
    shortCoveringBoost,
    sessionId,
    cycleId,
  } = params;

  if (!contributions || typeof contributions !== 'object') {
    return buildEmptyEmission();
  }
  if (!weights || typeof weights !== 'object') {
    return buildEmptyEmission();
  }

  try {
    // --------------------------------------------------------
    // Step 1 — resolve effective weights and short-covering boost.
    // --------------------------------------------------------
    const effectiveWeights = {};
    let totalConfiguredWeight = 0;
    for (const key of CONTRIBUTOR_KEYS) {
      const w = resolveWeight(weights, key);
      effectiveWeights[key] = w;
      totalConfiguredWeight += w;
    }
    const boost = resolveShortCoveringBoost(shortCoveringBoost);

    // --------------------------------------------------------
    // Step 2 — iterate contributors in priority order, applying
    //          the boost to oiBuildup and skipping missing/stale.
    // --------------------------------------------------------
    const usedKeys = [];
    const skippedKeys = [];
    /** @type {Object<string, number>} effective contribution VALUES post-boost */
    const effectiveValues = {};
    let usedWeightSum = 0;

    for (const key of EVALUATION_ORDER) {
      let value = readContribution(contributions, key);
      if (value === null) {
        skippedKeys.push(key);
        continue;
      }
      // Req 10.2: apply the short-covering boost to oiBuildup
      // BEFORE normalisation, then clamp back to [0, 1] so every
      // c_k stays on the same scale.
      if (key === 'oiBuildup' && boost !== 1.0) {
        value = clamp(value * boost, 0, 1);
      }
      effectiveValues[key] = value;
      usedKeys.push(key);
      usedWeightSum += effectiveWeights[key];
    }

    // --------------------------------------------------------
    // Step 3 — every contributor missing/stale ⇒ score = 0.
    // --------------------------------------------------------
    if (usedKeys.length === 0 || usedWeightSum <= 0) {
      return {
        score: 0,
        normalisedWeights: {},
        contributionsUsed: 0,
        contributionsSkipped: skippedKeys,
        renormalised: false,
      };
    }

    // --------------------------------------------------------
    // Step 4 — decide between direct combine vs renormalisation.
    // --------------------------------------------------------
    const operatorVectorValid =
      Math.abs(totalConfiguredWeight - 1.0) <= WEIGHT_SUM_TOLERANCE;
    const fullVectorUsed = skippedKeys.length === 0;

    /** @type {Object<string, number>} */
    const normalisedWeights = {};
    let score01 = 0;

    if (fullVectorUsed && operatorVectorValid) {
      // Direct combine — operator-supplied weights already sum to 1.
      for (const key of usedKeys) {
        normalisedWeights[key] = effectiveWeights[key];
        score01 += effectiveWeights[key] * effectiveValues[key];
      }
    } else {
      // Renormalisation path (Req 16.4). Scale each remaining
      // weight by `1 / usedWeightSum` so they sum to 1.00 within
      // tolerance.
      const inv = 1 / usedWeightSum;
      let normalisedSum = 0;
      for (const key of usedKeys) {
        const w = effectiveWeights[key] * inv;
        normalisedWeights[key] = w;
        normalisedSum += w;
        score01 += w * effectiveValues[key];
      }
      // Defensive invariant — the renormalised sum MUST be 1.00 ± 0.001.
      // If floating-point drift pushes us outside that band (e.g.
      // because every w_k was tiny), fall back to a safe default.
      if (Math.abs(normalisedSum - 1.0) > WEIGHT_SUM_TOLERANCE) {
        logger.warn(
          { normalisedSum, usedKeys, usedWeightSum },
          '[masterScore] renormalised weights drift exceeds tolerance; degrading to score=0'
        );
        return {
          score: 0,
          normalisedWeights: {},
          contributionsUsed: 0,
          contributionsSkipped: CONTRIBUTOR_KEYS.slice(),
          renormalised: false,
        };
      }
    }

    // --------------------------------------------------------
    // Step 5 — clamp final score to [0, 100].
    // --------------------------------------------------------
    const score = clamp(score01 * 100, 0, 100);
    const renormalised = !(fullVectorUsed && operatorVectorValid);

    // --------------------------------------------------------
    // Step 6 — log the renormalisation event when triggered.
    // --------------------------------------------------------
    if (renormalised) {
      logRenormalisationEvent({
        cycleId: typeof cycleId === 'string' && cycleId.length > 0 ? cycleId : null,
        sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
        skipped: skippedKeys,
        used: usedKeys,
        normalisedWeights,
        score,
      });
    }

    return {
      score,
      normalisedWeights,
      contributionsUsed: usedKeys.length,
      contributionsSkipped: skippedKeys,
      renormalised,
    };
  } catch (err) {
    // Outer safety net — `computeMasterScore` MUST NEVER throw.
    try {
      logger.warn(
        { err: err && err.message },
        '[masterScore] unexpected error; degrading to score=0'
      );
    } catch (_) { /* swallow */ }
    return buildEmptyEmission();
  }
}

module.exports = {
  computeMasterScore,
  // Exposed for unit tests / property tests / smoke checks and
  // for orchestrator-side reuse.
  CONTRIBUTOR_KEYS,
  EVALUATION_ORDER,
  WEIGHT_SUM_TOLERANCE,
};
