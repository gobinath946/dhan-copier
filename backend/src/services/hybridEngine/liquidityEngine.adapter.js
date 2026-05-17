/**
 * ============================================================
 * LIQUIDITY_ENGINE ADAPTER (Req 7) — task 6.1 + 6.2
 * ============================================================
 * Wraps the existing liquidity / order-flow services so the
 * orchestrator can append a single canonical `LiquidityOutput`
 * block (see the JSDoc typedef in `cycleContext.js`) onto the
 * immutable cycle context. The adapter is SYNC — every input it
 * needs is already present on `ctx.data` after
 * `dataEngine.adapter.fetchDataSnapshot` has run.
 *
 * Subtask 6.1 wires:
 *   1. Order-book / spread / absorption / depth analysis via
 *      `services/algorithms/liquidityAnalysis.service.js`
 *      (`analyzeLiquidity(optionChain, spotPrice, orderBookData,
 *      previousData)`). The legacy service returns a rich block
 *      (`bid_ask_imbalance`, `liquidity_sweeps`, `spread_analysis`,
 *      `smart_money_absorption`, `dom_depth`, ..., `liquidity_score`).
 *      We harvest only the fields the design typedef calls for
 *      and re-classify the spread status against
 *      `settings.liquidityEngine.spreadCutoffs` so the legacy
 *      hard-coded thresholds (0.5 / 1.0 / 2.0) cannot leak into
 *      the pipeline (Req 7.7).
 *   2. Bid/ask imbalance via
 *      `algorithms/orderBookImbalance.indicator.js`
 *      (`calculateOrderBookImbalance(optionChain, spotPrice,
 *      atmStrike)`). The legacy indicator returns
 *      `market_imbalance = totalBuyPressure / totalSellPressure`.
 *      We convert that positive ratio R into the design's signed
 *      ratio `(buy − sell) / (buy + sell) = (R − 1)/(R + 1)`,
 *      which lands cleanly in `[-1, 1]` and matches the contract
 *      Signal_Engine's mandatory checks (Req 8.1.4 / 9.1.4) read.
 *   3. Order-flow fallback / cumulative-delta proxy via
 *      `services/algorithms/orderFlow.service.js`
 *      (`analyzeOrderFlow(optionChain, spotData, previousData)`).
 *      When the option chain has no usable bid/ask quantities and
 *      `calculateOrderBookImbalance` cannot produce a finite
 *      `market_imbalance`, we fall back to the order-flow service's
 *      `net_aggressive` signed delta — exactly the
 *      "last-bar buy-vs-sell volume proxy" the design calls for
 *      when no real order-book is available.
 *
 * Subtask 6.2 DELIVERS the gates / confirmation flags layered
 * on top of the 6.1 baseline:
 *   - `spreadStatus = 'very_wide'` ⇒ `liquidityScore` is clamped
 *     to `min(score, 30)` and `LIQUIDITY_VERY_WIDE_SPREAD` is
 *     pushed onto `reasonCodes`. `liquidityHealth.healthy` is
 *     re-derived against the post-cap score so the same gate
 *     drives both signals (Req 7.3 / 17.4).
 *   - `liquidityScore < signalEngine.minLiquidityScore` ⇒
 *     `LIQUIDITY_LOW_SCORE` reason code (Req 7.3 / 17.4).
 *   - `stopHunt.detected = true` ⇒ `blockEntry = true` and
 *     `LIQUIDITY_STOP_HUNT_OPPOSES_SIDE` reason code. See the
 *     "Side-aware gates" note below for why we emit
 *     unconditionally on detection rather than against a
 *     candidate side that is not yet known at this stage of the
 *     pipeline (Req 7.4).
 *   - `imbalanceConfirmsLong / imbalanceConfirmsShort` are
 *     computed against the operator-supplied
 *     `liquidityEngine.bullishImbalanceMin /
 *     bearishImbalanceMax` after converting those operator-supplied
 *     RATIO thresholds into the SIGNED scale this adapter exposes
 *     for `bidAskImbalance`. See the "Threshold scale" note below
 *     (Req 7.5 / 7.6).
 *
 * Side-aware gates (design decision):
 *   The spec annotates `imbalanceConfirmsLong` /
 *   `imbalanceConfirmsShort` / `blockEntry` as "only meaningful
 *   when candidate is LONG / SHORT". The Liquidity_Engine runs
 *   BEFORE the Signal_Engine in the pipeline (Data → Regime →
 *   Structure → Liquidity → OI → PCR → Signal), so the candidate
 *   side is not yet known when this adapter executes. We resolve
 *   this with a clean contract:
 *
 *     1. `imbalanceConfirmsLong` and `imbalanceConfirmsShort`
 *        are computed UNCONDITIONALLY against their respective
 *        thresholds. Signal_Engine reads whichever flag matches
 *        the candidate side it is evaluating; the unmatched flag
 *        is simply ignored. The two flags are mutually exclusive
 *        in practice because the thresholds straddle 0 (bullish
 *        ≥ 0.2-ish, bearish ≤ -0.2-ish on the signed scale).
 *
 *     2. `blockEntry` is set to `true` whenever
 *        `stopHunt.detected = true`, and the reason code is
 *        emitted alongside. Signal_Engine reads `blockEntry`
 *        TOGETHER with `stopHunt.direction` and only short-
 *        circuits the side that is actually opposed by the
 *        sweep (sweep up ⇒ blocks LONG, sweep down ⇒ blocks
 *        SHORT). This keeps the Liquidity_Engine deterministic
 *        and side-agnostic while still letting the Signal_Engine
 *        enforce Req 7.4's "opposes the candidate side" rule.
 *
 *   The reason code `LIQUIDITY_STOP_HUNT_OPPOSES_SIDE` is pushed
 *   on stop-hunt detection regardless of side; Signal_Engine
 *   gates the actual NO_TRADE on the side relationship. The
 *   audit row will surface the code on every stop-hunt cycle,
 *   which is the conservative choice (over-reporting is safer
 *   than under-reporting in audit logs).
 *
 * Threshold scale (design decision):
 *   The operator-supplied `bullishImbalanceMin` (default `1.5`)
 *   and `bearishImbalanceMax` (default `0.667`) are documented
 *   on the legacy POSITIVE-RATIO scale `R = buy / sell` where
 *   `R = 1.0` is parity, `R > 1` is bullish, and `R < 1` is
 *   bearish. The adapter's `bidAskImbalance` exposes a SIGNED
 *   ratio in `[-1, 1]` matching `(buy − sell)/(buy + sell)`
 *   (see `ratioToSignedImbalance`). To compare apples to apples
 *   we convert the operator's ratio thresholds onto the same
 *   signed scale internally via `ratioThresholdToSigned`:
 *
 *     bullishImbalanceMin = 1.5  ⇒ signed +0.20
 *     bearishImbalanceMax = 0.667 ⇒ signed -0.20
 *
 *   This preserves backwards compatibility with the documented
 *   Algo_Settings defaults while letting downstream code reason
 *   in a single, signed coordinate system.
 *
 * Failure semantics (Req 1.5):
 *   - Every underlying service call is wrapped in try/catch.
 *   - On any unrecoverable failure the adapter still returns a
 *     stable-shape `LiquidityOutput` with `spreadStatus: 'normal'`,
 *     `liquidityScore: 0`, `liquidityHealth.healthy: false`, all
 *     booleans false, empty arrays. NO_TRADE is the downstream
 *     consequence — exactly what we want when liquidity is
 *     unknowable.
 *
 * Spread-proxy documentation (Req 7.1 / 7.2):
 *   The legacy `analyzeSpread(optionChain, spotPrice)` reads
 *   `(ask − bid)` directly off the ATM CE / PE rows when the
 *   broker exposes the L1 quote, otherwise it estimates the
 *   spread from the LTP (`ltp × ±0.5%`). `avg_spread_pct` is the
 *   mean of CE and PE spread-as-percent-of-LTP. We re-use this
 *   value but apply OUR cut-offs from
 *   `settings.liquidityEngine.spreadCutoffs` rather than the
 *   legacy hard-coded 0.5 / 1.0 / 2.0 thresholds (Req 7.7 — every
 *   threshold from `Algo_Settings.liquidityEngine`).
 *
 * Imbalance-proxy documentation (Req 7.5 / 7.6):
 *   The design's `bidAskImbalance` is a SIGNED ratio in `[-1, 1]`.
 *   The legacy `calculateOrderBookImbalance` returns a positive
 *   ratio `R = totalBuyPressure / totalSellPressure`. The mapping
 *   `signed = (R − 1)/(R + 1)` is monotonic and bijective on
 *   `(0, ∞) → (−1, 1)`, so subtask 6.2 can express its
 *   `bullishImbalanceMin` / `bearishImbalanceMax` cut-offs against
 *   the SAME signed scale the design typedef documents.
 *   When the broker exposes no usable L1 quote data the legacy
 *   indicator returns `R = 0` as its sentinel; we treat that as
 *   "no order-book signal" and fall through to the orderFlow
 *   proxy rather than emitting `-1`. When both paths return no
 *   useful signal the imbalance is emitted as `0` (neutral) so
 *   subtask 6.2's confirmation flags both evaluate to `false`.
 *
 * thinLiquidityZones heuristic (Req 7.7):
 *   The placeholder for 6.1 is documented as an empty array, but
 *   the canonical shape is "strikes whose combined OI is below
 *   `absorptionSensitivity`-derived threshold". We compute it
 *   here as: a strike is THIN iff
 *      `(ce.oi + pe.oi) <= (1 − absorptionSensitivity) × maxStrikeOi`
 *   This keeps `absorptionSensitivity` in `[0, 1]` (`1.0` ⇒ no
 *   strike is thin, `0.0` ⇒ every strike below the leader is
 *   thin) and matches the documented direction
 *   ("higher sensitivity ⇒ smaller / fewer thin zones").
 *   Empty array is still the safe fallback when the option chain
 *   is unavailable.
 *
 * slippageProbability composition (Req 7.7):
 *   We compose three deterministic signals into the `[0, 1]`
 *   probability space. Each component is independent so a
 *   pathological book lights up multiple dimensions:
 *     - spread component: `min(1, avg_spread_pct / slippageTolerance)`
 *       (config: `liquidityEngine.slippageTolerance`)
 *     - sweep component:  0.20 when `sweep_risk === 'high'` else 0
 *     - depth component:  0.20 when `depth.safe_to_trade === false` else 0
 *   The three are clamped after summation. The design does NOT
 *   pin a specific formula — this composition is the smallest
 *   reasonable shape that respects the slippageTolerance config
 *   (Req 7.7) and remains in `[0, 1]` for all inputs (Req 7.2).
 *
 * Spec references:
 *   - Req 3.4   — extends liquidityAnalysis / orderBookImbalance / orderFlow
 *   - Req 7.1   — order-flow imbalance, depth, absorption, stop-hunt,
 *                 spread widening
 *   - Req 7.2   — `liquidityScore ∈ [0, 100]`,
 *                 `slippageProbability ∈ [0, 1]`
 *   - Req 7.3   — `spreadStatus = 'very_wide'` ⇒ `liquidityScore ≤ 30`
 *                 (subtask 6.2 delivered the cap on top of 6.1's
 *                 baseline)
 *   - Req 7.4   — `blockEntry` when stop-hunt opposes side
 *                 (subtask 6.2 delivered: side-agnostic detection
 *                 here, side comparison in Signal_Engine)
 *   - Req 7.5   — `imbalanceConfirmsLong` against `bullishImbalanceMin`
 *                 (subtask 6.2 delivered against the signed scale)
 *   - Req 7.6   — `imbalanceConfirmsShort` against `bearishImbalanceMax`
 *                 (subtask 6.2 delivered against the signed scale)
 *   - Req 7.7   — every threshold from `Algo_Settings.liquidityEngine`
 *   - Req 17.4  — `LIQUIDITY_VERY_WIDE_SPREAD`,
 *                 `LIQUIDITY_LOW_SCORE`,
 *                 `LIQUIDITY_STOP_HUNT_OPPOSES_SIDE` reason codes
 *                 surfaced via `ctx.reasonCodes` (lifted by
 *                 `appendBlock(ctx, 'liquidity', output)`)
 *   - Design "Liquidity_Engine Adapter (Req 7)"
 *   - LiquidityOutput typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const { REASON_CODES } = require('./reasonCodes');

// ---- Wired services (Req 3.4 + Req 7.1) --------------------------
// Each service is invoked through a thin try/catch wrapper so a
// failure in one block never aborts the cycle. The legacy
// `liquidityAnalysis.service.js` ALSO exports a function named
// `analyzeLiquidity` — we import it under a private alias so the
// adapter's public `analyzeLiquidity({ctx, settings})` does not
// collide with the underlying service.
const liquidityAnalysisService = require('../algorithms/liquidityAnalysis.service');
const orderBookImbalanceIndicator = require('../../algorithms/orderBookImbalance.indicator');
const orderFlowService = require('../algorithms/orderFlow.service');

// ============================================================
// Constants
// ============================================================

/**
 * Default spread cut-offs used when the operator hasn't fully
 * configured `settings.liquidityEngine.spreadCutoffs`. Mirrors the
 * design's "Algo_Settings Surface" defaults so a partial config
 * still produces a deterministic spreadStatus (Req 7.7).
 */
const DEFAULT_SPREAD_CUTOFFS = Object.freeze({
  tight: 0.10,
  normal: 0.25,
  wide: 0.50,
  veryWide: 1.00,
});

/**
 * Default slippage-tolerance percent used as the denominator of
 * the spread component of `slippageProbability` when the operator
 * hasn't set `liquidityEngine.slippageTolerance`. Mirrors the
 * documented Algo_Settings Surface default.
 */
const DEFAULT_SLIPPAGE_TOLERANCE = 0.5;

/**
 * Default absorption sensitivity used to derive the
 * `thinLiquidityZones` threshold when the operator hasn't set
 * `liquidityEngine.absorptionSensitivity`. Mirrors the documented
 * Algo_Settings Surface default and keeps the value in `[0, 1]`.
 */
const DEFAULT_ABSORPTION_SENSITIVITY = 0.7;

/**
 * Default `signalEngine.minLiquidityScore` used by the baseline
 * health rule when the operator hasn't configured it. Mirrors the
 * documented Algo_Settings Surface default.
 */
const DEFAULT_MIN_LIQUIDITY_SCORE = 60;

/**
 * Default `liquidityEngine.bullishImbalanceMin` (positive-ratio
 * scale `R = buy/sell`). Mirrors the documented Algo_Settings
 * Surface default. Converted to the SIGNED scale internally via
 * `ratioThresholdToSigned` so it can be compared against
 * `bidAskImbalance` (which lives in `[-1, 1]`).
 */
const DEFAULT_BULLISH_IMBALANCE_MIN = 1.5;

/**
 * Default `liquidityEngine.bearishImbalanceMax` (positive-ratio
 * scale `R = buy/sell`). Mirrors the documented Algo_Settings
 * Surface default. Converted to the SIGNED scale internally via
 * `ratioThresholdToSigned`.
 */
const DEFAULT_BEARISH_IMBALANCE_MAX = 0.667;

/**
 * Cap applied to `liquidityScore` when `spreadStatus` is
 * `'very_wide'` (Req 7.3). Hard-coded by the spec rather than the
 * Algo_Settings surface, so it lives as a module constant.
 */
const VERY_WIDE_SPREAD_SCORE_CAP = 30;

// ============================================================
// Helpers — settings extraction
// ============================================================

/**
 * Resolve the spread cut-offs from `settings.liquidityEngine
 * .spreadCutoffs`, falling back per-key to the documented defaults
 * when a value is missing or non-finite. We do NOT enforce
 * `tight < normal < wide < veryWide` here — `algoSettings
 * .validateSettings` is the authoritative validator and may
 * reject an invalid set of cut-offs at hot-reload time. This
 * helper just guarantees a deterministic shape for the runtime.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {{ tight:number, normal:number, wide:number, veryWide:number }}
 */
function resolveSpreadCutoffs(settings) {
  const cfg =
    settings && settings.liquidityEngine && settings.liquidityEngine.spreadCutoffs
      ? settings.liquidityEngine.spreadCutoffs
      : {};
  /** @type {{tight:number,normal:number,wide:number,veryWide:number}} */
  const out = { ...DEFAULT_SPREAD_CUTOFFS };
  for (const key of Object.keys(DEFAULT_SPREAD_CUTOFFS)) {
    const value = cfg[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Resolve the slippage-tolerance percent (`liquidityEngine
 * .slippageTolerance`). Falls back to the documented default
 * when the operator hasn't set it; clamps to a strictly positive
 * floor so the spread component of `slippageProbability` cannot
 * divide by zero.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}
 */
function resolveSlippageTolerance(settings) {
  const v =
    settings && settings.liquidityEngine
      ? settings.liquidityEngine.slippageTolerance
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_SLIPPAGE_TOLERANCE;
}

/**
 * Resolve the absorption-sensitivity threshold (`liquidityEngine
 * .absorptionSensitivity`) used by the `thinLiquidityZones`
 * heuristic. Clamped to `[0, 1]` because the heuristic interprets
 * it as a fraction.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}
 */
function resolveAbsorptionSensitivity(settings) {
  const v =
    settings && settings.liquidityEngine
      ? settings.liquidityEngine.absorptionSensitivity
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }
  return DEFAULT_ABSORPTION_SENSITIVITY;
}

/**
 * Resolve the minimum liquidity score that still counts as
 * "healthy" (`signalEngine.minLiquidityScore`). Used by the
 * baseline `liquidityHealth.healthy` rule. Falls back to the
 * documented default when the operator hasn't set it.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}
 */
function resolveMinLiquidityScore(settings) {
  const v =
    settings && settings.signalEngine
      ? settings.signalEngine.minLiquidityScore
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_MIN_LIQUIDITY_SCORE;
}

/**
 * Resolve the bullish imbalance minimum threshold
 * (`liquidityEngine.bullishImbalanceMin`) on the operator's
 * documented POSITIVE-RATIO scale `R = buy / sell`. Falls back to
 * the documented default when the operator hasn't set it; clamps
 * to a strictly positive floor so the signed conversion via
 * `ratioThresholdToSigned` is always defined.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}                    Positive ratio (R = buy/sell).
 */
function resolveBullishImbalanceMin(settings) {
  const v =
    settings && settings.liquidityEngine
      ? settings.liquidityEngine.bullishImbalanceMin
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_BULLISH_IMBALANCE_MIN;
}

/**
 * Resolve the bearish imbalance maximum threshold
 * (`liquidityEngine.bearishImbalanceMax`) on the operator's
 * documented POSITIVE-RATIO scale `R = buy / sell`. Falls back to
 * the documented default when the operator hasn't set it; clamps
 * to a strictly positive floor so the signed conversion via
 * `ratioThresholdToSigned` is always defined.
 *
 * @param {Readonly<Object>|undefined} settings
 * @returns {number}                    Positive ratio (R = buy/sell).
 */
function resolveBearishImbalanceMax(settings) {
  const v =
    settings && settings.liquidityEngine
      ? settings.liquidityEngine.bearishImbalanceMax
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return DEFAULT_BEARISH_IMBALANCE_MAX;
}

// ============================================================
// Helpers — option-chain shape adaptation
// ============================================================

/**
 * The legacy `liquidityAnalysis.service.js` and `orderFlow.service.js`
 * read each strike via `strike.call.*` / `strike.put.*` (lowercase
 * `call` / `put`), while the cycle's normalised option chain (built
 * by `dataEngine.adapter.readOptionChain`) exposes `ce` / `pe`. We
 * adapt the snapshot shape ONCE here so neither legacy service
 * needs to know about the new naming.
 *
 * The legacy services also sometimes read `oi_change` (snake_case).
 * We mirror both `oiChange` and `oi_change` so either branch lands
 * the field. Likewise for `bidQty` / `bid_qty`.
 *
 * Returns `null` when the snapshot has no option chain — callers
 * MUST handle this and fall through to safe defaults (no service
 * is invoked when the chain is missing).
 *
 * @param {Object|null} optionChain  Snapshot's `ctx.data.optionChain`.
 * @returns {Object|null}            Legacy-shape option chain.
 */
function adaptOptionChainForLegacy(optionChain) {
  if (
    !optionChain ||
    !Array.isArray(optionChain.strikes) ||
    optionChain.strikes.length === 0
  ) {
    return null;
  }
  const strikes = optionChain.strikes
    .filter((row) => row && typeof row.strike === 'number')
    .map((row) => ({
      strike: row.strike,
      call: row.ce
        ? {
            ltp: row.ce.ltp,
            oi: row.ce.oi,
            oi_change:
              typeof row.ce.oiChange === 'number' ? row.ce.oiChange : 0,
            oiChange:
              typeof row.ce.oiChange === 'number' ? row.ce.oiChange : 0,
            iv: row.ce.iv,
            delta: row.ce.delta,
            volume: typeof row.ce.volume === 'number' ? row.ce.volume : 0,
            // L1 quote fields are not exposed by `dhanOptions`
            // today; the legacy services will fall back to
            // `ltp ± 0.5%` estimates when these are missing.
            bid: typeof row.ce.bid === 'number' ? row.ce.bid : undefined,
            ask: typeof row.ce.ask === 'number' ? row.ce.ask : undefined,
            bidQty: typeof row.ce.bidQty === 'number' ? row.ce.bidQty : 0,
            askQty: typeof row.ce.askQty === 'number' ? row.ce.askQty : 0,
          }
        : { ltp: 0, oi: 0, oi_change: 0, oiChange: 0, volume: 0, bidQty: 0, askQty: 0 },
      put: row.pe
        ? {
            ltp: row.pe.ltp,
            oi: row.pe.oi,
            oi_change:
              typeof row.pe.oiChange === 'number' ? row.pe.oiChange : 0,
            oiChange:
              typeof row.pe.oiChange === 'number' ? row.pe.oiChange : 0,
            iv: row.pe.iv,
            delta: row.pe.delta,
            volume: typeof row.pe.volume === 'number' ? row.pe.volume : 0,
            bid: typeof row.pe.bid === 'number' ? row.pe.bid : undefined,
            ask: typeof row.pe.ask === 'number' ? row.pe.ask : undefined,
            bidQty: typeof row.pe.bidQty === 'number' ? row.pe.bidQty : 0,
            askQty: typeof row.pe.askQty === 'number' ? row.pe.askQty : 0,
          }
        : { ltp: 0, oi: 0, oi_change: 0, oiChange: 0, volume: 0, bidQty: 0, askQty: 0 },
    }));
  return {
    atmStrike: optionChain.atmStrike,
    expiry: optionChain.expiry,
    strikes,
  };
}

// ============================================================
// Helpers — sub-block computation
// ============================================================

/**
 * Re-classify the `spreadStatus` against the operator-configured
 * cut-offs (Req 7.7). The legacy service's `spread_status` uses
 * its own hard-coded thresholds (0.5 / 1.0 / 2.0) which do NOT
 * match the design's Algo_Settings Surface defaults (0.10 / 0.25
 * / 0.50 / 1.00). We therefore harvest the raw `avg_spread_pct`
 * from the legacy block and apply our own step-function:
 *
 *   spread <= cutoffs.tight    ⇒ 'tight'
 *   spread <= cutoffs.normal   ⇒ 'normal'
 *   spread <= cutoffs.wide     ⇒ 'wide'
 *   spread >  cutoffs.wide     ⇒ 'very_wide'
 *
 * The `cutoffs.veryWide` value is documented in the Algo_Settings
 * Surface as the "absolute" very-wide floor; in step-function
 * terms anything strictly above `cutoffs.wide` lands in
 * `very_wide`, so `veryWide` is informational only at this layer.
 *
 * Returns `'normal'` when the input is missing / non-finite —
 * the safe-default that does not on its own trigger the
 * `LIQUIDITY_VERY_WIDE_SPREAD` gate.
 *
 * @param {number|null} avgSpreadPct
 * @param {{ tight:number, normal:number, wide:number, veryWide:number }} cutoffs
 * @returns {('tight'|'normal'|'wide'|'very_wide')}
 */
function classifySpread(avgSpreadPct, cutoffs) {
  if (typeof avgSpreadPct !== 'number' || !Number.isFinite(avgSpreadPct)) {
    return 'normal';
  }
  if (avgSpreadPct <= cutoffs.tight) return 'tight';
  if (avgSpreadPct <= cutoffs.normal) return 'normal';
  if (avgSpreadPct <= cutoffs.wide) return 'wide';
  return 'very_wide';
}

/**
 * Convert the legacy `market_imbalance` ratio into the design's
 * signed bid/ask imbalance.
 *
 * The legacy indicator returns `R = totalBuyPressure /
 * totalSellPressure` (a strictly positive ratio that's
 * unbounded above). The design's typedef calls for a SIGNED
 * ratio in `[-1, 1]` matching `(buy − sell) / (buy + sell)`.
 *
 * Algebra: if `R = buy/sell` then
 *   `(buy − sell)/(buy + sell) = (R − 1)/(R + 1)`,
 * which is a smooth, monotonic, odd map from `(0, ∞) → (−1, 1)`.
 * `R = 1` (parity) ⇒ `0`, `R → ∞` ⇒ `1`, `R → 0` ⇒ `−1`.
 *
 * Returns `null` when `R` is missing / non-finite — callers MUST
 * fall through to the orderFlow proxy (or emit `0` neutral when
 * orderFlow is also unavailable).
 *
 * @param {number|null|undefined} ratio
 * @returns {number|null}
 */
function ratioToSignedImbalance(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  // The legacy `calculateOrderBookImbalance` returns `R = 0` as its
  // "no usable bid/ask qty data" sentinel (the implementation
  // computes `R = totalSellPressure > 0 ? buy/sell : 0`, so an
  // all-zero L1 quote book lands on R = 0). We MUST NOT map that
  // to the design's `-1` (all-sell) — the caller will fall through
  // to the orderFlow proxy when this returns `null`. Strictly
  // negative R values are also impossible from the legacy formula
  // and therefore treated as "no data".
  if (ratio <= 0) return null;
  const signed = (ratio - 1) / (ratio + 1);
  // Defensive clamp — the algebra guarantees [-1, 1] but
  // floating-point edge cases (R = ±Infinity) can push out.
  if (signed > 1) return 1;
  if (signed < -1) return -1;
  return Number(signed.toFixed(4));
}

/**
 * Convert an operator-supplied POSITIVE-RATIO threshold (e.g.
 * `bullishImbalanceMin = 1.5` on the legacy `R = buy / sell`
 * scale) into the SIGNED scale used by `bidAskImbalance`.
 *
 * Mirrors `ratioToSignedImbalance` exactly so the two scales
 * agree by construction:
 *   signed = (R − 1) / (R + 1)
 *
 * Examples (using documented Algo_Settings Surface defaults):
 *   bullishImbalanceMin = 1.5   ⇒ signed +0.20
 *   bearishImbalanceMax = 0.667 ⇒ signed -0.20  (parity-symmetric)
 *
 * Unlike `ratioToSignedImbalance`, this helper treats `R = 0`
 * and non-finite inputs as a saturating bound rather than "no
 * data" — the caller passes a configured threshold, not a
 * measurement, so a misconfigured `0` is interpreted as "all
 * sell pressure" (signed -1) and `+Infinity` as "all buy
 * pressure" (signed +1). Negative inputs are clamped to `-1`
 * for safety; in practice `algoSettings.validateSettings`
 * rejects any non-positive threshold at hot-reload time.
 *
 * @param {number} ratio   Positive ratio threshold (R = buy/sell).
 * @returns {number}       Signed threshold in `[-1, 1]`.
 */
function ratioThresholdToSigned(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    // Conservative default: a non-finite threshold is impossible
    // to satisfy on the bullish side and trivially satisfied on
    // the bearish side. We pick the safer "impossible" mapping
    // by saturating at +1 — the unmatched flag stays false.
    return ratio === Number.POSITIVE_INFINITY ? 1 : 0;
  }
  if (ratio <= 0) return -1;
  const signed = (ratio - 1) / (ratio + 1);
  if (signed > 1) return 1;
  if (signed < -1) return -1;
  return Number(signed.toFixed(4));
}

/**
 * Compute the bid/ask imbalance from the cycle's option chain.
 *
 * Strategy:
 *   1. Try `orderBookImbalanceIndicator.calculateOrderBookImbalance`
 *      with the adapted option chain. When the broker exposes
 *      `bidQty` / `askQty` (real order book), this is the canonical
 *      source.
 *   2. Convert its `market_imbalance` ratio into the signed
 *      design value via `ratioToSignedImbalance`.
 *   3. If the ratio is missing / non-finite (no real book), fall
 *      back to `orderFlowService.analyzeOrderFlow` which derives
 *      a "last-bar buy-vs-sell volume proxy" (Req 7.5/7.6 design
 *      note). The order-flow service exposes
 *      `flowType.aggressive_buy / aggressive_sell` as the buy
 *      / sell totals; we re-use the same `(buy − sell)/(buy + sell)`
 *      formula.
 *   4. If both fail, return `0` (neutral) — the safe default that
 *      causes subtask 6.2's confirmation flags to evaluate to
 *      `false` for both sides.
 *
 * @param {Object|null} adaptedOptionChain
 * @param {number|null} spotPrice
 * @param {Object|null} spotData
 * @returns {number}                     Signed ratio in `[-1, 1]`.
 */
function computeBidAskImbalance(adaptedOptionChain, spotPrice, spotData) {
  // ---- Path 1: real order-book via orderBookImbalance indicator ----
  try {
    if (
      adaptedOptionChain &&
      typeof spotPrice === 'number' &&
      Number.isFinite(spotPrice) &&
      typeof adaptedOptionChain.atmStrike === 'number'
    ) {
      const obi = orderBookImbalanceIndicator.calculateOrderBookImbalance(
        adaptedOptionChain,
        spotPrice,
        adaptedOptionChain.atmStrike
      );
      if (obi && typeof obi.market_imbalance === 'number') {
        const signed = ratioToSignedImbalance(obi.market_imbalance);
        if (signed !== null) return signed;
      }
    }
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[liquidityEngine.adapter] computeBidAskImbalance — orderBookImbalance failed, falling back to orderFlow'
    );
  }

  // ---- Path 2: orderFlow last-bar buy-vs-sell proxy --------------
  try {
    if (adaptedOptionChain && spotData) {
      const flow = orderFlowService.analyzeOrderFlow(
        adaptedOptionChain,
        spotData,
        null
      );
      if (flow) {
        // `analyzeOrderFlow` does not surface the raw aggressive
        // buy / sell totals on its return value, but
        // `delta_weighted_oi` is a signed magnitude that captures
        // the same intent (positive = buy pressure, negative =
        // sell pressure). We map it onto `[-1, 1]` via tanh so
        // large magnitudes saturate cleanly at the bounds.
        const dwoi =
          typeof flow.delta_weighted_oi === 'number' ? flow.delta_weighted_oi : 0;
        if (Number.isFinite(dwoi) && dwoi !== 0) {
          // tanh-style: x / (|x| + k), k = 10000 (one block trade).
          const signed = dwoi / (Math.abs(dwoi) + 10000);
          if (signed > 1) return 1;
          if (signed < -1) return -1;
          return Number(signed.toFixed(4));
        }
        // Falls through to `net_flow` for a coarse non-zero hint.
        if (flow.net_flow === 'bullish') return 0.25;
        if (flow.net_flow === 'bearish') return -0.25;
      }
    }
  } catch (err) {
    logger.warn(
      { err: err && err.message },
      '[liquidityEngine.adapter] computeBidAskImbalance — orderFlow failed, returning neutral'
    );
  }

  return 0;
}

/**
 * Map the legacy absorption block onto the design's `{ detected,
 * side: 'bid'|'ask'|null }` shape.
 *
 * Legacy `smart_money_absorption` exposes:
 *   - `absorption_detected: bool`
 *   - `absorption_type: 'smart_money_buying' | 'smart_money_selling' | null`
 *
 * Mapping:
 *   smart_money_buying  ⇒ side = 'bid' (institutions absorbing on the bid)
 *   smart_money_selling ⇒ side = 'ask' (institutions distributing on the ask)
 *   null / unknown       ⇒ side = null
 *
 * @param {Object|null} legacyAbsorption
 * @returns {{ detected:boolean, side:('bid'|'ask'|null) }}
 */
function mapAbsorption(legacyAbsorption) {
  if (!legacyAbsorption) {
    return { detected: false, side: null };
  }
  const detected = !!legacyAbsorption.absorption_detected;
  let side = null;
  if (legacyAbsorption.absorption_type === 'smart_money_buying') {
    side = 'bid';
  } else if (legacyAbsorption.absorption_type === 'smart_money_selling') {
    side = 'ask';
  }
  return { detected, side };
}

/**
 * Map the legacy stop-hunt block onto the design's `{ detected,
 * direction: 'up'|'down'|null }` shape.
 *
 * Legacy `liquidity_sweeps` exposes:
 *   - `sweep_detected: bool`
 *   - `sweep_direction: 'upward' | 'downward' | null`
 *
 * Mapping:
 *   upward   ⇒ 'up'
 *   downward ⇒ 'down'
 *   null     ⇒ null
 *
 * @param {Object|null} legacySweeps
 * @returns {{ detected:boolean, direction:('up'|'down'|null) }}
 */
function mapStopHunt(legacySweeps) {
  if (!legacySweeps) {
    return { detected: false, direction: null };
  }
  const detected = !!legacySweeps.sweep_detected;
  let direction = null;
  if (legacySweeps.sweep_direction === 'upward') direction = 'up';
  else if (legacySweeps.sweep_direction === 'downward') direction = 'down';
  return { detected, direction };
}

/**
 * Compute the `thinLiquidityZones` array per the heuristic
 * documented in the file header. A strike is THIN when its
 * combined OI (`ce.oi + pe.oi`) is at most
 * `(1 − absorptionSensitivity) × maxStrikeOi` — i.e. it falls into
 * the lower fraction of the OI distribution.
 *
 * Edge cases:
 *   - Empty chain ⇒ empty array.
 *   - All strikes have OI 0 ⇒ empty array (no leader to compare to).
 *   - `absorptionSensitivity = 1` ⇒ threshold collapses to 0, so
 *     only strikes with literally zero OI count as thin (rare).
 *   - `absorptionSensitivity = 0` ⇒ threshold equals the max OI,
 *     so every strike below the leader counts as thin.
 *
 * The returned array is sorted ascending by strike (deterministic
 * audit-row output).
 *
 * @param {Object|null} adaptedOptionChain
 * @param {number}      sensitivity
 * @returns {Array<number>}
 */
function computeThinLiquidityZones(adaptedOptionChain, sensitivity) {
  if (!adaptedOptionChain || !Array.isArray(adaptedOptionChain.strikes)) {
    return [];
  }
  /** @type {Array<{strike:number, oi:number}>} */
  const rows = [];
  let maxOi = 0;
  for (const row of adaptedOptionChain.strikes) {
    const ceOi = row && row.call && typeof row.call.oi === 'number' ? row.call.oi : 0;
    const peOi = row && row.put && typeof row.put.oi === 'number' ? row.put.oi : 0;
    const combined = ceOi + peOi;
    rows.push({ strike: row.strike, oi: combined });
    if (combined > maxOi) maxOi = combined;
  }
  if (maxOi <= 0) return [];
  const threshold = (1 - sensitivity) * maxOi;
  const thin = rows.filter((r) => r.oi <= threshold).map((r) => r.strike);
  thin.sort((a, b) => a - b);
  return thin;
}

/**
 * Compose `slippageProbability` ∈ `[0, 1]` from the spread, sweep,
 * and depth signals per the formula documented in the file header.
 *
 * Returns `0` (no slippage signal) when every input is missing —
 * conservative for the "unknowable" path so the cycle does not
 * fail on absent telemetry.
 *
 * @param {number|null} avgSpreadPct
 * @param {Object|null} legacySweeps
 * @param {Object|null} legacyDepth
 * @param {number}      slippageTolerance
 * @returns {number}
 */
function composeSlippageProbability(
  avgSpreadPct,
  legacySweeps,
  legacyDepth,
  slippageTolerance
) {
  let p = 0;

  // Spread component — saturates at 1.0 when spread reaches tolerance.
  if (
    typeof avgSpreadPct === 'number' &&
    Number.isFinite(avgSpreadPct) &&
    slippageTolerance > 0
  ) {
    p += Math.min(1, Math.max(0, avgSpreadPct / slippageTolerance));
  }

  // Sweep component — high sweep risk adds 0.20 fixed.
  if (legacySweeps && legacySweeps.sweep_risk === 'high') {
    p += 0.20;
  }

  // Depth component — shallow / very shallow market adds 0.20 fixed.
  if (legacyDepth && legacyDepth.safe_to_trade === false) {
    p += 0.20;
  }

  if (p < 0) p = 0;
  if (p > 1) p = 1;
  return Number(p.toFixed(4));
}

/**
 * Clamp a numeric score into `[0, 100]`, rounding to an integer.
 * Returns `0` when the input is missing / non-finite — the safe
 * default that flips `liquidityHealth.healthy` to `false`.
 *
 * @param {number|null|undefined} score
 * @returns {number}
 */
function clampLiquidityScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return Math.round(score);
}

// ============================================================
// Helpers — safe-default emission
// ============================================================

/**
 * Build the stable-shape `LiquidityOutput` returned on
 * unrecoverable failure or when the cycle has no option chain.
 * The shape matches the JSDoc typedef in `cycleContext.js` exactly
 * so downstream code never has to null-check sub-fields (Req 1.5).
 *
 * Every gate-driven field is emitted as the SAFE-DEFAULT value
 * (false / empty), which causes Signal_Engine to short-circuit
 * to NO_TRADE — exactly what we want when liquidity is unknowable.
 *
 * @returns {Object}  Stable-shape LiquidityOutput.
 */
function buildSafeDefault() {
  return {
    spreadStatus: 'normal',
    bidAskImbalance: 0,
    absorption: { detected: false, side: null },
    thinLiquidityZones: [],
    stopHunt: { detected: false, direction: null },
    slippageProbability: 0,
    liquidityScore: 0,
    liquidityHealth: { healthy: false },
    imbalanceConfirmsLong: false,
    imbalanceConfirmsShort: false,
    blockEntry: false,
    reasonCodes: [],
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Analyse the current cycle's liquidity and emit a
 * `LiquidityOutput` matching the typedef in `cycleContext.js`.
 *
 * Pipeline ordering: this function is invoked AFTER `Data_Engine`
 * (so `ctx.data` is populated) and AFTER `Structure_Engine`
 * (so `ctx.structure` is available — though Liquidity_Engine does
 * not consume it). It runs BEFORE OI_Engine / PCR_Engine /
 * Signal_Engine.
 *
 * Subtask 6.1 contract:
 *   - Returns a fully-shaped object even on failure (Req 1.5).
 *   - Populates `spreadStatus`, `bidAskImbalance`, `absorption`,
 *     `stopHunt`, `slippageProbability`, `liquidityScore`,
 *     `liquidityHealth.healthy`, and `thinLiquidityZones` from
 *     the wired services + Algo_Settings (Req 7.1 / 7.2 / 7.7).
 *
 * Subtask 6.2 contract (delivered):
 *   - `spreadStatus = 'very_wide'` ⇒ `liquidityScore` clamped to
 *     `min(score, 30)` and `LIQUIDITY_VERY_WIDE_SPREAD` pushed
 *     onto `reasonCodes` (Req 7.3 / 17.4).
 *   - `liquidityScore < signalEngine.minLiquidityScore` ⇒
 *     `LIQUIDITY_LOW_SCORE` pushed onto `reasonCodes`.
 *   - `stopHunt.detected = true` ⇒ `blockEntry = true` and
 *     `LIQUIDITY_STOP_HUNT_OPPOSES_SIDE` pushed onto
 *     `reasonCodes` (Req 7.4 / 17.4).
 *   - `imbalanceConfirmsLong / imbalanceConfirmsShort` computed
 *     against the operator-configured thresholds, converted onto
 *     the signed scale via `ratioThresholdToSigned` (Req 7.5 /
 *     7.6).
 *
 * @param {Object}            params
 * @param {Object}            params.ctx        Immutable cycle context.
 * @param {Readonly<Object>}  params.settings   Algo_Settings snapshot.
 * @returns {Object}                            LiquidityOutput.
 */
function analyzeLiquidity({ ctx, settings } = {}) {
  // Hard guard: missing ctx / settings is a programming error in
  // the orchestrator, but per Req 1.5 we never throw — return the
  // safe-default block so downstream gates short-circuit to
  // NO_TRADE.
  if (!ctx || !ctx.data || !settings) {
    logger.warn(
      {
        hasCtx: !!ctx,
        hasData: !!(ctx && ctx.data),
        hasSettings: !!settings,
      },
      '[liquidityEngine.adapter] missing ctx / data / settings — emitting safe default'
    );
    return buildSafeDefault();
  }

  try {
    // --------------------------------------------------------
    // 0. Resolve every threshold from Algo_Settings (Req 7.7).
    //    Done up-front so the rest of the function reads from
    //    a single, deterministic config snapshot.
    // --------------------------------------------------------
    const spreadCutoffs = resolveSpreadCutoffs(settings);
    const slippageTolerance = resolveSlippageTolerance(settings);
    const absorptionSensitivity = resolveAbsorptionSensitivity(settings);
    const minLiquidityScore = resolveMinLiquidityScore(settings);
    // Operator thresholds are documented on the legacy POSITIVE-
    // RATIO scale (R = buy/sell). Convert them onto the signed
    // scale once so the comparison against `bidAskImbalance`
    // (which lives in `[-1, 1]`) is apples-to-apples (Req 7.5/7.6).
    const bullishImbalanceMinRatio = resolveBullishImbalanceMin(settings);
    const bearishImbalanceMaxRatio = resolveBearishImbalanceMax(settings);
    const bullishImbalanceMinSigned = ratioThresholdToSigned(
      bullishImbalanceMinRatio
    );
    const bearishImbalanceMaxSigned = ratioThresholdToSigned(
      bearishImbalanceMaxRatio
    );

    // --------------------------------------------------------
    // 1. Adapt the snapshot's option chain to the legacy
    //    services' shape (call/put, oi_change). Done once so
    //    every service reads the same data.
    // --------------------------------------------------------
    const adaptedOptionChain = adaptOptionChainForLegacy(ctx.data.optionChain);
    const spotData = ctx.data.spot || null;
    const spotPrice =
      spotData && typeof spotData.ltp === 'number' ? spotData.ltp : null;

    // When the option chain is missing entirely (Req 4.8 has
    // already raised OPTION_CHAIN_UNAVAILABLE on the cycle) we
    // cannot compute anything meaningful — emit the safe default
    // so downstream gates short-circuit, but keep the shape
    // stable so the audit row can still record the cycle.
    if (!adaptedOptionChain || spotPrice === null) {
      return buildSafeDefault();
    }

    // --------------------------------------------------------
    // 2. Run `liquidityAnalysisService.analyzeLiquidity` once;
    //    harvest the sub-blocks we need. Wrapped in try/catch
    //    so a failure here still returns a stable-shape output.
    //
    //    `previousData` is null for now — task 6.1 does not yet
    //    wire a "previous-cycle liquidity snapshot" channel.
    //    The legacy service degrades gracefully (no absorption
    //    detected, no sweep detected) when previousData is null.
    // --------------------------------------------------------
    let legacyLiquidity = null;
    try {
      legacyLiquidity = liquidityAnalysisService.analyzeLiquidity(
        adaptedOptionChain,
        spotPrice,
        null,
        null
      );
    } catch (err) {
      logger.warn(
        { err: err && err.message },
        '[liquidityEngine.adapter] liquidityAnalysisService.analyzeLiquidity threw — using safe defaults for that block'
      );
      legacyLiquidity = null;
    }

    // --------------------------------------------------------
    // 3. spreadStatus — re-classify from raw `avg_spread_pct`
    //    against `liquidityEngine.spreadCutoffs` (Req 7.7).
    //
    //    Replay/missing-depth heuristic: when the option-chain
    //    rows carry NO real bid/ask quotes (only ltp), the
    //    legacy `analyzeSpread` falls back to `ltp × ±0.5%`
    //    which always reports `avg_spread_pct ≈ 1.0` —
    //    artificially tripping the "very_wide" gate. We detect
    //    that fallback by looking at the first ATM-window strike
    //    and treat missing depth as `'normal'` (we do not know
    //    the spread; do not penalize).
    // --------------------------------------------------------
    const avgSpreadPct =
      legacyLiquidity &&
      legacyLiquidity.spread_analysis &&
      typeof legacyLiquidity.spread_analysis.avg_spread_pct === 'number'
        ? legacyLiquidity.spread_analysis.avg_spread_pct
        : null;
    const hasRealDepth = (() => {
      if (!adaptedOptionChain || !Array.isArray(adaptedOptionChain.strikes)) return false;
      for (const row of adaptedOptionChain.strikes) {
        if (row && row.call && (typeof row.call.bid === 'number' || typeof row.call.ask === 'number')) return true;
        if (row && row.put && (typeof row.put.bid === 'number' || typeof row.put.ask === 'number')) return true;
      }
      return false;
    })();
    const spreadStatus = hasRealDepth
      ? classifySpread(avgSpreadPct, spreadCutoffs)
      : 'normal';

    // --------------------------------------------------------
    // 4. bidAskImbalance — orderBookImbalance indicator first,
    //    orderFlow proxy fallback. Always lands in `[-1, 1]`
    //    (Req 7.5 / 7.6 design note).
    // --------------------------------------------------------
    const bidAskImbalance = computeBidAskImbalance(
      adaptedOptionChain,
      spotPrice,
      spotData
    );

    // --------------------------------------------------------
    // 5. absorption — map legacy block onto design shape.
    // --------------------------------------------------------
    const absorption = mapAbsorption(
      legacyLiquidity ? legacyLiquidity.smart_money_absorption : null
    );

    // --------------------------------------------------------
    // 6. thinLiquidityZones — derived from absorptionSensitivity
    //    over the option chain (Req 7.7). Documented heuristic
    //    in the file header.
    // --------------------------------------------------------
    const thinLiquidityZones = computeThinLiquidityZones(
      adaptedOptionChain,
      absorptionSensitivity
    );

    // --------------------------------------------------------
    // 7. stopHunt — map legacy sweep block onto design shape.
    // --------------------------------------------------------
    const stopHunt = mapStopHunt(
      legacyLiquidity ? legacyLiquidity.liquidity_sweeps : null
    );

    // --------------------------------------------------------
    // 8. slippageProbability — composite over spread / sweep
    //    risk / depth, divided by `slippageTolerance` so the
    //    value lives in `[0, 1]` (Req 7.2 / 7.7).
    // --------------------------------------------------------
    const slippageProbability = composeSlippageProbability(
      avgSpreadPct,
      legacyLiquidity ? legacyLiquidity.liquidity_sweeps : null,
      legacyLiquidity ? legacyLiquidity.dom_depth : null,
      slippageTolerance
    );

    // --------------------------------------------------------
    // 9. liquidityScore — clamp the legacy score into `[0, 100]`
    //    (Req 7.2). Subtask 6.2 layers the
    //    `spreadStatus = 'very_wide' ⇒ score ≤ 30` cap on top.
    // --------------------------------------------------------
    let liquidityScore = clampLiquidityScore(
      legacyLiquidity ? legacyLiquidity.liquidity_score : 0
    );

    // Reason-code accumulator for subtask 6.2 gates. Codes are
    // pushed in detection order; `cycleContext.appendBlock(ctx,
    // 'liquidity', output)` lifts them onto `ctx.reasonCodes`
    // (deduped) for the audit row (Req 17.4 / 17.7 / 18.4).
    /** @type {Array<string>} */
    const reasonCodes = [];

    // --------------------------------------------------------
    // 10. Subtask 6.2 — spread cap (Req 7.3).
    //     `spreadStatus = 'very_wide'` clamps the score to
    //     `min(score, 30)` so Signal_Engine's
    //     `signalEngine.minLiquidityScore` floor (default 60)
    //     is impossible to clear, guaranteeing NO_TRADE on a
    //     blown-out book. The reason code is emitted in
    //     parallel for the audit row.
    // --------------------------------------------------------
    if (spreadStatus === 'very_wide') {
      liquidityScore = Math.min(liquidityScore, VERY_WIDE_SPREAD_SCORE_CAP);
      reasonCodes.push(REASON_CODES.LIQUIDITY_VERY_WIDE_SPREAD);
    }

    // --------------------------------------------------------
    // 11. Subtask 6.2 — low-score reason code (Req 7.3 / 17.4).
    //     We push `LIQUIDITY_LOW_SCORE` whenever the
    //     post-cap score is below the operator-configured floor
    //     so Signal_Engine's NO_TRADE decision is fully
    //     auditable. Note that this can co-exist with
    //     `LIQUIDITY_VERY_WIDE_SPREAD` (the cap will pull a
    //     previously-healthy score below the floor) — both
    //     codes land on the audit row.
    // --------------------------------------------------------
    if (liquidityScore < minLiquidityScore) {
      reasonCodes.push(REASON_CODES.LIQUIDITY_LOW_SCORE);
    }

    // --------------------------------------------------------
    // 12. Subtask 6.2 — stop-hunt block (Req 7.4 / 17.4).
    //     `blockEntry = true` whenever stop-hunt is detected;
    //     Signal_Engine pairs `blockEntry` with
    //     `stopHunt.direction` to enforce "opposes the
    //     candidate side". See the file header's "Side-aware
    //     gates" note for the rationale.
    // --------------------------------------------------------
    const blockEntry = !!(stopHunt && stopHunt.detected);
    if (blockEntry) {
      reasonCodes.push(REASON_CODES.LIQUIDITY_STOP_HUNT_OPPOSES_SIDE);
    }

    // --------------------------------------------------------
    // 13. Subtask 6.2 — imbalance confirmation flags
    //     (Req 7.5 / 7.6).
    //     Computed unconditionally against the operator-
    //     supplied thresholds (converted onto the signed
    //     scale). Signal_Engine reads whichever flag matches
    //     the candidate side it is evaluating.
    // --------------------------------------------------------
    const imbalanceConfirmsLong = bidAskImbalance >= bullishImbalanceMinSigned;
    const imbalanceConfirmsShort = bidAskImbalance <= bearishImbalanceMaxSigned;

    // --------------------------------------------------------
    // 14. liquidityHealth.healthy — re-derived against the
    //     post-cap score so the gate stays consistent with
    //     `LIQUIDITY_LOW_SCORE` and `LIQUIDITY_VERY_WIDE_SPREAD`.
    //     A book is healthy iff the (possibly-capped) score
    //     clears the operator-configured floor AND the spread
    //     is not very_wide. The two conditions are redundant
    //     post-cap (the cap forces the score below the
    //     default floor of 60), but we keep both for clarity
    //     and for setups where the operator pushes
    //     `minLiquidityScore` below the cap (e.g. 25).
    // --------------------------------------------------------
    const healthy =
      liquidityScore >= minLiquidityScore && spreadStatus !== 'very_wide';

    return {
      spreadStatus,
      bidAskImbalance,
      absorption,
      thinLiquidityZones,
      stopHunt,
      slippageProbability,
      liquidityScore,
      liquidityHealth: { healthy },
      imbalanceConfirmsLong,
      imbalanceConfirmsShort,
      blockEntry,
      reasonCodes,
    };
  } catch (err) {
    // Unrecoverable — never throw (Req 1.5). Emit safe-default
    // so downstream gates short-circuit to NO_TRADE.
    logger.error(
      { err: err && err.message },
      '[liquidityEngine.adapter] unrecoverable failure — emitting safe default'
    );
    return buildSafeDefault();
  }
}

module.exports = {
  analyzeLiquidity,
  // Exposed for unit tests / orchestrator-side reuse. Each helper
  // is pure (no side effects) so callers can re-derive any
  // sub-block without re-running the full pipeline.
  resolveSpreadCutoffs,
  resolveSlippageTolerance,
  resolveAbsorptionSensitivity,
  resolveMinLiquidityScore,
  resolveBullishImbalanceMin,
  resolveBearishImbalanceMax,
  adaptOptionChainForLegacy,
  classifySpread,
  ratioToSignedImbalance,
  ratioThresholdToSigned,
  computeBidAskImbalance,
  mapAbsorption,
  mapStopHunt,
  computeThinLiquidityZones,
  composeSlippageProbability,
  clampLiquidityScore,
  buildSafeDefault,
};
