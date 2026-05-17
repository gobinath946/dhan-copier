/**
 * ============================================================
 * PCR_ENGINE ADAPTER (Req 11) — tasks 8.1 + 8.3
 * ============================================================
 * Pure deterministic PCR (Put-Call Ratio) sentiment computer
 * that emits a single canonical `PCROutput` block (see the
 * JSDoc typedef in `cycleContext.js`) onto the immutable cycle
 * context. The adapter is SYNC, has NO external dependencies
 * (the option chain has already been normalised by Data_Engine),
 * and never throws — failure modes always degrade to a stable-
 * shape "no-PCR-signal" emission so downstream gates can treat
 * the cycle as Neutral.
 *
 * ------------------------------------------------------------
 * What subtask 8.1 delivers (Req 11.1, Req 11.2, Req 11.7)
 * ------------------------------------------------------------
 *   1. Four PCR variants per cycle (Req 11.1):
 *        - `atmPcr`         = `pe.oi / ce.oi` at the ATM strike.
 *        - `strikewisePcr`  = `[{ strike, pcr }, ...]` for every
 *                              monitored strike with usable data.
 *        - `expiryPcr`      = `Σ pe.oi / Σ ce.oi` across the whole
 *                              option chain for the active expiry.
 *        - `intradayPcr`    = rolling-window average of `expiryPcr`
 *                              over the most recent
 *                              `pcrEngine.intradayWindowMinutes`
 *                              of cycles. The buffer is module-
 *                              level (`INTRADAY_BUFFER`) and is
 *                              reset across process restarts. See
 *                              the "intraday rolling-window buffer"
 *                              section below for the contract.
 *   2. Five labelled `PCR_Band`s (Req 11.2 + Req 11.7):
 *        Bands are read from `settings.pcrEngine.bands { b1, b2, b3, b4 }`.
 *        With the documented defaults `(0.7, 1.0, 1.3, 1.5)`:
 *
 *        | Range                  | Label                            |
 *        | ---------------------- | -------------------------------- |
 *        | `pcr < b1`             | `bearish-crowd-bullish-squeeze`  |
 *        | `b1 <= pcr < b2`       | `neutral`                        |
 *        | `b2 <= pcr <= b3`      | `bullish`                        |
 *        | `b3 < pcr <= b4`       | `reversal-risk`                  |
 *        | `pcr > b4`             | `contrarian-caution`             |
 *
 *        The mapping is total and monotonic by construction:
 *        for any `a <= b`, `bandIndex(a) <= bandIndex(b)` per the
 *        ordering `bearish-crowd-bullish-squeeze` < `neutral` <
 *        `bullish` < `reversal-risk` < `contrarian-caution`
 *        (Req 19.5).
 *   3. `bands { atm, expiry, intraday }` — each PCR scope is run
 *      through `assignBand(...)` so Signal_Engine and the master
 *      score have a single labelled view (Req 11.2).
 *
 * ------------------------------------------------------------
 * What subtask 8.3 delivers (Req 11.3, Req 11.4, Req 11.5, Req 11.6)
 * ------------------------------------------------------------
 *   - `bullishSqueezeProbability` (Req 11.3) — set to `true`
 *     when `atmPcr < settings.pcrEngine.bands.b1` AND price has
 *     reclaimed session VWAP from below. The "reclaim from
 *     below" leg is approximated from the already-populated
 *     `ctx.structure` block (Structure_Engine runs BEFORE
 *     PCR_Engine in the pipeline per Req 18.1, so its bias is
 *     available). Concretely:
 *
 *        priceReclaimedVwap =
 *          ctx.data.spot.ltp > ctx.data.vwap.session
 *          AND ctx.structure?.bias !== 'bearish'
 *
 *     Rationale: a bearish-biased structure where price is
 *     briefly above session VWAP looks more like a dead-cat
 *     bounce inside a downtrend than a genuine reclaim, so we
 *     refuse to flag a squeeze in that case. We deliberately do
 *     NOT require `bias === 'bullish'` (Structure can be
 *     `'neutral'` while still reclaiming VWAP). Without a
 *     multi-cycle "previous-tick" store this is the closest
 *     deterministic proxy for "from below"; a future enhancement
 *     can replace it with a per-session reclaim detector.
 *   - `contrarianCaution` (Req 11.4) — set to `true` when
 *     `atmPcr > settings.pcrEngine.bands.b4`. Edges are read
 *     from settings, NEVER hard-coded (Req 11.7).
 *   - `contributionWeight` (Req 11.6) — surfaced from
 *     `settings.indicatorWeights.pcrWeight`, runtime-clamped to
 *     `[0.00, 0.10]` as a defensive safety net even though
 *     `algoSettings.validateSettings` already rejects out-of-
 *     range values at load / hot-reload time. Falls back to `0`
 *     (no contribution) when missing or non-finite.
 *
 * ------------------------------------------------------------
 * Secondary-only contract (Req 11.5)
 * ------------------------------------------------------------
 * PCR_Engine is a SECONDARY confirmation only. The flags
 * `bullishSqueezeProbability`, `contrarianCaution`, every band
 * label, and the `contributionWeight` itself are MODULATORS —
 * they can upgrade or block, never trigger. The contract is:
 *
 *     PCR_Engine outputs alone NEVER cause Signal_Engine to
 *     emit LONG_SETUP or SHORT_SETUP. They only modulate the
 *     confidence of a candidate that the Req 8.1 / Req 9.1
 *     mandatory gates have already produced.
 *
 * The contract is ENFORCED in Signal_Engine (subtask 11) by
 * the iff-gate on the mandatory conditions. PCR_Engine itself
 * has no way to mechanically verify the caller's intent (it
 * does not know which downstream consumer it is being read
 * from), so we document the contract here and at every
 * emission point in the code, and we keep the `contributionWeight`
 * hard-clamped to `≤ 0.10` so even the master-score path can
 * never let PCR dominate.
 *
 * ------------------------------------------------------------
 * Per-strike PCR — skip rule
 * ------------------------------------------------------------
 * Per the design we skip a strike from `strikewisePcr` whenever:
 *   - The strike has no `ce` leg, OR
 *   - The strike has no `pe` leg, OR
 *   - `ce.oi` is not a strictly positive finite number, OR
 *   - `pe.oi` is not a non-negative finite number.
 *
 * Skipping is preferred over emitting `Infinity` so downstream
 * weighting / averaging does not have to special-case non-finite
 * PCRs. `atmPcr` follows the same rule and is `null` when the
 * ATM strike fails it.
 *
 * ------------------------------------------------------------
 * Intraday rolling-window buffer
 * ------------------------------------------------------------
 * `INTRADAY_BUFFER` is a module-level array of records:
 *
 *   {
 *     expiryPcr:      number,    // finite, > 0
 *     cycleStartedAt: number,    // epoch ms
 *     cycleId:        string,    // ULID-style
 *   }
 *
 * Behaviour:
 *   - On every successful `computePCR(...)` call where `expiryPcr`
 *     is finite and positive, the current cycle is appended (or
 *     replaces an existing record with the same `cycleId` —
 *     idempotency on re-run, Req 19.1).
 *   - `intradayPcr` is the arithmetic mean of every record whose
 *     `cycleStartedAt` is within `intradayWindowMinutes` of the
 *     current cycle's `cycleStartedAt`. When no records are in
 *     the window (first cycle of the session, or chain has been
 *     unavailable for the whole window), `intradayPcr` falls back
 *     to the current cycle's `expiryPcr`. When `expiryPcr` is
 *     itself null, `intradayPcr` is null.
 *   - The buffer is BOUNDED by `INTRADAY_BUFFER_HARD_CAP` so a
 *     pathological config (very long window) cannot leak memory.
 *     FIFO eviction once the cap is hit.
 *   - The buffer is RESET across process restarts (it is RAM
 *     only). This is documented as acceptable for a local-only
 *     engine — the first ~`intradayWindowMinutes` after a restart
 *     simply has a shorter rolling window.
 *
 * `__resetIntradayBufferForTest()` clears the buffer so smoke /
 * property tests start from a clean slate. Production callers
 * must NEVER use it.
 *
 * ------------------------------------------------------------
 * Idempotency (Req 19.1)
 * ------------------------------------------------------------
 * Re-calling `computePCR(...)` with the SAME `cycleId` against
 * the same `ctx` and `settings` MUST reproduce the same
 * `PCROutput`. The intraday buffer is dedup-keyed by `cycleId`
 * so a re-run does not double-count the cycle in its own rolling
 * average, and a `LAST_OUTPUT` cache guards the per-strike rows
 * so re-runs return the identical object.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - When `ctx.data.optionChain` is missing OR has no usable
 *     `strikes`, the adapter returns a stable-shape `PCROutput`
 *     with all PCR values `null`, all band labels `null`, and an
 *     empty `strikewisePcr`. The function never throws.
 *   - When `settings.pcrEngine.bands` is missing or malformed
 *     (which `algoSettings.validateSettings` already rejects at
 *     load / hot-reload), the adapter falls back to the
 *     documented defaults `(0.7, 1.0, 1.3, 1.5)`. This is a
 *     runtime safety net, not a substitute for validation.
 *   - Any unexpected error is caught at the outer boundary and
 *     degrades to the same empty `PCROutput`.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 11.1 — four PCR variants per cycle.
 *   - Req 11.2 — five labelled PCR_Bands.
 *   - Req 11.3 — `bullishSqueezeProbability` (delivered by 8.3).
 *   - Req 11.4 — `contrarianCaution` (delivered by 8.3).
 *   - Req 11.5 — secondary-only role enforced in Signal_Engine.
 *   - Req 11.6 — `contributionWeight` clamped to ≤ 0.10
 *                (delivered by 8.3).
 *   - Req 11.7 — band edges are read from
 *                `Algo_Settings.pcrEngine.bands`, never hard-coded.
 *   - Req 19.1 — idempotency on cycleId.
 *   - Req 19.5 — PCR-band monotonicity invariant.
 *   - PCROutput typedef in `./cycleContext.js`.
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');

// ============================================================
// Constants
// ============================================================

/**
 * The five PCR_Band labels enumerated in Req 11.2. Frozen so
 * callers can rely on identity comparison and the band-index
 * ordering used by the monotonicity invariant (Req 19.5).
 *
 * Index ordering:
 *   0 = bearish-crowd-bullish-squeeze (lowest PCR)
 *   1 = neutral
 *   2 = bullish
 *   3 = reversal-risk
 *   4 = contrarian-caution             (highest PCR)
 */
const PCR_BANDS = Object.freeze({
  BEARISH_CROWD_BULLISH_SQUEEZE: 'bearish-crowd-bullish-squeeze',
  NEUTRAL: 'neutral',
  BULLISH: 'bullish',
  REVERSAL_RISK: 'reversal-risk',
  CONTRARIAN_CAUTION: 'contrarian-caution',
});

/**
 * Documented default band edges, mirroring the
 * `algoSettings.pcrEngine.bands` defaults. Used only as a
 * runtime safety net when validation fails to catch a missing
 * key — `algoSettings.validateSettings` is the authoritative
 * validator (Req 11.7).
 */
const DEFAULT_BANDS = Object.freeze({ b1: 0.7, b2: 1.0, b3: 1.3, b4: 1.5 });

/**
 * Documented default `pcrEngine.intradayWindowMinutes`. Mirrors
 * the Algo_Settings Surface default; only used as a runtime
 * safety net.
 */
const DEFAULT_INTRADAY_WINDOW_MINUTES = 30;

/**
 * Hard ceiling on the intraday rolling-window buffer size. Even
 * if an operator configures a very long window the module never
 * grows the buffer past this cap, so it cannot leak memory under
 * a misconfiguration. The caller-visible window is still the
 * configured number of minutes; this just bounds the underlying
 * storage.
 */
const INTRADAY_BUFFER_HARD_CAP = 2048;

/**
 * Hard ceiling on `indicatorWeights.pcrWeight` per Req 11.6 /
 * Req 16.5. `algoSettings.validateSettings` already rejects any
 * candidate above this ceiling, but we re-clamp at runtime so a
 * future code path that bypasses validation cannot let PCR
 * exceed its secondary-only role.
 */
const PCR_WEIGHT_CEILING = 0.10;

/**
 * Hard floor on `indicatorWeights.pcrWeight`. Negative weights
 * are nonsensical for a contribution and would invert the
 * master-score arithmetic; clamp to zero.
 */
const PCR_WEIGHT_FLOOR = 0.0;

// ============================================================
// Module-level intraday rolling-window buffer
// ============================================================

/**
 * @type {Array<{ expiryPcr:number, cycleStartedAt:number, cycleId:string }>}
 *       FIFO-ordered records of prior cycles' `expiryPcr` values.
 *       Bounded by `INTRADAY_BUFFER_HARD_CAP`. See the
 *       "intraday rolling-window buffer" section in the module
 *       header for the lifecycle contract.
 */
let INTRADAY_BUFFER = [];

// ============================================================
// Module-level output cache (idempotency on cycleId)
// ============================================================

/**
 * Re-computing PCR for the SAME cycleId must reproduce the SAME
 * PCROutput (Req 19.1). The intraday buffer is already idempotent
 * on cycleId via dedup-by-id; the LAST_OUTPUT cache ensures the
 * full output object is byte-identical across re-runs.
 *
 * @type {{ cycleId: string|null, output: Object|null }}
 */
let LAST_OUTPUT = { cycleId: null, output: null };

// ============================================================
// Helpers — settings extraction
// ============================================================

/**
 * Resolve the PCR band edges `(b1, b2, b3, b4)` from
 * `settings.pcrEngine.bands` (Req 11.7). Falls back to the
 * documented defaults when missing / non-finite / non-monotonic.
 * `algoSettings.validateSettings` is the authoritative validator
 * (Req 11.2 strict-monotonicity check); this is only a runtime
 * safety net so the PCROutput shape stays stable.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {{ b1:number, b2:number, b3:number, b4:number }}
 */
function resolveBands(settings) {
  const cfg =
    settings && settings.pcrEngine && settings.pcrEngine.bands
      ? settings.pcrEngine.bands
      : null;
  if (cfg && typeof cfg === 'object') {
    const { b1, b2, b3, b4 } = cfg;
    if (
      Number.isFinite(b1) &&
      Number.isFinite(b2) &&
      Number.isFinite(b3) &&
      Number.isFinite(b4) &&
      b1 < b2 && b2 < b3 && b3 < b4
    ) {
      return { b1, b2, b3, b4 };
    }
    logger.warn(
      { bands: cfg },
      '[pcrEngine.adapter] pcrEngine.bands missing / non-monotonic; using documented defaults'
    );
  }
  return { ...DEFAULT_BANDS };
}

/**
 * Resolve the intraday rolling-window length in minutes from
 * `settings.pcrEngine.intradayWindowMinutes`. Falls back to the
 * documented default when missing / non-positive.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}  Strictly positive number of minutes.
 */
function resolveIntradayWindowMinutes(settings) {
  const v =
    settings && settings.pcrEngine
      ? settings.pcrEngine.intradayWindowMinutes
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_INTRADAY_WINDOW_MINUTES;
}

/**
 * Resolve `indicatorWeights.pcrWeight` from settings, runtime-
 * clamped to `[PCR_WEIGHT_FLOOR, PCR_WEIGHT_CEILING]` per
 * Req 11.6 / Req 16.5. Falls back to `0` (no contribution) when
 * missing or non-finite.
 *
 * `algoSettings.validateSettings` is the authoritative validator
 * (and rejects out-of-range candidates at load / hot-reload),
 * but we re-clamp here as a defensive safety net so a future
 * code path that bypasses validation cannot let PCR exceed its
 * secondary-only role.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}  Clamped weight in `[0.00, 0.10]`.
 */
function resolvePcrContributionWeight(settings) {
  const v =
    settings && settings.indicatorWeights
      ? settings.indicatorWeights.pcrWeight
      : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < PCR_WEIGHT_FLOOR) return PCR_WEIGHT_FLOOR;
  if (v > PCR_WEIGHT_CEILING) return PCR_WEIGHT_CEILING;
  return v;
}

/**
 * Detect "price reclaims session VWAP from below" (Req 11.3).
 *
 * Without a multi-cycle "previous-tick" store, we approximate
 * the reclaim from the already-populated `ctx.structure` block
 * (Structure_Engine runs BEFORE PCR_Engine in the pipeline per
 * Req 18.1, so its bias is available):
 *
 *   priceReclaimedVwap =
 *     spotLtp > sessionVwap AND structure.bias !== 'bearish'
 *
 * We deliberately do NOT require `bias === 'bullish'`. Structure
 * can be `'neutral'` while price is reclaiming session VWAP — a
 * common transition setup we want to flag. We DO refuse to flag
 * a squeeze when bias is `'bearish'`, because price briefly
 * above VWAP inside a downtrend is more likely a dead-cat
 * bounce than a genuine reclaim.
 *
 * Returns `false` whenever any of the inputs is missing or
 * non-finite — the safe default for a flag that can only
 * upgrade confidence.
 *
 * @param {Object|null|undefined} ctx
 * @returns {boolean}
 */
function detectPriceReclaimedVwap(ctx) {
  if (!ctx || !ctx.data) return false;
  const spot = ctx.data.spot;
  const vwap = ctx.data.vwap;
  if (!spot || !vwap) return false;

  const ltp = spot.ltp;
  const sessionVwap = vwap.session;
  if (typeof ltp !== 'number' || !Number.isFinite(ltp)) return false;
  if (typeof sessionVwap !== 'number' || !Number.isFinite(sessionVwap)) return false;
  if (ltp <= sessionVwap) return false;

  // ctx.structure may be null when Structure_Engine has not yet
  // populated the block (e.g. a degenerate pipeline that emits
  // PCR before Structure). In that case we treat the reclaim as
  // "not bearish" — i.e. allow the flag — because we have no
  // counter-evidence. If the operator wires the pipeline in the
  // documented order this branch is unreachable.
  const bias = ctx.structure ? ctx.structure.bias : null;
  if (bias === 'bearish') return false;

  return true;
}

// ============================================================
// Helpers — band assignment
// ============================================================

/**
 * Map a PCR value onto its labelled band per Req 11.2, using the
 * supplied band edges `(b1, b2, b3, b4)`. The mapping is total
 * and monotonic by construction (Req 19.5):
 *
 *   pcr < b1            ⇒ bearish-crowd-bullish-squeeze (idx 0)
 *   b1 <= pcr < b2      ⇒ neutral                        (idx 1)
 *   b2 <= pcr <= b3     ⇒ bullish                        (idx 2)
 *   b3 < pcr <= b4      ⇒ reversal-risk                  (idx 3)
 *   pcr > b4            ⇒ contrarian-caution             (idx 4)
 *
 * Non-finite PCRs (`null`, `NaN`, `Infinity`) return `null` so
 * downstream consumers can detect the no-signal case.
 *
 * @param {number|null} pcr
 * @param {{ b1:number, b2:number, b3:number, b4:number }} edges
 * @returns {('bearish-crowd-bullish-squeeze'|'neutral'|'bullish'|'reversal-risk'|'contrarian-caution'|null)}
 */
function assignBand(pcr, edges) {
  if (typeof pcr !== 'number' || !Number.isFinite(pcr)) return null;
  const { b1, b2, b3, b4 } = edges || DEFAULT_BANDS;
  if (pcr < b1) return PCR_BANDS.BEARISH_CROWD_BULLISH_SQUEEZE;
  if (pcr < b2) return PCR_BANDS.NEUTRAL;
  if (pcr <= b3) return PCR_BANDS.BULLISH;
  if (pcr <= b4) return PCR_BANDS.REVERSAL_RISK;
  return PCR_BANDS.CONTRARIAN_CAUTION;
}

/**
 * Return the integer band index for a PCR value, or `null` when
 * the input is non-finite. Useful for monotonicity invariants
 * and for ordering the per-cycle PCR bands.
 *
 * Index ordering matches `PCR_BANDS` documented in the module
 * header.
 *
 * @param {number|null} pcr
 * @param {{ b1:number, b2:number, b3:number, b4:number }} edges
 * @returns {number|null}  0..4 inclusive, or `null` when pcr is
 *                          non-finite.
 */
function bandIndex(pcr, edges) {
  if (typeof pcr !== 'number' || !Number.isFinite(pcr)) return null;
  const { b1, b2, b3, b4 } = edges || DEFAULT_BANDS;
  if (pcr < b1) return 0;
  if (pcr < b2) return 1;
  if (pcr <= b3) return 2;
  if (pcr <= b4) return 3;
  return 4;
}

// ============================================================
// Helpers — PCR primitives
// ============================================================

/**
 * Read the OI value off a leg, returning a finite number or
 * `null`. Used so that the per-strike / expiry PCR math never
 * sees a NaN that would NaN-propagate into the band assignment.
 *
 * @param {Object|null|undefined} leg   Normalised `{ oi, ... }` leg.
 * @returns {number|null}
 */
function readOI(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const v = leg.oi;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Compute the per-strike PCR `pe.oi / ce.oi`, applying the skip
 * rule documented in the module header: returns `null` when
 * either leg is missing, when CE OI is not strictly positive,
 * or when PE OI is not a non-negative finite number. Skipping
 * (returning `null`) is preferred over emitting `Infinity` so
 * downstream weighting / averaging never has to special-case
 * non-finite PCRs.
 *
 * @param {Object|null} ce
 * @param {Object|null} pe
 * @returns {number|null}
 */
function strikePcr(ce, pe) {
  const ceOI = readOI(ce);
  const peOI = readOI(pe);
  if (ceOI === null || peOI === null) return null;
  if (ceOI <= 0) return null;
  if (peOI < 0) return null;
  return peOI / ceOI;
}

// ============================================================
// Helpers — intraday rolling-window buffer
// ============================================================

/**
 * Append the current cycle's `(expiryPcr, cycleStartedAt, cycleId)`
 * record to the intraday buffer, deduping on `cycleId` so a
 * re-run of the same cycle never double-counts. Bounded by
 * `INTRADAY_BUFFER_HARD_CAP` with FIFO eviction.
 *
 * Records are only appended when `expiryPcr` is a finite,
 * strictly positive number — null PCRs (no-data cycles) are not
 * stored, so the rolling average reflects only cycles with
 * usable chain data.
 *
 * @param {Object} record
 * @param {number} record.expiryPcr
 * @param {number} record.cycleStartedAt
 * @param {string} record.cycleId
 * @returns {void}
 */
function recordIntradayPcr(record) {
  const { expiryPcr, cycleStartedAt, cycleId } = record;
  if (
    typeof expiryPcr !== 'number' || !Number.isFinite(expiryPcr) || expiryPcr <= 0 ||
    typeof cycleStartedAt !== 'number' || !Number.isFinite(cycleStartedAt) ||
    typeof cycleId !== 'string' || cycleId.length === 0
  ) {
    return;
  }

  // Idempotency on cycleId — overwrite an existing record from
  // the same cycle rather than appending a duplicate.
  const existingIdx = INTRADAY_BUFFER.findIndex((r) => r.cycleId === cycleId);
  if (existingIdx !== -1) {
    INTRADAY_BUFFER[existingIdx] = { expiryPcr, cycleStartedAt, cycleId };
    return;
  }

  INTRADAY_BUFFER.push({ expiryPcr, cycleStartedAt, cycleId });
  // FIFO eviction once the hard cap is hit.
  while (INTRADAY_BUFFER.length > INTRADAY_BUFFER_HARD_CAP) {
    INTRADAY_BUFFER.shift();
  }
}

/**
 * Compute the rolling-window average of `expiryPcr` over the
 * most recent `windowMinutes` ending at `nowMs`. Returns `null`
 * when no records fall in the window AND the current cycle
 * itself has no usable `expiryPcr`. When records exist, the
 * arithmetic mean is returned.
 *
 * @param {number} nowMs        Current cycle's `cycleStartedAt`.
 * @param {number} windowMinutes
 * @param {number|null} currentExpiryPcr  Fallback when the window
 *                                         is empty but the current
 *                                         cycle does have a usable
 *                                         expiry PCR.
 * @returns {number|null}
 */
function computeIntradayPcr(nowMs, windowMinutes, currentExpiryPcr) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return typeof currentExpiryPcr === 'number' && Number.isFinite(currentExpiryPcr)
      ? currentExpiryPcr
      : null;
  }
  const horizonMs = windowMinutes * 60 * 1000;
  let sum = 0;
  let count = 0;
  for (const rec of INTRADAY_BUFFER) {
    const elapsedMs = nowMs - rec.cycleStartedAt;
    if (elapsedMs >= 0 && elapsedMs <= horizonMs) {
      sum += rec.expiryPcr;
      count += 1;
    }
  }
  if (count > 0) return sum / count;
  // Window empty (first cycle of the session, or chain has been
  // unavailable for the whole window). Fall back to the current
  // cycle's expiryPcr when it exists.
  return typeof currentExpiryPcr === 'number' && Number.isFinite(currentExpiryPcr)
    ? currentExpiryPcr
    : null;
}

// ============================================================
// Helpers — empty / safe-default PCROutput
// ============================================================

/**
 * Build the stable-shape "no-PCR-signal" `PCROutput` used when
 * the option chain is missing, when every strike fails the skip
 * rule, or when an unexpected error is caught at the outer
 * boundary. The shape matches the `PCROutput` typedef so
 * downstream consumers always see the same fields.
 *
 * `bullishSqueezeProbability` and `contrarianCaution` are
 * always `false` on this path — there is no `atmPcr` to
 * compare against the bands, so neither flag can be true
 * (Req 11.3 / 11.4).
 *
 * `contributionWeight` is still surfaced from settings (Req 11.6)
 * even when the PCR values themselves are null, so the master
 * score sees a stable shape and can renormalise weights
 * cleanly when PCR is treated as "stale" for this cycle (Req 16.4).
 *
 * @param {Readonly<Object>|undefined} settings  Algo_Settings
 *                                               snapshot for the
 *                                               current cycle.
 *                                               Optional — when
 *                                               omitted the
 *                                               weight defaults
 *                                               to 0.
 * @returns {Object}  Empty `PCROutput`.
 */
function buildEmptyPcrOutput(settings) {
  return {
    atmPcr: null,
    strikewisePcr: [],
    expiryPcr: null,
    intradayPcr: null,
    bands: { atm: null, expiry: null, intraday: null },
    // Req 11.3 — no atmPcr means no squeeze flag; this is the
    // safe default. Signal_Engine cannot upgrade a LONG_SETUP
    // off this output. SECONDARY-ONLY (Req 11.5).
    bullishSqueezeProbability: false,
    // Req 11.4 — same rationale; no atmPcr means no caution
    // flag. SECONDARY-ONLY (Req 11.5).
    contrarianCaution: false,
    // Req 11.6 — clamped to [0.00, 0.10] in
    // `resolvePcrContributionWeight`. SECONDARY-ONLY (Req 11.5):
    // even at the maximum 0.10, PCR cannot dominate the
    // master score.
    contributionWeight: resolvePcrContributionWeight(settings),
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Compute the per-cycle `PCROutput` (Req 11.1 / 11.2 / 11.7).
 *
 * Synchronous and pure with respect to the supplied `ctx` and
 * `settings`, MODULO the module-level intraday rolling-window
 * buffer. The buffer is dedup-keyed by `cycleId` so re-runs of
 * the same cycle are idempotent (Req 19.1) — re-calling
 * `computePCR` with the same `cycleId` reproduces the same
 * `PCROutput`.
 *
 * @param {Object} params
 * @param {Object} params.ctx               Frozen `CycleContext`
 *                                          with `data.optionChain`
 *                                          populated upstream.
 * @param {Readonly<Object>} params.settings  Frozen Algo_Settings
 *                                            snapshot for this cycle.
 * @returns {Object}  `PCROutput` per the typedef in `cycleContext.js`.
 */
function computePCR(params) {
  const { ctx, settings } = params && typeof params === 'object' ? params : {};
  try {
    const cycleId =
      ctx && typeof ctx.cycleId === 'string' && ctx.cycleId.length > 0
        ? ctx.cycleId
        : null;

    // Idempotency on cycleId — re-running the same cycle returns
    // the cached output and does NOT re-mutate the intraday
    // buffer (`recordIntradayPcr` is itself idempotent on
    // cycleId, but the cache short-circuits before we even reach
    // it).
    if (cycleId !== null && LAST_OUTPUT.cycleId === cycleId && LAST_OUTPUT.output) {
      return LAST_OUTPUT.output;
    }

    const optionChain = ctx && ctx.data ? ctx.data.optionChain : null;
    if (
      !optionChain ||
      !Array.isArray(optionChain.strikes) ||
      optionChain.strikes.length === 0
    ) {
      const empty = buildEmptyPcrOutput(settings);
      if (cycleId !== null) LAST_OUTPUT = { cycleId, output: empty };
      return empty;
    }

    const edges = resolveBands(settings);
    const windowMinutes = resolveIntradayWindowMinutes(settings);
    const cycleStartedAt =
      ctx && typeof ctx.cycleStartedAt === 'number' && Number.isFinite(ctx.cycleStartedAt)
        ? ctx.cycleStartedAt
        : null;

    // ---- Strikewise PCR + expiry-wide totals ----------------
    /** @type {Array<{ strike:number, pcr:number }>} */
    const strikewisePcr = [];
    let sumCeOI = 0;
    let sumPeOI = 0;
    let expiryHasUsableLeg = false;
    let atmPcr = null;
    const atmStrike =
      typeof optionChain.atmStrike === 'number' && Number.isFinite(optionChain.atmStrike)
        ? optionChain.atmStrike
        : null;

    for (const row of optionChain.strikes) {
      if (!row || typeof row.strike !== 'number' || !Number.isFinite(row.strike)) continue;

      const ceOI = readOI(row.ce);
      const peOI = readOI(row.pe);

      // Expiry-wide totals: include any strike where BOTH legs
      // have finite OI (CE > 0 / PE >= 0). A strike that only has
      // one leg would skew the ratio asymmetrically, so we
      // require both legs.
      if (ceOI !== null && peOI !== null && ceOI > 0 && peOI >= 0) {
        sumCeOI += ceOI;
        sumPeOI += peOI;
        expiryHasUsableLeg = true;
      }

      // Per-strike PCR, applying the skip rule.
      const pcr = strikePcr(row.ce, row.pe);
      if (pcr === null) continue;

      strikewisePcr.push({ strike: row.strike, pcr });

      if (atmStrike !== null && row.strike === atmStrike) {
        atmPcr = pcr;
      }
    }

    // ---- Expiry PCR ----------------------------------------
    const expiryPcr = expiryHasUsableLeg && sumCeOI > 0 ? sumPeOI / sumCeOI : null;

    // ---- Intraday rolling-window PCR ------------------------
    // Append the current cycle BEFORE computing the average so the
    // current cycle is included in its own rolling window. Append
    // is idempotent on cycleId, so re-running this code path with
    // the same cycle does not double-count.
    if (cycleId !== null && cycleStartedAt !== null && expiryPcr !== null) {
      recordIntradayPcr({ expiryPcr, cycleStartedAt, cycleId });
    }
    const intradayPcr = computeIntradayPcr(cycleStartedAt, windowMinutes, expiryPcr);

    // ---- Band assignment ------------------------------------
    const bands = {
      atm: assignBand(atmPcr, edges),
      expiry: assignBand(expiryPcr, edges),
      intraday: assignBand(intradayPcr, edges),
    };

    // ---- Subtask 8.3 — modulator flags + contribution weight
    //
    // SECONDARY-ONLY CONTRACT (Req 11.5):
    // None of the three fields below can, on their own, cause
    // Signal_Engine to emit LONG_SETUP or SHORT_SETUP. The
    // iff-gate on the Req 8.1 / Req 9.1 mandatory conditions
    // (enforced in Signal_Engine, subtask 11) makes that
    // mechanically impossible. PCR_Engine MODULATES; it never
    // TRIGGERS.
    //
    // Req 11.3 — `bullishSqueezeProbability` is true only when
    // ATM PCR is below the configured `b1` edge AND price has
    // reclaimed session VWAP from below. See
    // `detectPriceReclaimedVwap` for the reclaim approximation.
    const bullishSqueezeProbability =
      atmPcr !== null && atmPcr < edges.b1 && detectPriceReclaimedVwap(ctx);

    // Req 11.4 — `contrarianCaution` is true only when ATM PCR
    // exceeds the configured `b4` edge. The strict inequality
    // matches the spec language ("ATM PCR > 1.5") and aligns
    // with the band boundary `pcr > b4 ⇒ contrarian-caution`
    // from `assignBand` so the flag and the band are in lock-
    // step.
    const contrarianCaution = atmPcr !== null && atmPcr > edges.b4;

    // Req 11.6 — runtime-clamped `[0.00, 0.10]` contribution
    // weight. `algoSettings.validateSettings` already rejects
    // out-of-range candidates at load / hot-reload, so this
    // clamp is a defensive safety net.
    const contributionWeight = resolvePcrContributionWeight(settings);

    const pcrOutput = {
      atmPcr,
      strikewisePcr,
      expiryPcr,
      intradayPcr,
      bands,
      // SECONDARY-ONLY (Req 11.5) — see contract comment above.
      bullishSqueezeProbability,
      // SECONDARY-ONLY (Req 11.5) — see contract comment above.
      contrarianCaution,
      // SECONDARY-ONLY (Req 11.5) — clamped <= 0.10 (Req 11.6).
      contributionWeight,
    };

    if (cycleId !== null) LAST_OUTPUT = { cycleId, output: pcrOutput };
    return pcrOutput;
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[pcrEngine.adapter] computePCR failed; emitting empty PCROutput'
    );
    return buildEmptyPcrOutput(settings);
  }
}

// ============================================================
// Test-only helpers
// ============================================================

/**
 * Clear the module-level intraday rolling-window buffer AND the
 * idempotency cache so smoke / property tests start from a clean
 * slate. Production callers must NEVER use this.
 *
 * @returns {void}
 */
function __resetIntradayBufferForTest() {
  INTRADAY_BUFFER = [];
  LAST_OUTPUT = { cycleId: null, output: null };
}

module.exports = {
  computePCR,
  // Exposed for unit tests / property tests / smoke checks and
  // for downstream modules (e.g. signalEngine) that want to
  // re-band a PCR value without going through the adapter.
  assignBand,
  bandIndex,
  strikePcr,
  PCR_BANDS,
  __resetIntradayBufferForTest,
};
