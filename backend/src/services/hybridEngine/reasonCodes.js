/**
 * Hybrid_Engine — Reason Codes
 *
 * Centralised string enum of NO_TRADE / block reason codes used everywhere in the
 * hybrid institutional engine pipeline. Every NO_TRADE decision and every blocked
 * order MUST carry one of these codes so the operator can audit avoidance behaviour
 * via the `EngineEventLog` audit row.
 *
 * Source of truth: `.kiro/specs/nifty50-hybrid-institutional-engine/design.md`,
 * section "Reason Codes (NO_TRADE provenance)".
 *
 * Validates: Requirements 17.7, 18.4
 */

/**
 * @typedef {keyof typeof REASON_CODE_VALUES | `SIGNAL_MANDATORY_FAIL_${string}`} ReasonCode
 */

/**
 * Internal map of literal reason-code values. Kept as an object literal so the
 * exported `REASON_CODES` object can be deep-frozen and consumed as
 * `REASON_CODES.REGIME_BLOCK_RANGING` etc.
 *
 * `SIGNAL_MANDATORY_FAIL_<id>` is parametric (per-mandatory-condition); use the
 * `signalMandatoryFail(id)` helper to construct concrete codes. The literal
 * template string is also exposed as `SIGNAL_MANDATORY_FAIL_TEMPLATE` for
 * documentation / lookup purposes.
 */
const REASON_CODE_VALUES = {
  // Regime gates (Requirement 5, 17.1)
  REGIME_BLOCK_RANGING: "REGIME_BLOCK_RANGING",
  REGIME_BLOCK_EXPIRY_MANIPULATION: "REGIME_BLOCK_EXPIRY_MANIPULATION",
  REGIME_BLOCK_HIGH_RISK: "REGIME_BLOCK_HIGH_RISK",
  REGIME_LOW_CONFIDENCE: "REGIME_LOW_CONFIDENCE",

  // Liquidity gates (Requirement 7, 17.4)
  LIQUIDITY_VERY_WIDE_SPREAD: "LIQUIDITY_VERY_WIDE_SPREAD",
  LIQUIDITY_LOW_SCORE: "LIQUIDITY_LOW_SCORE",
  LIQUIDITY_STOP_HUNT_OPPOSES_SIDE: "LIQUIDITY_STOP_HUNT_OPPOSES_SIDE",

  // Data freshness / availability (Requirement 4)
  DATA_TICK_STALE: "DATA_TICK_STALE",
  OPTION_CHAIN_UNAVAILABLE: "OPTION_CHAIN_UNAVAILABLE",

  // Signal_Engine outputs (Requirement 11, 16)
  // SIGNAL_MANDATORY_FAIL_<id> — parametric; use signalMandatoryFail(id)
  SIGNAL_MANDATORY_FAIL_TEMPLATE: "SIGNAL_MANDATORY_FAIL_<id>",
  SIGNAL_NO_OI_CONFIRMATION: "SIGNAL_NO_OI_CONFIRMATION",
  SIGNAL_RR_BELOW_FLOOR: "SIGNAL_RR_BELOW_FLOOR",

  // Risk_Engine gates (Requirement 12)
  RISK_KILL_SWITCH: "RISK_KILL_SWITCH",
  RISK_DAILY_LOSS_EXCEEDED: "RISK_DAILY_LOSS_EXCEEDED",
  RISK_EXPOSURE_EXCEEDED: "RISK_EXPOSURE_EXCEEDED",
  RISK_COOLDOWN_ACTIVE: "RISK_COOLDOWN_ACTIVE",
  RISK_INVALID_SL: "RISK_INVALID_SL",
  RISK_PER_TRADE_RISK_OOR: "RISK_PER_TRADE_RISK_OOR",

  // Execution_Engine rejections (Requirement 13)
  EXEC_ILLIQUID_WINDOW: "EXEC_ILLIQUID_WINDOW",
  EXEC_NEWS_SPIKE: "EXEC_NEWS_SPIKE",
  EXEC_NO_ELIGIBLE_STRIKE: "EXEC_NO_ELIGIBLE_STRIKE",
  EXEC_CONFIG_INVALID: "EXEC_CONFIG_INVALID",
  EXEC_UNAUTHORISED_SOURCE: "EXEC_UNAUTHORISED_SOURCE",

  // When-not-to-trade operational filters (Requirement 17)
  WHEN_NOT_TO_TRADE_LUNCH: "WHEN_NOT_TO_TRADE_LUNCH",
  WHEN_NOT_TO_TRADE_FAKE_BREAKOUT: "WHEN_NOT_TO_TRADE_FAKE_BREAKOUT",

  // AI_Support_Layer outcomes (Requirement 14)
  AI_DOWNGRADED_TO_NO_TRADE: "AI_DOWNGRADED_TO_NO_TRADE",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",

  // Monitoring_Engine signals (Requirement 15)
  // Emitted on per-tick `MonitoringSnapshot.reasonCodes` so the audit
  // trail records WHICH self-preservation trigger fired this cycle.
  // Subtasks 15.2 (kill-switch triggers) and 15.3 (re-evaluation
  // requests) consume these codes when calling
  // `riskEngine.requestKillSwitch(...)` / re-evaluation hooks.
  MONITORING_LATENCY_BREACH: "MONITORING_LATENCY_BREACH",
  MONITORING_EDGE_DECAY: "MONITORING_EDGE_DECAY",
  MONITORING_REGIME_CHANGED: "MONITORING_REGIME_CHANGED",
  MONITORING_AI_CONFIDENCE_DECAY: "MONITORING_AI_CONFIDENCE_DECAY",

  // Monitoring_Engine re-evaluation drain (subtask 16.3 / Req 15.4 / 15.5 / 18.3).
  // Emitted by the orchestrator each cycle when it drains the
  // Risk_Engine pending re-evaluation queue. The codes record
  // WHICH source triggered the drained request so the cycle's
  // CYCLE_AUDIT row carries the provenance.
  // Mirror of `riskEngine.adapter.VALID_REEVAL_SOURCES`:
  //   - 'regime_change'        → MONITORING_REEVAL_REGIME_CHANGE
  //   - 'ai_confidence_decay'  → MONITORING_REEVAL_AI_CONFIDENCE_DECAY
  //   - 'manual'               → MONITORING_REEVAL_MANUAL
  MONITORING_REEVAL_REGIME_CHANGE: "MONITORING_REEVAL_REGIME_CHANGE",
  MONITORING_REEVAL_AI_CONFIDENCE_DECAY: "MONITORING_REEVAL_AI_CONFIDENCE_DECAY",
  MONITORING_REEVAL_MANUAL: "MONITORING_REEVAL_MANUAL",

  // Hybrid_Engine orchestrator (Requirement 18)
  // Emitted by `hybridEngine.service.js` when the outer per-cycle
  // try/catch fires — e.g. an adapter throws despite its own
  // safe-default contract. The orchestrator NEVER propagates the
  // error to the prediction loop; instead it lifts this code onto
  // `ctx.reasonCodes`, sets `ctx.finalAction = 'NO_TRADE'`, and
  // lets `ScalpingSession` recovery on next start restore the
  // identical risk state (Req 1.5 / 18.6).
  ORCHESTRATOR_ERROR: "ORCHESTRATOR_ERROR",
};

/**
 * Build a `SIGNAL_MANDATORY_FAIL_<id>` reason code for a specific mandatory
 * condition. Used by Signal_Engine when a named mandatory gate fails so that
 * the audit log records *which* mandatory condition blocked the trade.
 *
 * @param {string|number} id  Identifier of the mandatory condition that failed.
 * @returns {string}          Concrete reason code, e.g. `SIGNAL_MANDATORY_FAIL_1`.
 */
function signalMandatoryFail(id) {
  return `SIGNAL_MANDATORY_FAIL_${id}`;
}

/**
 * Frozen, immutable reason-code enum. Consumers MUST NOT mutate this object;
 * `Object.freeze` enforces this at runtime in strict mode.
 *
 * @type {Readonly<typeof REASON_CODE_VALUES>}
 */
const REASON_CODES = Object.freeze(REASON_CODE_VALUES);

module.exports = {
  REASON_CODES,
  signalMandatoryFail,
};
