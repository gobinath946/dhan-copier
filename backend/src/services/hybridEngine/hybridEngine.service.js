'use strict';

/**
 * ============================================================
 * HYBRID_ENGINE ORCHESTRATOR (Req 18) — subtask 16.1
 * ============================================================
 * The per-cycle pipeline orchestrator for the NIFTY 50 hybrid
 * institutional engine. Threads a single immutable
 * `CycleContext` through ten stages in strict order:
 *
 *   Data_Engine → Regime_Engine → Structure_Engine →
 *   Liquidity_Engine → OI_Engine → PCR_Engine → Signal_Engine →
 *   Risk_Engine → AI_Support_Layer → Execution_Engine
 *
 * The Master_Score is computed between PCR_Engine and
 * Signal_Engine so Signal_Engine can see the score on
 * `ctx.masterScore`. AI_Support_Layer may modulate the score
 * but never upgrade NO_TRADE (Req 14.9).
 *
 * SCOPE — this file delivers ONLY subtask 16.1:
 *   - Cycle tick on `Algo_Settings.signalEngine.predictionIntervalMs`
 *     with a per-cycle Algo_Settings snapshot (Req 18.1, Req 2.4).
 *   - Strict 10-stage pipeline with documented short-circuit
 *     reason codes (Req 18.2, Req 18.3).
 *   - Direction derivation from Signal_Engine output
 *     (LONG_SETUP → BUY_CE, SHORT_SETUP → BUY_PE).
 *   - Risk_Engine + AI_Support_Layer + Execution_Engine wiring
 *     for the success path; per-trade roster updates on
 *     placed/partial outcomes.
 *   - Outer try/catch resolving to a NO_TRADE context with
 *     `ORCHESTRATOR_ERROR` on any unhandled in-process error
 *     (Req 1.5 / 18.6) — `ScalpingSession` recovery on next
 *     start restores identical risk state.
 *
 * DEFERRED to subsequent subtasks (TODO markers inline):
 *   - Subtask 16.3: Monitoring_Engine cadence loop. The
 *     `start()` / `stop()` lifecycle below already wires the
 *     prediction loop AND injects this orchestrator's
 *     `riskEngine` reference into Monitoring_Engine via
 *     `setRiskEngine(...)` so the kill-switch /
 *     re-evaluation routing is ready. The actual
 *     `monitoringEngine.start()` / `monitoringEngine.stop()`
 *     calls are gated behind `TODO 16.3:` markers.
 *
 * Wired in subtask 16.2 (per-cycle audit row writer):
 *   - `auditLog.writeCycleAudit` is now called via
 *     `_writeAuditSafe(ctx)` exactly once at every termination
 *     point in `runCycle` (each NO_TRADE short-circuit, the
 *     terminal success return, and the outer try/catch). The
 *     active `ScalpingSession._id` flows through `setSessionId`.
 *
 * Failure semantics (Req 1.5):
 *   - `runCycle()` NEVER throws. Adapter calls are wrapped in
 *     `_safeAdapterCall`; the outer try/catch pinpoints any
 *     unhandled error and lifts `ORCHESTRATOR_ERROR` onto the
 *     returned context.
 *   - `start()` / `stop()` are idempotent.
 *   - Module-level state is reset by `__resetForTest()` for
 *     smoke / property tests.
 *
 * Spec references:
 *   - Req 1.1 / 1.2 / 1.3 / 1.4 / 1.5 — single hybrid engine,
 *     graceful degradation when external dependencies are
 *     unreachable.
 *   - Req 18.1 — single immutable cycle context, frozen
 *     Algo_Settings snapshot per cycle.
 *   - Req 18.2 — strict pipeline order.
 *   - Req 18.3 — short-circuit on upstream NO_TRADE flags.
 *   - Req 18.5 — AI_Support_Layer is advisory-only (modulate
 *     score, may downgrade to NO_TRADE, never upgrade).
 *   - Req 18.6 — outer error handler protects the prediction
 *     loop; `ScalpingSession` recovery restores identical risk
 *     state on next start.
 *   - Design "Pipeline Topology" + "Per-Cycle Audit Row Schema".
 * ============================================================
 */

const logger = require('../../utils/logger');
const algoSettings = require('../../config/algoSettings');

const cycleContext = require('./cycleContext');
const { REASON_CODES } = require('./reasonCodes');
const auditLog = require('./auditLog');

// ---- Stage adapters (Req 18.2 strict order) ----------------------
const dataEngineAdapter = require('./dataEngine.adapter');
const regimeEngineAdapter = require('./regimeEngine.adapter');
const structureEngineAdapter = require('./structureEngine.adapter');
const liquidityEngineAdapter = require('./liquidityEngine.adapter');
const oiEngineAdapter = require('./oiEngine.adapter');
const pcrEngineAdapter = require('./pcrEngine.adapter');
const signalEngineEvaluator = require('./signalEngine.evaluator');
const riskEngineAdapter = require('./riskEngine.adapter');
const aiSupportAdapter = require('./aiSupport.adapter');
const executionEngineAdapter = require('./executionEngine.adapter');

// Master_Score is computed inline between PCR and Signal so the
// signal evaluator sees `ctx.masterScore`.
const masterScore = require('./masterScore');

// Monitoring_Engine cadence loop is owned by subtask 16.3. We
// import the adapter here so subtask 16.1 can inject the
// `riskEngine` reference at startup; the actual `start()` /
// `stop()` calls live behind `TODO 16.3:` markers below.
const monitoringEngineAdapter = require('./monitoringEngine.adapter');

// ============================================================
// Constants
// ============================================================

/**
 * Default prediction-loop cadence in milliseconds, used when the
 * operator hasn't set `signalEngine.predictionIntervalMs`.
 * Mirrors the documented Algo_Settings Surface default (5 s).
 */
const DEFAULT_PREDICTION_INTERVAL_MS = 5000;

/**
 * Reason codes that, when present on `ctx.reasonCodes`, force
 * the orchestrator to short-circuit before Signal_Engine.
 *
 * CALIBRATION 2026-05-17: removed `REGIME_BLOCK_RANGING` and
 * `REGIME_LOW_CONFIDENCE` from the short-circuit set so the
 * Signal_Engine evaluator's UT-Bot-primary path can fire on
 * ranging / low-confidence cycles. Those codes are still
 * emitted (audit rows preserve them); they just don't
 * auto-block. The hard-block label set (`expiry-manipulation`,
 * `high-risk`) is still enforced.
 *
 * Documented at the file header and pulled exclusively from the
 * frozen `REASON_CODES` enum. Order matches Req 18.3.
 *
 * Stages OI_Engine / PCR_Engine / Structure_Engine never emit a
 * code in this set — they are ALWAYS run.
 */
const UPSTREAM_SHORT_CIRCUIT_CODES = Object.freeze([
  // Data_Engine (Req 4.6 / 4.8)
  REASON_CODES.DATA_TICK_STALE,
  REASON_CODES.OPTION_CHAIN_UNAVAILABLE,
  // Regime_Engine (hard blocks only — Req 5.7 / 5.8)
  REASON_CODES.REGIME_BLOCK_EXPIRY_MANIPULATION,
  REASON_CODES.REGIME_BLOCK_HIGH_RISK,
  // Liquidity_Engine (Req 7.3 / 7.4 / 17.4)
  REASON_CODES.LIQUIDITY_VERY_WIDE_SPREAD,
  REASON_CODES.LIQUIDITY_LOW_SCORE,
  REASON_CODES.LIQUIDITY_STOP_HUNT_OPPOSES_SIDE,
]);

// ============================================================
// Module-level state
// ------------------------------------------------------------
// The orchestrator is a singleton — there is exactly one hybrid
// engine per process. Instance-style construction would force
// every consumer to track the handle; the existing adapters
// already follow the same singleton pattern (e.g.
// `monitoringEngine.adapter.start()`), so we mirror their style.
// `__resetForTest()` zeroes every field below.
// ============================================================

/** @type {boolean} */
let _isRunning = false;

/** @type {NodeJS.Timeout|null} */
let _cadenceTimer = null;

/** @type {number|null} Epoch ms of the last completed cycle. */
let _lastCycleAt = null;

/** @type {number} Number of cycles completed since `start()`. */
let _cycleCount = 0;

/** @type {number} Cached prediction-interval (resolved at start). */
let _predictionIntervalMs = DEFAULT_PREDICTION_INTERVAL_MS;

/**
 * Execution-mode switch — `'live'` (default) routes intents
 * through `orderOrchestration.executeMultiAccountOrder` and into
 * the broker layer underneath `dhanProd.service.js`. `'simulation'`
 * routes intents through the recorder so dry-run cycles produce
 * `TradeExecutionLog` rows tagged `simulation: true` without
 * touching the broker (Req 1.1 / 1.2 / 1.3 / subtask 18.1).
 *
 * The orchestrator owns the operator-facing API; the adapter
 * holds its own copy via `executionEngineAdapter.setExecutionMode(...)`
 * so per-cycle settings snapshots stay frozen.
 *
 * @type {('live'|'simulation')}
 */
let _executionMode = 'live';

/**
 * Replay-folder pointer used by Data_Engine in dry-run cycles
 * (subtask 18.1 / Req 4.4). When non-null, `Data_Engine` reads
 * candles from the recorded JSONL under the absolute folder path
 * regardless of today's IST date. The recommended shape is
 * `<repo>/dhan-copier/backend/live-feed/<YYYY-MM-DD>_NIFTY_50/`.
 *
 * @type {string|null}
 */
let _replayFolder = null;

/**
 * Active `ScalpingSession._id` used by the audit-row writer
 * (subtask 16.2) when persisting `EngineEventLog` rows. The
 * orchestrator owns this id; consumers set it via
 * `setSessionId({ sessionId })`. When unset (smoke checks, dry
 * runs, the brief window before session bind) the audit-row
 * writer logs a warning and skips the persist — the prediction
 * loop continues uninterrupted.
 *
 * @type {string|null}
 */
let _sessionId = null;

/**
 * Subtask 18.2 — has the orchestrator already registered process-
 * level shutdown handlers (`SIGINT` / `SIGTERM`) for the current
 * Node process? Re-entrant calls to `start()` MUST NOT register
 * duplicate listeners; the boolean below guards the registration
 * path. `__resetForTest` flips this back to `false` between
 * smoke scenarios so the next `start()` re-installs handlers if
 * the test exercise needs them. We do NOT remove the underlying
 * process listeners on reset — `process.once` self-cleans after
 * the first signal, and registering once per Node process is
 * the desired production semantics.
 *
 * @type {boolean}
 */
let _processShutdownHandlersInstalled = false;

// ============================================================
// Internal helpers
// ============================================================

/**
 * Read the prediction-loop cadence from a frozen Algo_Settings
 * snapshot. Falls back to the documented default when the value
 * is missing / non-finite. Clamped to a strictly positive floor
 * of 100 ms so an operator typo cannot peg the event loop.
 *
 * @param {Readonly<Object>} settings
 * @returns {number}
 */
function _readPredictionInterval(settings) {
  const v =
    settings && settings.signalEngine
      ? settings.signalEngine.predictionIntervalMs
      : undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 100) return v;
  return DEFAULT_PREDICTION_INTERVAL_MS;
}

/**
 * Read the operator-supplied per-trade risk percentage from the
 * frozen Algo_Settings snapshot. Risk_Engine validates this
 * against `[perTradeRiskPctMin, perTradeRiskPctMax]` itself; the
 * orchestrator simply forwards the legacy flat-key value.
 *
 * @param {Readonly<Object>} settings
 * @returns {number}
 */
function _readPerTradeRiskPct(settings) {
  if (!settings || typeof settings !== 'object') return 1.0;
  if (
    typeof settings.riskPerTradePct === 'number' &&
    Number.isFinite(settings.riskPerTradePct)
  ) {
    return settings.riskPerTradePct;
  }
  // Fallback to riskEngine.perTradeRiskPctMax — the upper bound
  // of the validated range.
  const r = settings.riskEngine || {};
  if (
    typeof r.perTradeRiskPctMax === 'number' &&
    Number.isFinite(r.perTradeRiskPctMax)
  ) {
    return r.perTradeRiskPctMax;
  }
  return 1.0;
}

/**
 * Wrap an adapter call in a defensive try/catch so a single
 * misbehaving stage does not crash the pipeline. Returns the
 * adapter's value on success and `null` on failure (the
 * orchestrator decides how to handle each null — typically by
 * appending a synthetic block with reason codes and short-
 * circuiting).
 *
 * Adapters are themselves contract-bound to never throw
 * (Req 1.5), so this helper is a defence-in-depth measure for
 * future regressions.
 *
 * @template T
 * @param {string} name             Stage name for the log line.
 * @param {() => T|Promise<T>} fn   Adapter invocation.
 * @returns {Promise<T|null>}
 */
async function _safeAdapterCall(name, fn) {
  try {
    const out = await fn();
    return out === undefined ? null : out;
  } catch (err) {
    try {
      logger.error(
        { module: 'hybridEngine.service', stage: name, err: err && err.message },
        `[hybridEngine.service] ${name} threw — degrading to safe default`
      );
    } catch (_) {
      /* logger itself failed — last-resort console */
      // eslint-disable-next-line no-console
      console.error(`[hybridEngine.service] ${name} threw:`, err && err.message);
    }
    return null;
  }
}

/**
 * Test whether the supplied cycle context carries any of the
 * documented upstream short-circuit reason codes (Req 18.3).
 *
 * @param {Readonly<{ reasonCodes: ReadonlyArray<string> }>} ctx
 * @returns {boolean}
 */
function _isShortCircuit(ctx) {
  if (!ctx || !Array.isArray(ctx.reasonCodes) || ctx.reasonCodes.length === 0) {
    return false;
  }
  for (const code of ctx.reasonCodes) {
    if (UPSTREAM_SHORT_CIRCUIT_CODES.indexOf(code) !== -1) return true;
  }
  return false;
}

/**
 * Append `finalAction = 'NO_TRADE'` to a cycle context. The
 * audit-row write is performed by `_writeAuditSafe` at every
 * termination site (subtask 16.2) AFTER calling this helper, so
 * the persisted row records `finalAction: 'NO_TRADE'` rather
 * than the pre-finalisation context.
 *
 * @param {Readonly<import('./cycleContext').CycleContext>} ctx
 * @returns {Readonly<import('./cycleContext').CycleContext>}
 */
function _terminateNoTrade(ctx) {
  return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');
}

/**
 * Persist exactly one `EngineEventLog` row of `type = 'CYCLE_AUDIT'`
 * for the cycle described by `ctx` (subtask 16.2 / Req 17 / Req 18.4).
 *
 * The wrapper around `auditLog.writeCycleAudit` enforces three
 * invariants so the prediction loop never breaks on persistence:
 *
 *   1. The call site at every termination point in `runCycle` is a
 *      single `await _writeAuditSafe(ctx)`. Exactly one row per
 *      cycle — never zero, never two.
 *   2. `_writeAuditSafe` swallows ALL errors. A Mongo outage, a
 *      malformed context, or a serialiser crash logs and returns;
 *      it does NOT propagate up to the cadence loop (Req 1.5).
 *   3. The active `ScalpingSession._id` (set via `setSessionId`) is
 *      threaded through so `EngineEventLog` validation passes. When
 *      the session id is missing the inner writer logs and skips
 *      the persist — still no throw.
 *
 * @param {Readonly<import('./cycleContext').CycleContext>} ctx
 * @returns {Promise<void>}
 */
async function _writeAuditSafe(ctx) {
  try {
    await auditLog.writeCycleAudit(ctx, {
      type: 'CYCLE_AUDIT',
      sessionId: _sessionId,
    });
  } catch (err) {
    try {
      logger.error(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] _writeAuditSafe failed'
      );
    } catch (_) {
      // eslint-disable-next-line no-console
      console.error('[hybridEngine.service] _writeAuditSafe failed:', err && err.message);
    }
  }
}

/**
 * Build the contributions map consumed by `masterScore.computeMasterScore`.
 *
 * The eight contributor keys are documented in
 * `masterScore.CONTRIBUTOR_KEYS`. We derive each one from the
 * already-populated stage blocks on `ctx`:
 *
 *   - `oiBuildup`      : `ctx.oi.ceDominance | peDominance ?` ⇒ 1.0 when one side dominates and futures-aligned.
 *   - `vwapAvwap`      : `ctx.structure.bias` non-neutral × biasConfidence (already in [0, 1]).
 *   - `volumeProfile`  : `1.0` when price is on the favoured side of POC, else `0`. Stale when VP is null.
 *   - `deltaOrderflow` : abs(ctx.liquidity.bidAskImbalance) — already in [0, 1].
 *   - `liquidity`      : `ctx.liquidity.liquidityScore / 100`, capped to [0, 1].
 *   - `ivVix`          : 0.5 baseline when VIX is missing (stale=true so it doesn't fabricate signal).
 *   - `breadth`        : 0.5 baseline; stale when no breadth data is present.
 *   - `pcrWeight`      : `ctx.pcr.bullishSqueezeProbability` ? 1 : `ctx.pcr.contrarianCaution` ? 0 : 0.5.
 *
 * Every key emits `{ value, stale }`. `stale: true` causes
 * `masterScore` to drop the contributor from the weighted sum
 * and renormalise the remaining weights (Req 16.4).
 *
 * @param {Readonly<import('./cycleContext').CycleContext>} ctx
 * @returns {Object<string, { value:number, stale:boolean }>}
 */
function _buildMasterScoreContributions(ctx) {
  const data = ctx.data || null;
  const structure = ctx.structure || null;
  const liquidity = ctx.liquidity || null;
  const oi = ctx.oi || null;
  const pcr = ctx.pcr || null;

  // ----- oiBuildup -----
  let oiBuildup = { value: 0, stale: true };
  if (oi) {
    const ceDom = !!oi.ceDominance;
    const peDom = !!oi.peDominance;
    const aligned = !!oi.futuresOIAligned;
    if (ceDom || peDom) {
      oiBuildup = { value: aligned ? 1.0 : 0.5, stale: false };
    } else {
      oiBuildup = { value: 0.0, stale: false };
    }
  }

  // ----- vwapAvwap -----
  let vwapAvwap = { value: 0.5, stale: true };
  if (structure) {
    if (structure.bias === 'bullish' || structure.bias === 'bearish') {
      const conf = typeof structure.biasConfidence === 'number'
        ? structure.biasConfidence
        : 0;
      vwapAvwap = { value: Math.max(0, Math.min(1, conf)), stale: false };
    } else {
      vwapAvwap = { value: 0.0, stale: false };
    }
  }

  // ----- volumeProfile -----
  let volumeProfile = { value: 0, stale: true };
  if (
    structure &&
    structure.volumeProfile &&
    typeof structure.volumeProfile.poc === 'number' &&
    data &&
    data.spot &&
    typeof data.spot.ltp === 'number'
  ) {
    const price = data.spot.ltp;
    const poc = structure.volumeProfile.poc;
    if (structure.bias === 'bullish') {
      volumeProfile = { value: price > poc ? 1.0 : 0.0, stale: false };
    } else if (structure.bias === 'bearish') {
      volumeProfile = { value: price < poc ? 1.0 : 0.0, stale: false };
    } else {
      // Neutral bias ⇒ no directional VP signal.
      volumeProfile = { value: 0.5, stale: false };
    }
  }

  // ----- deltaOrderflow -----
  let deltaOrderflow = { value: 0, stale: true };
  if (liquidity && typeof liquidity.bidAskImbalance === 'number') {
    deltaOrderflow = {
      value: Math.max(0, Math.min(1, Math.abs(liquidity.bidAskImbalance))),
      stale: false,
    };
  }

  // ----- liquidity -----
  let liquidityContrib = { value: 0, stale: true };
  if (liquidity && typeof liquidity.liquidityScore === 'number') {
    liquidityContrib = {
      value: Math.max(0, Math.min(1, liquidity.liquidityScore / 100)),
      stale: false,
    };
  }

  // ----- ivVix -----
  // VIX is not yet wired into Data_Engine (see dataEngine.adapter
  // header); we mark this stale so masterScore renormalises
  // around it rather than fabricating a contribution.
  const ivVix = { value: 0.5, stale: data && data.vix === null };

  // ----- breadth -----
  // Same story for breadth — stale until a future data wiring task
  // populates `ctx.data.breadth`.
  const breadth = { value: 0.5, stale: !(data && data.breadth) };

  // ----- pcrWeight -----
  let pcrWeight = { value: 0.5, stale: true };
  if (pcr) {
    if (pcr.bullishSqueezeProbability === true) {
      pcrWeight = { value: 1.0, stale: false };
    } else if (pcr.contrarianCaution === true) {
      pcrWeight = { value: 0.0, stale: false };
    } else {
      pcrWeight = { value: 0.5, stale: false };
    }
  }

  return {
    oiBuildup,
    vwapAvwap,
    volumeProfile,
    deltaOrderflow,
    liquidity: liquidityContrib,
    ivVix,
    breadth,
    pcrWeight,
  };
}

/**
 * Translate a Signal_Engine candidate onto an
 * `Algo_Settings.executionEngine.direction` value.
 *
 *   LONG_SETUP  → BUY_CE
 *   SHORT_SETUP → BUY_PE
 *
 * Returns `null` for NO_TRADE / unknown.
 *
 * @param {string|null|undefined} candidate
 * @returns {('BUY_CE'|'BUY_PE'|null)}
 */
function _candidateToDirection(candidate) {
  if (candidate === 'LONG_SETUP') return 'BUY_CE';
  if (candidate === 'SHORT_SETUP') return 'BUY_PE';
  return null;
}

/**
 * Apply the AI_Support_Layer's bounded score modulation to the
 * cycle's master score.
 *
 *   - `scoreDelta` is in 0..100 units (matching `masterScore`).
 *   - Already clamped by `aiSupport.maxConfidenceModulation`
 *     inside `aiSupport.adapter._computeModulation`.
 *   - Final score is clamped to `[0, 100]` defensively.
 *
 * Returns the new master score (does NOT mutate `ctx`).
 *
 * @param {number|null} currentScore
 * @param {*}           ai
 * @returns {number|null}
 */
function _applyAiScoreModulation(currentScore, ai) {
  if (typeof currentScore !== 'number' || !Number.isFinite(currentScore)) {
    return currentScore;
  }
  if (!ai || typeof ai !== 'object') return currentScore;
  if (typeof ai.scoreDelta !== 'number' || !Number.isFinite(ai.scoreDelta)) {
    return currentScore;
  }
  const next = currentScore + ai.scoreDelta;
  if (next < 0) return 0;
  if (next > 100) return 100;
  return next;
}

/**
 * Record a successfully placed (or partially placed) trade with
 * Risk_Engine so the open-roster, exposure cap, and per-trade
 * exit lifecycle stay in sync for the next cycle (Req 12.3).
 *
 * Defensive — every failure mode logs and returns silently.
 *
 * @param {Readonly<import('./cycleContext').CycleContext>} ctx
 * @param {('BUY_CE'|'BUY_PE')} direction
 * @returns {void}
 */
function _recordTradeOpenFromExecution(ctx, direction) {
  try {
    const exec = ctx && ctx.execution;
    if (!exec || (exec.status !== 'placed' && exec.status !== 'partial')) {
      return;
    }
    const orderParams = exec.orderParams || {};
    const lots =
      typeof orderParams.lots === 'number' && Number.isFinite(orderParams.lots)
        ? orderParams.lots
        : 0;
    const lotSize =
      typeof orderParams.lotSize === 'number' && Number.isFinite(orderParams.lotSize)
        ? orderParams.lotSize
        : (ctx.settings && typeof ctx.settings.lotSize === 'number'
            ? ctx.settings.lotSize
            : 65);
    const premium =
      typeof orderParams.premium === 'number' && Number.isFinite(orderParams.premium)
        ? orderParams.premium
        : 0;
    riskEngineAdapter.recordTradeOpen({
      trade: {
        id: exec.orderId || `${ctx.cycleId}-${direction}`,
        type: 'scalp',
        side: direction === 'BUY_CE' ? 'LONG' : 'SHORT',
        openedAt: Date.now(),
        premium,
        lots,
        lotSize,
        cycleId: ctx.cycleId,
      },
    });
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] recordTradeOpen failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Run a single prediction cycle and return the resulting
 * `CycleContext`. NEVER throws (Req 1.5 / 18.6).
 *
 * The function:
 *   1. Snapshots Algo_Settings at the cycle boundary (Req 18.1).
 *   2. Builds the immutable cycle context.
 *   3. Executes the ten stage adapters in strict order with
 *      documented short-circuit semantics (Req 18.2 / 18.3).
 *   4. On any unhandled error, lifts `ORCHESTRATOR_ERROR` onto
 *      `ctx.reasonCodes`, sets `finalAction = 'NO_TRADE'`, and
 *      returns the context. `ScalpingSession` recovery on next
 *      start restores identical risk state (Req 18.6).
 *
 * @param {Object} [opts]
 * @param {number} [opts.now]   Override for `Date.now()`; passthrough to Data_Engine.
 * @returns {Promise<Readonly<import('./cycleContext').CycleContext>>}
 */
async function runCycle(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const now = typeof options.now === 'number' ? options.now : Date.now();

  // Outer try/catch — `runCycle` MUST NEVER throw. Any failure
  // path below resolves to a NO_TRADE context with
  // `ORCHESTRATOR_ERROR` so the prediction loop keeps ticking.
  let ctx;
  try {
    // ----------------------------------------------------------
    // Step 1: snapshot Algo_Settings at the cycle boundary.
    // ----------------------------------------------------------
    const settings = algoSettings.snapshot();
    const settingsHash = algoSettings.settingsHash(settings);
    ctx = cycleContext.buildCycleContext({ settings, settingsHash });

    // ----------------------------------------------------------
    // Subtask 16.3 — drain Monitoring_Engine's re-evaluation
    // queue (Req 15.4 / 15.5 / 18.3).
    //
    // Monitoring_Engine enqueues per-source re-evaluation
    // requests (`regime_change`, `ai_confidence_decay`,
    // `manual`) via `riskEngineAdapter.requestReEvaluation` on
    // its OWN cadence (independent of this prediction loop).
    // Risk_Engine retains exit decision authority — Monitoring
    // never submits exits directly (Req 19.7). The orchestrator
    // drains the queue once at the START of every cycle and
    // lifts a reason code per drained source onto
    // `ctx.reasonCodes` so the CYCLE_AUDIT row carries the
    // provenance regardless of whether the cycle later
    // proceeds to Execution_Engine or short-circuits.
    //
    // NOTE: routing each drained request through the actual
    // per-trade exit-decision path (`monitorEngine.service.js`)
    // is OUT OF SCOPE for 16.3. The queue surface and the
    // reason-code audit are wired here so a future per-trade
    // exit-management subtask can attach without re-plumbing
    // the orchestrator.
    try {
      const pending =
        typeof riskEngineAdapter.consumePendingReEvaluations === 'function'
          ? riskEngineAdapter.consumePendingReEvaluations()
          : [];
      if (Array.isArray(pending) && pending.length > 0) {
        const reEvalCodes = [];
        for (const p of pending) {
          if (!p || typeof p !== 'object') continue;
          const src = String(p.source || 'manual').toLowerCase();
          if (src === 'regime_change') {
            reEvalCodes.push(REASON_CODES.MONITORING_REEVAL_REGIME_CHANGE);
          } else if (src === 'ai_confidence_decay') {
            reEvalCodes.push(REASON_CODES.MONITORING_REEVAL_AI_CONFIDENCE_DECAY);
          } else {
            reEvalCodes.push(REASON_CODES.MONITORING_REEVAL_MANUAL);
          }
        }
        if (reEvalCodes.length > 0) {
          ctx = cycleContext.addReasonCodes(ctx, reEvalCodes);
        }
        try {
          logger.info(
            {
              module: 'hybridEngine.service',
              pendingCount: pending.length,
              sources: pending.map((p) => p && p.source),
            },
            '[hybridEngine.service] drained Monitoring_Engine re-evaluation queue'
          );
        } catch (_) {
          /* swallow */
        }
      }
    } catch (err) {
      try {
        logger.warn(
          { module: 'hybridEngine.service', err: err && err.message },
          '[hybridEngine.service] re-evaluation drain failed; continuing'
        );
      } catch (_) {
        /* swallow */
      }
    }

    // ----------------------------------------------------------
    // Stage 1 — Data_Engine (Req 4)
    // ----------------------------------------------------------
    // 18.1: thread the operator's `_replayFolder` through so the
    // Data_Engine can read candles from a specific recorded
    // folder regardless of today's IST date. When null, falls
    // back to the live/recorded auto-detection path.
    const dataSnapshot = await _safeAdapterCall('dataEngine', () =>
      dataEngineAdapter.fetchDataSnapshot({
        settings,
        now,
        replayFolder: _replayFolder,
      })
    );
    if (dataSnapshot === null) {
      // Adapter threw — emit synthetic stale-data block so the
      // standard short-circuit path fires.
      ctx = cycleContext.appendBlock(ctx, 'data', {
        tickAt: now,
        tickStale: true,
        reasonCodes: [REASON_CODES.DATA_TICK_STALE],
      });
    } else {
      ctx = cycleContext.appendBlock(ctx, 'data', dataSnapshot);
    }

    // ----------------------------------------------------------
    // TRADE MONITOR — runs every cycle, BEFORE the gating stages.
    // ----------------------------------------------------------
    // Per-cycle exit decisions for OPEN ScalpingTrade rows from
    // earlier cycles. Mirrors the institutional trail / early-
    // abort / stall-scratch / time-expiry rules from the
    // backtest driver. Updates `currentPrice` / `unrealizedPnl`
    // every cycle and emits `scalpingTradeUpdate` so the UI
    // table ticks live. Closes trades that hit their exit
    // condition and emits `scalpingTradeClosed`.
    //
    // The monitor never gates the rest of the cycle — it just
    // services existing positions before we evaluate new entries.
    try {
      // eslint-disable-next-line global-require
      const tradeMonitor = require('./tradeMonitor.adapter');
      await tradeMonitor.runMonitorCycle({ sessionId: _sessionId, ctx });
    } catch (err) {
      try {
        logger.warn(
          { module: 'hybridEngine.service', err: err && err.message },
          '[hybridEngine.service] tradeMonitor.runMonitorCycle failed; continuing',
        );
      } catch (_) { /* swallow */ }
    }

    if (_isShortCircuit(ctx)) {
      // Subtask 16.2: persist exactly one CYCLE_AUDIT row for this
      // Data_Engine short-circuit BEFORE returning. Finalise the
      // context first so the audit row records `finalAction: 'NO_TRADE'`.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Stage 2 — Regime_Engine (Req 5)
    // ----------------------------------------------------------
    const regimeOutput = await _safeAdapterCall('regimeEngine', () =>
      regimeEngineAdapter.classifyRegime({ ctx, settings })
    );
    if (regimeOutput === null) {
      ctx = cycleContext.appendBlock(ctx, 'regime', {
        label: 'high-risk',
        confidence: 0,
        tradePermissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: false },
        positionSizingMultiplier: 0,
        allowedSetups: [],
        inputs: {},
        reasonCodes: [REASON_CODES.REGIME_BLOCK_HIGH_RISK],
      });
    } else {
      ctx = cycleContext.appendBlock(ctx, 'regime', regimeOutput);
    }

    // Subtask 16.2 / Req 17.3 — when the Regime_Engine classifies
    // the regime as `fake-breakout`, lift the operator-facing
    // `WHEN_NOT_TO_TRADE_FAKE_BREAKOUT` reason code onto the
    // context so the audit row carries it alongside any
    // structural codes the regime adapter emitted (e.g.
    // `REGIME_LOW_CONFIDENCE`). Mirrors the lunch-window pattern
    // where Execution_Engine emits both the structural
    // `EXEC_ILLIQUID_WINDOW` AND the operator-facing
    // `WHEN_NOT_TO_TRADE_LUNCH`.
    if (ctx.regime && ctx.regime.label === 'fake-breakout') {
      ctx = cycleContext.addReasonCodes(ctx, [
        REASON_CODES.WHEN_NOT_TO_TRADE_FAKE_BREAKOUT,
      ]);
    }

    if (_isShortCircuit(ctx)) {
      // Subtask 16.2: persist CYCLE_AUDIT for the regime block.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Stage 3 — Structure_Engine (Req 6)
    // Structure does not emit upstream short-circuit codes; it
    // ALWAYS runs and feeds Signal_Engine's mandatory checks.
    // ----------------------------------------------------------
    const structureOutput = await _safeAdapterCall('structureEngine', () =>
      structureEngineAdapter.analyzeStructure({ ctx, settings })
    );
    ctx = cycleContext.appendBlock(
      ctx,
      'structure',
      structureOutput || structureEngineAdapter.buildSafeDefault(ctx)
    );

    // ----------------------------------------------------------
    // Stage 4 — Liquidity_Engine (Req 7)
    // ----------------------------------------------------------
    const liquidityOutput = await _safeAdapterCall('liquidityEngine', () =>
      liquidityEngineAdapter.analyzeLiquidity({ ctx, settings })
    );
    if (liquidityOutput === null) {
      ctx = cycleContext.appendBlock(ctx, 'liquidity', {
        spreadStatus: 'very_wide',
        bidAskImbalance: 0,
        absorption: { detected: false, side: null },
        thinLiquidityZones: [],
        stopHunt: { detected: false, direction: null },
        slippageProbability: 1,
        liquidityScore: 0,
        liquidityHealth: { healthy: false },
        imbalanceConfirmsLong: false,
        imbalanceConfirmsShort: false,
        blockEntry: false,
        reasonCodes: [REASON_CODES.LIQUIDITY_VERY_WIDE_SPREAD, REASON_CODES.LIQUIDITY_LOW_SCORE],
      });
    } else {
      ctx = cycleContext.appendBlock(ctx, 'liquidity', liquidityOutput);
    }
    if (_isShortCircuit(ctx)) {
      // Subtask 16.2: persist CYCLE_AUDIT for the liquidity block.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Stage 5 — OI_Engine (Req 10) — never short-circuits.
    // ----------------------------------------------------------
    const oiOutput = await _safeAdapterCall('oiEngine', () =>
      oiEngineAdapter.classifyOI({ ctx, settings })
    );
    if (oiOutput !== null) {
      ctx = cycleContext.appendBlock(ctx, 'oi', oiOutput);
    }

    // ----------------------------------------------------------
    // Stage 6 — PCR_Engine (Req 11) — never short-circuits.
    // ----------------------------------------------------------
    const pcrOutput = await _safeAdapterCall('pcrEngine', () =>
      pcrEngineAdapter.computePCR({ ctx, settings })
    );
    if (pcrOutput !== null) {
      ctx = cycleContext.appendBlock(ctx, 'pcr', pcrOutput);
    }

    // ----------------------------------------------------------
    // Master_Score (Req 16) — between PCR and Signal so the
    // signal evaluator can read `ctx.masterScore`.
    // ----------------------------------------------------------
    const contributions = _buildMasterScoreContributions(ctx);
    const weights = (settings && settings.indicatorWeights) || {};
    const shortCoveringBoost =
      weights && typeof weights.oiShortCoveringBoost === 'number'
        ? weights.oiShortCoveringBoost
        : 1.0;
    const scoreResult = masterScore.computeMasterScore({
      contributions,
      weights,
      shortCoveringBoost,
      cycleId: ctx.cycleId,
      sessionId: _sessionId,
    });
    ctx = cycleContext.appendBlock(
      ctx,
      'masterScore',
      typeof scoreResult.score === 'number' ? scoreResult.score : 0
    );

    // ----------------------------------------------------------
    // Stage 7 — Signal_Engine (Req 8 / 9 / 18)
    // ----------------------------------------------------------
    const signalOutput = await _safeAdapterCall('signalEngine', () =>
      signalEngineEvaluator.evaluateSignal({ ctx, settings })
    );
    if (signalOutput === null) {
      // Synthetic NO_TRADE — `ORCHESTRATOR_ERROR` is the right
      // code because the signal evaluator itself promises never
      // to throw; reaching this branch means
      // `_safeAdapterCall` caught a genuinely unexpected failure.
      ctx = cycleContext.appendBlock(ctx, 'signal', {
        candidate: 'NO_TRADE',
        mandatoryResults: {},
        oiConfirmations: [],
        riskReward: 0,
        reasonCodes: [REASON_CODES.ORCHESTRATOR_ERROR],
        provenance: null,
      });
      // Subtask 16.2: persist CYCLE_AUDIT for the synthetic
      // signal-failure NO_TRADE.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }
    ctx = cycleContext.appendBlock(ctx, 'signal', signalOutput);

    if (
      !ctx.signal ||
      ctx.signal.candidate === 'NO_TRADE' ||
      (ctx.signal.candidate !== 'LONG_SETUP' &&
        ctx.signal.candidate !== 'SHORT_SETUP')
    ) {
      // Subtask 16.2: persist CYCLE_AUDIT for the
      // Signal_Engine NO_TRADE branch.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Direction derivation (Req 18.2) — LONG_SETUP → BUY_CE,
    // SHORT_SETUP → BUY_PE.
    // ----------------------------------------------------------
    const direction = _candidateToDirection(ctx.signal.candidate);
    if (direction === null) {
      // Defensive — can't happen given the guard above, but keep
      // the audit row honest.
      // Subtask 16.2: persist CYCLE_AUDIT for the defensive
      // unknown-direction branch.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Stage 8 — Risk_Engine (Req 12)
    // ----------------------------------------------------------
    const perTradeRiskPct = _readPerTradeRiskPct(settings);
    const riskDecision = await _safeAdapterCall('riskEngine', () =>
      riskEngineAdapter.evaluateRisk({ ctx, settings, perTradeRiskPct, now })
    );
    if (riskDecision === null) {
      ctx = cycleContext.appendBlock(ctx, 'risk', {
        allowEntry: false,
        blockReason: 'INVALID_SL',
        stopLossPoints: 0,
        targetPoints: 0,
        riskRewardRatio: 0,
        positionSize: { lotsPerAccount: {}, totalLots: 0 },
        trailing: null,
        reasonCodes: [REASON_CODES.RISK_INVALID_SL],
      });
      // Subtask 16.2: persist CYCLE_AUDIT for the synthetic
      // Risk_Engine failure NO_TRADE.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }
    ctx = cycleContext.appendBlock(ctx, 'risk', riskDecision);

    if (!ctx.risk || ctx.risk.allowEntry !== true) {
      // Subtask 16.2: persist CYCLE_AUDIT for the
      // Risk_Engine block branch (kill switch / daily loss /
      // exposure / cooldown / per-trade-risk-OOR / invalid SL).
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Stage 9 — AI_Support_Layer (Req 14 / 18.5) — advisory only.
    // ----------------------------------------------------------
    const aiAdvisory = await _safeAdapterCall('aiSupport', () =>
      aiSupportAdapter.evaluateAISupport({
        ctx,
        settings,
        masterScore: ctx.masterScore,
      })
    );
    if (aiAdvisory === null) {
      ctx = cycleContext.appendBlock(ctx, 'ai', {
        state: 'unavailable',
        reasonCodes: [REASON_CODES.AI_UNAVAILABLE],
        scoreDelta: 0,
        downgradedToNoTrade: false,
      });
    } else {
      ctx = cycleContext.appendBlock(ctx, 'ai', aiAdvisory);
    }

    // AI may modulate master score (bounded, never upgrades).
    const modulatedScore = _applyAiScoreModulation(ctx.masterScore, ctx.ai);
    if (modulatedScore !== ctx.masterScore) {
      ctx = cycleContext.appendBlock(ctx, 'masterScore', modulatedScore);
    }

    // AI may downgrade to NO_TRADE (Req 14.9).
    if (ctx.ai && ctx.ai.downgradedToNoTrade === true) {
      // Subtask 16.2: persist CYCLE_AUDIT for the AI-downgrade NO_TRADE.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }

    // ----------------------------------------------------------
    // Stage 10 — Execution_Engine (Req 13)
    // ----------------------------------------------------------
    const intent = {
      source: 'SIGNAL_RISK',
      signal: ctx.signal,
      risk: ctx.risk,
      masterScore: ctx.masterScore,
    };
    const executionOutcome = await _safeAdapterCall('executionEngine', () =>
      executionEngineAdapter.executeOrder({ ctx, settings, intent })
    );
    if (executionOutcome === null) {
      ctx = cycleContext.appendBlock(ctx, 'execution', {
        status: 'error',
        rejectReason: 'ORCHESTRATOR_ERROR',
        reasonCodes: [REASON_CODES.ORCHESTRATOR_ERROR],
      });
      // Subtask 16.2: persist CYCLE_AUDIT for the synthetic
      // Execution_Engine failure NO_TRADE.
      const finalCtx = _terminateNoTrade(ctx);
      await _writeAuditSafe(finalCtx);
      return finalCtx;
    }
    ctx = cycleContext.appendBlock(ctx, 'execution', executionOutcome);

    // ----------------------------------------------------------
    // Final action mapping.
    // ----------------------------------------------------------
    const execStatus = ctx.execution && ctx.execution.status;
    if (execStatus === 'placed' || execStatus === 'partial') {
      ctx = cycleContext.appendBlock(ctx, 'finalAction', direction);
      // Per-trade roster update — keeps Risk_Engine open-roster
      // accurate for the next cycle's exposure cap (Req 12.3).
      _recordTradeOpenFromExecution(ctx, direction);
    } else {
      // 'rejected' / 'error' / 'blocked' all collapse to NO_TRADE.
      ctx = cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');
    }

    // Subtask 16.2: persist exactly one CYCLE_AUDIT row at the
    // terminal success path. Captures placed / partial / rejected /
    // error / blocked execution outcomes and the final
    // `direction` / `NO_TRADE` mapping.
    await _writeAuditSafe(ctx);
    return ctx;
  } catch (err) {
    // ----------------------------------------------------------
    // Outer error handler (Req 18.6 / 1.5).
    //
    // Adapters are contract-bound to never throw, but if one
    // does we MUST NOT let the prediction loop crash. We:
    //   - log the error (no rethrow),
    //   - lift `ORCHESTRATOR_ERROR` onto whatever context we
    //     managed to build,
    //   - emit `finalAction: 'NO_TRADE'`.
    // `ScalpingSession` recovery on next start restores identical
    // risk state because Risk_Engine auto-persists its state on
    // every transition (subtask 12.8).
    // ----------------------------------------------------------
    try {
      logger.error(
        {
          module: 'hybridEngine.service',
          event: 'ORCHESTRATOR_ERROR',
          err: err && err.message,
          stack: err && err.stack,
        },
        '[hybridEngine.service] runCycle outer try/catch caught an error'
      );
    } catch (_) {
      // eslint-disable-next-line no-console
      console.error('[hybridEngine.service] ORCHESTRATOR_ERROR:', err && err.message);
    }

    let safeCtx;
    if (ctx && typeof ctx === 'object') {
      safeCtx = cycleContext.addReasonCodes(ctx, [REASON_CODES.ORCHESTRATOR_ERROR]);
    } else {
      // We didn't even manage to build a context. Construct a
      // minimal one with empty settings so the audit row writer
      // (16.2) still has something to persist.
      const fallbackSettings = (() => {
        try {
          return algoSettings.snapshot();
        } catch (_) {
          return Object.freeze({});
        }
      })();
      const fallbackHash = (() => {
        try {
          return algoSettings.settingsHash(fallbackSettings);
        } catch (_) {
          return 'unknown';
        }
      })();
      safeCtx = cycleContext.buildCycleContext({
        settings: fallbackSettings,
        settingsHash: fallbackHash,
      });
      safeCtx = cycleContext.addReasonCodes(safeCtx, [REASON_CODES.ORCHESTRATOR_ERROR]);
    }
    safeCtx = cycleContext.appendBlock(safeCtx, 'finalAction', 'NO_TRADE');
    // Subtask 16.2: persist CYCLE_AUDIT from the outer try/catch.
    // A Mongo failure inside the audit writer is itself swallowed
    // by `_writeAuditSafe`, so this last-resort path can never
    // re-raise into the prediction loop (Req 1.5 / 18.6).
    await _writeAuditSafe(safeCtx);
    return safeCtx;
  } finally {
    // Bookkeeping always runs (success OR failure). The
    // try/catch above handles error propagation; this block
    // just keeps the diagnostic counters honest.
    _cycleCount += 1;
    _lastCycleAt = Date.now();
    // Best-effort UI broadcast — surfaces cycle progress to the
    // operator's browser so simulation runs are observable in
    // real time. Never throws into the prediction loop.
    try {
      // eslint-disable-next-line global-require
      const scalpingSocket = require('../../utils/scalpingSocket');
      if (scalpingSocket && typeof scalpingSocket.emitCycleCompleted === 'function') {
        scalpingSocket.emitCycleCompleted(_sessionId, _cycleCount, 'prediction');
      }
      // Persist + broadcast a session update every 5 cycles so
      // the UI's `Cycles` / `Open` / `Capital` / `P&L` stat chips
      // refresh in near real-time without thrashing Mongo.
      if (_sessionId && _cycleCount % 5 === 0) {
        try {
          // eslint-disable-next-line global-require
          const ScalpingSession = require('../../models/ScalpingSession');
          // eslint-disable-next-line global-require
          const ScalpingTrade = require('../../models/ScalpingTrade');
          const session = await ScalpingSession.findById(_sessionId);
          if (session) {
            const openCount = await ScalpingTrade.countDocuments({
              sessionId: _sessionId,
              status: 'open',
            });
            session.cycleCount = _cycleCount;
            session.lastCycleAt = new Date();
            await session.save();
            if (typeof scalpingSocket.emitSessionUpdate === 'function') {
              scalpingSocket.emitSessionUpdate(session, _isRunning === true, openCount);
            }
          }
        } catch (err) {
          // swallow — UI fan-out is non-critical
        }
      }
      // Also emit the full cycle audit row so the UI can render
      // per-cycle decision logs (executionMode, finalAction,
      // reasonCodes, masterScore, ai advisory, etc.).
      if (scalpingSocket && scalpingSocket.__io
        && typeof scalpingSocket.__io.emit === 'function') {
        // Compact payload so the WS event stays light.
        scalpingSocket.__io.emit('hybridCycleAudit', {
          sessionId: _sessionId,
          cycleCount: _cycleCount,
          cycleId: ctx && ctx.cycleId,
          executionMode: _executionMode,
          replayFolder: _replayFolder,
          tickAt: ctx && ctx.data && ctx.data.tickAt,
          finalAction: ctx && ctx.finalAction,
          masterScore: ctx && ctx.masterScore,
          reasonCodes: (ctx && ctx.reasonCodes) || [],
          regimeLabel: ctx && ctx.regime && ctx.regime.label,
          regimeConfidence: ctx && ctx.regime && ctx.regime.confidence,
          signalCandidate: ctx && ctx.signal && ctx.signal.candidate,
          signalStrategy: ctx && ctx.signal && ctx.signal.mandatoryResults
            && ctx.signal.mandatoryResults.STRATEGY,
          aiState: ctx && ctx.ai && ctx.ai.state,
          aiScoreDelta: ctx && ctx.ai && ctx.ai.scoreDelta,
          executionStatus: ctx && ctx.execution && ctx.execution.status,
          timestamp: _lastCycleAt,
        });
      }
    } catch (_) {
      /* swallow — UI broadcast is non-critical */
    }
  }
}

/**
 * Set the runtime execution-mode switch (subtask 18.1 / Req 1.1 / 1.2 / 1.3).
 *
 * Accepts only `'live'` or `'simulation'`; any other value (null,
 * undefined, empty string, typo) defaults to `'live'` so the
 * deterministic broker path stays the safe default. The new mode
 * is propagated into `executionEngineAdapter` so the very next
 * `runCycle` honours it; module state stays in sync with the
 * adapter at all times.
 *
 * Idempotent — passing the same mode is a no-op. Safe to call
 * before `start()`, between cycles, or while the prediction loop
 * is running (the next cycle picks up the new mode at the
 * settings-snapshot boundary, Req 18.1).
 *
 * @param {('live'|'simulation')} mode
 * @returns {('live'|'simulation')}  The mode that was actually
 *                                   applied (after coercion).
 */
function setExecutionMode(mode) {
  // 18.1: failure-safe coerce — anything that isn't exactly
  // 'simulation' or 'live' resets to 'live' so a malformed
  // operator input can never accidentally point the engine at
  // the broker.
  if (mode === 'simulation' || mode === 'live') {
    _executionMode = mode;
  } else {
    _executionMode = 'live';
  }
  try {
    if (typeof executionEngineAdapter.setExecutionMode === 'function') {
      executionEngineAdapter.setExecutionMode(_executionMode);
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] propagating setExecutionMode to executionEngineAdapter failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }
  try {
    logger.info(
      { module: 'hybridEngine.service', executionMode: _executionMode },
      `[hybridEngine.service] executionMode set to '${_executionMode}'`
    );
  } catch (_) {
    /* swallow */
  }
  return _executionMode;
}

/**
 * Read the active execution-mode switch.
 *
 * Subtask 18.1.
 *
 * @returns {('live'|'simulation')}
 */
function getExecutionMode() {
  return _executionMode;
}

/**
 * Point Data_Engine at a specific recorded folder for replay
 * (subtask 18.1 / Req 4.4). Pass an absolute path of the form
 * `.../live-feed/<YYYY-MM-DD>_NIFTY_50/` to force the next cycle
 * to read candles from that folder regardless of today's IST
 * date. Pass `null` (or omit) to revert to the live / auto-
 * detected JSONL path.
 *
 * Idempotent. Safe to call before `start()` or while the
 * prediction loop is running — the next cycle picks up the new
 * folder at the settings-snapshot boundary (Req 18.1).
 *
 * @param {string|null|undefined} replayFolder
 * @returns {string|null}  The folder path that was actually
 *                         applied (`null` reverts to live).
 */
function setReplayFolder(replayFolder) {
  // 18.1: failure-safe coerce — only non-empty strings are
  // accepted; anything else reverts to the live data path.
  if (typeof replayFolder === 'string' && replayFolder.length > 0) {
    _replayFolder = replayFolder;
  } else {
    _replayFolder = null;
  }
  try {
    logger.info(
      { module: 'hybridEngine.service', replayFolder: _replayFolder },
      _replayFolder === null
        ? '[hybridEngine.service] replayFolder cleared — Data_Engine reverts to live data path'
        : `[hybridEngine.service] replayFolder set to '${_replayFolder}'`
    );
  } catch (_) {
    /* swallow */
  }
  return _replayFolder;
}

/**
 * Read the active replay-folder pointer.
 *
 * Subtask 18.1.
 *
 * @returns {string|null}
 */
function getReplayFolder() {
  return _replayFolder;
}

/**
 * Start the prediction-loop cadence and inject the orchestrator's
 * `riskEngine` reference into Monitoring_Engine so the kill-
 * switch / re-evaluation routing is wired (Req 15.2 / 15.3).
 *
 * Idempotent: returns `{ started: false, reason: 'ALREADY_RUNNING' }`
 * when called on an already-running engine.
 *
 * Subtask 18.1 — accepts optional `executionMode` and
 * `replayFolder` so the operator can launch the engine in a dry-
 * run configuration with a single call. Both values are applied
 * via the documented setters BEFORE the prediction loop kicks off
 * so the very first cycle sees the new state.
 *
 * Subtask 18.2 — accepts an optional `sessionId` so a single
 * `start({ sessionId })` call wires the active
 * `ScalpingSession._id` into both the orchestrator's audit-row
 * writer (`setSessionId`) AND the Risk_Engine adapter's auto-
 * persist hooks (`riskEngineAdapter.setSessionId`). Also runs
 * `algoSettings.snapshot()` + `algoSettings.validateSettings(...)`
 * BEFORE wiring anything; on a load failure (Req 2.8) the
 * engine refuses to start and surfaces the error reason; on a
 * validation failure (Req 2.6) the engine refuses to start and
 * surfaces the per-key error map. Process-level `SIGINT` /
 * `SIGTERM` handlers are installed once per process so a clean
 * shutdown tears the prediction-loop and monitoring-loop timers
 * down without leaking.
 *
 * @param {Object} [opts]
 * @param {('live'|'simulation')} [opts.executionMode] 18.1: route intents to the
 *                                                     simulation recorder when set.
 * @param {string|null}           [opts.replayFolder]  18.1: absolute path to a
 *                                                     `<YYYY-MM-DD>_NIFTY_50` folder.
 * @param {string|null}           [opts.sessionId]     18.2: active `ScalpingSession._id`
 *                                                     threaded through the audit-row
 *                                                     writer and Risk_Engine auto-persist.
 * @returns {Promise<{ started: boolean, reason?: string, predictionIntervalMs?: number, executionMode?: string, replayFolder?: (string|null), errors?: Object, error?: string }>}
 *   On success: `{ started: true, predictionIntervalMs, executionMode, replayFolder }`.
 *   On `algoSettings.snapshot()` throw (Req 2.8): `{ started: false, reason: 'ALGO_SETTINGS_LOAD_FAILED', error }`.
 *   On `validateSettings(...).valid === false` (Req 2.6): `{ started: false, reason: 'ALGO_SETTINGS_INVALID', errors }`.
 *   When already running: `{ started: false, reason: 'ALREADY_RUNNING' }`.
 */
async function start(opts) {
  if (_isRunning === true && _cadenceTimer !== null) {
    return { started: false, reason: 'ALREADY_RUNNING' };
  }

  // ------------------------------------------------------------
  // Subtask 18.2 — Algo_Settings load + validate gate (Req 2.6 / 2.8).
  //
  // Run BEFORE any other wiring so a misconfigured settings file
  // refuses to start the session AND does not leave the monitoring
  // adapter / dry-run state half-configured. Both branches return
  // a structured `{ started: false, reason, ... }` and never throw
  // — the caller (`hybridEngineLifecycle.startWithSession`) routes
  // failures back to the operator UI without crashing the host
  // process (Req 1.5).
  // ------------------------------------------------------------
  let preStartSnapshot;
  try {
    preStartSnapshot = algoSettings.snapshot();
  } catch (err) {
    try {
      logger.error(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] Algo_Settings load failure; refusing to start (Req 2.8)'
      );
    } catch (_) {
      /* swallow */
    }
    return {
      started: false,
      reason: 'ALGO_SETTINGS_LOAD_FAILED',
      error: err && err.message ? err.message : String(err),
    };
  }
  let validationResult;
  try {
    validationResult = algoSettings.validateSettings(preStartSnapshot);
  } catch (err) {
    try {
      logger.error(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] Algo_Settings validation threw; refusing to start (Req 2.6)'
      );
    } catch (_) {
      /* swallow */
    }
    return {
      started: false,
      reason: 'ALGO_SETTINGS_VALIDATION_THREW',
      error: err && err.message ? err.message : String(err),
    };
  }
  if (validationResult && validationResult.valid === false) {
    // Build a per-key error map so the caller can surface
    // structured field-level errors back to the operator.
    const perKeyErrors = {};
    if (Array.isArray(validationResult.errors)) {
      for (const e of validationResult.errors) {
        if (e && typeof e.key === 'string') {
          perKeyErrors[e.key] = e.reason || 'invalid';
        }
      }
    }
    try {
      logger.error(
        { module: 'hybridEngine.service', errors: perKeyErrors },
        '[hybridEngine.service] Algo_Settings invalid; refusing to start (Req 2.6)'
      );
    } catch (_) {
      /* swallow */
    }
    return {
      started: false,
      reason: 'ALGO_SETTINGS_INVALID',
      errors: perKeyErrors,
    };
  }

  // 18.1: apply the operator-supplied execution-mode and replay-
  // folder BEFORE the prediction loop starts so the first cycle
  // sees the new state. Both setters are idempotent and never
  // throw.
  const options = opts && typeof opts === 'object' ? opts : {};
  if (Object.prototype.hasOwnProperty.call(options, 'executionMode')) {
    setExecutionMode(options.executionMode);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'replayFolder')) {
    setReplayFolder(options.replayFolder);
  }

  // 18.2: thread the active ScalpingSession id into BOTH the
  // orchestrator's audit-row writer AND the Risk_Engine adapter's
  // auto-persist hooks so survival-layer state lands in
  // `ScalpingSession.payload.riskState` from the first cycle
  // onward (Req 12.12).
  if (Object.prototype.hasOwnProperty.call(options, 'sessionId')) {
    setSessionId({ sessionId: options.sessionId });
    try {
      if (typeof riskEngineAdapter.setSessionId === 'function') {
        riskEngineAdapter.setSessionId({ sessionId: options.sessionId });
      }
    } catch (err) {
      try {
        logger.warn(
          { module: 'hybridEngine.service', err: err && err.message },
          '[hybridEngine.service] propagating sessionId to riskEngineAdapter failed; continuing'
        );
      } catch (_) {
        /* swallow */
      }
    }
  }

  // Read the cadence from a fresh settings snapshot. The
  // prediction loop will ALSO snapshot Algo_Settings on every
  // cycle (Req 18.1), so if the operator changes the cadence
  // mid-session a `stop()` + `start()` is required to pick up
  // the new interval. Documented behaviour, not a bug.
  let predictionIntervalMs;
  try {
    const settings = algoSettings.snapshot();
    predictionIntervalMs = _readPredictionInterval(settings);
  } catch (err) {
    predictionIntervalMs = DEFAULT_PREDICTION_INTERVAL_MS;
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] start: could not read settings; using default cadence'
      );
    } catch (_) {
      /* swallow */
    }
  }
  _predictionIntervalMs = predictionIntervalMs;

  // Wire Monitoring_Engine's risk-engine dependency so 15.2 /
  // 15.3 routing works as soon as Monitoring_Engine starts in
  // 16.3. This is just a reference injection — the cadence
  // loop itself is owned by 16.3.
  try {
    monitoringEngineAdapter.setRiskEngine(riskEngineAdapter);
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] setRiskEngine on monitoringEngine failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Subtask 16.3 — wire Monitoring_Engine's `EngineEventLog`
  // writer. The writer is invoked by the adapter once per
  // monitoring tick with a `{ type, tickAt, payload }` row;
  // here we route the redacted payload through
  // `auditLog.writeMonitoringSnapshot` so the snapshot lands
  // in the same `EngineEventLog` collection as the per-cycle
  // CYCLE_AUDIT rows. Failure is swallowed so a Mongo outage
  // can never break the monitoring cadence (Req 1.5).
  try {
    monitoringEngineAdapter.setEventLogWriter(async (row) => {
      try {
        if (!row || typeof row !== 'object') return;
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : null;
        if (!payload) return;
        await auditLog.writeMonitoringSnapshot(payload, { sessionId: _sessionId });
      } catch (err) {
        try {
          logger.error(
            { module: 'hybridEngine.service', err: err && err.message },
            '[hybridEngine.service] monitoring writer failed; continuing'
          );
        } catch (_) {
          /* swallow */
        }
      }
    });
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] setEventLogWriter on monitoringEngine failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Subtask 16.3 — wire Monitoring_Engine's broadcaster onto
  // the existing `scalpingSocket` channel (Req 15.7). The
  // helper module exposes per-event emitters
  // (`emitTradeUpdated`, `emitEngineStarted`, ...) but no
  // generic `(channel, payload)` API; we therefore reach for
  // the underlying `io` instance via the module's
  // `initializeSocket(io)` injection. When the socket isn't
  // initialised (smoke checks, dry runs) we fall back to the
  // adapter's no-op broadcaster — the cadence loop still
  // ticks, just without a live UI fan-out.
  try {
    // eslint-disable-next-line global-require
    const scalpingSocketModule = require('../../utils/scalpingSocket');
    let broadcaster = null;
    if (
      scalpingSocketModule &&
      typeof scalpingSocketModule.emit === 'function'
    ) {
      // Defensive: if a future refactor exposes a generic
      // `emit(channel, payload)` we'll prefer it.
      broadcaster = (channel, payload) => {
        scalpingSocketModule.emit(channel, payload);
      };
    } else if (
      scalpingSocketModule &&
      scalpingSocketModule.__io &&
      typeof scalpingSocketModule.__io.emit === 'function'
    ) {
      // Some environments stub the `io` reference for tests.
      broadcaster = (channel, payload) => {
        scalpingSocketModule.__io.emit(channel, payload);
      };
    }
    if (broadcaster !== null) {
      monitoringEngineAdapter.setSocketBroadcaster(broadcaster);
    } else {
      // No-op fallback. The adapter already defaults to a
      // no-op broadcaster, so we just leave it untouched and
      // log so the operator knows the live UI fan-out is dark.
      try {
        logger.warn(
          { module: 'hybridEngine.service' },
          '[hybridEngine.service] scalpingSocket has no generic emit; monitoring broadcasts will be no-op until socket-server wiring lands'
        );
      } catch (_) {
        /* swallow */
      }
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] scalpingSocket not available; using no-op broadcaster'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Prediction loop. The interval handler is fire-and-forget —
  // `runCycle` never throws, so we don't attach a `.catch`.
  _cadenceTimer = setInterval(() => {
    runCycle();
  }, predictionIntervalMs);
  _isRunning = true;

  // Subtask 16.3 — start Monitoring_Engine on its OWN cadence
  // (`monitoringEngine.intervalSeconds × 1000`), independent of
  // the prediction-loop timer above (Req 15.1 / 18.3). A failed
  // monitoring start does NOT prevent the prediction loop from
  // running — it just means the operator UI won't see live
  // monitoring snapshots until the next `start()`.
  try {
    const monStart = monitoringEngineAdapter.start();
    try {
      logger.info(
        { module: 'hybridEngine.service', monStart },
        '[hybridEngine.service] monitoring loop started'
      );
    } catch (_) {
      /* swallow */
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] monitoring start failed; continuing with prediction loop only'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // 18.1: log the active dry-run state alongside the cadence so
  // the operator can confirm the engine started in the configured
  // mode.
  try {
    logger.info(
      {
        module: 'hybridEngine.service',
        predictionIntervalMs,
        executionMode: _executionMode,
        replayFolder: _replayFolder,
      },
      `[hybridEngine.service] prediction loop started — executionMode='${_executionMode}', replayFolder=${_replayFolder === null ? 'null' : `'${_replayFolder}'`}`
    );
  } catch (_) {
    /* swallow */
  }

  // ------------------------------------------------------------
  // Subtask 18.2 — process-level shutdown handlers (Req 1.1).
  //
  // Register `SIGINT` and `SIGTERM` listeners exactly once per
  // Node process so an operator pressing Ctrl-C or a container
  // orchestrator sending `SIGTERM` triggers a clean tear-down of
  // BOTH the prediction-loop and the monitoring-loop timers.
  // `process.once` is used so each handler self-removes after
  // firing — combined with the `_processShutdownHandlersInstalled`
  // guard, repeated `start()` / `stop()` cycles in the same
  // process do NOT pile up listeners. The teardown swallows all
  // errors so a misbehaving adapter cannot block process exit.
  // ------------------------------------------------------------
  if (_processShutdownHandlersInstalled === false) {
    const teardown = (signal) => {
      try {
        logger.info(
          { module: 'hybridEngine.service', signal },
          `[hybridEngine.service] received ${signal}; tearing down hybrid engine timers`
        );
      } catch (_) {
        /* swallow */
      }
      try {
        stop();
      } catch (_) {
        /* swallow — stop() is contract-bound to never throw, but
         * we belt-and-brace this so an unforeseen regression
         * cannot block the process from exiting cleanly. */
      }
    };
    try {
      process.once('SIGINT', () => teardown('SIGINT'));
      process.once('SIGTERM', () => teardown('SIGTERM'));
      _processShutdownHandlersInstalled = true;
    } catch (err) {
      try {
        logger.warn(
          { module: 'hybridEngine.service', err: err && err.message },
          '[hybridEngine.service] failed to install SIGINT/SIGTERM handlers; continuing'
        );
      } catch (_) {
        /* swallow */
      }
    }
  }

  return {
    started: true,
    predictionIntervalMs,
    executionMode: _executionMode,
    replayFolder: _replayFolder,
  };
}

/**
 * Stop the prediction-loop cadence. Idempotent — calling on a
 * stopped engine is a no-op.
 *
 * @returns {{ stopped: boolean, reason?: string }}
 */
function stop() {
  if (_isRunning === false && _cadenceTimer === null) {
    return { stopped: false, reason: 'NOT_RUNNING' };
  }
  if (_cadenceTimer !== null) {
    clearInterval(_cadenceTimer);
    _cadenceTimer = null;
  }
  _isRunning = false;

  // Subtask 16.3 — stop Monitoring_Engine. The two timers are
  // independent (Req 15.1 / 18.3), so this `stop()` clears the
  // monitoring `setInterval` separately from the prediction
  // `setInterval` cleared above. Failure is swallowed so a
  // double-stop or a malformed adapter cannot break the
  // orchestrator's idempotent stop contract.
  try {
    const monStop = monitoringEngineAdapter.stop();
    try {
      logger.info(
        { module: 'hybridEngine.service', monStop },
        '[hybridEngine.service] monitoring loop stopped'
      );
    } catch (_) {
      /* swallow */
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngine.service', err: err && err.message },
        '[hybridEngine.service] monitoring stop failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }

  return { stopped: true };
}

/**
 * Diagnostic accessor — exposes the orchestrator's runtime
 * counters without leaking module-level state. Used by
 * Monitoring_Engine (subtask 15.2) and the smoke / property
 * tests.
 *
 * @returns {{ isRunning: boolean, cycleCount: number, lastCycleAt: (number|null), predictionIntervalMs: number }}
 */
function getCycleStats() {
  return {
    isRunning: _isRunning,
    cycleCount: _cycleCount,
    lastCycleAt: _lastCycleAt,
    predictionIntervalMs: _predictionIntervalMs,
  };
}

/**
 * Set the active `ScalpingSession._id` used by the per-cycle
 * audit-row writer (subtask 16.2). The orchestrator owns the
 * lifecycle: callers (`scalpingEngine.service` / session bootstrap)
 * invoke `setSessionId({ sessionId })` once per session start
 * AFTER `start()` has been called.
 *
 * Idempotent — passing the same id is a no-op; passing a
 * different id silently rotates. Passing `null` / `undefined`
 * clears the id (subsequent audit writes will log a warning and
 * skip the persist; the prediction loop continues).
 *
 * @param {Object} params
 * @param {string|null} params.sessionId
 * @returns {void}
 */
function setSessionId({ sessionId } = {}) {
  if (sessionId === null || sessionId === undefined) {
    _sessionId = null;
    return;
  }
  _sessionId = String(sessionId);
}

/**
 * Read the active session id (set by `setSessionId` during start).
 * Used by adapters that need to write to session-scoped collections
 * (e.g. `ScalpingTrade`) without taking a circular dependency on
 * the lifecycle wrapper.
 *
 * @returns {string|null}
 */
function getActiveSessionId() {
  return _sessionId;
}

/**
 * Test-only accessor for the active session id. Smoke / property
 * tests use this to confirm `setSessionId` wired correctly.
 *
 * @returns {string|null}
 */
function __getSessionIdForTest() {
  return _sessionId;
}

/**
 * Reset every module-level state field. Smoke / property tests
 * call this between scenarios so each one starts from a clean
 * slate. NOT for production use.
 *
 * @returns {void}
 */
function __resetForTest() {
  if (_cadenceTimer !== null) {
    clearInterval(_cadenceTimer);
    _cadenceTimer = null;
  }
  _isRunning = false;
  _lastCycleAt = null;
  _cycleCount = 0;
  _predictionIntervalMs = DEFAULT_PREDICTION_INTERVAL_MS;
  _sessionId = null;
  // 18.2: reset the shutdown-handler installation flag so the
  // next `start()` re-installs handlers if the smoke scenario
  // needs them. We deliberately do NOT remove the underlying
  // process listeners — `process.once` self-cleans after the
  // first signal, and tests that exercise SIGINT/SIGTERM should
  // call `process.removeAllListeners('SIGINT')` themselves.
  _processShutdownHandlersInstalled = false;
  // 18.1: reset the dry-run state. We also propagate the live
  // default into the executionEngineAdapter so a previous test's
  // simulation mode does not leak across smoke scenarios.
  _executionMode = 'live';
  _replayFolder = null;
  try {
    if (typeof executionEngineAdapter.setExecutionMode === 'function') {
      executionEngineAdapter.setExecutionMode('live');
    }
  } catch (_) {
    /* swallow */
  }
}

module.exports = {
  // Public lifecycle
  start,
  stop,
  runCycle,
  getCycleStats,
  setSessionId,
  getActiveSessionId,
  // 18.1 — dry-run controls
  setExecutionMode,
  getExecutionMode,
  setReplayFolder,
  getReplayFolder,
  // Test helpers / smoke check hooks
  __resetForTest,
  __getSessionIdForTest,
  // Constants exposed for downstream consumers / tests
  UPSTREAM_SHORT_CIRCUIT_CODES,
  DEFAULT_PREDICTION_INTERVAL_MS,
  // Internal helpers exposed for unit / smoke tests so the
  // contributions builder / direction mapping can be
  // exercised without spinning up the full pipeline.
  _buildMasterScoreContributions,
  _candidateToDirection,
  _isShortCircuit,
  _applyAiScoreModulation,
};
