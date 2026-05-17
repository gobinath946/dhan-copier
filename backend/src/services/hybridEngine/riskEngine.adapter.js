/**
 * ============================================================
 * RISK_ENGINE ADAPTER (Req 12) — subtasks 12.1 + 12.3 + 12.6 + 12.8
 * ============================================================
 * Survival-layer adapter that turns a fully-populated
 * `CycleContext` (data / regime / structure / liquidity / oi /
 * pcr / signal already present) into a single canonical
 * `RiskDecision` block (see the JSDoc typedef in
 * `cycleContext.js`). The orchestrator threads the result back
 * into `ctx` via `appendBlock(ctx, 'risk', decision)`, which
 * lifts `decision.reasonCodes` onto the top-level audit trail.
 *
 * ------------------------------------------------------------
 * Subtask 12.1 scope (already delivered)
 * ------------------------------------------------------------
 *   1. SL formula per Req 12.5:
 *        stopLossPoints = min(maxSLPoints,
 *                             max(fixedSLPoints,
 *                                 atrSLMultiplier × ATR))
 *   2. RISK_INVALID_SL guard (Req 12.7).
 *   3. RISK_PER_TRADE_RISK_OOR guard (Req 12.1).
 *   4. Sizing formula (Req 12.6).
 *   5. RR / target derivation (Req 8.1.12 / 9.1.12).
 *   6. Trailing-SL params block (Req 12.9).
 *
 * ------------------------------------------------------------
 * Subtask 12.3 scope (this delivery)
 * ------------------------------------------------------------
 *   1. Module-level `RISK_STATE` carrying the per-session
 *      survival counters (Req 12.2 / 12.3 / 12.10 / 12.11).
 *   2. Daily-loss cap gate (Req 12.3) — `RISK_DAILY_LOSS_EXCEEDED`.
 *   3. Exposure cap gate (Req 12.11) — `RISK_EXPOSURE_EXCEEDED`.
 *   4. Cooldown gate (Req 12.10) — `RISK_COOLDOWN_ACTIVE`.
 *   5. IST 00:00 daily reset (Req 12.2).
 *   6. Max-hold scan helper (Req 12.8): `checkMaxHoldExits`
 *      returns the list of `{ tradeId, reason: 'MAX_HOLD' }`
 *      exit-requests so the orchestrator can submit the
 *      market exit via `professionalExitManager.service.js`.
 *      The adapter intentionally DOES NOT submit those orders
 *      directly — keeping the adapter pure-deterministic and
 *      executor-free is consistent with the other stage
 *      adapters and is documented below.
 *
 * ------------------------------------------------------------
 * Subtask 12.6 scope (this delivery)
 * ------------------------------------------------------------
 *   1. Auto-trigger from consecutive losses (Req 12.4):
 *      `evaluateRisk` checks `consecutiveLosses ≥
 *      consecutiveLossKill` BEFORE the gate ordering and, if
 *      tripped, calls `requestKillSwitch({ source:
 *      'consecutive_loss', ... })`. We chose this site over
 *      `recordTradeClose` so `recordTradeClose` stays
 *      settings-free; the transition still fires at the next
 *      cycle boundary (which is the boundary that matters —
 *      we only need `killSwitch=true` BEFORE the next entry
 *      attempt is evaluated).
 *   2. External triggers (Req 15.3 / 15.6): exported
 *      `requestKillSwitch({ source, reason })` accepts
 *      `'consecutive_loss' | 'latency_breach' | 'edge_decay' |
 *      'manual'`. Idempotent — calling again while the
 *      switch is already true preserves the original trigger.
 *   3. Operator-only clear (Req 12.4 / 19.6): exported
 *      `clearKillSwitch({ operatorAction })`. Refuses to clear
 *      unless `operatorAction` is a non-empty object. No
 *      automated path can flip `killSwitch` back to false —
 *      this is the kill-switch monotonicity invariant
 *      enforced by Req 19.6.
 *   4. Highest-priority survival gate: when
 *      `killSwitch === true`, `evaluateRisk` returns
 *      `blockReason: 'KILL_SWITCH'` with reason code
 *      `RISK_KILL_SWITCH` BEFORE every other survival-layer
 *      gate. The kill switch is the single hardest gate.
 *
 * ------------------------------------------------------------
 * Subtask 12.8 scope (this delivery)
 * ------------------------------------------------------------
 *   1. Module-level `MODULE_SESSION_ID` set by the orchestrator
 *      via `setSessionId({ sessionId })` at session start.
 *      When unset (e.g. smoke checks, dry runs) every persist
 *      call is a no-op.
 *   2. `persistRiskState({ sessionId })` — serialises
 *      `RISK_STATE` (excluding `openTrades`, see below) into
 *      `ScalpingSession.payload.riskState` so the survival-
 *      layer counters survive an in-process restart within a
 *      session (Req 12.12). Fire-and-forget — wrapped in
 *      try/catch so a Mongo failure NEVER throws into the
 *      orchestrator hot path (Req 1.5).
 *   3. `restoreRiskState({ sessionId })` — loads
 *      `payload.riskState` and merges the persisted fields
 *      back into `RISK_STATE`. `openTrades` is intentionally
 *      NOT in the persisted set: open positions are sourced
 *      from the `ScalpingTrade` collection by the orchestrator
 *      so a single source of truth governs the open-roster.
 *   4. Auto-persist hooks: `recordTradeClose`,
 *      `requestKillSwitch`, and `clearKillSwitch` each
 *      fire-and-forget `persistRiskState({ sessionId:
 *      MODULE_SESSION_ID })` after their state mutation.
 *      `recordTradeOpen` / `recordTradeExit` do NOT persist —
 *      open-roster lives in `ScalpingTrade` per the scoping
 *      decision above.
 *   5. PnL math: `recordTradeClose({ pnl, outcome, closedAt })`
 *      keeps its existing signature so the orchestrator and
 *      smoke scripts continue to call it unchanged. The
 *      orchestrator (subtask 16) is responsible for invoking
 *      `plCalculation.calculateFinalPL(tradeExecutionId,
 *      exitPremium)` BEFORE calling `recordTradeClose`, and
 *      passing the resulting `data.totalPL` as the `pnl`
 *      argument. Centralising PnL math in
 *      `plCalculation.service.js` avoids divergence between
 *      the survival-layer counter and the persisted
 *      `TradePLRecord` rows.
 *
 * ------------------------------------------------------------
 * EXPLICITLY OUT OF SCOPE (deferred)
 * ------------------------------------------------------------
 *   - Per-account lot allocation hand-off through the cycle
 *     context. The orchestrator will pass `{ accounts,
 *     premium, lotSize }` in subtask 16. The hand-off site is
 *     marked with a `TODO 16` comment in `evaluateRisk`.
 *
 * ------------------------------------------------------------
 * Daily-loss threshold choice
 * ------------------------------------------------------------
 * Req 12.3 says cumulative loss "between dailyMaxLossPctMin
 * and dailyMaxLossPctMax" blocks all new entries. The exact
 * tripping point is left to the operator. We adopt the
 * conservative "outer envelope" reading also used by the
 * design's Property 13:
 *
 *   block when |realizedPnL| / sessionStartCapital × 100
 *              ≥ riskEngine.dailyMaxLossPctMax
 *
 * `dailyMaxLossPctMax` is the documented hard circuit-breaker
 * (default 3.0%). The `dailyMaxLossPctMin` value is the
 * defensive shoulder reported by Monitoring_Engine for early
 * warning; it does not appear in any block decision in this
 * adapter. If a future operator wants the tighter
 * `dailyMaxLossPctMin` cap to block first, the threshold
 * variable in `evaluateDailyLossGate` is the single point of
 * change.
 *
 * ------------------------------------------------------------
 * Inputs from `ctx`
 * ------------------------------------------------------------
 *   - `ctx.signal.candidate`                ('LONG_SETUP' /
 *                                            'SHORT_SETUP' /
 *                                            'NO_TRADE'). Only
 *                                            the first two
 *                                            invoke the SL /
 *                                            sizing math.
 *   - `ctx.regime.positionSizingMultiplier` — multiplied into
 *                                            position size.
 *   - `ctx.data.spot.ltp`                   — entry proxy.
 *   - `ctx.data.candles.spot[signalTimeframe]` — for ATR(14).
 *
 * ------------------------------------------------------------
 * Settings reads (every value from `Algo_Settings`, Req 2.2)
 * ------------------------------------------------------------
 *   - `riskEngine.fixedSLPoints`
 *   - `riskEngine.atrSLMultiplier`
 *   - `riskEngine.maxSLPoints`
 *   - `riskEngine.perTradeRiskPctMin`
 *   - `riskEngine.perTradeRiskPctMax`
 *   - `riskEngine.dailyMaxLossPctMax`           (12.3)
 *   - `riskEngine.maxConcurrentExposurePct`     (12.3)
 *   - `riskEngine.cooldownSecondsAfterLoss`     (12.3)
 *   - `riskEngine.cooldownSecondsAfterWin`      (12.3)
 *   - `riskEngine.maxHoldSecondsScalp`          (12.3)
 *   - `riskEngine.maxHoldSecondsSwing`          (12.3)
 *   - `riskEngine.consecutiveLossKill`          (12.6)
 *   - `riskEngine.enableTrailingSL`
 *   - `signalEngine.minRR`            (RR floor; target = SL × minRR)
 *   - `signalEngine.long.signalTimeframe` /
 *     `signalEngine.short.signalTimeframe` (ATR series source)
 *   - `lotSize`                       (legacy flat key — used
 *                                      for notional fallback;
 *                                      see "Notional sourcing")
 *   - `capital`                       (legacy flat key — see
 *                                      "Capital sourcing" note)
 *
 * ------------------------------------------------------------
 * Capital sourcing (deliberate documented fallback)
 * ------------------------------------------------------------
 * The Hybrid_Engine spec does not yet introduce a scoped
 * `riskEngine.capital`. Daily-loss / exposure gates use the
 * `RISK_STATE.sessionStartCapital` set by `initSessionState`;
 * the SL-and-sizing math reads the legacy flat
 * `settings.capital` for the raw sizing formula. The
 * CANONICAL per-account capital used by `lotAllocation.service.js`
 * is owned by that module and read off the account roster — this
 * adapter does not duplicate that logic.
 *
 * ------------------------------------------------------------
 * Notional sourcing
 * ------------------------------------------------------------
 * Open-trade notional drives the exposure cap. The adapter
 * accepts EITHER a precomputed `trade.notional` field (the
 * preferred shape because it lets the orchestrator account
 * for any per-account sizing rounding) OR derives it from
 * `trade.premium × trade.lots × (trade.lotSize ?? settings.lotSize ?? 65)`.
 * 65 is the documented NIFTY lot size in `algoSettings.js`.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - The function never throws.
 *   - Underlying service calls (`lotAllocation.allocateLots`)
 *     are wrapped in try/catch.
 *   - On any unrecoverable error the adapter returns the safe-
 *     default block-shape: `allowEntry: false`,
 *     `blockReason: 'INVALID_SL'`, the corresponding reason
 *     code, and zeroed numeric fields — guaranteeing the
 *     downstream short-circuit to NO_TRADE.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 3.6   — wire to `professionalExitManager.service.js`
 *                 + `lotAllocation.service.js` + `plCalculation.service.js`
 *   - Req 12.1  — per-trade risk in `[perTradeRiskPctMin,
 *                 perTradeRiskPctMax]`; OOR ⇒ block + error
 *   - Req 12.2  — daily counters reset at 00:00 IST session
 *                 boundary
 *   - Req 12.3  — daily-loss cap blocks every new entry for
 *                 the rest of the session
 *   - Req 12.4  — Kill_Switch trips on `consecutiveLossKill`
 *                 consecutive losses; only an operator action
 *                 can clear it
 *   - Req 12.5  — SL formula and `maxSLPoints` cap
 *   - Req 12.6  — sizing formula and lot-allocation hand-off
 *   - Req 12.7  — SL ≤ 0 / non-finite ⇒ block, no allocation
 *   - Req 12.8  — max-hold scalp/swing market-exit submission
 *   - Req 12.9  — trailing SL via professionalExitManager
 *   - Req 12.10 — post-trade cooldown
 *   - Req 12.11 — exposure cap
 *   - Req 15.3  — Monitoring_Engine triggers Kill_Switch on
 *                 sustained latency breach
 *   - Req 15.6  — Monitoring_Engine triggers Kill_Switch on
 *                 edge decay
 *   - Req 19.6  — kill-switch monotonicity invariant: once
 *                 set within a session, no automated path
 *                 SHALL clear it
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const { REASON_CODES } = require('./reasonCodes');
const lotAllocation = require('../lotAllocation.service');
const ScalpingSession = require('../../models/ScalpingSession');
// `professionalExitManager.service.js` is referenced for trailing
// SL wiring per Req 12.9. The adapter does not invoke its
// `analyzeExit` AI path (that is the Monitoring_Engine's job);
// it only echoes the trailing parameters that the exit manager
// consumes when the position is already open.
// eslint-disable-next-line no-unused-vars
const professionalExitManager = require('../professionalExitManager.service');
// `plCalculation.service.js` is the canonical PnL calculator
// (Req 3.6). The orchestrator (subtask 16) is responsible for
// calling `plCalculation.calculateFinalPL(...)` on every trade
// exit and passing the resulting total PnL into
// `recordTradeClose({ pnl, ... })`. We import the module here
// to:
//   1. document the dependency at the top of the file (Req 3.6),
//   2. make the import a hard requirement so a missing service
//      file fails fast at load time rather than silently
//      bypassing PnL on every close.
// The reference is consumed by a `void plCalculation` in
// `recordTradeClose` so static analysers do not flag it.
const plCalculation = require('../plCalculation.service');

// ============================================================
// Module-level RISK_STATE (Req 12.2 / 12.3 / 12.10 / 12.11)
// ============================================================
//
// Stage adapters are normally pure functions of `(ctx, settings)`,
// but the survival layer is inherently STATEFUL: cumulative loss,
// last-trade timestamp, and open-trade list must persist across
// cycles. The state lives at module scope so any consumer that
// `require()`s this module reads the same canonical risk state.
//
// The orchestrator (subtask 16) drives the lifecycle:
//   - calls `initSessionState({...})` at session start,
//   - calls `recordTradeOpen({ trade })` on every fill,
//   - calls `recordTradeClose({ pnl, outcome, closedAt })` on every exit,
//   - reads `getRiskState()` for monitoring snapshots.
//
// Tests reset the state via `__resetRiskStateForTest()`.
//
// Subtask 12.8 serialises this object (excluding `openTrades`)
// into `ScalpingSession.payload.riskState` so the values
// survive an in-process restart within a session. The persist
// hooks live inside `recordTradeClose`, `requestKillSwitch`,
// and `clearKillSwitch` and are gated on `MODULE_SESSION_ID`
// being set via `setSessionId({ sessionId })`. See the 12.8
// scope block in the file header for the full lifecycle.

/**
 * @typedef {Object} OpenTradeRecord
 * @property {string} id
 * @property {('scalp'|'swing')} type        Drives max-hold timer.
 * @property {('LONG'|'SHORT')} [side]
 * @property {number} openedAt               Epoch ms.
 * @property {number} [premium]              Per-lot option premium at entry.
 * @property {number} [lots]                 Number of lots.
 * @property {number} [lotSize]              Per-lot quantity (default 65).
 * @property {number} [notional]             Pre-computed notional; preferred.
 */

/**
 * @typedef {Object} KillSwitchTrigger
 * @property {('consecutive_loss'|'latency_breach'|'edge_decay'|'manual')} source
 *   Origin of the request that flipped `killSwitch` to true.
 * @property {string} reason                 Free-text audit label.
 * @property {number} triggeredAt            Epoch ms.
 */

/**
 * @typedef {Object} ReEvaluationRequest
 * @property {('regime_change'|'ai_confidence_decay'|'manual')} source
 *   Origin of the re-evaluation request (Req 15.4 / 15.5).
 * @property {string} reason                 Free-text audit label.
 * @property {Array<Object>} openPositions   Snapshot of the open-trade roster
 *                                           the orchestrator should re-evaluate.
 * @property {number} requestedAt            Epoch ms.
 * @property {boolean} processed             Set to `true` once
 *                                           `consumePendingReEvaluations` has
 *                                           drained this record. Pre-drain
 *                                           records remain `false`.
 */

/**
 * @typedef {Object} RiskState
 * @property {number|null} sessionStartedAtIST   Epoch ms of the active IST 00:00 boundary.
 * @property {number|null} sessionStartCapital   Capital snapshot at session start (₹).
 * @property {number}      realizedPnL           Cumulative ₹ PnL since session start.
 * @property {number}      consecutiveLosses     Running count for Kill_Switch (Req 12.4 / 12.6).
 * @property {boolean}     killSwitch            Monotonic flag (Req 12.4 / 12.6 / 19.6).
 * @property {KillSwitchTrigger|null} killSwitchTrigger  Origin of the active kill switch (null when cleared).
 * @property {number|null} lastTradeClosedAt     Epoch ms of last trade close (cooldown anchor).
 * @property {('win'|'loss'|null)} lastTradeOutcome   Selects which cooldown applies.
 * @property {Array<OpenTradeRecord>} openTrades  Open-trade roster for exposure / max-hold.
 * @property {Array<ReEvaluationRequest>} pendingReEvaluations
 *   Transient queue of re-evaluation requests enqueued by
 *   `requestReEvaluation` (Req 15.4 / 15.5). Drained by the
 *   orchestrator each cycle via `consumePendingReEvaluations()`;
 *   intentionally NOT persisted (per-cycle ephemera).
 */

/** @type {RiskState} */
let RISK_STATE = createInitialRiskState();

/**
 * Build a fresh, zeroed risk-state object. Centralised so
 * `__resetRiskStateForTest` and `initSessionState` agree on the
 * canonical shape.
 *
 * @returns {RiskState}
 */
function createInitialRiskState() {
  return {
    sessionStartedAtIST: null,
    sessionStartCapital: null,
    realizedPnL: 0,
    consecutiveLosses: 0,
    killSwitch: false,
    killSwitchTrigger: null,
    lastTradeClosedAt: null,
    lastTradeOutcome: null,
    openTrades: [],
    pendingReEvaluations: [],
  };
}

/**
 * Test-only helper. Zeros every field of the module-level risk
 * state. Used by smoke / property tests so each scenario starts
 * from a clean slate without the test having to know the field
 * shape.
 *
 * @returns {void}
 */
function __resetRiskStateForTest() {
  RISK_STATE = createInitialRiskState();
  MODULE_SESSION_ID = null;
}

// ============================================================
// Module-level session id (12.8)
// ============================================================
//
// The orchestrator (subtask 16) calls `setSessionId({ sessionId })`
// once at session start, after `initSessionState`. Persisting the
// id at module scope lets the survival-layer mutators
// (`recordTradeClose`, `requestKillSwitch`, `clearKillSwitch`)
// auto-persist without each call site having to thread the id —
// keeping their existing signatures unchanged so the smoke
// scripts and the orchestrator do not need to re-plumb every
// helper.
//
// When `MODULE_SESSION_ID` is null (smoke checks, dry runs,
// the brief window between `initSessionState` and
// `setSessionId`), the auto-persist hooks short-circuit. Tests
// reset it via `__resetRiskStateForTest`.

/** @type {string|null} */
let MODULE_SESSION_ID = null;

/**
 * Set the active `ScalpingSession._id` used by the auto-persist
 * hooks. Idempotent — calling with the same id is a no-op;
 * calling with a different id silently rotates (the orchestrator
 * is responsible for ordering this with `initSessionState`).
 *
 * Pass `null` to clear (e.g. on session stop) so subsequent
 * survival-layer mutations no longer attempt to write.
 *
 * @param {Object} params
 * @param {string|null} params.sessionId
 * @returns {void}
 */
function setSessionId({ sessionId } = {}) {
  if (sessionId === null || sessionId === undefined) {
    MODULE_SESSION_ID = null;
    return;
  }
  MODULE_SESSION_ID = String(sessionId);
}

/**
 * Test helper — read the active module session id without
 * exposing the `let` binding. Used by smoke / property tests.
 *
 * @returns {string|null}
 */
function __getModuleSessionIdForTest() {
  return MODULE_SESSION_ID;
}

/**
 * Initialise a brand-new session. Called by the orchestrator at
 * session start with the operator-confirmed capital snapshot.
 * If `sessionStartedAtIST` is omitted we derive the IST 00:00
 * boundary preceding `Date.now()`.
 *
 * Open trades are intentionally CLEARED here — a new session
 * begins flat. If the orchestrator needs to carry an in-flight
 * trade across a session boundary it should call
 * `recordTradeOpen` AFTER `initSessionState`.
 *
 * @param {Object} params
 * @param {number} params.sessionStartCapital
 * @param {number} [params.sessionStartedAtIST]
 * @returns {RiskState} Snapshot of the freshly-initialised state.
 */
function initSessionState({ sessionStartCapital, sessionStartedAtIST } = {}) {
  const cap =
    typeof sessionStartCapital === 'number' &&
    Number.isFinite(sessionStartCapital) &&
    sessionStartCapital > 0
      ? sessionStartCapital
      : null;
  const startedAt =
    typeof sessionStartedAtIST === 'number' && Number.isFinite(sessionStartedAtIST)
      ? sessionStartedAtIST
      : __deriveISTMidnight(Date.now());

  RISK_STATE = createInitialRiskState();
  RISK_STATE.sessionStartCapital = cap;
  RISK_STATE.sessionStartedAtIST = startedAt;
  return getRiskState();
}

/**
 * Read-only snapshot of the current risk state. We deep-copy
 * `openTrades` so a caller cannot accidentally mutate the
 * adapter's internal roster by holding a reference to the
 * returned object.
 *
 * @returns {RiskState}
 */
function getRiskState() {
  return {
    sessionStartedAtIST: RISK_STATE.sessionStartedAtIST,
    sessionStartCapital: RISK_STATE.sessionStartCapital,
    realizedPnL: RISK_STATE.realizedPnL,
    consecutiveLosses: RISK_STATE.consecutiveLosses,
    killSwitch: RISK_STATE.killSwitch,
    killSwitchTrigger: RISK_STATE.killSwitchTrigger
      ? { ...RISK_STATE.killSwitchTrigger }
      : null,
    lastTradeClosedAt: RISK_STATE.lastTradeClosedAt,
    lastTradeOutcome: RISK_STATE.lastTradeOutcome,
    openTrades: RISK_STATE.openTrades.map((t) => ({ ...t })),
    pendingReEvaluations: RISK_STATE.pendingReEvaluations.map((r) => ({
      source: r.source,
      reason: r.reason,
      openPositions: Array.isArray(r.openPositions)
        ? r.openPositions.map((p) => (p && typeof p === 'object' ? { ...p } : p))
        : [],
      requestedAt: r.requestedAt,
      processed: r.processed,
    })),
  };
}

/**
 * Record a trade close. Updates `realizedPnL`, the consecutive
 * loss / win counter, and the cooldown anchor.
 *
 * Outcome semantics:
 *   - `'loss'` ⇒ `consecutiveLosses += 1`. The Kill_Switch
 *     auto-trigger lives in `evaluateRisk` (subtask 12.6) so
 *     this helper stays settings-free; the next call to
 *     `evaluateRisk` will see the updated counter and call
 *     `requestKillSwitch({ source: 'consecutive_loss' })`
 *     when `consecutiveLosses ≥ riskEngine.consecutiveLossKill`.
 *   - `'win'`  ⇒ `consecutiveLosses = 0`. Wins break the streak
 *     but never flip `killSwitch` back to false (Req 19.6).
 *   - `null`   ⇒ flat / scratch trade. Counters left untouched.
 *
 * @param {Object} params
 * @param {number} params.pnl                    Signed ₹ PnL.
 * @param {('win'|'loss'|null)} params.outcome
 * @param {number} [params.closedAt]             Epoch ms; defaults to `Date.now()`.
 * @returns {RiskState}
 */
function recordTradeClose({ pnl, outcome, closedAt } = {}) {
  // The orchestrator (subtask 16) is responsible for using
  // `plCalculation.calculateFinalPL(...)` to compute the
  // `pnl` argument BEFORE calling this helper, so the
  // survival-layer counter and the persisted `TradePLRecord`
  // rows agree (Req 3.6). The reference below is documented
  // and intentional — we want a missing `plCalculation.service.js`
  // to fail at module load, not at the first close.
  void plCalculation;

  const safePnl =
    typeof pnl === 'number' && Number.isFinite(pnl) ? pnl : 0;
  const safeClosedAt =
    typeof closedAt === 'number' && Number.isFinite(closedAt)
      ? closedAt
      : Date.now();

  RISK_STATE.realizedPnL += safePnl;

  if (outcome === 'loss') {
    RISK_STATE.consecutiveLosses += 1;
  } else if (outcome === 'win') {
    RISK_STATE.consecutiveLosses = 0;
  }

  RISK_STATE.lastTradeClosedAt = safeClosedAt;
  RISK_STATE.lastTradeOutcome = outcome === 'win' || outcome === 'loss' ? outcome : null;

  // 12.8 auto-persist: fire-and-forget snapshot to Mongo so a
  // restart resumes from the post-close counters. No-op when
  // `MODULE_SESSION_ID` is null (smoke checks).
  __autoPersistRiskState();

  return getRiskState();
}

/**
 * Record a new open trade. The orchestrator should call this
 * after `executionEngine.adapter.js` confirms the fill.
 *
 * No deduplication is performed — the orchestrator is the only
 * caller, and it dedupes on the upstream `tradeId`.
 *
 * @param {Object} params
 * @param {OpenTradeRecord} params.trade
 * @returns {RiskState}
 */
function recordTradeOpen({ trade } = {}) {
  if (!trade || typeof trade !== 'object') return getRiskState();
  RISK_STATE.openTrades.push({ ...trade });
  return getRiskState();
}

/**
 * Remove a trade from the open-trade roster. Idempotent — a
 * non-existent `tradeId` is a no-op so the orchestrator can call
 * this on every exit-event without first checking presence.
 *
 * @param {Object} params
 * @param {string} params.tradeId
 * @returns {RiskState}
 */
function recordTradeExit({ tradeId } = {}) {
  if (!tradeId) return getRiskState();
  RISK_STATE.openTrades = RISK_STATE.openTrades.filter((t) => t && t.id !== tradeId);
  return getRiskState();
}

// ============================================================
// Kill_Switch transitions (Req 12.4 / 15.3 / 15.6 / 19.6)
// ============================================================
//
// The kill switch is the highest-priority survival gate. Two
// monotonicity invariants govern its lifecycle:
//
//   1. Within a session, ANY automated path may set
//      `killSwitch = true` (consecutive losses, latency
//      breach, edge decay, …) but NO automated path may flip
//      it back to false. Only `clearKillSwitch` driven by an
//      explicit operator action can clear it (Req 12.4 /
//      19.6).
//
//   2. `requestKillSwitch` is IDEMPOTENT. The first call sets
//      `killSwitchTrigger`; subsequent calls while the switch
//      is already true preserve the original trigger so the
//      audit log records the FIRST cause rather than the most
//      recent.
//
// `clearKillSwitch` requires a non-empty `operatorAction`
// payload. We deliberately keep the schema loose (any
// non-empty object) so the orchestrator owns the auth /
// confirmation policy; this adapter's only contract is "no
// silent automated clear can ever happen".

const VALID_KILL_SWITCH_SOURCES = Object.freeze([
  'consecutive_loss',
  'latency_breach',
  'edge_decay',
  'manual',
]);

// ============================================================
// Re-evaluation request queue (Req 15.4 / 15.5 — subtask 15.3)
// ============================================================
//
// Monitoring_Engine pushes re-evaluation requests onto this
// queue when:
//   - the Regime_Engine label changes while ≥ 1 trade is open
//     (Req 15.4), or
//   - AI confidence on an open trade decays below
//     `monitoringEngine.confidenceDecayFloor` (Req 15.5).
//
// The orchestrator (subtask 16.3) drains the queue once per
// monitoring cycle via `consumePendingReEvaluations()` and
// routes each request through the actual exit-decision path
// (`monitorEngine.service.js` / Risk_Engine exit logic).
//
// Idempotency invariant — "exactly one re-evaluation request
// per trigger" (Req 15.4 / 15.5): a duplicate request with
// the SAME `source` while a prior request is still pending is
// SUPPRESSED. The orchestrator's `consumePendingReEvaluations`
// drains and clears the queue each cycle, after which a fresh
// trigger from the same source can enqueue again.
//
// Persistence is OUT OF SCOPE — `pendingReEvaluations` is a
// transient in-memory queue. A process restart drops any
// un-drained requests; the next monitoring tick will re-emit
// the trigger naturally because `regimeChange` /
// `aiConfidenceDecay` are derived from the live tick state.

const VALID_REEVAL_SOURCES = Object.freeze([
  'regime_change',
  'ai_confidence_decay',
  'manual',
]);

/**
 * Set `killSwitch = true` and record the trigger source on
 * `RISK_STATE.killSwitchTrigger`. Idempotent — when the switch
 * is already true the call is a no-op and the original trigger
 * is preserved.
 *
 * Used by:
 *   - `evaluateRisk` (this module) for the consecutive-loss
 *     auto-trigger (Req 12.4).
 *   - Monitoring_Engine adapter (subtask 15) for latency-breach
 *     and edge-decay triggers (Req 15.3 / 15.6).
 *   - Orchestrator-level operator manual trip (`source:
 *     'manual'`).
 *
 * @param {Object} params
 * @param {('consecutive_loss'|'latency_breach'|'edge_decay'|'manual')} params.source
 * @param {string} [params.reason]            Audit-log description.
 * @param {number} [params.triggeredAt]       Epoch ms; defaults to `Date.now()`.
 * @returns {RiskState}
 */
function requestKillSwitch({ source, reason, triggeredAt } = {}) {
  // Idempotent: preserve the FIRST trigger so the audit row
  // records the original cause, not the most recent ping.
  if (RISK_STATE.killSwitch === true) {
    return getRiskState();
  }
  const safeSource = VALID_KILL_SWITCH_SOURCES.includes(source) ? source : 'manual';
  const safeReason = typeof reason === 'string' && reason.length > 0 ? reason : '';
  const safeAt =
    typeof triggeredAt === 'number' && Number.isFinite(triggeredAt)
      ? triggeredAt
      : Date.now();
  RISK_STATE.killSwitch = true;
  RISK_STATE.killSwitchTrigger = {
    source: safeSource,
    reason: safeReason,
    triggeredAt: safeAt,
  };
  logger.warn(
    {
      module: 'riskEngine.adapter',
      event: 'KILL_SWITCH_TRIGGERED',
      source: safeSource,
      reason: safeReason,
      triggeredAt: safeAt,
      consecutiveLosses: RISK_STATE.consecutiveLosses,
    },
    'Risk_Engine Kill_Switch ENGAGED',
  );
  // 12.8 auto-persist: every kill-switch transition must hit
  // disk (Req 12.12) so a restart resumes with the switch
  // engaged.
  __autoPersistRiskState();
  return getRiskState();
}

/**
 * Operator-only clear (Req 12.4 / 19.6). Refuses to clear
 * unless `operatorAction` is a non-empty plain object — the
 * orchestrator owns the auth / confirmation policy; this
 * adapter only enforces the "no automated clear" invariant.
 *
 * Returns `{ cleared: boolean, state: RiskState }` so the
 * caller can distinguish a successful clear from a refusal
 * without having to compare snapshots.
 *
 * @param {Object} [params]
 * @param {Object} [params.operatorAction]   E.g. `{ operatorId: 'gobi', confirmed: true }`.
 * @returns {{ cleared: boolean, state: RiskState }}
 */
function clearKillSwitch({ operatorAction } = {}) {
  // Refuse the clear when no operator action is supplied. This
  // is the entire point of the gate — without an explicit
  // operator-confirmed payload we MUST NOT touch `killSwitch`.
  const isValidOperatorAction =
    operatorAction !== null &&
    typeof operatorAction === 'object' &&
    !Array.isArray(operatorAction) &&
    Object.keys(operatorAction).length > 0;
  if (!isValidOperatorAction) {
    logger.warn(
      {
        module: 'riskEngine.adapter',
        event: 'KILL_SWITCH_CLEAR_REFUSED',
        reason: 'missing_or_empty_operatorAction',
      },
      'Risk_Engine Kill_Switch clear refused — operator action missing',
    );
    return { cleared: false, state: getRiskState() };
  }
  if (RISK_STATE.killSwitch === false) {
    // Already clear — no-op success so callers can be idempotent.
    return { cleared: true, state: getRiskState() };
  }
  const previousTrigger = RISK_STATE.killSwitchTrigger;
  RISK_STATE.killSwitch = false;
  RISK_STATE.killSwitchTrigger = null;
  logger.warn(
    {
      module: 'riskEngine.adapter',
      event: 'KILL_SWITCH_CLEARED',
      operatorAction,
      previousTrigger,
    },
    'Risk_Engine Kill_Switch CLEARED by operator',
  );
  // 12.8 auto-persist: a successful clear is also a kill-switch
  // transition; persist so a restart resumes in the cleared state.
  __autoPersistRiskState();
  return { cleared: true, state: getRiskState() };
}

/**
 * Enqueue a re-evaluation request from Monitoring_Engine
 * (Req 15.4 / 15.5 — subtask 15.3). The orchestrator drains
 * the queue once per monitoring cycle via
 * `consumePendingReEvaluations()` and routes each request
 * through the actual exit-decision path. Risk_Engine retains
 * exit decision authority — Monitoring_Engine MUST NOT submit
 * exits directly.
 *
 * Idempotency: when a prior request with the SAME `source` is
 * still pending (i.e. has not yet been consumed by the
 * orchestrator), the new request is SUPPRESSED and the
 * function returns `{ enqueued: false, reason: 'ALREADY_PENDING',
 * queueLength }`. This enforces the "exactly one re-evaluation
 * request per trigger per cycle" invariant from Req 15.4 / 15.5.
 *
 * NEVER throws. Unknown / missing `source` falls back to
 * `'manual'` so the audit row still records the request rather
 * than silently dropping it.
 *
 * @param {Object} params
 * @param {('regime_change'|'ai_confidence_decay'|'manual')} params.source
 * @param {string} [params.reason]                Audit-log description.
 * @param {Array<Object>} [params.openPositions]  Open-trade roster snapshot.
 * @param {number} [params.requestedAt]           Epoch ms; defaults to `Date.now()`.
 * @returns {{ enqueued: boolean, queueLength: number, source: string, reason?: string }}
 */
function requestReEvaluation({ source, reason, openPositions, requestedAt } = {}) {
  try {
    const safeSource = VALID_REEVAL_SOURCES.includes(source) ? source : 'manual';
    const safeReason = typeof reason === 'string' && reason.length > 0 ? reason : '';
    const safePositions = Array.isArray(openPositions)
      ? openPositions.map((p) => (p && typeof p === 'object' ? { ...p } : p))
      : [];
    const safeAt =
      typeof requestedAt === 'number' && Number.isFinite(requestedAt)
        ? requestedAt
        : Date.now();

    // Idempotency gate: suppress duplicate requests for the
    // same source while a prior record is still pending. The
    // orchestrator's `consumePendingReEvaluations` drains the
    // queue each cycle, so the next regime change / confidence
    // drop after a drain can re-enqueue freely.
    const alreadyPending = RISK_STATE.pendingReEvaluations.some(
      (r) => r && r.source === safeSource && r.processed === false,
    );
    if (alreadyPending) {
      logger.warn(
        {
          module: 'riskEngine.adapter',
          event: 'RE_EVAL_REQUEST_SUPPRESSED',
          source: safeSource,
          reason: safeReason,
          queueLength: RISK_STATE.pendingReEvaluations.length,
        },
        'Risk_Engine re-evaluation request suppressed — already pending',
      );
      return {
        enqueued: false,
        reason: 'ALREADY_PENDING',
        queueLength: RISK_STATE.pendingReEvaluations.length,
        source: safeSource,
      };
    }

    RISK_STATE.pendingReEvaluations.push({
      source: safeSource,
      reason: safeReason,
      openPositions: safePositions,
      requestedAt: safeAt,
      processed: false,
    });
    logger.warn(
      {
        module: 'riskEngine.adapter',
        event: 'RE_EVAL_REQUEST_ENQUEUED',
        source: safeSource,
        reason: safeReason,
        openPositionsCount: safePositions.length,
        requestedAt: safeAt,
        queueLength: RISK_STATE.pendingReEvaluations.length,
      },
      'Risk_Engine re-evaluation request enqueued',
    );
    return {
      enqueued: true,
      queueLength: RISK_STATE.pendingReEvaluations.length,
      source: safeSource,
    };
  } catch (err) {
    // NEVER throw (Req 1.5). Log and return a soft failure so
    // the Monitoring_Engine cadence is unaffected.
    // eslint-disable-next-line no-console
    console.error(
      '[riskEngine.adapter] requestReEvaluation: unexpected error',
      err && err.message,
    );
    return {
      enqueued: false,
      reason: 'ERROR',
      queueLength: RISK_STATE.pendingReEvaluations.length,
      source: typeof source === 'string' ? source : 'manual',
    };
  }
}

/**
 * Drain the pending re-evaluation queue. Returns a deep-cloned
 * snapshot of the queue and CLEARS it so a subsequent trigger
 * from the same `source` can enqueue again. Used by the
 * orchestrator (subtask 16.3) once per monitoring cycle.
 *
 * @returns {Array<ReEvaluationRequest>}
 */
function consumePendingReEvaluations() {
  const drained = RISK_STATE.pendingReEvaluations.map((r) => ({
    source: r.source,
    reason: r.reason,
    openPositions: Array.isArray(r.openPositions)
      ? r.openPositions.map((p) => (p && typeof p === 'object' ? { ...p } : p))
      : [],
    requestedAt: r.requestedAt,
    processed: true,
  }));
  RISK_STATE.pendingReEvaluations = [];
  return drained;
}

/**
 * Read-only inspector for the pending re-evaluation queue.
 * Returns a deep-cloned snapshot WITHOUT clearing the queue.
 * Used by Monitoring_Engine smoke checks and operator
 * dashboards.
 *
 * @returns {Array<ReEvaluationRequest>}
 */
function getPendingReEvaluations() {
  return RISK_STATE.pendingReEvaluations.map((r) => ({
    source: r.source,
    reason: r.reason,
    openPositions: Array.isArray(r.openPositions)
      ? r.openPositions.map((p) => (p && typeof p === 'object' ? { ...p } : p))
      : [],
    requestedAt: r.requestedAt,
    processed: r.processed,
  }));
}

// ============================================================
// Risk-state persistence (Req 12.12 / Req 3.6 — subtask 12.8)
// ============================================================
//
// The survival counters (realisedPnL, consecutiveLosses,
// killSwitch, sessionStartCapital) MUST survive an in-process
// restart within a session so the operator never loses track
// of the day's loss / kill-switch posture (Req 12.12).
//
// Persistence target: `ScalpingSession.payload.riskState`.
// `payload` is a Mongoose `Mixed` field, so we mutate the
// nested object and call `markModified('payload')` before
// `save()` to force change detection.
//
// Persisted shape:
//   {
//     realizedPnL,
//     consecutiveLosses,
//     killSwitch,
//     sessionStartCapital,
//     killSwitchTrigger,        // audit-trail of the active trigger
//     sessionStartedAtIST,      // for IST-reset semantics on restart
//     lastTradeClosedAt,        // cooldown anchor
//     lastTradeOutcome,         // cooldown selector
//     persistedAt,              // bookkeeping
//   }
//
// EXCLUDED from the persisted set (deliberately):
//   - `openTrades`. Open positions are owned by the
//     `ScalpingTrade` collection. Persisting them on every
//     close / kill transition would create a second source of
//     truth for the open-roster and risk drift if the
//     adapter and Mongo disagreed. The orchestrator queries
//     `ScalpingTrade` directly to rebuild `openTrades` on
//     restart.
//
// Failure semantics (Req 1.5): NEVER throw. Mongo failures are
// logged and swallowed — the in-memory `RISK_STATE` is the
// authoritative live source; persistence is best-effort
// durability.

/**
 * Build the plain-object snapshot that lands in
 * `ScalpingSession.payload.riskState`. We deep-clone the
 * `killSwitchTrigger` so a later mutation of `RISK_STATE`
 * cannot retroactively rewrite a previously-persisted row.
 *
 * @returns {Object}
 */
function __buildPersistedSnapshot() {
  return {
    realizedPnL: RISK_STATE.realizedPnL,
    consecutiveLosses: RISK_STATE.consecutiveLosses,
    killSwitch: RISK_STATE.killSwitch,
    sessionStartCapital: RISK_STATE.sessionStartCapital,
    killSwitchTrigger: RISK_STATE.killSwitchTrigger
      ? { ...RISK_STATE.killSwitchTrigger }
      : null,
    sessionStartedAtIST: RISK_STATE.sessionStartedAtIST,
    lastTradeClosedAt: RISK_STATE.lastTradeClosedAt,
    lastTradeOutcome: RISK_STATE.lastTradeOutcome,
    persistedAt: Date.now(),
  };
}

/**
 * Persist the current risk state to `ScalpingSession.payload.riskState`.
 * NEVER throws — Mongo failures are logged and swallowed so a
 * persistence outage cannot corrupt the orchestrator hot path
 * (Req 1.5). Callers MAY `await` the returned promise for
 * test-side determinism, but production callers fire-and-forget.
 *
 * Auto-invoked by `recordTradeClose`, `requestKillSwitch`, and
 * `clearKillSwitch` when `MODULE_SESSION_ID` is set. The
 * orchestrator may also call this directly with an explicit
 * `sessionId` if it needs an ad-hoc snapshot (e.g. on
 * graceful shutdown).
 *
 * @param {Object} [params]
 * @param {string} [params.sessionId]  Defaults to `MODULE_SESSION_ID`.
 * @returns {Promise<{ persisted: boolean, reason?: string }>}
 */
async function persistRiskState({ sessionId } = {}) {
  const id = sessionId || MODULE_SESSION_ID;
  if (!id) {
    return { persisted: false, reason: 'no_session_id' };
  }
  try {
    const session = await ScalpingSession.findById(id);
    if (!session) {
      logger.warn(
        { module: 'riskEngine.adapter', event: 'RISK_STATE_PERSIST_NO_SESSION', sessionId: id },
        'persistRiskState: ScalpingSession not found; skipping write',
      );
      return { persisted: false, reason: 'session_not_found' };
    }
    const snapshot = __buildPersistedSnapshot();
    if (!session.payload || typeof session.payload !== 'object') {
      session.payload = {};
    }
    session.payload.riskState = snapshot;
    // `payload` is a Mongoose `Mixed` field. Without
    // `markModified` Mongoose will not detect the nested
    // mutation and `save()` becomes a silent no-op — this is
    // the single most common foot-gun with `Mixed` fields.
    if (typeof session.markModified === 'function') {
      session.markModified('payload');
    }
    await session.save();
    return { persisted: true };
  } catch (err) {
    logger.error(
      {
        module: 'riskEngine.adapter',
        event: 'RISK_STATE_PERSIST_ERROR',
        sessionId: id,
        error: err && err.message ? err.message : String(err),
      },
      'persistRiskState: failed to write riskState; continuing in-memory',
    );
    return { persisted: false, reason: 'error' };
  }
}

/**
 * Fire-and-forget wrapper used by the auto-persist hooks. Swallows
 * every error so the calling mutator (`recordTradeClose`,
 * `requestKillSwitch`, `clearKillSwitch`) cannot throw. We use a
 * separate helper so the synchronous mutators can return their
 * canonical snapshot synchronously while persistence runs in the
 * background.
 *
 * @returns {void}
 */
function __autoPersistRiskState() {
  if (!MODULE_SESSION_ID) return;
  // Intentionally not awaited — survival-layer mutators are sync.
  // The trailing `.catch` guards the unlikely case where
  // `persistRiskState` rejects despite its internal try/catch
  // (e.g. a synchronous throw before the await).
  Promise.resolve()
    .then(() => persistRiskState({ sessionId: MODULE_SESSION_ID }))
    .catch(() => {
      // Swallow — `persistRiskState` already logged.
    });
}

/**
 * Restore risk state from `ScalpingSession.payload.riskState`.
 * Used on engine restart within the same session so the
 * survival counters resume identically (Req 12.12).
 *
 * Validation: every persisted key is type-checked before
 * merging. A missing or malformed field falls back to the
 * existing in-memory value, so a partial / corrupted document
 * cannot zero a healthy in-memory state.
 *
 * `openTrades` is rebuilt from the `ScalpingTrade` collection
 * by the orchestrator and is intentionally NOT touched here.
 *
 * NEVER throws.
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @returns {Promise<{ restored: boolean, reason?: string, state?: RiskState }>}
 */
async function restoreRiskState({ sessionId } = {}) {
  if (!sessionId) {
    return { restored: false, reason: 'no_session_id' };
  }
  try {
    const session = await ScalpingSession.findById(sessionId);
    if (!session) {
      return { restored: false, reason: 'session_not_found' };
    }
    const persisted =
      session.payload && typeof session.payload === 'object'
        ? session.payload.riskState
        : null;
    if (!persisted || typeof persisted !== 'object') {
      return { restored: false, reason: 'no_persisted_state' };
    }

    // Type-validated merge: ignore malformed values rather than
    // overwrite a healthy in-memory state. The defensive
    // `isFiniteNumber` checks below mirror the validation used
    // in `initSessionState` and `recordTradeClose`.
    if (isFiniteNumber(persisted.realizedPnL)) {
      RISK_STATE.realizedPnL = persisted.realizedPnL;
    }
    if (
      Number.isInteger(persisted.consecutiveLosses) &&
      persisted.consecutiveLosses >= 0
    ) {
      RISK_STATE.consecutiveLosses = persisted.consecutiveLosses;
    }
    if (typeof persisted.killSwitch === 'boolean') {
      RISK_STATE.killSwitch = persisted.killSwitch;
    }
    if (
      isFiniteNumber(persisted.sessionStartCapital) &&
      persisted.sessionStartCapital > 0
    ) {
      RISK_STATE.sessionStartCapital = persisted.sessionStartCapital;
    } else if (persisted.sessionStartCapital === null) {
      RISK_STATE.sessionStartCapital = null;
    }
    if (
      persisted.killSwitchTrigger &&
      typeof persisted.killSwitchTrigger === 'object'
    ) {
      RISK_STATE.killSwitchTrigger = { ...persisted.killSwitchTrigger };
    } else if (persisted.killSwitchTrigger === null) {
      RISK_STATE.killSwitchTrigger = null;
    }
    if (isFiniteNumber(persisted.sessionStartedAtIST)) {
      RISK_STATE.sessionStartedAtIST = persisted.sessionStartedAtIST;
    } else if (persisted.sessionStartedAtIST === null) {
      RISK_STATE.sessionStartedAtIST = null;
    }
    if (isFiniteNumber(persisted.lastTradeClosedAt)) {
      RISK_STATE.lastTradeClosedAt = persisted.lastTradeClosedAt;
    } else if (persisted.lastTradeClosedAt === null) {
      RISK_STATE.lastTradeClosedAt = null;
    }
    if (
      persisted.lastTradeOutcome === 'win' ||
      persisted.lastTradeOutcome === 'loss' ||
      persisted.lastTradeOutcome === null
    ) {
      RISK_STATE.lastTradeOutcome = persisted.lastTradeOutcome;
    }

    logger.info(
      {
        module: 'riskEngine.adapter',
        event: 'RISK_STATE_RESTORED',
        sessionId,
        realizedPnL: RISK_STATE.realizedPnL,
        consecutiveLosses: RISK_STATE.consecutiveLosses,
        killSwitch: RISK_STATE.killSwitch,
      },
      'restoreRiskState: risk state restored from ScalpingSession',
    );
    return { restored: true, state: getRiskState() };
  } catch (err) {
    logger.error(
      {
        module: 'riskEngine.adapter',
        event: 'RISK_STATE_RESTORE_ERROR',
        sessionId,
        error: err && err.message ? err.message : String(err),
      },
      'restoreRiskState: failed to read riskState; keeping in-memory state',
    );
    return { restored: false, reason: 'error' };
  }
}

// ============================================================
// IST midnight derivation (Req 12.2)
// ============================================================
//
// IST = UTC+5:30 with no DST. The IST 00:00 boundary preceding
// `nowMs` is the floor of the IST-shifted timestamp at the
// 86_400_000 ms (one day) modulus, then shifted back to UTC.
//
// Worked example (`nowMs` = 2026-05-04T03:30:00Z = 09:00 IST):
//   istTime      = nowMs + 5.5 h   = 2026-05-04T09:00:00Z-equivalent
//   istMidnight  = floor / 86_400_000 × 86_400_000
//                = 2026-05-04T00:00:00 IST equivalent in ms
//   utcEpoch     = istMidnight − 5.5 h
//                = 2026-05-03T18:30:00Z
//
// 2026-05-03T18:30:00Z is exactly the UTC instant at which IST
// 2026-05-04 00:00:00 occurred — which is what the spec's
// "00:00 IST session boundary" means.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Return the UTC-epoch milliseconds of the most recent IST
 * 00:00 boundary at or before `nowMs`. Pure / deterministic
 * helper used by `maybeResetSessionForIST` and the session-
 * init fallback in `initSessionState`.
 *
 * @param {number} nowMs Epoch ms.
 * @returns {number}
 */
function __deriveISTMidnight(nowMs) {
  const safeNow =
    typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const istShifted = safeNow + IST_OFFSET_MS;
  const istMidnightShifted = Math.floor(istShifted / ONE_DAY_MS) * ONE_DAY_MS;
  return istMidnightShifted - IST_OFFSET_MS;
}

/**
 * Reset the daily counters when a new IST trading session has
 * begun. Called at the top of every `evaluateRisk` call so the
 * orchestrator does not need its own midnight-watcher.
 *
 * Reset surface (Req 12.2): `realizedPnL`,
 * `consecutiveLosses`, `lastTradeClosedAt`,
 * `lastTradeOutcome`. PRESERVED: `sessionStartCapital`,
 * `killSwitch` (monotonic per Req 19.6 — operator-only clear),
 * `openTrades` (a position open across midnight remains open).
 *
 * @param {number} nowMs
 * @returns {boolean} `true` iff a reset occurred.
 */
function maybeResetSessionForIST(nowMs) {
  const istMidnight = __deriveISTMidnight(nowMs);
  if (
    RISK_STATE.sessionStartedAtIST === null ||
    istMidnight > RISK_STATE.sessionStartedAtIST
  ) {
    RISK_STATE.sessionStartedAtIST = istMidnight;
    RISK_STATE.realizedPnL = 0;
    RISK_STATE.consecutiveLosses = 0;
    RISK_STATE.lastTradeClosedAt = null;
    RISK_STATE.lastTradeOutcome = null;
    return true;
  }
  return false;
}

// ============================================================
// Defensive numeric helpers
// ============================================================

/**
 * Same as `finiteOrNull` but coerces to `false` for boolean checks.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Read a positive-finite number with a runtime fallback. The
 * authoritative validator is `algoSettings.validateSettings`;
 * this is just a safety net so the RiskDecision shape stays
 * stable on misconfiguration. Use this for VALUES THAT MUST BE
 * POSITIVE (e.g. `perTradeRiskPctMax`, `capital`, `minRR`); the
 * fallback covers `null` / `undefined` / non-finite / non-positive.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function resolvePositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Read a finite number with a runtime fallback only for
 * `null` / `undefined` / non-finite inputs. UNLIKE
 * `resolvePositiveNumber` this allows zero or negative values
 * to pass through unchanged, so a deliberately-zeroed input
 * (e.g. `fixedSLPoints: 0`) collapses the SL formula and
 * triggers the Req 12.7 invalid-SL guard rather than being
 * silently rewritten to the default. Use for SL-formula inputs
 * (`fixedSLPoints`, `atrSLMultiplier`, `maxSLPoints`) so the
 * guard branch is reachable from a misconfigured snapshot.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function resolveFiniteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read a non-negative-finite number with a runtime fallback.
 * Used for cooldowns, max-hold seconds, and exposure caps where
 * zero is a valid operator choice (zero cooldown ⇒ no cooldown
 * applied) but negatives or non-finite values should fall back
 * to the documented default.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function resolveNonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

// ============================================================
// Inline ATR(period) — Wilder smoothing, seeded with SMA over
// the first `period` TR values. Mirrors the canonical
// implementation in `services/atr.service.js > calculateATR`
// and the inline copy in `signalEngine.evaluator.js` so all
// three modules see numerically identical ATR values.
//
// Returns `null` when the input is too short or contains a
// non-finite OHLC value.
// ============================================================

/**
 * @param {Array<{high:number, low:number, close:number}>} bars
 * @param {number} period
 * @returns {number|null}
 */
function computeAtr(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1 || period <= 0) return null;
  // True Range series: TR_i = max(H_i − L_i, |H_i − C_{i-1}|, |L_i − C_{i-1}|).
  const tr = [];
  for (let i = 1; i < bars.length; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (!cur || !prev) return null;
    if (
      !isFiniteNumber(cur.high) ||
      !isFiniteNumber(cur.low) ||
      !isFiniteNumber(prev.close)
    ) {
      return null;
    }
    const range1 = cur.high - cur.low;
    const range2 = Math.abs(cur.high - prev.close);
    const range3 = Math.abs(cur.low - prev.close);
    tr.push(Math.max(range1, range2, range3));
  }
  if (tr.length < period) return null;
  // Seed: simple average of the first `period` TRs.
  let atr = 0;
  for (let i = 0; i < period; i += 1) atr += tr[i];
  atr /= period;
  // Wilder smoothing for the rest.
  for (let i = period; i < tr.length; i += 1) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return Number.isFinite(atr) ? atr : null;
}

// ============================================================
// Settings extraction helpers
// ============================================================

/**
 * Resolve the signal timeframe string for the current side.
 * Risk_Engine pulls ATR off the SAME series the Signal_Engine
 * used so SL distance is consistent with the gate it just
 * cleared.
 *
 * @param {Readonly<Object>} settings
 * @param {('LONG_SETUP'|'SHORT_SETUP')} candidate
 * @returns {string}
 */
function resolveSignalTimeframe(settings, candidate) {
  const sig = settings && settings.signalEngine ? settings.signalEngine : {};
  const sideKey = candidate === 'SHORT_SETUP' ? 'short' : 'long';
  const tf = sig[sideKey] ? sig[sideKey].signalTimeframe : null;
  return typeof tf === 'string' && tf.length > 0 ? tf : '5m';
}

/**
 * Compute the notional (₹) of a single open trade. Prefers the
 * pre-computed `trade.notional` field so the orchestrator can
 * carry rounding decisions from `lotAllocation.service.js`. Falls
 * back to `premium × lots × lotSize` otherwise.
 *
 * Returns `0` (not `null`) on an unusable trade record so it
 * cannot poison the `Σ` in `currentExposurePct`.
 *
 * @param {OpenTradeRecord} trade
 * @param {number} defaultLotSize
 * @returns {number}
 */
function tradeNotional(trade, defaultLotSize) {
  if (!trade || typeof trade !== 'object') return 0;
  if (isFiniteNumber(trade.notional) && trade.notional >= 0) return trade.notional;
  const premium = isFiniteNumber(trade.premium) && trade.premium >= 0 ? trade.premium : 0;
  const lots = isFiniteNumber(trade.lots) && trade.lots >= 0 ? trade.lots : 0;
  const lotSize =
    isFiniteNumber(trade.lotSize) && trade.lotSize > 0
      ? trade.lotSize
      : defaultLotSize;
  return premium * lots * lotSize;
}

/**
 * Σ open notional / sessionStartCapital × 100. Returns `0` when
 * there are no open trades or capital is unset. Visible to
 * Monitoring_Engine via `getRiskState`/this helper for the
 * `exposurePct` snapshot.
 *
 * @param {Object} [params]
 * @param {Array<OpenTradeRecord>} [params.openTrades]
 * @param {number|null} [params.sessionStartCapital]
 * @param {number} [params.defaultLotSize=65]
 * @returns {number}
 */
function currentExposurePct({
  openTrades = RISK_STATE.openTrades,
  sessionStartCapital = RISK_STATE.sessionStartCapital,
  defaultLotSize = 65,
} = {}) {
  if (!Array.isArray(openTrades) || openTrades.length === 0) return 0;
  if (!isFiniteNumber(sessionStartCapital) || sessionStartCapital <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < openTrades.length; i += 1) {
    sum += tradeNotional(openTrades[i], defaultLotSize);
  }
  return (sum / sessionStartCapital) * 100;
}

/**
 * Scan the open-trade roster for trades whose elapsed hold has
 * reached the configured ceiling. Returns an array of
 * `{ tradeId, reason: 'MAX_HOLD' }` records that the
 * orchestrator hands to `professionalExitManager.service.js`
 * for actual market-order submission.
 *
 * Scoping decision (12.3): the adapter intentionally does NOT
 * submit the exit orders itself. Stage adapters are pure and
 * never touch the executor; the orchestrator (subtask 16) owns
 * order submission. Returning a request-list keeps the
 * adapter testable without a live execution path.
 *
 * @param {Object} params
 * @param {number} params.now            Epoch ms.
 * @param {Readonly<Object>} params.settings
 * @returns {Array<{ tradeId: string, reason: 'MAX_HOLD' }>}
 */
function checkMaxHoldExits({ now, settings } = {}) {
  const re = (settings && settings.riskEngine) || {};
  const scalpSec = resolveNonNegativeNumber(re.maxHoldSecondsScalp, 300);
  const swingSec = resolveNonNegativeNumber(re.maxHoldSecondsSwing, 1800);
  const safeNow = isFiniteNumber(now) ? now : Date.now();
  const out = [];
  for (let i = 0; i < RISK_STATE.openTrades.length; i += 1) {
    const trade = RISK_STATE.openTrades[i];
    if (!trade || !trade.id || !isFiniteNumber(trade.openedAt)) continue;
    const elapsedSec = (safeNow - trade.openedAt) / 1000;
    if (elapsedSec < 0) continue; // future-dated; skip defensively
    const ceiling = trade.type === 'swing' ? swingSec : scalpSec;
    if (elapsedSec >= ceiling) {
      out.push({ tradeId: trade.id, reason: 'MAX_HOLD' });
    }
  }
  return out;
}

/**
 * Build the canonical "no-trade" / blocked RiskDecision shape.
 * Fields are zeroed so consumers can rely on the contract even
 * on failure paths.
 *
 * @param {Object} params
 * @param {string|null} params.blockReason
 * @param {Array<string>} [params.reasonCodes=[]]
 * @returns {import('./cycleContext').RiskDecision}
 */
function buildBlockedDecision({ blockReason, reasonCodes = [] }) {
  return {
    allowEntry: false,
    blockReason: blockReason || null,
    stopLossPoints: 0,
    targetPoints: 0,
    riskRewardRatio: 0,
    positionSize: { lotsPerAccount: {}, totalLots: 0 },
    trailing: null,
    reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.slice() : [],
  };
}

/**
 * Build the trailing-SL params block when
 * `riskEngine.enableTrailingSL = true`. The values mirror the
 * activation thresholds enforced inside
 * `professionalExitManager.service.js > ruleBasedExit`:
 *
 *   - activate after 15% unrealised profit,
 *   - lock in a minimum 10% profit,
 *   - trail by 5-point increments,
 *   - never move the SL against the trade.
 *
 * Future subtasks (Req 12.9 refinement) may move these into
 * `Algo_Settings.riskEngine.trailing.*` for operator tuning.
 *
 * @returns {{ enabled: boolean, params: Object }}
 */
function buildTrailingParams() {
  return {
    enabled: true,
    params: {
      activationProfitPct: 15,
      lockMinProfitPct: 10,
      trailStepPoints: 5,
      // Documented invariant from the legacy manager: trailing
      // never moves the SL against the position. Carried over
      // explicitly so the audit row records the contract.
      neverMoveAgainstPosition: true,
    },
  };
}

// ============================================================
// Survival-layer gate evaluators (12.3)
//
// Each evaluator is pure with respect to its arguments — the
// caller (`evaluateRisk`) is the single read-write touchpoint
// for `RISK_STATE` so gates can be reused without side effects.
// Each evaluator returns `null` when the gate passes, or an
// object `{ blockReason, reasonCode }` when the gate trips.
// `evaluateRisk` accumulates every tripped gate so the audit
// row records every reason at once.
// ============================================================

/**
 * Daily-loss cap (Req 12.3). Block when the running realised
 * loss ≥ `dailyMaxLossPctMax × sessionStartCapital`. See module
 * header for the threshold-choice rationale.
 *
 * Skipped (returns `null`) when `sessionStartCapital` is unset
 * or non-positive — without a capital baseline the percentage
 * cannot be computed; the orchestrator must call
 * `initSessionState` before relying on this gate.
 *
 * @param {Readonly<Object>} settings
 * @returns {{ blockReason: string, reasonCode: string }|null}
 */
function evaluateDailyLossGate(settings) {
  const cap = RISK_STATE.sessionStartCapital;
  if (!isFiniteNumber(cap) || cap <= 0) return null;
  if (RISK_STATE.realizedPnL >= 0) return null; // no loss yet
  const re = (settings && settings.riskEngine) || {};
  // `dailyMaxLossPctMax` is the documented hard circuit-breaker
  // (default 3.0%). Validation enforces the upper bound — see
  // `algoSettings.validateSettings` step 3.
  const maxPct = resolvePositiveNumber(re.dailyMaxLossPctMax, 3.0);
  const lossPct = (-RISK_STATE.realizedPnL / cap) * 100;
  if (lossPct >= maxPct) {
    return {
      blockReason: 'DAILY_LOSS',
      reasonCode: REASON_CODES.RISK_DAILY_LOSS_EXCEEDED,
    };
  }
  return null;
}

/**
 * Exposure cap (Req 12.11). Block when current open notional
 * exposure exceeds `maxConcurrentExposurePct`. The Property 15
 * spec says "exceeds", so the comparison is strict-greater-than
 * — exposure exactly at the cap is permitted.
 *
 * @param {Readonly<Object>} settings
 * @returns {{ blockReason: string, reasonCode: string }|null}
 */
function evaluateExposureGate(settings) {
  const cap = RISK_STATE.sessionStartCapital;
  if (!isFiniteNumber(cap) || cap <= 0) return null;
  const re = (settings && settings.riskEngine) || {};
  const limitPct = resolvePositiveNumber(re.maxConcurrentExposurePct, 25);
  const defaultLotSize = resolvePositiveNumber(settings && settings.lotSize, 65);
  const exposurePct = currentExposurePct({
    openTrades: RISK_STATE.openTrades,
    sessionStartCapital: cap,
    defaultLotSize,
  });
  if (exposurePct > limitPct) {
    return {
      blockReason: 'EXPOSURE',
      reasonCode: REASON_CODES.RISK_EXPOSURE_EXCEEDED,
    };
  }
  return null;
}

/**
 * Cooldown gate (Req 12.10). Block when the elapsed time since
 * the last trade close is less than the applicable cooldown.
 *
 * Cooldown selection: `loss` ⇒ `cooldownSecondsAfterLoss`,
 * `win` ⇒ `cooldownSecondsAfterWin`. A `null` outcome
 * (flat / scratch close) skips the gate so a zero-PnL exit
 * does not gate the next entry.
 *
 * @param {Readonly<Object>} settings
 * @param {number} now
 * @returns {{ blockReason: string, reasonCode: string }|null}
 */
function evaluateCooldownGate(settings, now) {
  if (!isFiniteNumber(RISK_STATE.lastTradeClosedAt)) return null;
  const outcome = RISK_STATE.lastTradeOutcome;
  if (outcome !== 'win' && outcome !== 'loss') return null;
  const re = (settings && settings.riskEngine) || {};
  const cooldownSec =
    outcome === 'loss'
      ? resolveNonNegativeNumber(re.cooldownSecondsAfterLoss, 60)
      : resolveNonNegativeNumber(re.cooldownSecondsAfterWin, 30);
  if (cooldownSec <= 0) return null;
  const elapsedMs = now - RISK_STATE.lastTradeClosedAt;
  if (elapsedMs < cooldownSec * 1000) {
    return {
      blockReason: 'COOLDOWN',
      reasonCode: REASON_CODES.RISK_COOLDOWN_ACTIVE,
    };
  }
  return null;
}

// ============================================================
// Public API
// ============================================================

/**
 * Evaluate the Risk_Engine for the current cycle.
 *
 * SYNCHRONOUS by design — every input is already on `ctx` and
 * `lotAllocation.allocateLots` is sync. Returns a
 * `RiskDecision` matching the typedef in `cycleContext.js`. The
 * orchestrator threads it onto the cycle context via
 * `appendBlock(ctx, 'risk', decision)`, which automatically
 * lifts `decision.reasonCodes` onto `ctx.reasonCodes` for the
 * audit row (Req 17.7 / 18.4).
 *
 * Pipeline:
 *   0. IST 00:00 reset (Req 12.2). Always runs first so the
 *      remaining gates see a fresh per-day counter set.
 *   1. `signal.candidate === 'NO_TRADE'` ⇒ return blocked with
 *      `blockReason: null` and no reason code.
 *   2. `perTradeRiskPct` out of `[perTradeRiskPctMin,
 *      perTradeRiskPctMax]` ⇒ return blocked with reason
 *      `RISK_PER_TRADE_RISK_OOR` (Req 12.1). This is the
 *      OPERATOR-input gate — it intentionally short-circuits
 *      before the survival-layer gates so an out-of-range
 *      operator request never produces a misleading
 *      survival-layer reason.
 *   3. Survival-layer gates (Req 12.3 / 12.4 / 12.10 / 12.11).
 *      Every gate evaluator runs; a tripped gate appends its
 *      reason code to a list. Evaluation order is
 *      KILL_SWITCH → DAILY_LOSS → EXPOSURE → COOLDOWN, with
 *      Kill_Switch documented first so it always wins the
 *      `blockReason` slot whenever it is engaged. If ANY gate
 *      trips, return blocked with the first `blockReason`
 *      encountered and ALL accumulated reason codes. This is
 *      Property 15's "block when (a) OR (b) OR ..." semantics
 *      — the audit row records every reason that contributed.
 *   4. `stopLossPoints` per Req 12.5; ≤ 0 / non-finite ⇒ block
 *      with `RISK_INVALID_SL` (Req 12.7).
 *   5. `targetPoints = stopLossPoints × signalEngine.minRR`,
 *      `riskRewardRatio = signalEngine.minRR`.
 *   6. Raw `positionSize = (perTradeRiskPct × capital ×
 *      regime.positionSizingMultiplier) / stopLossPoints`.
 *   7. Lot-allocation hand-off — `lotsPerAccount` is empty
 *      until subtask 16 plumbs the account roster.
 *   8. Trailing SL when enabled.
 *
 * @param {Object} params
 * @param {Readonly<import('./cycleContext').CycleContext>} params.ctx
 * @param {Readonly<Object>} params.settings
 * @param {number} params.perTradeRiskPct  Operator-specified per-trade risk %.
 * @param {number} [params.now]            Override for tests; defaults to `Date.now()`.
 * @returns {import('./cycleContext').RiskDecision}
 */
function evaluateRisk({ ctx, settings, perTradeRiskPct, now } = {}) {
  try {
    const safeNow = isFiniteNumber(now) ? now : Date.now();

    // ------------------------------------------------------------
    // 0) IST 00:00 daily reset (Req 12.2).
    // ------------------------------------------------------------
    maybeResetSessionForIST(safeNow);

    // ------------------------------------------------------------
    // 1) NO_TRADE upstream ⇒ nothing to evaluate.
    // ------------------------------------------------------------
    const candidate =
      ctx && ctx.signal && typeof ctx.signal.candidate === 'string'
        ? ctx.signal.candidate
        : 'NO_TRADE';
    if (candidate !== 'LONG_SETUP' && candidate !== 'SHORT_SETUP') {
      return buildBlockedDecision({ blockReason: null, reasonCodes: [] });
    }

    const re = (settings && settings.riskEngine) || {};
    const sig = (settings && settings.signalEngine) || {};

    // ------------------------------------------------------------
    // 2) Per-trade risk OOR check (Req 12.1).
    //
    // Validation occurs BEFORE the survival-layer gates so an
    // out-of-range operator request can never trigger a
    // survival-layer reason or an SL/lot-allocation call. The
    // bounds themselves are validated in
    // `algoSettings.validateSettings` (Req 12.13).
    // ------------------------------------------------------------
    const minPct = resolvePositiveNumber(re.perTradeRiskPctMin, 0.5);
    const maxPct = resolvePositiveNumber(re.perTradeRiskPctMax, 1.0);
    if (
      !isFiniteNumber(perTradeRiskPct) ||
      perTradeRiskPct < minPct ||
      perTradeRiskPct > maxPct
    ) {
      return buildBlockedDecision({
        blockReason: 'PER_TRADE_RISK_OOR',
        reasonCodes: [REASON_CODES.RISK_PER_TRADE_RISK_OOR],
      });
    }

    // ------------------------------------------------------------
    // 3) Survival-layer gates (Req 12.3 / 12.4 / 12.10 / 12.11).
    //
    // Accumulate every tripped reason code so the audit row
    // captures every cause. The decision's `blockReason` is the
    // FIRST tripped reason in the documented evaluation order
    // (KILL_SWITCH → DAILY_LOSS → EXPOSURE → COOLDOWN); the full
    // set of reason codes is exposed through `reasonCodes` and
    // lifted to `ctx.reasonCodes` by `appendBlock`.
    //
    // Kill_Switch auto-trigger (Req 12.4): the consecutive-loss
    // threshold is checked at this cycle boundary so that
    // `recordTradeClose` can stay settings-free. The flip is
    // monotonic (Req 19.6): once `killSwitch === true`, only an
    // explicit operator clear can flip it back.
    // ------------------------------------------------------------
    const re2 = (settings && settings.riskEngine) || {};
    const consecutiveLossKill = resolvePositiveNumber(re2.consecutiveLossKill, 3);
    if (
      RISK_STATE.killSwitch !== true &&
      RISK_STATE.consecutiveLosses >= consecutiveLossKill
    ) {
      requestKillSwitch({
        source: 'consecutive_loss',
        reason: `consecutiveLosses (${RISK_STATE.consecutiveLosses}) >= consecutiveLossKill (${consecutiveLossKill})`,
        triggeredAt: safeNow,
      });
    }

    /** @type {Array<{blockReason: string, reasonCode: string}>} */
    const trippedGates = [];
    if (RISK_STATE.killSwitch === true) {
      // Kill_Switch is the highest-priority survival gate. It
      // is documented FIRST in the evaluation order so the
      // emitted `blockReason` is `KILL_SWITCH` whenever the
      // switch is engaged, regardless of whether other gates
      // would also have tripped.
      trippedGates.push({
        blockReason: 'KILL_SWITCH',
        reasonCode: REASON_CODES.RISK_KILL_SWITCH,
      });
    }
    const dailyLossHit = evaluateDailyLossGate(settings);
    if (dailyLossHit) trippedGates.push(dailyLossHit);
    const exposureHit = evaluateExposureGate(settings);
    if (exposureHit) trippedGates.push(exposureHit);
    const cooldownHit = evaluateCooldownGate(settings, safeNow);
    if (cooldownHit) trippedGates.push(cooldownHit);

    if (trippedGates.length > 0) {
      return buildBlockedDecision({
        blockReason: trippedGates[0].blockReason,
        reasonCodes: trippedGates.map((g) => g.reasonCode),
      });
    }

    // ------------------------------------------------------------
    // 4) Stop-loss distance (Req 12.5).
    //
    // SL = min(maxSLPoints, max(fixedSLPoints, atrSLMultiplier × ATR)).
    //
    // When ATR is unavailable (insufficient candles), we treat
    // the ATR-based component as 0 and fall back to fixedSLPoints
    // — that keeps the gate usable on data-availability edges
    // rather than failing the cycle.
    // ------------------------------------------------------------
    const fixedSL = resolveFiniteNumber(re.fixedSLPoints, 15);
    const atrMul = resolveFiniteNumber(re.atrSLMultiplier, 1.2);
    const maxSL = resolveFiniteNumber(re.maxSLPoints, 25);

    const tf = resolveSignalTimeframe(settings, candidate);
    const bars =
      ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
        ? ctx.data.candles.spot[tf]
        : null;
    const atr = computeAtr(bars, 14);
    const atrSL = isFiniteNumber(atr) && atr > 0 ? atrMul * atr : 0;
    const stopLossPoints = Math.min(maxSL, Math.max(fixedSL, atrSL));

    // ------------------------------------------------------------
    // 5) Invalid SL guard (Req 12.7).
    //
    // SL ≤ 0 or non-finite ⇒ block + RISK_INVALID_SL, WITHOUT
    // invoking lotAllocation. This is the conservative branch
    // also used for any unexpected internal failure (see catch).
    // ------------------------------------------------------------
    if (!isFiniteNumber(stopLossPoints) || stopLossPoints <= 0) {
      return buildBlockedDecision({
        blockReason: 'INVALID_SL',
        reasonCodes: [REASON_CODES.RISK_INVALID_SL],
      });
    }

    // ------------------------------------------------------------
    // 6) Risk-reward target (Req 12.6 / 8.1.12 / 9.1.12).
    //
    // The Signal_Engine has already verified that RR ≥ minRR
    // using a placeholder constant target multiple (see
    // `signalEngine.evaluator.js`). Risk_Engine is the
    // authoritative target computer per the design's
    // "Decisions and Rationale" — we set the target distance
    // to exactly `stopLossPoints × minRR` so the emitted RR
    // equals the floor. Future subtasks will refine the target
    // using actual support / resistance levels.
    // ------------------------------------------------------------
    const minRR = resolvePositiveNumber(sig.minRR, 2.0);
    const targetPoints = stopLossPoints * minRR;
    const riskRewardRatio = minRR;

    // ------------------------------------------------------------
    // 7) Raw position size (Req 12.6).
    //
    //   rawPositionSize ≈ (perTradeRiskPct × capital ×
    //                       regime.positionSizingMultiplier)
    //                      / (stopLossPoints × lotSize)
    //
    // `perTradeRiskPct` is a percentage (e.g. 1.0 means 1%);
    // we divide by 100 here so the formula represents an
    // absolute capital-at-risk amount. `capital` falls back to
    // the legacy flat key — see "Capital sourcing" in the
    // module header for rationale.
    //
    // Lot-size correction (calibration fix): the original formula
    // (capitalAtRisk / stopLossPoints) silently treated each
    // unit of position as a single NIFTY contract, but downstream
    // consumers interpret `totalLots` as LOTS (one lot = 65 NIFTY
    // contracts). Without the lotSize divisor the engine sized
    // positions ~65× too large — a 10-day backtest sweep showed
    // 40-lot entries against ₹100K capital, which translated to
    // ~₹70K losses on standard SL hits. The correct formula
    // divides by lotSize to convert capital-at-risk into LOT
    // count.
    // ------------------------------------------------------------
    const capital = resolvePositiveNumber(
      settings && settings.capital,
      100000,
    );
    const sizingMultiplier = resolvePositiveNumber(
      ctx && ctx.regime ? ctx.regime.positionSizingMultiplier : null,
      1.0,
    );
    const lotSize = resolvePositiveNumber(
      settings && settings.lotSize,
      65,
    );
    const capitalAtRisk = (perTradeRiskPct / 100) * capital * sizingMultiplier;
    const rawPositionSize = capitalAtRisk / (stopLossPoints * lotSize);

    if (!isFiniteNumber(rawPositionSize) || rawPositionSize <= 0) {
      // Defensive: the math above is valid for any positive
      // perTradeRiskPct, capital, multiplier, and SL, but a
      // non-finite multiplier could leak through. Treat as
      // INVALID_SL since the size formula collapses.
      return buildBlockedDecision({
        blockReason: 'INVALID_SL',
        reasonCodes: [REASON_CODES.RISK_INVALID_SL],
      });
    }

    // ------------------------------------------------------------
    // 8) Hand off to lotAllocation.service.js (Req 12.6).
    //
    // The canonical lot-allocation API takes
    //   (accounts, totalLots, premium, lotSize)
    // and returns a Map of accountId → lots. The orchestrator is
    // responsible for passing the enabled account roster
    // alongside the cycle context — that plumbing arrives in
    // subtask 16. For 12.3 we therefore surface the SIZE in lots
    // (`floor(rawPositionSize)`) without per-account splits.
    // ------------------------------------------------------------
    const totalLots = Math.max(1, Math.floor(rawPositionSize));
    const lotsPerAccount = {};
    // Reference the import so a future bundler tree-shake does
    // not drop it before subtask 16 wires the call.
    void lotAllocation;

    // ------------------------------------------------------------
    // 9) Trailing SL wiring (Req 12.9).
    // ------------------------------------------------------------
    const trailing = re.enableTrailingSL === true ? buildTrailingParams() : null;

    return {
      allowEntry: true,
      blockReason: null,
      stopLossPoints,
      targetPoints,
      riskRewardRatio,
      positionSize: { lotsPerAccount, totalLots },
      trailing,
      reasonCodes: [],
    };
  } catch (_err) {
    // Conservative default on any unexpected failure: block the
    // entry with INVALID_SL so the orchestrator short-circuits
    // to NO_TRADE and the audit row records the cause.
    return buildBlockedDecision({
      blockReason: 'INVALID_SL',
      reasonCodes: [REASON_CODES.RISK_INVALID_SL],
    });
  }
}

module.exports = {
  evaluateRisk,
  // ------- 12.3 surface (state lifecycle) -------
  initSessionState,
  recordTradeClose,
  recordTradeOpen,
  recordTradeExit,
  getRiskState,
  currentExposurePct,
  checkMaxHoldExits,
  // ------- 12.6 surface (Kill_Switch lifecycle) -------
  requestKillSwitch,
  clearKillSwitch,
  // ------- 12.8 surface (risk-state persistence) -------
  setSessionId,
  persistRiskState,
  restoreRiskState,
  // ------- 15.3 surface (re-evaluation queue) -------
  requestReEvaluation,
  consumePendingReEvaluations,
  getPendingReEvaluations,
  // ------- Test-only helpers -------
  __resetRiskStateForTest,
  __deriveISTMidnight,
  __getModuleSessionIdForTest,
  // ------- Exposed for unit tests / future shared-helper migration -------
  computeAtr,
};
