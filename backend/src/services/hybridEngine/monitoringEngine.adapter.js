/**
 * ============================================================
 * MONITORING_ENGINE ADAPTER (Req 15) — subtasks 15.1 + 15.2 + 15.3
 * ============================================================
 * Self-preservation monitoring loop adapter that runs on its
 * OWN cadence (`Algo_Settings.monitoringEngine.intervalSeconds
 * × 1000`), independent of the prediction-cycle loop. On every
 * tick it composes a single canonical `MonitoringSnapshot`
 * (see the JSDoc typedef in `./cycleContext.js`), persists the
 * row into `EngineEventLog`, and broadcasts the snapshot over
 * the existing `scalpingSocket` channel so the operator UI
 * receives live updates (Req 15.7).
 *
 * ------------------------------------------------------------
 * Subtask 15.1 scope (delivered)
 * ------------------------------------------------------------
 *   1. Cadence loop: `start()` / `stop()` / idempotency.
 *   2. `runMonitoringTick(input)`: per-tick snapshot assembly
 *      with the full Req 15.1 field set (`perTradePnL`,
 *      `totalLivePnL`, `pipelineLatencyMs`,
 *      `liquidityDeterioration`, `regimeChange`,
 *      `openPositions`, `exposurePct`, `riskViolations`,
 *      `aiConfidenceDecay`, `edgeDecay`).
 *   3. Persistence into `EngineEventLog` via an injected
 *      `_eventLogWriter`, defaulting to a no-op so the adapter
 *      remains testable / runnable without a Mongo connection.
 *   4. Broadcast over `scalpingSocket` via an injected
 *      `_socketBroadcaster`, defaulting to a no-op for the
 *      same reason. The orchestrator wires the real
 *      `scalpingSocket` emitter at session start.
 *   5. NEVER-throw guarantee (Req 1.5). Every public function
 *      catches its own errors and resolves to a safe-default
 *      snapshot shape with `error: true`.
 *
 * ------------------------------------------------------------
 * Subtask 15.2 scope — implemented (Req 15.3 / 15.6 / 19.7)
 * ------------------------------------------------------------
 *   - Latency-breach kill switch. `_consecutiveLatencyBreaches`
 *     increments every tick where `pipelineLatencyMs >
 *     maxLatencyMs` and resets to 0 otherwise. Once the
 *     counter hits `latencyBreachCycles`, the tick pushes
 *     `REASON_CODES.MONITORING_LATENCY_BREACH` onto the
 *     snapshot and calls `_riskEngine.requestKillSwitch({
 *     source: 'latency_breach', reason })`. The Risk_Engine
 *     side is idempotent (Req 19.6) so re-firing every tick
 *     while the breach persists is safe and audited.
 *   - Edge-decay kill switch. When the rolling win-rate window
 *     has filled (`edgeDecay.windowTrades >= edgeWindowTrades`)
 *     AND the rolling win-rate has dropped below
 *     `edgeDecayFloor`, the tick pushes
 *     `REASON_CODES.MONITORING_EDGE_DECAY` onto the snapshot
 *     and calls `_riskEngine.requestKillSwitch({ source:
 *     'edge_decay', reason })`. Idempotency on the Risk_Engine
 *     side guarantees one trigger row per session.
 *   - Risk_Engine routing only. The adapter NEVER submits
 *     execution directly. Both triggers are wrapped in
 *     try/catch — a Risk_Engine outage cannot break the
 *     monitoring loop, and the reason codes are still pushed
 *     onto the snapshot (and persisted into `EngineEventLog`)
 *     even when Risk_Engine is unavailable so the operator
 *     audit trail survives a downstream failure.
 *
 * ------------------------------------------------------------
 * Subtask 15.3 scope — implemented (Req 15.4 / 15.5)
 * ------------------------------------------------------------
 *   - Regime-change re-evaluate. When `regimeChange === true`
 *     (the Regime_Engine label transitioned this tick) AND at
 *     least one trade is open, the tick pushes
 *     `REASON_CODES.MONITORING_REGIME_CHANGED` onto the
 *     snapshot and calls `_riskEngine.requestReEvaluation({
 *     source: 'regime_change', reason, openPositions })`.
 *     Risk_Engine's queue is idempotent per-source, so a
 *     persistent regime change cannot enqueue duplicates
 *     before the orchestrator has drained the queue.
 *   - AI-confidence decay re-evaluate. When
 *     `aiConfidenceDecay === true` (an edge-transition
 *     through `confidenceDecayFloor`) AND at least one trade
 *     is open, the tick pushes
 *     `REASON_CODES.MONITORING_AI_CONFIDENCE_DECAY` and calls
 *     `_riskEngine.requestReEvaluation({ source:
 *     'ai_confidence_decay', reason, openPositions })`.
 *   - Risk_Engine retains exit decision authority. The
 *     adapter ENQUEUES re-evaluation requests; it NEVER
 *     submits exits directly (Req 15.4 / 15.5 / 19.7). The
 *     orchestrator (subtask 16.3) drains the queue via
 *     `riskEngine.consumePendingReEvaluations()` and routes
 *     each request through `monitorEngine.service.js` /
 *     Risk_Engine's exit-decision path.
 *   - "Empty open-position roster" gate. Triggers fire ONLY
 *     when `openPositions.length > 0`. A regime change or
 *     confidence decay with no live exposure has nothing to
 *     re-evaluate, so the reason code is NOT pushed and no
 *     re-evaluation is enqueued.
 *   - Risk_Engine errors are swallowed (Req 1.5). The reason
 *     code is still pushed onto the snapshot so the trigger
 *     survives in `EngineEventLog` even when Risk_Engine is
 *     unavailable.
 *
 * ------------------------------------------------------------
 * Underlying service
 * ------------------------------------------------------------
 *   - `monitorEngine.service.js`: per-open-trade EXIT/HOLD
 *     decisions. This adapter does NOT duplicate that logic —
 *     it WRAPS the service for shape normalisation and live
 *     broadcasting. Subtask 15.3 will route the regime / AI
 *     decay re-evaluations through `monitorEngine.decide` or
 *     through a new lightweight hook on Risk_Engine; that
 *     wiring is intentionally deferred.
 *
 * ------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------
 *   - `setRiskEngine(adapter)` — inject the Risk_Engine
 *     reference used by 15.2/15.3 for kill-switch / re-eval.
 *   - `setSocketBroadcaster(fn)` — inject the
 *     `scalpingSocket`-shaped emitter `(channel, payload)`.
 *   - `setEventLogWriter(fn)` — inject the persistence writer
 *     `(row) => Promise<void>`.
 *   - `start()` — start the cadence timer. Idempotent.
 *   - `stop()` — clear the cadence timer. Idempotent.
 *   - `runMonitoringTick(input)` — run one tick directly
 *     (also called by the cadence timer). Returns the emitted
 *     `MonitoringSnapshot`. NEVER throws.
 *   - `getLastSnapshot()` — read the most-recently emitted
 *     snapshot (used by 15.2/15.3 to diff regime / AI signals
 *     across ticks).
 *   - `__resetForTest()` — zero all module-level state
 *     (timer, last snapshot, latency counter, broadcaster,
 *     writer, riskEngine). Used by the smoke check.
 *
 * ------------------------------------------------------------
 * Settings reads (every value from `Algo_Settings`, Req 2.2)
 * ------------------------------------------------------------
 * All settings reads go through `_readMonitoringSettings()`
 * with documented defaults so a hot-reload picks up changes
 * on the very next tick without restart. Defaults are
 * identical to the values in `algoSettings.js` so a fresh
 * install behaves identically whether or not the operator
 * has applied a custom config.
 *
 *   - `monitoringEngine.intervalSeconds`        (default 5)
 *   - `monitoringEngine.maxLatencyMs`           (default 1500)
 *   - `monitoringEngine.latencyBreachCycles`    (default 3)
 *   - `monitoringEngine.edgeDecayFloor`         (default 0.40)
 *   - `monitoringEngine.edgeWindowTrades`       (default 20)
 *   - `monitoringEngine.confidenceDecayFloor`   (default 0.55)
 *
 * Note: the documented defaults above (e.g. `intervalSeconds=5`)
 * are the FALLBACKS this adapter applies when the settings
 * snapshot is malformed; the operator-shipped values in
 * `config/algoSettings.js` (e.g. `intervalSeconds=10`,
 * `maxLatencyMs=800`, `confidenceDecayFloor=4`) are passed
 * through verbatim when the snapshot is well-formed.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - The exported `runMonitoringTick` function NEVER throws.
 *   - The injected broadcaster / writer are wrapped in
 *     try/catch (`_emitSafe` / `_writeEventSafe`) so a Mongo
 *     outage or a Socket.io crash NEVER breaks the cadence.
 *   - On any unrecoverable error inside the body, the adapter
 *     returns the safe-default snapshot shape with
 *     `error: true` and `errorMessage` populated, and STILL
 *     attempts to broadcast / persist that error snapshot so
 *     the operator UI sees the failure live.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 3.9   — wire to `monitorEngine.service.js`
 *   - Req 15.1  — own cadence (`intervalSeconds × 1000`)
 *   - Req 15.2  — per-tick snapshot field set
 *   - Req 15.3  — latency-breach kill-switch (15.2, implemented)
 *   - Req 15.4  — regime-change re-evaluate (15.3, implemented)
 *   - Req 15.5  — AI-confidence decay re-evaluate (15.3, implemented)
 *   - Req 15.6  — edge-decay kill-switch (15.2, implemented)
 *   - Req 15.7  — `EngineEventLog` row + `scalpingSocket` live
 *                 broadcast
 *   - Req 19.7  — every survival action routes through
 *                 Risk_Engine, never direct execution
 *   - MonitoringSnapshot typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

// `monitorEngine.service.js` is the underlying per-trade
// decision-maker (Req 3.9). We `require` it up-front so a
// missing service file fails fast at module load time. The
// service is referenced (not invoked) from this subtask —
// 15.3 will route per-trade re-evaluations through
// `monitorEngine.decide`.
//
// eslint-disable-next-line no-unused-vars
const monitorEngine = require('../monitorEngine.service');

// Reason-code enum used by 15.2 (latency-breach + edge-decay
// kill switches) and 15.3 (re-evaluation requests). Pushed onto
// `MonitoringSnapshot.reasonCodes` so the audit row records
// WHICH self-preservation trigger fired this cycle (Req 15.7).
const { REASON_CODES } = require('./reasonCodes');

// ============================================================
// Documented defaults (only consulted when the corresponding
// setting is missing on the snapshot — `validateSettings`
// already enforces presence at startup / hot-reload).
// ============================================================

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_MAX_LATENCY_MS = 1500;
const DEFAULT_LATENCY_BREACH_CYCLES = 3;
const DEFAULT_EDGE_DECAY_FLOOR = 0.4;
const DEFAULT_EDGE_WINDOW_TRADES = 20;
const DEFAULT_CONFIDENCE_DECAY_FLOOR = 0.55;

// Channel name used by `_socketBroadcaster`. Mirrored in the
// smoke check; documented here so consumers know which
// `scalpingSocket` event to subscribe to.
const SOCKET_CHANNEL = 'monitoring:snapshot';

// Lazy `algoSettings` resolver. Resolved on every settings
// read so a hot-reload swap of the singleton (or a smoke-test
// stub of `require.cache`) is picked up on the very next
// tick. We intentionally do NOT cache the module-level
// reference at load time — see `aiSupport.adapter.js` for
// the same pattern and rationale.
function _algoSettings() {
  // eslint-disable-next-line global-require
  return require('../../config/algoSettings');
}

// ============================================================
// Module-level state
// ------------------------------------------------------------
// The cadence timer, the diff-state needed by 15.2/15.3, and
// the injected dependencies all live at module scope so a
// single `require('./monitoringEngine.adapter')` from the
// orchestrator gives every consumer the same canonical loop.
// Tests reset the state via `__resetForTest()`.
// ============================================================

/** @type {Object|null} */
let _riskEngine = null;

/** @type {ReturnType<typeof setInterval>|null} */
let _cadenceTimer = null;

/** @type {boolean} */
let _isRunning = false;

/** @type {import('./cycleContext').MonitoringSnapshot|null} */
let _lastSnapshot = null;

/**
 * Counter used by 15.2 for the latency-breach kill switch.
 * Initialised here so the state survives across this subtask
 * boundary; 15.2 increments / resets it inside the latency-
 * breach block in `runMonitoringTick`.
 *
 * @type {number}
 */
let _consecutiveLatencyBreaches = 0;

/** @type {(channel: string, payload: any) => void} */
let _socketBroadcaster = _noopBroadcaster;

/** @type {(row: Object) => Promise<void>|void} */
let _eventLogWriter = _noopWriter;

function _noopBroadcaster(/* channel, payload */) {
  // No-op default. Wired to the real `scalpingSocket` emitter
  // by the orchestrator at session start via
  // `setSocketBroadcaster(scalpingSocket.emitMonitoringSnapshot)`.
}

function _noopWriter(/* row */) {
  // No-op default. Wired to a Mongoose `EngineEventLog.create`
  // call by the orchestrator at session start via
  // `setEventLogWriter(...)`.
}

// ============================================================
// Defensive helpers
// ------------------------------------------------------------
// Mirror the pattern from `executionEngine.adapter.js`. Every
// snapshot field passes through one of these helpers so a
// malformed input from the Hybrid_Engine orchestrator can
// never crash the monitoring loop.
// ============================================================

/**
 * Return `true` iff `value` is a finite number. Centralised so
 * defensive guards across this adapter all read identically.
 *
 * @param {*} value
 * @returns {boolean}
 */
function _isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Return `true` iff `value` is a non-empty string. Used by the
 * regime-change diff (a missing / blank label cannot count as
 * a "change") and by reason-code emission helpers.
 *
 * @param {*} value
 * @returns {boolean}
 */
function _isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Coerce a value to a finite number, falling back to `fallback`
 * for `NaN` / `Infinity` / non-numeric inputs.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function _toFiniteNumber(value, fallback) {
  return _isFiniteNumber(value) ? value : fallback;
}

/**
 * Read the `monitoringEngine` settings group with documented
 * defaults. NEVER throws — when `algoSettings.get()` itself
 * throws (e.g. malformed snapshot), every key falls back to its
 * documented default and a `console.warn` is logged so the
 * operator can see the misconfiguration.
 *
 * @returns {{
 *   intervalSeconds: number,
 *   maxLatencyMs: number,
 *   latencyBreachCycles: number,
 *   edgeDecayFloor: number,
 *   edgeWindowTrades: number,
 *   confidenceDecayFloor: number,
 * }}
 */
function _readMonitoringSettings() {
  let snapshot = null;
  try {
    const settings = _algoSettings();
    if (settings && typeof settings.get === 'function') {
      snapshot = settings.get();
    }
  } catch (err) {
    // Defensive: a misconfigured `algoSettings` module SHOULD
    // not break monitoring. Fall back to documented defaults.
    // eslint-disable-next-line no-console
    console.warn(
      '[monitoringEngine.adapter] _readMonitoringSettings: algoSettings.get() threw; falling back to defaults',
      err && err.message,
    );
    snapshot = null;
  }
  const group = (snapshot && snapshot.monitoringEngine) || {};
  return {
    intervalSeconds: _toFiniteNumber(group.intervalSeconds, DEFAULT_INTERVAL_SECONDS),
    maxLatencyMs: _toFiniteNumber(group.maxLatencyMs, DEFAULT_MAX_LATENCY_MS),
    latencyBreachCycles: _toFiniteNumber(
      group.latencyBreachCycles,
      DEFAULT_LATENCY_BREACH_CYCLES,
    ),
    edgeDecayFloor: _toFiniteNumber(group.edgeDecayFloor, DEFAULT_EDGE_DECAY_FLOOR),
    edgeWindowTrades: _toFiniteNumber(group.edgeWindowTrades, DEFAULT_EDGE_WINDOW_TRADES),
    confidenceDecayFloor: _toFiniteNumber(
      group.confidenceDecayFloor,
      DEFAULT_CONFIDENCE_DECAY_FLOOR,
    ),
  };
}

/**
 * Strip heavy nested arrays / objects out of a snapshot before
 * persistence. Keeps the `EngineEventLog.data.payload` field
 * within reason even when an upstream consumer accidentally
 * passes a full candle map onto the input. Defensive only —
 * the canonical snapshot shape doesn't carry candles, but a
 * future caller might.
 *
 * @param {Object} snapshot
 * @returns {Object}
 */
function _redact(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const clone = { ...snapshot };
  // Defensive: never persist heavy nested arrays even if an
  // upstream consumer accidentally passes them in.
  delete clone.candles;
  delete clone.optionChain;
  return clone;
}

/**
 * Wrap `_socketBroadcaster` in try/catch so a misbehaving
 * Socket.io emitter cannot break the monitoring loop.
 *
 * @param {string} channel
 * @param {*} payload
 * @returns {void}
 */
function _emitSafe(channel, payload) {
  try {
    if (typeof _socketBroadcaster === 'function') {
      _socketBroadcaster(channel, payload);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[monitoringEngine.adapter] _emitSafe: broadcaster threw',
      err && err.message,
    );
  }
}

/**
 * Wrap `_eventLogWriter` in try/catch so a Mongo outage cannot
 * break the monitoring loop. The writer is fire-and-forget; we
 * `Promise.resolve` whatever the writer returns and swallow
 * rejections.
 *
 * @param {Object} row
 * @returns {void}
 */
function _writeEventSafe(row) {
  try {
    if (typeof _eventLogWriter === 'function') {
      const result = _eventLogWriter(row);
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            '[monitoringEngine.adapter] _writeEventSafe: writer rejected',
            err && err.message,
          );
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[monitoringEngine.adapter] _writeEventSafe: writer threw',
      err && err.message,
    );
  }
}

// ============================================================
// Public API — dependency injection
// ============================================================

/**
 * Inject the Risk_Engine reference. Called by 15.2
 * (kill-switch triggers) and 15.3 (re-evaluation requests).
 * The adapter calls `_riskEngine.requestKillSwitch(...)` for
 * latency-breach / edge-decay (15.2) and
 * `_riskEngine.requestReEvaluation(...)` for regime-change /
 * AI-confidence decay (15.3). An injected `null` /
 * malformed object is silently ignored so the cadence loop
 * still ticks even before Risk_Engine is wired.
 *
 * @param {Object|null} adapter  Risk_Engine adapter module.
 * @returns {void}
 */
function setRiskEngine(adapter) {
  if (adapter === null || adapter === undefined) {
    _riskEngine = null;
    return;
  }
  // We accept any object — Risk_Engine's full API surface is
  // validated lazily in 15.2/15.3 when the methods are
  // actually called. This mirrors the lenient injection
  // pattern used by the other adapters' `set*` helpers.
  if (typeof adapter !== 'object') return;
  _riskEngine = adapter;
}

/**
 * Inject the socket broadcaster `(channel, payload) => void`.
 * Falls back to a no-op when `fn` is not callable, so a
 * misconfigured orchestrator cannot break the loop.
 *
 * @param {(channel: string, payload: any) => void} fn
 * @returns {void}
 */
function setSocketBroadcaster(fn) {
  _socketBroadcaster = typeof fn === 'function' ? fn : _noopBroadcaster;
}

/**
 * Inject the event-log writer `(row) => Promise<void>|void`.
 * Falls back to a no-op when `fn` is not callable.
 *
 * @param {(row: Object) => Promise<void>|void} fn
 * @returns {void}
 */
function setEventLogWriter(fn) {
  _eventLogWriter = typeof fn === 'function' ? fn : _noopWriter;
}

// ============================================================
// Public API — cadence lifecycle
// ============================================================

/**
 * Start the monitoring cadence loop. Reads
 * `monitoringEngine.intervalSeconds` once at start time and
 * sets a `setInterval` for `intervalSeconds × 1000` ms. The
 * interval handler invokes `runMonitoringTick(undefined)` so
 * the orchestrator can rely on the no-input default branch.
 *
 * Idempotent: a second `start()` while the loop is already
 * running returns `{ started: false, reason: 'ALREADY_RUNNING' }`
 * without rotating the timer.
 *
 * @returns {{ started: boolean, reason?: string, intervalMs?: number }}
 */
function start() {
  if (_isRunning === true && _cadenceTimer !== null) {
    return { started: false, reason: 'ALREADY_RUNNING' };
  }
  const settings = _readMonitoringSettings();
  const intervalMs = Math.max(1, Math.floor(settings.intervalSeconds * 1000));
  _cadenceTimer = setInterval(() => {
    // The cadence timer NEVER awaits the tick — `runMonitoringTick`
    // is fire-and-forget. The function never throws, so we don't
    // need a `.catch` here. Returning the promise from the
    // interval callback would be a footgun (the Node.js timer
    // pool ignores it).
    runMonitoringTick();
  }, intervalMs);
  _isRunning = true;
  return { started: true, intervalMs };
}

/**
 * Stop the monitoring cadence loop. Idempotent: a `stop()` on
 * a stopped loop is a no-op.
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
  return { stopped: true };
}

// ============================================================
// Public API — tick body
// ============================================================

/**
 * @typedef {Object} MonitoringTickInput
 * Shape consumed by the orchestrator (subtask 16.3) when it
 * feeds the latest monitoring inputs into a tick.
 *
 * @property {number}        [pipelineLatencyMs]      Most recent prediction-cycle latency.
 * @property {Array<Object>} [openPositions]          Roster of currently-open trades.
 * @property {Array<Object>} [perTradePnL]            Per-open-trade signed ₹ PnL summaries.
 * @property {number}        [totalLivePnL]           Sum of `perTradePnL`.
 * @property {number}        [exposurePct]            Σ notional / capital ∈ [0, 1+].
 * @property {Object}        [liquidityHealth]        `{ healthy: boolean, ... }` from Liquidity_Engine.
 * @property {boolean}       [liquidityDeterioration] Direct flag from upstream (overrides derivation).
 * @property {string}        [regimeLabel]            Pass-through Regime_Engine label.
 * @property {number}        [aiConfidence]           Pass-through AI confidence 0..10.
 * @property {Object}        [edge]                   `{ rollingWinRate: number, windowTrades: number }`.
 * @property {Array<string>} [riskViolations]         Risk-layer breach flags.
 */

/**
 * Run a single monitoring tick. Composes a `MonitoringSnapshot`,
 * persists it via `_eventLogWriter`, broadcasts via
 * `_socketBroadcaster`, updates `_lastSnapshot`, and returns
 * the snapshot. NEVER throws — on any unrecoverable error
 * resolves to a safe-default snapshot with `error: true`.
 *
 * Subtasks 15.2 and 15.3 inject their kill-switch and
 * re-evaluation calls inside this function (Req 15.3 / 15.4 /
 * 15.5 / 15.6).
 *
 * @param {MonitoringTickInput} [input]
 * @returns {import('./cycleContext').MonitoringSnapshot}
 */
function runMonitoringTick(input) {
  const tickAtIso = new Date().toISOString();
  try {
    const settings = _readMonitoringSettings();
    const safeInput = input && typeof input === 'object' ? input : {};

    // ---- Field assembly (Req 15.1 / 15.2) -----------------
    const perTradePnL = Array.isArray(safeInput.perTradePnL) ? safeInput.perTradePnL : [];
    const totalLivePnL = _toFiniteNumber(safeInput.totalLivePnL, 0);
    const pipelineLatencyMs = _toFiniteNumber(safeInput.pipelineLatencyMs, 0);

    // Liquidity deterioration: prefer the explicit flag when
    // supplied; otherwise derive from `liquidityHealth.healthy`.
    let liquidityDeterioration = false;
    if (typeof safeInput.liquidityDeterioration === 'boolean') {
      liquidityDeterioration = safeInput.liquidityDeterioration;
    } else if (
      safeInput.liquidityHealth &&
      typeof safeInput.liquidityHealth === 'object' &&
      safeInput.liquidityHealth.healthy === false
    ) {
      liquidityDeterioration = true;
    }

    // Regime change: TRUE iff the previous tick recorded a
    // different non-empty label. The very first tick always
    // emits `false` because there's no prior state to diff.
    const regimeLabel = _isNonEmptyString(safeInput.regimeLabel)
      ? safeInput.regimeLabel
      : null;
    let regimeChange = false;
    if (
      _lastSnapshot &&
      _isNonEmptyString(_lastSnapshot.regimeLabel) &&
      _isNonEmptyString(regimeLabel) &&
      _lastSnapshot.regimeLabel !== regimeLabel
    ) {
      regimeChange = true;
    }

    const openPositions = Array.isArray(safeInput.openPositions)
      ? safeInput.openPositions
      : [];
    const exposurePct = _toFiniteNumber(safeInput.exposurePct, 0);
    const riskViolations = Array.isArray(safeInput.riskViolations)
      ? safeInput.riskViolations.filter(_isNonEmptyString)
      : [];

    // AI confidence decay: TRUE on the TRANSITION cycle when
    // confidence drops below the floor (Req 15.5). A decayed
    // value that stays below the floor across consecutive
    // ticks emits `false` after the first transition — the
    // operator UI treats this as an edge-trigger rather than
    // a level-trigger so repeated emails / alerts don't
    // flood the audit log.
    const aiConfidence = _isFiniteNumber(safeInput.aiConfidence)
      ? safeInput.aiConfidence
      : null;
    let aiConfidenceDecay = false;
    if (
      aiConfidence !== null &&
      aiConfidence < settings.confidenceDecayFloor &&
      _lastSnapshot &&
      _isFiniteNumber(_lastSnapshot.aiConfidence) &&
      _lastSnapshot.aiConfidence >= settings.confidenceDecayFloor
    ) {
      aiConfidenceDecay = true;
    }

    // Edge decay block. The full kill-switch trigger lives in
    // 15.2; today we just propagate the rolling stats so the
    // operator UI can chart them.
    const edgeInput =
      safeInput.edge && typeof safeInput.edge === 'object' ? safeInput.edge : {};
    const edgeDecay = {
      rollingWinRate: _toFiniteNumber(edgeInput.rollingWinRate, 1.0),
      windowTrades: _toFiniteNumber(edgeInput.windowTrades, 0),
    };

    // Reason codes: the canonical lift-via-`appendBlock` pattern
    // requires every block to carry its own `reasonCodes` array
    // even when empty. 15.2 pushes `MONITORING_LATENCY_BREACH`
    // / `MONITORING_EDGE_DECAY`; 15.3 pushes
    // `MONITORING_REGIME_CHANGED` / `MONITORING_AI_CONFIDENCE_DECAY`.
    const reasonCodes = [];

    // ---- 15.2: kill-switch triggers (Req 15.3 / 15.6) -----
    // Both triggers route through Risk_Engine and are
    // idempotent on the Risk_Engine side (preserves the FIRST
    // trigger), so re-firing every tick while the breach
    // persists is safe and audited. Risk_Engine errors are
    // swallowed — the reason code is still pushed onto the
    // snapshot so the breach is recorded in `EngineEventLog`
    // even when Risk_Engine itself is unavailable (Req 1.5).

    // (a) Latency breach — `pipelineLatencyMs >
    //     settings.maxLatencyMs` for `latencyBreachCycles`
    //     consecutive ticks. We bump / reset the counter
    //     before testing the threshold so the very tick that
    //     hits `latencyBreachCycles` fires the kill switch
    //     rather than waiting for the next one.
    if (pipelineLatencyMs > settings.maxLatencyMs) {
      _consecutiveLatencyBreaches += 1;
    } else {
      _consecutiveLatencyBreaches = 0;
    }
    if (_consecutiveLatencyBreaches >= settings.latencyBreachCycles) {
      reasonCodes.push(REASON_CODES.MONITORING_LATENCY_BREACH);
      if (_riskEngine && typeof _riskEngine.requestKillSwitch === 'function') {
        try {
          _riskEngine.requestKillSwitch({
            source: 'latency_breach',
            reason:
              'latency ' +
              pipelineLatencyMs +
              'ms > ' +
              settings.maxLatencyMs +
              'ms for ' +
              _consecutiveLatencyBreaches +
              ' cycles',
            triggeredAt: Date.now(),
          });
        } catch (riskErr) {
          // eslint-disable-next-line no-console
          console.error(
            '[monitoringEngine.adapter] requestKillSwitch(latency_breach) threw',
            riskErr && riskErr.message,
          );
        }
      }
    }

    // (b) Edge decay — rolling win-rate over the configured
    //     window has dropped below the floor. Guard on
    //     `windowTrades >= edgeWindowTrades` so we never fire
    //     during the early-session ramp-up while the rolling
    //     window is still being filled.
    if (
      edgeDecay.windowTrades >= settings.edgeWindowTrades &&
      edgeDecay.rollingWinRate < settings.edgeDecayFloor
    ) {
      reasonCodes.push(REASON_CODES.MONITORING_EDGE_DECAY);
      if (_riskEngine && typeof _riskEngine.requestKillSwitch === 'function') {
        try {
          _riskEngine.requestKillSwitch({
            source: 'edge_decay',
            reason:
              'winRate ' +
              edgeDecay.rollingWinRate +
              ' < floor ' +
              settings.edgeDecayFloor +
              ' over ' +
              edgeDecay.windowTrades +
              ' trades',
            triggeredAt: Date.now(),
          });
        } catch (riskErr) {
          // eslint-disable-next-line no-console
          console.error(
            '[monitoringEngine.adapter] requestKillSwitch(edge_decay) threw',
            riskErr && riskErr.message,
          );
        }
      }
    }

    // ---- 15.3: re-evaluation requests (Req 15.4 / 15.5) --
    // Both triggers route through Risk_Engine via
    // `requestReEvaluation`. Risk_Engine retains exit decision
    // authority — Monitoring_Engine MUST NOT submit exits
    // directly. Risk_Engine errors are swallowed; the reason
    // code is still pushed onto the snapshot so the trigger is
    // recorded in `EngineEventLog` even when Risk_Engine is
    // unavailable (Req 1.5).

    // (a) Regime-change re-evaluate. Triggers only when the
    //     label transitioned this tick AND at least one trade
    //     is open — a regime change with no live exposure has
    //     nothing to re-evaluate.
    if (regimeChange === true && openPositions.length > 0) {
      reasonCodes.push(REASON_CODES.MONITORING_REGIME_CHANGED);
      if (_riskEngine && typeof _riskEngine.requestReEvaluation === 'function') {
        try {
          const previousLabel =
            _lastSnapshot && _isNonEmptyString(_lastSnapshot.regimeLabel)
              ? _lastSnapshot.regimeLabel
              : '';
          _riskEngine.requestReEvaluation({
            source: 'regime_change',
            reason:
              'regime ' +
              previousLabel +
              ' \u2192 ' +
              regimeLabel +
              ' with ' +
              openPositions.length +
              ' open position(s)',
            openPositions,
            requestedAt: Date.now(),
          });
        } catch (riskErr) {
          // eslint-disable-next-line no-console
          console.error(
            '[monitoringEngine.adapter] requestReEvaluation(regime_change) threw',
            riskErr && riskErr.message,
          );
        }
      }
    }

    // (b) AI-confidence decay re-evaluate. Triggers on the
    //     edge transition through `confidenceDecayFloor` while
    //     ≥ 1 trade is open — a confidence drop with no live
    //     exposure has nothing to re-evaluate.
    if (aiConfidenceDecay === true && openPositions.length > 0) {
      reasonCodes.push(REASON_CODES.MONITORING_AI_CONFIDENCE_DECAY);
      if (_riskEngine && typeof _riskEngine.requestReEvaluation === 'function') {
        try {
          _riskEngine.requestReEvaluation({
            source: 'ai_confidence_decay',
            reason:
              'AI confidence ' +
              aiConfidence +
              ' < floor ' +
              settings.confidenceDecayFloor +
              ' with ' +
              openPositions.length +
              ' open position(s)',
            openPositions,
            requestedAt: Date.now(),
          });
        } catch (riskErr) {
          // eslint-disable-next-line no-console
          console.error(
            '[monitoringEngine.adapter] requestReEvaluation(ai_confidence_decay) threw',
            riskErr && riskErr.message,
          );
        }
      }
    }

    /** @type {import('./cycleContext').MonitoringSnapshot} */
    const snapshot = {
      tickAt: tickAtIso,
      perTradePnL,
      totalLivePnL,
      pipelineLatencyMs,
      liquidityDeterioration,
      regimeChange,
      regimeLabel,
      openPositions,
      exposurePct,
      riskViolations,
      aiConfidenceDecay,
      aiConfidence,
      edgeDecay,
      reasonCodes,
      error: false,
    };

    // Persist + broadcast. Both helpers are fail-safe — a Mongo
    // outage / Socket.io crash never propagates back into the
    // cadence loop. The persisted row uses the design's
    // `MONITORING_SNAPSHOT` event-type discriminator (Req 15.7);
    // the orchestrator's `_eventLogWriter` is responsible for
    // mapping that onto `EngineEventLog.eventType` via the
    // existing `auditLog.js` pattern.
    _writeEventSafe({
      type: 'MONITORING_SNAPSHOT',
      tickAt: tickAtIso,
      payload: _redact(snapshot),
    });
    _emitSafe(SOCKET_CHANNEL, snapshot);

    _lastSnapshot = snapshot;
    return snapshot;
  } catch (err) {
    // NEVER throw (Req 1.5). Build a safe-default error
    // snapshot, attempt to broadcast / persist it, and return.
    // eslint-disable-next-line no-console
    console.error(
      '[monitoringEngine.adapter] runMonitoringTick: tick body threw',
      err && err.message,
    );
    /** @type {import('./cycleContext').MonitoringSnapshot} */
    const errorSnapshot = {
      tickAt: tickAtIso,
      perTradePnL: [],
      totalLivePnL: 0,
      pipelineLatencyMs: 0,
      liquidityDeterioration: false,
      regimeChange: false,
      regimeLabel: null,
      openPositions: [],
      exposurePct: 0,
      riskViolations: [],
      aiConfidenceDecay: false,
      aiConfidence: null,
      edgeDecay: { rollingWinRate: 1.0, windowTrades: 0 },
      reasonCodes: [],
      error: true,
      errorMessage: err && err.message ? String(err.message) : 'unknown error',
    };
    // Best-effort persist / broadcast even on the error path so
    // the operator UI sees the failure live.
    _writeEventSafe({
      type: 'MONITORING_SNAPSHOT',
      tickAt: tickAtIso,
      payload: _redact(errorSnapshot),
    });
    _emitSafe(SOCKET_CHANNEL, errorSnapshot);
    _lastSnapshot = errorSnapshot;
    return errorSnapshot;
  }
}

/**
 * Read the most-recently emitted snapshot. Used by 15.2 / 15.3
 * to diff regime / AI signals across ticks. Returns `null`
 * before the first tick has been emitted.
 *
 * @returns {import('./cycleContext').MonitoringSnapshot|null}
 */
function getLastSnapshot() {
  return _lastSnapshot;
}

// ============================================================
// Test helpers
// ============================================================

/**
 * Reset every module-level state field. Used by smoke /
 * property tests so each scenario starts from a clean slate
 * without the test having to know the field shape.
 *
 * @returns {void}
 */
function __resetForTest() {
  if (_cadenceTimer !== null) {
    clearInterval(_cadenceTimer);
    _cadenceTimer = null;
  }
  _isRunning = false;
  _lastSnapshot = null;
  _consecutiveLatencyBreaches = 0;
  _riskEngine = null;
  _socketBroadcaster = _noopBroadcaster;
  _eventLogWriter = _noopWriter;
}

/**
 * Test-only inspector for the running state. Exposed so smoke
 * checks can assert idempotent `start()` behaviour without
 * digging into `setInterval` internals.
 *
 * @returns {{ isRunning: boolean, hasTimer: boolean, consecutiveLatencyBreaches: number }}
 */
function __getInternalStateForTest() {
  return {
    isRunning: _isRunning,
    hasTimer: _cadenceTimer !== null,
    consecutiveLatencyBreaches: _consecutiveLatencyBreaches,
  };
}

module.exports = {
  // Dependency injection
  setRiskEngine,
  setSocketBroadcaster,
  setEventLogWriter,
  // Cadence lifecycle
  start,
  stop,
  // Tick body
  runMonitoringTick,
  getLastSnapshot,
  // Constants exposed for downstream consumers / tests
  SOCKET_CHANNEL,
  // Test helpers
  __resetForTest,
  __getInternalStateForTest,
};
