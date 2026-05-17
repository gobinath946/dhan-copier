/**
 * ============================================================
 * OI_ENGINE ADAPTER (Req 10) — tasks 7.1 + 7.3 + 7.6 + 7.9
 * ============================================================
 * Pure deterministic OI classifier that emits a single canonical
 * `OIOutput` block (see the JSDoc typedef in `cycleContext.js`)
 * onto the immutable cycle context. The adapter is SYNC, exposes
 * a single optional dependency (`gammaExposure.service.js`,
 * wired by subtask 7.9), and never throws — failure modes
 * always degrade to a stable-shape "no-OI-signal" emission so
 * downstream gates can treat the cycle as Neutral.
 *
 * Subtask 7.1 delivers:
 *   1. The deterministic per-strike classification table (Req 10.1).
 *      For each monitored strike the adapter emits TWO rows — one
 *      for the CE leg and one for the PE leg — applying the
 *      mapping documented in `classifyLeg` below against
 *      `Δp = priceChange`, `Δoi = oiChange`, and the operator-
 *      configured floor `f = oiEngine.classificationDeltaFloor`.
 *   2. The `shortCoveringBoostMultiplier` field surfaced from
 *      `indicatorWeights.oiShortCoveringBoost` (Req 10.2). The
 *      multiplier is documented in this module as the "explosive
 *      move" preference; the actual `× multiplier` weighting of
 *      the Short_Covering contribution is applied DOWNSTREAM by
 *      `masterScore.js` (subtask 9.1) where every contributor
 *      sits on the same `[0, 1]` scale before normalisation.
 *
 * Subtask 7.3 delivers (Req 10.3, Req 10.5, Req 10.6):
 *   3. Strike migration tracking. We carry a small module-level
 *      ring buffer of prior-cycle `(atmStrike, ceTotalBuildup,
 *      peTotalBuildup, futuresOI, cycleId, cycleStartedAt)`
 *      records and emit `strikeMigration { direction, magnitude }`
 *      where `magnitude` is the integer-strikes distance between
 *      the current ATM and the oldest ATM in the lookback window
 *      (`oiEngine.strikeMigrationLookbackCycles`), and `direction`
 *      is `'flat'` iff `magnitude < oiEngine.strikeMigrationFlatThreshold`.
 *   4. CE / PE dominance. `ceDominance` / `peDominance` are
 *      computed over the lookback window
 *      (`oiEngine.dominanceLookbackCycles`) using the sign-aware
 *      fractional comparison
 *          (sumA - sumB) / max(|sumA| + |sumB|, 1) > dominanceMargin
 *      against `oiEngine.dominanceMargin`.
 *   5. Futures OI alignment. `futuresOIAligned` is true iff
 *      `sign(Δfutures OI)` is non-zero, the dominant-side build-up
 *      sign (`+1` for CE-dominant, `-1` for PE-dominant) is
 *      non-zero, and the two signs are equal. `futuresAlignmentReason`
 *      narrates the negative cases per the design's documented
 *      priority order:
 *          missing endpoint  → 'futures_oi_missing'
 *          Δfutures OI === 0 → 'futures_oi_stale'
 *          dominant side 0   → 'no_dominant_side'
 *          signs match       → 'aligned'
 *          signs differ      → 'mismatch'
 *
 * Subtask 7.6 delivers (Req 10.4, Req 10.8):
 *   6. Per-strike `oiVelocity` and `oiAcceleration`. These are
 *      pure finite differences against the prior observation of
 *      the SAME (strike, side):
 *           oiVelocity      = (currentOI - prevOI) / dtSeconds
 *           oiAcceleration  = (currentVelocity - prevVelocity) / dtSeconds
 *      `dtSeconds` is computed from the current cycle's
 *      `cycleStartedAt` minus the prior observation's
 *      `cycleStartedAt`, divided by 1000. Using actual elapsed
 *      time is more robust than reading the configured
 *      `signalEngine.predictionIntervalMs` cadence — which is
 *      the *intended* cadence, not necessarily the realised one
 *      (cycles can be skipped, delayed, or run faster under
 *      backfill). When `dtSeconds` is 0, negative, or non-finite
 *      we emit `null` for both metrics on that cycle (no breach
 *      can be raised against a nonsense dt).
 *   7. First-observation safety. When `oiAtTMinus1` is unavailable
 *      (first cycle for the strike, or strike has just appeared
 *      in the chain) we emit `oiVelocity: null`. When
 *      `velocityAtTMinus1` is unavailable we emit
 *      `oiAcceleration: null`. Per Req 10.4 the breach gates
 *      downstream interpret `null` as "no signal this cycle"
 *      and never raise a velocity / acceleration breach.
 *   8. Per-strike IV emission shape (Req 10.8). When the leg's
 *      `iv` is finite ⇒ pass-through, `ivChange = iv - prevIV`
 *      (or null when no prev), `ivUnavailable = false`. When
 *      `iv` is missing / non-finite ⇒ `iv = null`, `ivChange =
 *      null`, `ivUnavailable = true`.
 *   9. `priceChange` is now finite-difference too:
 *      `ltp - prevLTP` when both finite, else `0`. The
 *      classifier coerces non-finite Δp to 0 (lands in Neutral),
 *      so callers continue to see a finite number on the row.
 *
 * Subtask 7.9 delivers (Req 3.5, Req 10.7, Req 10.9):
 *   10. `gammaPressure { netDealerGamma, gammaFlip, perStrike }`
 *      surfaced from `services/algorithms/gammaExposure.service.js`.
 *      The legacy service consumes the option chain in its own
 *      `{ strikes: [{ strike, call, put }] }` shape (with
 *      `.call.greeks.gamma` / `.put.greeks.gamma` fall-back); we
 *      adapt the cycle's normalised `{ strike, ce, pe }` snapshot
 *      to that shape inside `adaptOptionChainForGamma` so neither
 *      side has to know about the other's naming.
 *
 *      Failure semantics (Req 1.5):
 *        - `optionChain` missing / empty / spot LTP missing ⇒
 *          `gammaPressure: null` (no log; this is the no-data path).
 *        - `gammaExposure` throws OR returns null/undefined ⇒
 *          warn-log and `gammaPressure: null`. The error is
 *          NEVER propagated.
 *        - `perStrike` is bounded to the strikes already in the
 *          chain (no expansion); `auditLog.redactGammaPressure`
 *          collapses it when the array gets heavy.
 *
 *      Threshold validation (Req 10.9) is delegated to
 *      `algoSettings.validateSettings` — every `oiEngine.*`
 *      threshold (classification floor, lookbacks, dominance
 *      margin, velocity / acceleration / IV expansion floors)
 *      plus `indicatorWeights.oiShortCoveringBoost ≥ 1.0` is
 *      checked at startup AND on every hot-reload. A failure
 *      there refuses the load (or refuses the reload), retains
 *      the last valid configuration, and surfaces a
 *      configuration error identifying the failed key. This
 *      adapter consequently only ever sees already-validated
 *      settings.
 *
 * ------------------------------------------------------------
 * History buffers
 * ------------------------------------------------------------
 * The adapter keeps TWO module-level stores:
 *
 *   1. `HISTORY` (subtask 7.3) — a bounded ring buffer of
 *      cycle-LEVEL records `(atmStrike, ceTotalBuildup,
 *      peTotalBuildup, futuresOI, cycleId, cycleStartedAt)` used
 *      to compute strike migration, dominance, and futures
 *      alignment.
 *   2. `STRIKE_LEDGER` (subtask 7.6) — a `Map` keyed by
 *      `${strike}_${side}` carrying the per-LEG state
 *      `{ oi, ltp, iv, velocity, cycleId, cycleStartedAt }`
 *      from each leg's most recent observation. Used to compute
 *      the finite-difference `oiVelocity`, `oiAcceleration`,
 *      `ivChange`, and `priceChange` columns.
 *
 * Both stores are MULTI-CYCLE state — the orchestrator (subtask
 * 18) does not yet own a previous-cycle store, so the adapter
 * holds them itself. Each successful `classifyOI(...)` call
 * appends / updates AFTER the migration / dominance / alignment
 * AND the per-strike rows have been computed for the current
 * cycle, so the current cycle's signals are derived from STRICT
 * prior history. This keeps Req 19.1 (idempotency) intact for
 * the per-cycle output: re-classifying the SAME ctx against a
 * frozen-in-time pair of stores reproduces the same `OIOutput`.
 *
 * `HISTORY`:
 *   - Cap size = max(strikeMigrationLookbackCycles,
 *                    dominanceLookbackCycles), bounded by
 *     `HISTORY_BUFFER_HARD_CAP`.
 *   - Eviction: FIFO once the cap is hit.
 *   - Deduplication by `cycleId`.
 *
 * `STRIKE_LEDGER`:
 *   - Eviction: stale entries (legs that have NOT been observed
 *     for `2 × max(strikeMigrationLookbackCycles,
 *     dominanceLookbackCycles)` cycles' worth of time) are
 *     evicted on the next classify call. Staleness is measured
 *     in elapsed cycle time using `cycleStartedAt`.
 *   - Idempotency by `cycleId` per ledger entry: re-classifying
 *     the same cycle does NOT re-update the ledger (each entry
 *     tracks the `cycleId` of its last observation and refuses
 *     to overwrite for the same cycle).
 *
 * Reset: `__resetHistoryForTest()` clears BOTH stores so smoke
 * / property tests start from a clean slate. Production callers
 * must NEVER use it.
 *
 * Once subtask 18 wires a shared previous-cycle store both
 * buffers can become thin pass-throughs; the public API
 * (`classifyOI`, `recordCycleHistory`,
 * `__resetHistoryForTest`) is structured so that swap is local.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - When `ctx.data.optionChain` is missing OR has no usable
 *     `strikes`, the adapter returns a stable-shape `OIOutput`
 *     with `perStrike: []` and all other fields at their safe
 *     defaults.
 *   - When `settings.indicatorWeights.oiShortCoveringBoost` is
 *     missing or non-finite, the adapter emits
 *     `shortCoveringBoostMultiplier: 1` (the no-boost default;
 *     `1.0` is the lower bound enforced by
 *     `algoSettings.validateSettings`, Req 10.2).
 *   - The classifier itself is total: every (Δp, Δoi, f) triple
 *     maps to exactly one of the five labels (Req 19.4). Non-
 *     finite `Δp` or `Δoi` are coerced to `0` so the leg lands
 *     in `Neutral` rather than throwing.
 *   - The function never throws — any unexpected error is
 *     caught at the outer boundary and degrades to the stable-
 *     shape empty emission.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 3.5  — `gammaExposure.service.js` wired by subtask 7.9
 *   - Req 10.1 — per-strike classification table
 *   - Req 10.2 — `oiShortCoveringBoost` "explosive move" preference
 *   - Req 10.3 — strike migration definitional invariant
 *   - Req 10.4 — OI velocity / acceleration first-cycle invariant
 *   - Req 10.5 — CE / PE dominance over lookback with margin
 *   - Req 10.6 — futures-OI alignment vs dominant side
 *   - Req 10.7 — gamma pressure block sourced from gammaExposure
 *   - Req 10.8 — IV emission shape
 *   - Req 10.9 — threshold validation owned by
 *                `algoSettings.validateSettings`; this adapter
 *                only consumes already-validated settings.
 *   - Req 19.4 — OI classification correctness invariant
 *   - Design "OI_Engine Adapter (Req 10)"
 *   - OIOutput typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const gammaExposureService = require('../algorithms/gammaExposure.service');

// ============================================================
// Constants
// ============================================================

/**
 * Default `oiEngine.classificationDeltaFloor` used when the
 * operator hasn't configured one. Mirrors the documented
 * Algo_Settings Surface default in
 * `dhan-copier/backend/src/config/algoSettings.js`.
 *
 * `algoSettings.validateSettings` is the authoritative validator
 * for this key (Req 10.9); this default is only a runtime safety
 * net.
 */
const DEFAULT_CLASSIFICATION_DELTA_FLOOR = 0.0001;

/**
 * Default `indicatorWeights.oiShortCoveringBoost`. Mirrors the
 * documented Algo_Settings Surface default. The `≥ 1.0` lower
 * bound is enforced by `algoSettings.validateSettings` (Req 10.2);
 * this default is a runtime safety net.
 */
const DEFAULT_SHORT_COVERING_BOOST = 1;

/**
 * Defaults for the subtask 7.3 history-driven settings. Mirrors
 * the Algo_Settings Surface defaults; only used as a runtime
 * safety net.
 */
const DEFAULT_STRIKE_MIGRATION_LOOKBACK = 6;
const DEFAULT_STRIKE_MIGRATION_FLAT_THRESHOLD = 1;
const DEFAULT_DOMINANCE_LOOKBACK = 12;
const DEFAULT_DOMINANCE_MARGIN = 0.10;

/**
 * Hard ceiling on the history ring-buffer size. Even if an
 * operator configures a very long lookback we never grow the
 * buffer past this cap, so the module cannot leak memory under
 * a misconfiguration. The caller-visible lookback is still the
 * configured value; this just bounds the underlying storage.
 */
const HISTORY_BUFFER_HARD_CAP = 256;

/**
 * The five OI classification labels enumerated in Req 10.1. Used
 * for documentation / type-narrowing of the classifier output.
 */
const OI_CLASSES = Object.freeze({
  LONG_BUILDUP: 'Long_Buildup',
  SHORT_BUILDUP: 'Short_Buildup',
  SHORT_COVERING: 'Short_Covering',
  LONG_UNWINDING: 'Long_Unwinding',
  NEUTRAL: 'Neutral',
});

/**
 * The five `futuresAlignmentReason` values enumerated in Req 10.6.
 * Frozen so callers can rely on identity comparison.
 */
const FUTURES_ALIGNMENT_REASONS = Object.freeze({
  ALIGNED: 'aligned',
  NO_DOMINANT_SIDE: 'no_dominant_side',
  FUTURES_OI_STALE: 'futures_oi_stale',
  FUTURES_OI_MISSING: 'futures_oi_missing',
  MISMATCH: 'mismatch',
});

// ============================================================
// Module-level history ring buffer (subtask 7.3)
// ------------------------------------------------------------
// Holds prior-cycle records. See the "History buffer" section
// of the module header for the contract. Each entry shape:
//   {
//     atmStrike:       number|null,
//     ceTotalBuildup:  number,           // Σ CE oiChange
//     peTotalBuildup:  number,           // Σ PE oiChange
//     futuresOI:       number|null,
//     cycleId:         string|null,
//     cycleStartedAt:  number|null,
//   }
// ============================================================

/** @type {Array<Object>} */
let HISTORY = [];

// ============================================================
// Module-level per-strike ledger (subtask 7.6)
// ------------------------------------------------------------
// Holds the most-recent observation of each `(strike, side)`
// leg seen in any prior cycle. Used to compute the finite-
// difference per-leg metrics (`oiVelocity`, `oiAcceleration`,
// `ivChange`, `priceChange`).
//
// Key:    `${strike}_${side}`  (e.g. `"22500_CE"`).
// Value:  {
//           oi:             number|null,
//           ltp:            number|null,
//           iv:             number|null,
//           velocity:       number|null,    // last computed oiVelocity
//           cycleId:        string|null,    // last observation
//           cycleStartedAt: number|null,    // epoch ms; used for
//                                            staleness eviction
//         }
//
// Idempotency on `cycleId` is enforced inside
// `updateStrikeLedger(...)`: if the entry's `cycleId` matches
// the current cycle's, we refuse to overwrite. That keeps
// re-classification of the same cycle deterministic.
// ============================================================

/** @type {Map<string, {oi:number|null, ltp:number|null, iv:number|null, velocity:number|null, cycleId:string|null, cycleStartedAt:number|null}>} */
const STRIKE_LEDGER = new Map();

// ============================================================
// Module-level output cache (subtask 7.6 idempotency)
// ------------------------------------------------------------
// Re-classifying the SAME cycleId must reproduce the SAME
// OIOutput (Req 19.1). The migration / dominance / alignment
// signals are already idempotent on cycleId via `recordCycleHistory`'s
// dedup. The per-strike finite-difference columns, however,
// would change on re-run because the ledger has been mutated
// to contain the current cycle's snapshot. We cache the last
// emitted output keyed by cycleId and return a stable copy on
// re-run.
// ============================================================

/** @type {{ cycleId:string|null, output:Object|null }} */
let LAST_OUTPUT = { cycleId: null, output: null };

// ============================================================
// Helpers — settings extraction
// ============================================================

/**
 * Resolve the classification delta floor `f` from
 * `settings.oiEngine.classificationDeltaFloor`. Falls back to the
 * documented default when missing / non-finite. Negative or zero
 * floors collapse the table to "everything Neutral" — we accept
 * that pathologically but log a warning so an operator notices.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}
 */
function resolveClassificationDeltaFloor(settings) {
  const v =
    settings && settings.oiEngine
      ? settings.oiEngine.classificationDeltaFloor
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (v !== undefined) {
    logger.warn(
      { value: v },
      '[oiEngine.adapter] classificationDeltaFloor missing / non-positive; using default'
    );
  }
  return DEFAULT_CLASSIFICATION_DELTA_FLOOR;
}

/**
 * Resolve the Short_Covering boost multiplier from
 * `settings.indicatorWeights.oiShortCoveringBoost` (Req 10.2).
 * Falls back to `1` (the no-boost default) when missing or below
 * `1.0`. `algoSettings.validateSettings` is the authoritative
 * validator; this is a runtime safety net so the OIOutput shape
 * is always stable.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}                    Multiplier ≥ 1.0.
 */
function resolveShortCoveringBoost(settings) {
  const v =
    settings && settings.indicatorWeights
      ? settings.indicatorWeights.oiShortCoveringBoost
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return v;
  return DEFAULT_SHORT_COVERING_BOOST;
}

/**
 * Resolve a positive-integer setting from the `oiEngine` group,
 * with a runtime fallback. `algoSettings.validateSettings` is
 * the authoritative validator (Req 10.9); this is only a safety
 * net so the OIOutput shape stays stable on any pathological
 * config that slipped past validation.
 *
 * @param {Readonly<Object>|undefined} settings
 * @param {string} key
 * @param {number} fallback
 * @param {boolean} [allowZero=false]   When true, 0 is accepted.
 * @returns {number}
 */
function resolvePositiveInt(settings, key, fallback, allowZero) {
  const v =
    settings && settings.oiEngine ? settings.oiEngine[key] : undefined;
  const minOK = allowZero ? v >= 0 : v > 0;
  if (typeof v === 'number' && Number.isInteger(v) && minOK) return v;
  return fallback;
}

/**
 * Resolve `oiEngine.dominanceMargin`, clamping to `[0, 1]`.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}
 */
function resolveDominanceMargin(settings) {
  const v =
    settings && settings.oiEngine ? settings.oiEngine.dominanceMargin : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) return v;
  return DEFAULT_DOMINANCE_MARGIN;
}

// ============================================================
// Helpers — classification
// ============================================================

/**
 * Coerce a possibly-null / NaN / Infinite numeric leg field into
 * a finite number. Used so the classifier never sees a non-finite
 * `Δp` or `Δoi` (which would NaN-propagate through the table). A
 * non-finite input is treated as `0` — i.e. "no signal", which
 * lands the leg in `Neutral`.
 *
 * @param {*} value
 * @returns {number}
 */
function toFiniteOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Apply the deterministic OI classification table from Req 10.1.
 *
 * | Condition                       | Class            |
 * | `Δp ≥ +f` and `Δoi ≥ +f`        | Long_Buildup     |
 * | `Δp ≤ -f` and `Δoi ≥ +f`        | Short_Buildup    |
 * | `Δp ≥ +f` and `Δoi ≤ -f`        | Short_Covering   |
 * | `Δp ≤ -f` and `Δoi ≤ -f`        | Long_Unwinding   |
 * | otherwise                       | Neutral          |
 *
 * The mapping is total and unique by construction (Req 19.4).
 *
 * @param {number} priceChange    Δp; coerced via `toFiniteOrZero`.
 * @param {number} oiChange       Δoi; coerced via `toFiniteOrZero`.
 * @param {number} f              Positive classification floor.
 * @returns {('Long_Buildup'|'Short_Buildup'|'Short_Covering'|'Long_Unwinding'|'Neutral')}
 */
function classifyLeg(priceChange, oiChange, f) {
  const dp = toFiniteOrZero(priceChange);
  const doi = toFiniteOrZero(oiChange);

  // Defensive: a non-positive floor disables the classifier and
  // emits Neutral for every leg. `algoSettings.validateSettings`
  // already rejects this at hot-reload time (Req 10.9).
  if (!(typeof f === 'number' && Number.isFinite(f) && f > 0)) {
    return OI_CLASSES.NEUTRAL;
  }

  const priceUp = dp >= f;
  const priceDown = dp <= -f;
  const oiUp = doi >= f;
  const oiDown = doi <= -f;

  if (priceUp && oiUp) return OI_CLASSES.LONG_BUILDUP;
  if (priceDown && oiUp) return OI_CLASSES.SHORT_BUILDUP;
  if (priceUp && oiDown) return OI_CLASSES.SHORT_COVERING;
  if (priceDown && oiDown) return OI_CLASSES.LONG_UNWINDING;
  return OI_CLASSES.NEUTRAL;
}

/**
 * Build the ledger key for a `(strike, side)` leg.
 *
 * @param {number} strike
 * @param {('CE'|'PE')} side
 * @returns {string}
 */
function ledgerKey(strike, side) {
  return `${strike}_${side}`;
}

/**
 * Coerce a possibly-null / NaN / Infinite numeric leg field
 * into either a finite number or `null`. Used by the per-strike
 * ledger so the ledger never stores a NaN that would
 * NaN-propagate through the next cycle's finite-differences.
 *
 * @param {*} value
 * @returns {number|null}
 */
function toFiniteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build a single per-strike row (one CE leg or one PE leg).
 *
 * Subtask 7.1 emitted the deterministic classification + the
 * scaffold IV pass-through; subtask 7.6 fills in the finite-
 * difference columns (`oiVelocity`, `oiAcceleration`,
 * `ivChange`, `priceChange`) by looking up the prior
 * observation in `STRIKE_LEDGER`.
 *
 * `dtSeconds` is computed from the elapsed wall-time between
 * the prior observation's `cycleStartedAt` and the current
 * cycle's `cycleStartedAt`. When elapsed time is non-positive
 * or non-finite (clock skew, identical timestamps, missing
 * ctx) we treat velocity / acceleration as unavailable.
 *
 * @param {number} strike
 * @param {('CE'|'PE')} side
 * @param {Object|null} leg          Normalised leg `{ ltp, oi, oiChange, iv, ... }`.
 * @param {number} f                 Classification delta floor.
 * @param {number|null} cycleStartedAt
 * @returns {Object}
 */
function buildPerStrikeRow(strike, side, leg, f, cycleStartedAt) {
  const oiChangeRaw = leg && typeof leg.oiChange === 'number' ? leg.oiChange : null;
  const oiChange = toFiniteOrZero(oiChangeRaw);

  const currentOI = toFiniteOrNull(leg ? leg.oi : null);
  const currentLTP = toFiniteOrNull(leg ? leg.ltp : null);
  const currentIV = toFiniteOrNull(leg ? leg.iv : null);

  const prev = STRIKE_LEDGER.get(ledgerKey(strike, side)) || null;

  // dtSeconds — elapsed wall-time between the prior observation
  // and the current cycle. Use actual elapsed time so missed /
  // delayed cycles don't poison the finite-difference math.
  let dtSeconds = null;
  if (
    prev &&
    typeof prev.cycleStartedAt === 'number' &&
    Number.isFinite(prev.cycleStartedAt) &&
    typeof cycleStartedAt === 'number' &&
    Number.isFinite(cycleStartedAt)
  ) {
    const elapsedMs = cycleStartedAt - prev.cycleStartedAt;
    if (elapsedMs > 0) dtSeconds = elapsedMs / 1000;
  }

  // priceChange — finite-difference against prevLTP, else 0 so
  // the classifier (which expects a number) lands the leg in
  // Neutral. Matches the existing 7.1 contract for the row.
  const priceChange =
    prev && typeof prev.ltp === 'number' && Number.isFinite(prev.ltp) &&
    currentLTP !== null
      ? currentLTP - prev.ltp
      : 0;

  const classification = classifyLeg(priceChange, oiChange, f);

  // oiVelocity — null on first observation OR when dtSeconds is
  // unavailable OR currentOI / prevOI is null. Per Req 10.4 the
  // breach gates downstream interpret null as "no breach this
  // cycle".
  let oiVelocity = null;
  if (
    prev &&
    typeof prev.oi === 'number' &&
    Number.isFinite(prev.oi) &&
    currentOI !== null &&
    dtSeconds !== null &&
    dtSeconds > 0
  ) {
    oiVelocity = (currentOI - prev.oi) / dtSeconds;
  }

  // oiAcceleration — null when either velocity is null OR
  // dtSeconds is unavailable. Per Req 10.4 breach gates
  // interpret null as "no breach this cycle".
  let oiAcceleration = null;
  if (
    oiVelocity !== null &&
    prev &&
    typeof prev.velocity === 'number' &&
    Number.isFinite(prev.velocity) &&
    dtSeconds !== null &&
    dtSeconds > 0
  ) {
    oiAcceleration = (oiVelocity - prev.velocity) / dtSeconds;
  }

  // IV emission shape (Req 10.8). Finite iv ⇒ pass it through;
  // missing / non-finite iv ⇒ all three IV columns are null /
  // true. `ivChange` requires both endpoints finite.
  const iv = currentIV;
  const ivUnavailable = iv === null;
  let ivChange = null;
  if (
    iv !== null &&
    prev &&
    typeof prev.iv === 'number' &&
    Number.isFinite(prev.iv)
  ) {
    ivChange = iv - prev.iv;
  }

  return {
    strike,
    side,
    classification,
    priceChange,
    oiChange,
    oiVelocity,
    oiAcceleration,
    iv,
    ivChange,
    ivUnavailable,
  };
}

// ============================================================
// Helpers — subtask 7.3: strike migration / dominance / futures alignment
// ============================================================

/**
 * Sum each leg's `oiChange` across the cycle's per-strike rows,
 * partitioned by side. Used to feed the dominance window with a
 * single CE / PE total per cycle.
 *
 * @param {Array<Object>} perStrike
 * @returns {{ ce:number, pe:number }}
 */
function totalBuildups(perStrike) {
  let ce = 0;
  let pe = 0;
  for (const row of perStrike) {
    if (!row) continue;
    if (row.side === 'CE') ce += toFiniteOrZero(row.oiChange);
    else if (row.side === 'PE') pe += toFiniteOrZero(row.oiChange);
  }
  return { ce, pe };
}

/**
 * Infer the strike step from the option chain. Reads adjacent
 * differences between consecutive numeric strikes (sorted) and
 * returns the smallest positive diff. Falls back to `null` when
 * the chain has fewer than two distinct numeric strikes — callers
 * use that to short-circuit migration to flat / 0.
 *
 * @param {Object|null} optionChain   Normalised `{ strikes:[{strike,...}] }`.
 * @returns {number|null}
 */
function inferStrikeStep(optionChain) {
  if (!optionChain || !Array.isArray(optionChain.strikes)) return null;
  const xs = [];
  for (const row of optionChain.strikes) {
    if (row && typeof row.strike === 'number' && Number.isFinite(row.strike)) {
      xs.push(row.strike);
    }
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  let minDiff = Infinity;
  for (let i = 1; i < xs.length; i += 1) {
    const d = xs[i] - xs[i - 1];
    if (d > 0 && d < minDiff) minDiff = d;
  }
  return Number.isFinite(minDiff) && minDiff > 0 ? minDiff : null;
}

/**
 * Compute strike migration (Req 10.3) over the lookback window.
 *
 * Contract:
 *   - `magnitude` is a non-negative integer measured in strikes.
 *   - `direction` is `'flat'` iff `magnitude < flatThreshold`.
 *   - When the buffer has < 1 prior entry OR a strike step cannot
 *     be inferred OR the current ATM is null, returns the
 *     no-signal `{ direction: 'flat', magnitude: 0 }`.
 *
 * @param {number|null} currentATM
 * @param {number|null} strikeStep
 * @param {Array<Object>} historyWindow   Prior-cycle records, oldest-first.
 * @param {number} flatThreshold
 * @returns {{direction:('up'|'down'|'flat'), magnitude:number}}
 */
function computeStrikeMigration(currentATM, strikeStep, historyWindow, flatThreshold) {
  if (
    typeof currentATM !== 'number' ||
    !Number.isFinite(currentATM) ||
    typeof strikeStep !== 'number' ||
    !Number.isFinite(strikeStep) ||
    strikeStep <= 0 ||
    !Array.isArray(historyWindow) ||
    historyWindow.length === 0
  ) {
    return { direction: 'flat', magnitude: 0 };
  }
  // Find the OLDEST entry in the window with a usable atmStrike.
  let oldestATM = null;
  for (const entry of historyWindow) {
    if (
      entry &&
      typeof entry.atmStrike === 'number' &&
      Number.isFinite(entry.atmStrike)
    ) {
      oldestATM = entry.atmStrike;
      break;
    }
  }
  if (oldestATM === null) {
    return { direction: 'flat', magnitude: 0 };
  }

  const rawDelta = currentATM - oldestATM;
  // Round to nearest integer-strikes; absolute value, non-negative.
  const magnitude = Math.max(0, Math.round(Math.abs(rawDelta) / strikeStep));

  if (magnitude < flatThreshold) {
    return { direction: 'flat', magnitude };
  }
  return {
    direction: rawDelta > 0 ? 'up' : 'down',
    magnitude,
  };
}

/**
 * Sign-aware fractional dominance comparison (Req 10.5).
 *
 *      (sumA - sumB) / max(|sumA| + |sumB|, 1) > margin
 *
 * Symmetric in A / B by construction.
 *
 * @param {number} sumA
 * @param {number} sumB
 * @param {number} margin
 * @returns {boolean}
 */
function dominates(sumA, sumB, margin) {
  const denom = Math.max(Math.abs(sumA) + Math.abs(sumB), 1);
  return (sumA - sumB) / denom > margin;
}

/**
 * Compute CE / PE dominance (Req 10.5) over the lookback window.
 * Sums each side's per-cycle build-up totals and applies the
 * sign-aware fractional comparison.
 *
 * When the window is empty OR both sums are exactly zero, both
 * flags are `false` — there is no dominance signal to emit.
 *
 * @param {Array<Object>} historyWindow   Prior-cycle records.
 * @param {number} margin
 * @returns {{ ceDominance:boolean, peDominance:boolean, ceSum:number, peSum:number }}
 */
function computeDominance(historyWindow, margin) {
  if (!Array.isArray(historyWindow) || historyWindow.length === 0) {
    return { ceDominance: false, peDominance: false, ceSum: 0, peSum: 0 };
  }
  let ceSum = 0;
  let peSum = 0;
  for (const entry of historyWindow) {
    if (!entry) continue;
    ceSum += toFiniteOrZero(entry.ceTotalBuildup);
    peSum += toFiniteOrZero(entry.peTotalBuildup);
  }
  if (ceSum === 0 && peSum === 0) {
    return { ceDominance: false, peDominance: false, ceSum, peSum };
  }
  return {
    ceDominance: dominates(ceSum, peSum, margin),
    peDominance: dominates(peSum, ceSum, margin),
    ceSum,
    peSum,
  };
}

/**
 * Compute futures-OI alignment (Req 10.6).
 *
 * Priority for `futuresAlignmentReason`:
 *   1. Either endpoint missing                         → 'futures_oi_missing'
 *   2. Δfutures OI === 0 (both endpoints non-null)     → 'futures_oi_stale'
 *   3. Dominant side === 0 (no CE / PE dominance)      → 'no_dominant_side'
 *   4. sign(Δfutures OI) === dominantSide              → 'aligned'
 *   5. signs differ                                    → 'mismatch'
 *
 * @param {number|null} currentFuturesOI
 * @param {Array<Object>} historyWindow   Prior-cycle records, oldest-first.
 * @param {boolean} ceDominance
 * @param {boolean} peDominance
 * @returns {{ futuresOIAligned:boolean, futuresAlignmentReason:string }}
 */
function computeFuturesAlignment(currentFuturesOI, historyWindow, ceDominance, peDominance) {
  // CE-dominant ⇒ bullish positioning ⇒ +1; PE-dominant ⇒ -1.
  const dominantSide = ceDominance ? 1 : peDominance ? -1 : 0;

  const currOK =
    typeof currentFuturesOI === 'number' && Number.isFinite(currentFuturesOI);

  let oldestFuturesOI = null;
  if (Array.isArray(historyWindow)) {
    for (const entry of historyWindow) {
      if (
        entry &&
        typeof entry.futuresOI === 'number' &&
        Number.isFinite(entry.futuresOI)
      ) {
        oldestFuturesOI = entry.futuresOI;
        break;
      }
    }
  }

  if (!currOK || oldestFuturesOI === null) {
    return {
      futuresOIAligned: false,
      futuresAlignmentReason: FUTURES_ALIGNMENT_REASONS.FUTURES_OI_MISSING,
    };
  }

  const dFut = currentFuturesOI - oldestFuturesOI;
  if (dFut === 0) {
    return {
      futuresOIAligned: false,
      futuresAlignmentReason: FUTURES_ALIGNMENT_REASONS.FUTURES_OI_STALE,
    };
  }
  if (dominantSide === 0) {
    return {
      futuresOIAligned: false,
      futuresAlignmentReason: FUTURES_ALIGNMENT_REASONS.NO_DOMINANT_SIDE,
    };
  }
  const futSign = Math.sign(dFut); // -1 or +1 (dFut !== 0 here)
  if (futSign === dominantSide) {
    return {
      futuresOIAligned: true,
      futuresAlignmentReason: FUTURES_ALIGNMENT_REASONS.ALIGNED,
    };
  }
  return {
    futuresOIAligned: false,
    futuresAlignmentReason: FUTURES_ALIGNMENT_REASONS.MISMATCH,
  };
}

// ============================================================
// Helpers — history buffer
// ============================================================

/**
 * Take the most recent `n` entries from the history buffer,
 * returned oldest-first so callers can iterate naturally.
 *
 * @param {number} n
 * @returns {Array<Object>}
 */
function takeWindow(n) {
  if (!Number.isInteger(n) || n <= 0) return [];
  if (HISTORY.length <= n) return HISTORY.slice();
  return HISTORY.slice(HISTORY.length - n);
}

/**
 * Push a record onto the history ring buffer, trimming to a cap
 * derived from the current settings' lookbacks (whichever is
 * larger), bounded by `HISTORY_BUFFER_HARD_CAP`. Idempotent on
 * `cycleId`: re-classifying the same cycle does not push a
 * duplicate entry.
 *
 * Subtask 7.3 calls this from inside `classifyOI(...)` AFTER the
 * dominance / migration / alignment have been computed for the
 * current cycle, so the current cycle's signals are derived from
 * STRICT prior history.
 *
 * @param {Object} params
 * @param {Object} params.ctx
 * @param {Object} params.oiOutput
 */
function recordCycleHistory({ ctx, oiOutput } = {}) {
  if (!ctx || !ctx.data) return;

  const cycleId = typeof ctx.cycleId === 'string' ? ctx.cycleId : null;
  // Idempotency on cycleId — refuse to double-push.
  if (cycleId !== null) {
    for (let i = HISTORY.length - 1; i >= 0; i -= 1) {
      if (HISTORY[i] && HISTORY[i].cycleId === cycleId) return;
    }
  }

  const optionChain = ctx.data.optionChain || null;
  const futures = ctx.data.futures || null;
  const atmStrike =
    optionChain && typeof optionChain.atmStrike === 'number'
      ? optionChain.atmStrike
      : null;
  const futuresOI =
    futures && typeof futures.oi === 'number' && Number.isFinite(futures.oi)
      ? futures.oi
      : null;

  // Re-derive per-cycle CE/PE totals from the emitted perStrike
  // rows so the buffer is self-contained.
  const totals = oiOutput && Array.isArray(oiOutput.perStrike)
    ? totalBuildups(oiOutput.perStrike)
    : { ce: 0, pe: 0 };

  HISTORY.push({
    atmStrike,
    ceTotalBuildup: totals.ce,
    peTotalBuildup: totals.pe,
    futuresOI,
    cycleId,
    cycleStartedAt:
      typeof ctx.cycleStartedAt === 'number' ? ctx.cycleStartedAt : null,
  });

  // Cap derived from settings (best effort) — fall back to the
  // hard ceiling when settings aren't readable.
  const settings = ctx.settings || null;
  const a = resolvePositiveInt(
    settings,
    'strikeMigrationLookbackCycles',
    DEFAULT_STRIKE_MIGRATION_LOOKBACK
  );
  const b = resolvePositiveInt(
    settings,
    'dominanceLookbackCycles',
    DEFAULT_DOMINANCE_LOOKBACK
  );
  const cap = Math.min(HISTORY_BUFFER_HARD_CAP, Math.max(a, b));
  while (HISTORY.length > cap) HISTORY.shift();
}

/**
 * Update the per-strike ledger with the current cycle's leg
 * observations. Idempotent on `cycleId`: if the entry's last
 * `cycleId` matches the current cycle's, the entry is left
 * untouched (re-classification of the same cycle must not
 * mutate state — Req 19.1).
 *
 * Called from `classifyOI(...)` AFTER the per-strike rows are
 * built, so the current cycle's rows are derived from STRICT
 * prior ledger state.
 *
 * @param {Object} params
 * @param {Object} params.ctx
 * @param {Array<Object>} params.perStrike   Rows emitted this cycle.
 */
function updateStrikeLedger({ ctx, perStrike } = {}) {
  if (!ctx || !ctx.data || !Array.isArray(perStrike)) return;

  const optionChain = ctx.data.optionChain || null;
  if (!optionChain || !Array.isArray(optionChain.strikes)) return;

  const cycleId = typeof ctx.cycleId === 'string' ? ctx.cycleId : null;
  const cycleStartedAt =
    typeof ctx.cycleStartedAt === 'number' && Number.isFinite(ctx.cycleStartedAt)
      ? ctx.cycleStartedAt
      : null;

  // Build a quick lookup `${strike}_${side} → { row, leg }` so
  // we can update with the AS-OBSERVED `oi`/`ltp`/`iv` (from
  // the raw leg) plus the JUST-COMPUTED `velocity` (from the
  // emitted row).
  /** @type {Map<string, {leg:Object|null, velocity:number|null}>} */
  const seen = new Map();
  for (const row of perStrike) {
    if (!row || typeof row.strike !== 'number') continue;
    seen.set(ledgerKey(row.strike, row.side), {
      leg: null,
      velocity: typeof row.oiVelocity === 'number' && Number.isFinite(row.oiVelocity)
        ? row.oiVelocity
        : null,
    });
  }
  for (const chainRow of optionChain.strikes) {
    if (!chainRow || typeof chainRow.strike !== 'number') continue;
    const ce = seen.get(ledgerKey(chainRow.strike, 'CE'));
    if (ce) ce.leg = chainRow.ce || null;
    const pe = seen.get(ledgerKey(chainRow.strike, 'PE'));
    if (pe) pe.leg = chainRow.pe || null;
  }

  for (const [key, { leg, velocity }] of seen) {
    const existing = STRIKE_LEDGER.get(key);
    // Idempotency on cycleId — refuse to overwrite for the same
    // cycle.
    if (existing && existing.cycleId !== null && existing.cycleId === cycleId) {
      continue;
    }
    STRIKE_LEDGER.set(key, {
      oi: toFiniteOrNull(leg ? leg.oi : null),
      ltp: toFiniteOrNull(leg ? leg.ltp : null),
      iv: toFiniteOrNull(leg ? leg.iv : null),
      velocity,
      cycleId,
      cycleStartedAt,
    });
  }
}

/**
 * Evict ledger entries that have not been observed for an
 * extended period — i.e. legs that have fallen off the chain
 * universe (e.g. far-OTM strikes after ATM rolled). The
 * staleness budget is `2 × max(strikeMigrationLookbackCycles,
 * dominanceLookbackCycles)` cycles' worth of time, where one
 * cycle is the configured `signalEngine.predictionIntervalMs`.
 *
 * Falls back to `signalEngine.predictionIntervalMs` defaulted
 * to 5000 ms when the setting is missing or non-finite.
 *
 * @param {Readonly<Object>|undefined} settings
 * @param {number|null} cycleStartedAt
 */
function evictStaleStrikeLedgerEntries(settings, cycleStartedAt) {
  if (typeof cycleStartedAt !== 'number' || !Number.isFinite(cycleStartedAt)) {
    return;
  }
  const a = resolvePositiveInt(
    settings,
    'strikeMigrationLookbackCycles',
    DEFAULT_STRIKE_MIGRATION_LOOKBACK
  );
  const b = resolvePositiveInt(
    settings,
    'dominanceLookbackCycles',
    DEFAULT_DOMINANCE_LOOKBACK
  );
  const lookbackCycles = 2 * Math.max(a, b);

  let cycleMs = 5000;
  const pim =
    settings && settings.signalEngine
      ? settings.signalEngine.predictionIntervalMs
      : undefined;
  if (typeof pim === 'number' && Number.isFinite(pim) && pim > 0) {
    cycleMs = pim;
  }
  const stalenessBudgetMs = lookbackCycles * cycleMs;

  for (const [key, entry] of STRIKE_LEDGER) {
    if (
      !entry ||
      typeof entry.cycleStartedAt !== 'number' ||
      !Number.isFinite(entry.cycleStartedAt)
    ) {
      continue;
    }
    if (cycleStartedAt - entry.cycleStartedAt > stalenessBudgetMs) {
      STRIKE_LEDGER.delete(key);
    }
  }
}

/**
 * Reset the module-level history buffer AND the per-strike
 * ledger. Exposed for smoke / property tests so each test
 * starts from a clean slate. Production callers must NOT use
 * this — it would silently blank the migration / dominance /
 * alignment signals AND the velocity / acceleration / IV
 * finite-differences for the next cycle.
 *
 * @returns {void}
 */
function __resetHistoryForTest() {
  HISTORY = [];
  STRIKE_LEDGER.clear();
  LAST_OUTPUT = { cycleId: null, output: null };
}

// ============================================================
// Helpers — gamma pressure (subtask 7.9)
// ------------------------------------------------------------
// `services/algorithms/gammaExposure.service.js` is a legacy
// service that consumes the option chain in its OWN snapshot
// shape: `{ strikes: [{ strike, call:{ oi, greeks:{ gamma } },
// put:{ oi, greeks:{ gamma } } }] }`. The cycle's normalised
// chain (built by `dataEngine.adapter.readOptionChain`) instead
// exposes `{ strike, ce:{ oi, gamma }, pe:{ oi, gamma } }`. We
// adapt the snapshot ONCE here so the legacy service can be
// reused unchanged.
//
// Failure path is uniform (Req 1.5): a missing / empty chain,
// a missing spot LTP, a thrown service call, or a service
// returning null all degrade to `gammaPressure: null` on the
// emission. The legacy service already swallows its own
// computation errors and returns `null` — we still wrap it in
// a defensive try/catch so a future regression cannot leak an
// exception into `classifyOI`'s caller.
// ============================================================

/**
 * Adapt the cycle's normalised option-chain snapshot
 * (`{ strike, ce, pe }` with flat `.gamma`) into the legacy
 * `gammaExposure.service.js` shape (`{ strike, call, put }`
 * with `.greeks.gamma`). Returns `null` when the chain is
 * missing or empty.
 *
 * The legacy service falls back to an analytic gamma estimate
 * when `greeks.gamma` is missing, so we only need to populate
 * `oi` faithfully and pass `gamma` through under the nested
 * key when the upstream actually provided one.
 *
 * @param {Object|null} optionChain
 * @returns {{ strikes: Array<{ strike:number, call:Object, put:Object }> }|null}
 */
function adaptOptionChainForGamma(optionChain) {
  if (
    !optionChain ||
    !Array.isArray(optionChain.strikes) ||
    optionChain.strikes.length === 0
  ) {
    return null;
  }
  const strikes = [];
  for (const row of optionChain.strikes) {
    if (!row || typeof row.strike !== 'number' || !Number.isFinite(row.strike)) {
      continue;
    }
    const ce = row.ce || null;
    const pe = row.pe || null;
    strikes.push({
      strike: row.strike,
      call: {
        oi: typeof (ce && ce.oi) === 'number' ? ce.oi : 0,
        greeks:
          ce && typeof ce.gamma === 'number' && Number.isFinite(ce.gamma)
            ? { gamma: ce.gamma }
            : undefined,
      },
      put: {
        oi: typeof (pe && pe.oi) === 'number' ? pe.oi : 0,
        greeks:
          pe && typeof pe.gamma === 'number' && Number.isFinite(pe.gamma)
            ? { gamma: pe.gamma }
            : undefined,
      },
    });
  }
  if (strikes.length === 0) return null;
  return { strikes };
}

/**
 * Compute the `gammaPressure` block for the current cycle.
 *
 * Returns the canonical `{ netDealerGamma, gammaFlip, perStrike }`
 * shape (Req 10.7) on success, or `null` when the underlying
 * service can't compute a result. The mapping from the legacy
 * `calculateGammaExposure` output is:
 *   - `total_gamma_exposure`  → `netDealerGamma`
 *   - `gamma_flip_point`      → `gammaFlip`
 *   - `gamma_by_strike`       → `perStrike` (array, sorted by
 *                               strike, one row per strike).
 *
 * `perStrike` is bounded to the strikes already present in the
 * chain — we never expand the universe. Each row is the small
 * shape `{ strike, callGamma, putGamma, netGamma, totalOI }`,
 * which `auditLog.redactGammaPressure` collapses to a count if
 * the array becomes heavy.
 *
 * @param {Object|null} optionChain
 * @param {number|null} spotPrice
 * @returns {{ netDealerGamma:number|null, gammaFlip:number|null, perStrike:Array<Object> }|null}
 */
function computeGammaPressure(optionChain, spotPrice) {
  const adapted = adaptOptionChainForGamma(optionChain);
  if (!adapted) return null;
  if (typeof spotPrice !== 'number' || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    return null;
  }

  let raw;
  try {
    raw = gammaExposureService.calculateGammaExposure(adapted, spotPrice);
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[oiEngine.adapter] gammaExposure.calculateGammaExposure threw — emitting gammaPressure: null'
    );
    return null;
  }

  if (!raw || typeof raw !== 'object') {
    logger.warn(
      '[oiEngine.adapter] gammaExposure.calculateGammaExposure returned no result — emitting gammaPressure: null'
    );
    return null;
  }

  const netDealerGamma =
    typeof raw.total_gamma_exposure === 'number' && Number.isFinite(raw.total_gamma_exposure)
      ? raw.total_gamma_exposure
      : null;
  const gammaFlip =
    typeof raw.gamma_flip_point === 'number' && Number.isFinite(raw.gamma_flip_point)
      ? raw.gamma_flip_point
      : null;

  /** @type {Array<Object>} */
  const perStrike = [];
  const byStrike = raw.gamma_by_strike || {};
  // Sort by numeric strike so the emitted array is order-stable
  // (downstream code can binary-search if needed; the audit row
  // is also more diff-friendly).
  const strikeKeys = Object.keys(byStrike)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const strike of strikeKeys) {
    const entry = byStrike[strike];
    if (!entry || typeof entry !== 'object') continue;
    perStrike.push({
      strike,
      callGamma: toFiniteOrNull(entry.call_gamma),
      putGamma: toFiniteOrNull(entry.put_gamma),
      netGamma: toFiniteOrNull(entry.net_gamma),
      totalOI: toFiniteOrNull(entry.total_oi),
    });
  }

  return { netDealerGamma, gammaFlip, perStrike };
}



/**
 * Build the canonical "no-OI-signal" `OIOutput`. Used when the
 * option chain is unavailable / empty / unparseable. The shape
 * mirrors the design typedef exactly so downstream consumers
 * can treat the absence of OI data as a uniform NO_TRADE-equiv.
 *
 * @param {number} shortCoveringBoostMultiplier
 * @returns {Object}
 */
function buildEmptyOIOutput(shortCoveringBoostMultiplier) {
  return {
    perStrike: [],
    strikeMigration: { direction: 'flat', magnitude: 0 },
    ceDominance: false,
    peDominance: false,
    futuresOIAligned: false,
    futuresAlignmentReason: FUTURES_ALIGNMENT_REASONS.FUTURES_OI_MISSING,
    // Empty emission has no chain to feed `gammaExposure`, so
    // `gammaPressure` is null by construction (Req 10.7).
    gammaPressure: null,
    // Req 10.2 — "explosive move" preference. The multiplier is
    // surfaced here on every emission (including the empty one)
    // so `masterScore.js` can read it from a stable channel.
    shortCoveringBoostMultiplier,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Classify the cycle's option chain into per-strike OI labels,
 * compute multi-cycle migration / dominance / futures-alignment
 * signals over the prior-history buffer, and surface the
 * explosive-move boost multiplier.
 *
 * Subtasks delivered: 7.1 (per-strike table + boost multiplier),
 * 7.3 (strike migration, CE / PE dominance, futures alignment).
 *
 * Contract:
 *   - Synchronous; no IO, no service calls.
 *   - Never throws; failure modes degrade to `buildEmptyOIOutput`.
 *   - Always returns an `OIOutput` matching the typedef in
 *     `./cycleContext.js`.
 *   - The current cycle's signals are derived from STRICT prior
 *     history. `recordCycleHistory` is invoked at the END of a
 *     successful classification so re-classifying the same ctx
 *     against a frozen-in-time buffer reproduces the same
 *     `OIOutput` (idempotency on cycleId is enforced inside
 *     `recordCycleHistory`).
 *
 * @param {Object} params
 * @param {Object} params.ctx        Frozen `CycleContext` with
 *                                   `data` populated upstream.
 * @param {Readonly<Object>} params.settings  Frozen Algo_Settings
 *                                            snapshot for this cycle.
 * @returns {Object}                 `OIOutput` per the typedef.
 */
function classifyOI({ ctx, settings } = {}) {
  const shortCoveringBoostMultiplier = resolveShortCoveringBoost(settings);

  try {
    const cycleId =
      ctx && typeof ctx.cycleId === 'string' && ctx.cycleId.length > 0
        ? ctx.cycleId
        : null;

    // Idempotency on cycleId — re-classifying the same cycle
    // must reproduce the same OIOutput even though the ledger
    // and history buffer have been mutated by the first call.
    if (cycleId !== null && LAST_OUTPUT.cycleId === cycleId && LAST_OUTPUT.output) {
      return LAST_OUTPUT.output;
    }

    const optionChain = ctx && ctx.data ? ctx.data.optionChain : null;
    if (
      !optionChain ||
      !Array.isArray(optionChain.strikes) ||
      optionChain.strikes.length === 0
    ) {
      const empty = buildEmptyOIOutput(shortCoveringBoostMultiplier);
      if (cycleId !== null) LAST_OUTPUT = { cycleId, output: empty };
      return empty;
    }

    const f = resolveClassificationDeltaFloor(settings);
    const cycleStartedAt =
      ctx && typeof ctx.cycleStartedAt === 'number' && Number.isFinite(ctx.cycleStartedAt)
        ? ctx.cycleStartedAt
        : null;

    /** @type {Array<Object>} */
    const perStrike = [];
    for (const row of optionChain.strikes) {
      if (!row || typeof row.strike !== 'number') continue;
      perStrike.push(buildPerStrikeRow(row.strike, 'CE', row.ce || null, f, cycleStartedAt));
      perStrike.push(buildPerStrikeRow(row.strike, 'PE', row.pe || null, f, cycleStartedAt));
    }

    // ---- Subtask 7.3: history-driven signals ----------------
    const strikeMigrationLookback = resolvePositiveInt(
      settings,
      'strikeMigrationLookbackCycles',
      DEFAULT_STRIKE_MIGRATION_LOOKBACK
    );
    const flatThreshold = resolvePositiveInt(
      settings,
      'strikeMigrationFlatThreshold',
      DEFAULT_STRIKE_MIGRATION_FLAT_THRESHOLD,
      /* allowZero */ true
    );
    const dominanceLookback = resolvePositiveInt(
      settings,
      'dominanceLookbackCycles',
      DEFAULT_DOMINANCE_LOOKBACK
    );
    const dominanceMargin = resolveDominanceMargin(settings);

    const currentATM =
      typeof optionChain.atmStrike === 'number' ? optionChain.atmStrike : null;
    const strikeStep = inferStrikeStep(optionChain);
    const futuresOI =
      ctx.data.futures && typeof ctx.data.futures.oi === 'number' &&
      Number.isFinite(ctx.data.futures.oi)
        ? ctx.data.futures.oi
        : null;

    const migrationWindow = takeWindow(strikeMigrationLookback);
    const dominanceWindow = takeWindow(dominanceLookback);

    const strikeMigration = computeStrikeMigration(
      currentATM,
      strikeStep,
      migrationWindow,
      flatThreshold
    );

    const { ceDominance, peDominance } = computeDominance(
      dominanceWindow,
      dominanceMargin
    );

    // Futures alignment uses the dominance window as its lookback
    // — the same "sentiment window" the dominance flags speak to.
    const { futuresOIAligned, futuresAlignmentReason } = computeFuturesAlignment(
      futuresOI,
      dominanceWindow,
      ceDominance,
      peDominance
    );

    // ---- Subtask 7.9: gamma pressure ------------------------
    // Compute net dealer gamma, gamma flip, and per-strike
    // gamma pressure from the legacy gammaExposure service.
    // Bounded by the strikes already present in the chain;
    // null on any failure (Req 1.5).
    const spotLtp =
      ctx.data.spot && typeof ctx.data.spot.ltp === 'number' &&
      Number.isFinite(ctx.data.spot.ltp)
        ? ctx.data.spot.ltp
        : null;
    const gammaPressure = computeGammaPressure(optionChain, spotLtp);

    const oiOutput = {
      perStrike,
      strikeMigration,
      ceDominance,
      peDominance,
      futuresOIAligned,
      futuresAlignmentReason,
      gammaPressure,
      // Req 10.2 — "explosive move" preference signal.
      shortCoveringBoostMultiplier,
    };

    // Push the current cycle into the history AFTER computing the
    // signals so the current cycle's output is based on STRICT
    // prior history (Req 19.1 idempotency).
    recordCycleHistory({ ctx, oiOutput });

    // Update the per-strike ledger with the as-observed (oi, ltp,
    // iv, velocity) for every leg seen this cycle, AFTER the
    // per-strike rows have been computed against PRIOR ledger
    // state. Idempotent on cycleId.
    updateStrikeLedger({ ctx, perStrike });

    // Evict ledger entries for legs that have fallen off the
    // chain universe (Req 7.6 lifecycle guideline).
    evictStaleStrikeLedgerEntries(settings, cycleStartedAt);

    if (cycleId !== null) LAST_OUTPUT = { cycleId, output: oiOutput };

    return oiOutput;
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[oiEngine.adapter] classifyOI failed; emitting empty OIOutput'
    );
    return buildEmptyOIOutput(shortCoveringBoostMultiplier);
  }
}

module.exports = {
  classifyOI,
  recordCycleHistory,
  updateStrikeLedger,
  evictStaleStrikeLedgerEntries,
  // Exposed for unit tests / property tests / smoke checks.
  classifyLeg,
  computeStrikeMigration,
  computeDominance,
  computeFuturesAlignment,
  computeGammaPressure,
  adaptOptionChainForGamma,
  inferStrikeStep,
  __resetHistoryForTest,
  // Alias kept so callers that want to reset only the per-strike
  // ledger have an explicit name. Both stores are managed
  // together so this is a thin re-export.
  __resetStrikeLedgerForTest: __resetHistoryForTest,
  // Exposed so 7.9 can compose without re-importing.
  OI_CLASSES,
  FUTURES_ALIGNMENT_REASONS,
};
