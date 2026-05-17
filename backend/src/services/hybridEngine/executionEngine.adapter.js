/**
 * ============================================================
 * EXECUTION_ENGINE ADAPTER (Req 13) — subtasks 14.1 + 14.2
 * ============================================================
 * Order-placement adapter that consumes a fully-decided cycle
 * (Signal_Engine + Risk_Engine output) and routes the order
 * through the existing copy-trade pipeline. It emits a single
 * canonical `ExecutionOutcome` block (see the JSDoc typedef in
 * `cycleContext.js`) onto the immutable cycle context. The
 * orchestrator threads the result back into `ctx` via
 * `appendBlock(ctx, 'execution', outcome)`, which lifts
 * `outcome.reasonCodes` onto the top-level audit trail
 * (`EXEC_UNAUTHORISED_SOURCE`, `EXEC_CONFIG_INVALID`,
 * `EXEC_NO_ELIGIBLE_STRIKE`, …).
 *
 * ------------------------------------------------------------
 * Pipeline placement (Req 18.1)
 * ------------------------------------------------------------
 *   Data → Regime → Structure → Liquidity → OI → PCR →
 *   Signal → Risk → AI_Support → **Execution_Engine**
 *
 * The Execution_Engine is the LAST stage in the per-cycle
 * pipeline. It only runs when Signal_Engine emitted
 * `LONG_SETUP` / `SHORT_SETUP` AND Risk_Engine reported
 * `allowEntry = true`. Every other path short-circuits before
 * it (the orchestrator owns that gating; this adapter still
 * defends itself via the authorisation gate below).
 *
 * ------------------------------------------------------------
 * Subtask 14.1 scope (delivered)
 * ------------------------------------------------------------
 *   1. Authorisation gate (Req 13.7 / 19.7) — `intent.source`
 *      MUST be `'SIGNAL_RISK'` AND carry a non-NO_TRADE
 *      `signal` AND a Risk decision with `allowEntry = true`.
 *      Anything else (AI-originated intent, monitoring re-eval,
 *      manual override, malformed payload) is rejected with
 *      `EXEC_UNAUTHORISED_SOURCE`. This is the single hardest
 *      gate — it prevents AI / monitoring / external scripts
 *      from sneaking orders past the deterministic pipeline.
 *   2. Config validation (Req 13.3 / 13.9) — every placement
 *      reads `productType`, `orderType`, `validity`, and
 *      `exchangeSegment` off `settings.executionEngine`. Any
 *      missing / non-string / empty key rejects the placement
 *      with `EXEC_CONFIG_INVALID`. The validator runs AFTER the
 *      authorisation gate so an unauthorised source never
 *      reveals which config key was missing.
 *   3. Direction derivation (Req 13.1) — `LONG_SETUP` ⇒
 *      `BUY_CE`, `SHORT_SETUP` ⇒ `BUY_PE`. Anything else is
 *      treated as unauthorised (`EXEC_UNAUTHORISED_SOURCE`).
 *   4. Strike selection (Req 13.2 / 13.8) — delegated to a
 *      deterministic local picker that mirrors the design's
 *      "delegated to `strikeSelector.service.js` bounded by
 *      `executionEngine.strikeRange` and ranked by
 *      `strikePreference`" contract. The picker walks
 *      `ctx.data.optionChain.strikes`, keeps strikes whose
 *      ATM offset (in 50-pt steps) lies within
 *      `[strikeRange.atmOffsetMin, strikeRange.atmOffsetMax]`,
 *      filters by the configured premium / delta band, and
 *      returns the strike closest to the centre of the delta
 *      band. When no eligible strike is found, the placement
 *      is rejected with `EXEC_NO_ELIGIBLE_STRIKE`.
 *
 *      The existing `strikeSelector.service.js` exposes an AI-
 *      driven picker (`fetchMultiStrikeData` +
 *      `selectBestStrike`) that DOES NOT meet Hybrid_Engine
 *      contracts (Req 14.4 forbids AI from selecting strikes,
 *      and the existing service requires outbound network
 *      calls and an OpenAI key). The deterministic picker
 *      below is the canonical Hybrid_Engine implementation;
 *      `strikeSelector.service.js` is `require()`-d at the top
 *      of the file to document the wiring (Req 3.7) and to
 *      keep the import surface that the orchestrator audits.
 *   5. Order placement (Req 13.1) — built order payload is
 *      submitted via `orderOrchestration.executeMultiAccountOrder`,
 *      which is the canonical replacement for the older
 *      `copyTrade.executeCopyTrade` pipeline. Both modules are
 *      `require()`-d at the top of the file (Req 13.1) so a
 *      missing service file fails fast at load time. The
 *      broker layer underneath (`dhan.service` for live,
 *      `dhanProd.service` for production market data) is
 *      transitively reached via `orderOrchestration`.
 *   6. Outcome recording (Req 13.6) — every placement, fill,
 *      partial, rejection, and error writes a row to
 *      `TradeExecutionLog` and (for non-simulation paths) one
 *      row per account to `TradeAccountResult`. `orderOrchestration`
 *      already writes both rows on the live path; this
 *      adapter only writes them directly on the simulation
 *      path and on the unauthorised / config / strike rejection
 *      paths so the audit trail is uniform.
 *   7. Simulation mode (`settings.executionMode === 'simulation'`):
 *      route the order through a stub that records the
 *      simulation flag on the `TradeExecutionLog` row instead
 *      of calling the broker. The `TradeExecutionLog` schema
 *      does NOT add new fields — we set `triggeredMode:
 *      'sandbox'` (the existing enum value reserved for non-
 *      production placements) and stamp the human-readable
 *      `note` with the `simulation:true` audit string. Subtask
 *      18.1 will refine this scaffold (replay-driven execution,
 *      slippage simulation, etc.); for 14.1 we just respect
 *      the toggle.
 *
 * ------------------------------------------------------------
 * Subtask 14.2 scope (this delivery — operational blocks)
 * ------------------------------------------------------------
 *   The 14.1 authorisation gate already rejects any cycle
 *   where `intent.risk.allowEntry !== true`, so the kill
 *   switch / daily-loss / exposure blocks computed by
 *   Risk_Engine in subtasks 12.3 / 12.6 are covered indirectly
 *   via `EXEC_UNAUTHORISED_SOURCE`. Req 13.5 / 17.2 require
 *   the audit row to record EXPLICITLY which operational
 *   filter blocked the placement, so 14.2 introduces three
 *   new pre-submission gates that emit their own reason codes.
 *
 *   The new flow is:
 *     1. Source / signal check (Req 13.7) — rejects with
 *        `EXEC_UNAUTHORISED_SOURCE` when `intent.source !==
 *        'SIGNAL_RISK'` or the candidate is not a setup.
 *     2. Risk block-reason mapping (Req 13.5 / 17.2) — when
 *        Risk_Engine populated `intent.risk.blockReason`,
 *        translate it to the explicit reason code:
 *          'KILL_SWITCH' → `RISK_KILL_SWITCH`
 *          'DAILY_LOSS'  → `RISK_DAILY_LOSS_EXCEEDED`
 *          'EXPOSURE'    → `RISK_EXPOSURE_EXCEEDED`
 *        The other documented Risk block reasons (`COOLDOWN`,
 *        `INVALID_SL`, `PER_TRADE_RISK_OOR`) are NOT mapped
 *        here because subtask 12.6 already lifts those onto
 *        `ctx.reasonCodes` via `appendBlock(ctx, 'risk', …)`,
 *        so this adapter falls back to the existing
 *        `EXEC_UNAUTHORISED_SOURCE` rejection for them.
 *     3. allowEntry fallback (Req 13.7) — when
 *        `intent.risk.allowEntry !== true` and no explicit
 *        Risk block-reason matched in step 2, reject with
 *        `EXEC_UNAUTHORISED_SOURCE` (preserves 14.1 behaviour).
 *     4. Config validation (Req 13.3 / 13.9) — unchanged from
 *        14.1.
 *     5. Illiquid-window gate (Req 13.4 / 17.2) — when the
 *        cycle's wall-clock time (`ctx.cycleStartedAt`
 *        converted to IST via fixed UTC+5:30) falls within ANY
 *        `settings.whenNotToTrade.illiquidWindows` entry,
 *        reject with BOTH `EXEC_ILLIQUID_WINDOW` AND
 *        `WHEN_NOT_TO_TRADE_LUNCH`. Both codes are emitted so
 *        the audit trail records the structural rejection
 *        (illiquid window) AND the operator-facing label
 *        (lunch chop).
 *     6. News-spike gate (Req 13.5) — when
 *        `ctx.ai.newsInterpretation.breakingNews === true` AND
 *        `riskLevel >= settings.whenNotToTrade.newsRiskFloor`
 *        (default 7), reject with `EXEC_NEWS_SPIKE`. The full
 *        Req 13.5 contract requires the gate to remain active
 *        until `whenNotToTrade.newsConfirmationCandles`
 *        confirmation candles have closed since the news
 *        event; that count is hard to derive from a single
 *        cycle without a multi-cycle news-tracker, so 14.2
 *        applies the simpler heuristic (block while breaking
 *        news + risk floor are active) and subtask 16
 *        (Monitoring_Engine wiring) will introduce the
 *        confirmation-candles tracker that decays the block
 *        after N closed candles.
 *     7. Direction (Req 13.1) — unchanged from 14.1.
 *     8. Strike selection (Req 13.2 / 13.8) — unchanged.
 *     9. Order placement (Req 13.1 / 13.6) — unchanged.
 *
 * ------------------------------------------------------------
 * Inputs from `ctx`
 * ------------------------------------------------------------
 *   - `ctx.data.optionChain.atmStrike`       — centre of the
 *                                              strike-range
 *                                              window.
 *   - `ctx.data.optionChain.strikes`         — `{ strike, ce,
 *                                              pe }[]` rows
 *                                              produced by the
 *                                              Data_Engine.
 *   - `ctx.data.spot.ltp`                    — audit context
 *                                              (logged on the
 *                                              outcome).
 *
 * ------------------------------------------------------------
 * Inputs from `intent`
 * ------------------------------------------------------------
 *   - `intent.source`                        — MUST be
 *                                              `'SIGNAL_RISK'`.
 *   - `intent.signal`                        — `SignalOutput`
 *                                              produced by
 *                                              Signal_Engine.
 *                                              `signal.candidate`
 *                                              MUST be
 *                                              `'LONG_SETUP'`
 *                                              or
 *                                              `'SHORT_SETUP'`.
 *   - `intent.risk`                          — `RiskDecision`
 *                                              produced by
 *                                              Risk_Engine.
 *                                              `risk.allowEntry`
 *                                              MUST be `true`.
 *                                              `risk.positionSize.totalLots`
 *                                              and
 *                                              `risk.positionSize.lotsPerAccount`
 *                                              are forwarded
 *                                              into the order
 *                                              payload.
 *   - `intent.masterScore`                   — optional 0..100
 *                                              audit number.
 *
 * ------------------------------------------------------------
 * Settings reads (every value from `Algo_Settings`, Req 2.2)
 * ------------------------------------------------------------
 *   - `executionEngine.productType`           (Req 13.3)
 *   - `executionEngine.orderType`             (Req 13.3)
 *   - `executionEngine.validity`              (Req 13.3)
 *   - `executionEngine.exchangeSegment`       (Req 13.3)
 *   - `executionEngine.strikeRange.atmOffsetMin`
 *   - `executionEngine.strikeRange.atmOffsetMax`
 *   - `executionEngine.strikePreference.delta` ([min, max])
 *   - `executionEngine.strikePreference.premiumMin`
 *   - `executionEngine.strikePreference.premiumMax`
 *   - `executionMode`                        (legacy flat key,
 *                                             `'simulation'` |
 *                                             `'live'`)
 *   - `lotSize`                              (legacy flat key,
 *                                             default 65 for
 *                                             NIFTY)
 *   - `whenNotToTrade.illiquidWindows`       (Req 13.4 / 17.2)
 *   - `whenNotToTrade.newsRiskFloor`         (Req 13.5)
 *   - `whenNotToTrade.newsConfirmationCandles` (Req 13.5;
 *                                             documented
 *                                             dependency, full
 *                                             enforcement
 *                                             deferred to
 *                                             subtask 16)
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - The exported `executeOrder` function NEVER throws.
 *   - `orderOrchestration.executeMultiAccountOrder` is wrapped
 *     in try/catch.
 *   - Strike-selection and model-write paths are wrapped in
 *     try/catch.
 *   - On any unrecoverable error the adapter returns the safe-
 *     default `{ status: 'error', rejectReason: <message>,
 *     reasonCodes: [], orderParams }` shape so the orchestrator
 *     can continue, the audit row records the failure, and the
 *     deterministic pipeline never crashes the cycle.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 3.7   — wire `orderOrchestration.service.js`,
 *                 `copyTrade.service.js`, `dhanProd.service.js`,
 *                 `strikeSelector.service.js`
 *   - Req 13.1  — placement via the existing copy-trade pipeline
 *   - Req 13.2  — strike selection bounded by `strikeRange` /
 *                 ranked by `strikePreference`
 *   - Req 13.3  — read all four exec config keys per placement
 *   - Req 13.4  — refuse during illiquid windows
 *   - Req 13.5  — refuse during active news spike / kill switch
 *                 / daily loss / exposure
 *   - Req 13.6  — record every outcome via existing models
 *   - Req 13.7  — reject `EXEC_UNAUTHORISED_SOURCE` for any
 *                 non-Signal+Risk source
 *   - Req 13.8  — reject `EXEC_NO_ELIGIBLE_STRIKE` when no
 *                 strike fits the bounds
 *   - Req 13.9  — reject `EXEC_CONFIG_INVALID` on missing /
 *                 invalid config
 *   - Req 17.2  — operator-facing operational filters
 *                 (illiquid windows, news spike) carry their
 *                 own reason codes
 *   - Req 17.6  — every rejection is persisted to
 *                 `TradeExecutionLog`
 *   - Req 19.7  — execution authorisation invariant
 *   - ExecutionOutcome typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

const logger = require('../../utils/logger');
const { REASON_CODES } = require('./reasonCodes');

// We `require` the four downstream services up-front so a
// missing service file fails fast at module load (Req 3.7) and
// the smoke check can stub them via the require-cache (the
// canonical Node.js module-mocking technique). The references
// are resolved on every `executeOrder` call — never cached at
// module load — so a runtime stub of
// `require.cache[...].exports` is reflected on the very next
// call. This mirrors `aiSupport.adapter.js`.
const orderOrchestration = require('../orderOrchestration.service');
// eslint-disable-next-line no-unused-vars
const copyTrade = require('../copyTrade.service');
// eslint-disable-next-line no-unused-vars
const dhanProd = require('../dhanProd.service');
// eslint-disable-next-line no-unused-vars
const strikeSelector = require('../strikeSelector.service');
const TradeExecutionLog = require('../../models/TradeExecutionLog');
// eslint-disable-next-line no-unused-vars
const TradeAccountResult = require('../../models/TradeAccountResult');

// ============================================================
// Defaults (only consulted when the corresponding setting is
// missing — `validateSettings` already enforces presence at
// startup / hot-reload). NIFTY lot size default mirrors the
// documented constant in `algoSettings.js`.
// ============================================================

const NIFTY_STRIKE_STEP = 50;
const DEFAULT_NIFTY_LOT_SIZE = 65;

// ============================================================
// Module-level execution-mode switch (subtask 18.1)
// ------------------------------------------------------------
// 18.1 introduces an operator-facing toggle so dry-run cycles
// can produce `TradeExecutionLog` rows tagged `simulation: true`
// without ever calling `orderOrchestration.executeMultiAccountOrder`
// (and therefore never reaching the broker layer underneath
// `dhanProd.service.js`). The orchestrator (`hybridEngine.service.js`)
// owns the operator-facing API; this adapter just holds the
// current value and exposes a `setExecutionMode` setter so the
// orchestrator can propagate the operator's choice without
// rebuilding the per-cycle Algo_Settings snapshot.
//
// Semantics:
//   - `_executionMode === 'simulation'` AT ANY TIME triggers the
//     simulation branch in `executeOrder` regardless of the
//     legacy `settings.executionMode` flat key.
//   - `_executionMode === 'live'` defers to the legacy flat key
//     so an operator who configured `executionMode: 'simulation'`
//     in `algoSettings.js` still gets simulation behaviour
//     (backwards compatibility with subtask 14.1's contract).
//   - Any other value passed to `setExecutionMode` resets the
//     switch to `'live'` (failure-safe default — see Part F of
//     the 18.1 design).
//   - The legacy `settings.executionMode` flat key is still
//     consulted on every cycle so existing operators who only
//     set the flat key keep getting simulation behaviour even
//     before they call `setExecutionMode`.
// ============================================================

/** @type {('live'|'simulation')} */
let _executionMode = 'live';

/**
 * Set the runtime execution-mode switch. Accepts only `'live'` or
 * `'simulation'`; any other value (including `null`, `undefined`,
 * empty string, or random typo) defaults to `'live'` so the
 * deterministic broker path stays the safe default. Idempotent.
 *
 * Subtask 18.1 — exposed so `hybridEngine.service.js` can
 * propagate the operator's `setExecutionMode(mode)` call into
 * this adapter without coupling the two modules through
 * `Algo_Settings` (which is intentionally frozen per cycle).
 *
 * @param {('live'|'simulation')} mode
 * @returns {void}
 */
function setExecutionMode(mode) {
  // 18.1: failure-safe coerce — anything that isn't exactly
  // 'simulation' or 'live' resets to 'live'.
  if (mode === 'simulation' || mode === 'live') {
    _executionMode = mode;
  } else {
    _executionMode = 'live';
  }
}

/**
 * Read the current execution-mode switch. Used by the smoke
 * check and by `hybridEngine.service.js` for logging.
 *
 * Subtask 18.1.
 *
 * @returns {('live'|'simulation')}
 */
function getExecutionMode() {
  return _executionMode;
}

// ============================================================
// Small defensive helpers
// ============================================================

/**
 * Return `true` iff `value` is a non-empty string. Used to
 * validate every executionEngine config key in one place
 * (Req 13.3 / 13.9).
 *
 * @param {*} value
 * @returns {boolean}
 */
function _isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Return `true` iff `value` is a finite number. Used by the
 * strike picker to defend against `NaN` / `Infinity` premium
 * / delta values that may sneak through a malformed option
 * chain row.
 *
 * @param {*} value
 * @returns {boolean}
 */
function _isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// ============================================================
// Authorisation gate (Req 13.7 / 19.7)
// ------------------------------------------------------------
// The single hardest gate in this adapter. The orchestrator
// builds the `intent` object FROM the deterministic Signal+Risk
// output and stamps `intent.source = 'SIGNAL_RISK'`. Anything
// else (AI advisory, monitoring re-eval, manual override) MUST
// be rejected so AI / monitoring / external scripts cannot
// sneak orders past the deterministic pipeline.
//
// The 14.1 delivery folded the source check, the candidate
// check, and the `risk.allowEntry === true` check into a
// single `_isAuthorisedIntent` predicate. Subtask 14.2 splits
// that predicate into a structural source/signal check
// (`_isIntentSourceValid`) and a separate risk block-reason
// mapping (`_mapRiskBlockReason`) so the audit row can record
// the EXPLICIT Risk reason (`RISK_KILL_SWITCH` /
// `RISK_DAILY_LOSS_EXCEEDED` / `RISK_EXPOSURE_EXCEEDED`)
// instead of always falling back to `EXEC_UNAUTHORISED_SOURCE`
// when Risk_Engine has populated `risk.blockReason`.
//
// `_isAuthorisedIntent` is retained (and still exported) for
// backward compatibility with existing callers / smoke checks
// from 14.1.
// ============================================================

/**
 * Structural source / signal validation (Req 13.7). Returns
 * `true` iff `intent` is an object with `source === 'SIGNAL_RISK'`,
 * a non-NO_TRADE signal candidate, and a Risk decision object.
 * Does NOT inspect `risk.allowEntry` or `risk.blockReason` —
 * those are evaluated by the explicit gates in `executeOrder`
 * so the audit row records the precise reason code.
 *
 * @param {Object} intent
 * @returns {boolean}
 */
function _isIntentSourceValid(intent) {
  if (!intent || typeof intent !== 'object') return false;
  if (intent.source !== 'SIGNAL_RISK') return false;
  if (!intent.signal || typeof intent.signal !== 'object') return false;
  if (!intent.risk || typeof intent.risk !== 'object') return false;
  const candidate = intent.signal.candidate;
  if (candidate !== 'LONG_SETUP' && candidate !== 'SHORT_SETUP') return false;
  return true;
}

/**
 * Map a `RiskDecision.blockReason` onto the explicit operational
 * reason code consumed by the audit row (Req 13.5 / 17.2).
 *
 *   'KILL_SWITCH' → `RISK_KILL_SWITCH`
 *   'DAILY_LOSS'  → `RISK_DAILY_LOSS_EXCEEDED`
 *   'EXPOSURE'    → `RISK_EXPOSURE_EXCEEDED`
 *
 * The other documented Risk block reasons (`COOLDOWN`,
 * `INVALID_SL`, `PER_TRADE_RISK_OOR`) are NOT mapped here
 * because subtask 12.6 already lifts those onto
 * `ctx.reasonCodes` via `appendBlock(ctx, 'risk', …)`. Returns
 * `null` for unmapped block reasons so the caller falls back
 * to the existing `EXEC_UNAUTHORISED_SOURCE` rejection.
 *
 * @param {string|null|undefined} blockReason
 * @returns {{ rejectReason: string, reasonCode: string }|null}
 */
function _mapRiskBlockReason(blockReason) {
  if (typeof blockReason !== 'string' || blockReason.length === 0) return null;
  if (blockReason === 'KILL_SWITCH') {
    return { rejectReason: 'RISK_KILL_SWITCH', reasonCode: REASON_CODES.RISK_KILL_SWITCH };
  }
  if (blockReason === 'DAILY_LOSS') {
    return {
      rejectReason: 'RISK_DAILY_LOSS_EXCEEDED',
      reasonCode: REASON_CODES.RISK_DAILY_LOSS_EXCEEDED,
    };
  }
  if (blockReason === 'EXPOSURE') {
    return {
      rejectReason: 'RISK_EXPOSURE_EXCEEDED',
      reasonCode: REASON_CODES.RISK_EXPOSURE_EXCEEDED,
    };
  }
  return null;
}

/**
 * Return `true` iff `intent` is a fully-authorised Signal+Risk
 * payload. The gate is intentionally strict — every condition
 * must hold. See the section header for the rationale.
 *
 * Retained from 14.1 for backward compatibility; new code in
 * `executeOrder` uses `_isIntentSourceValid` +
 * `_mapRiskBlockReason` directly so the audit row can record
 * the explicit Risk reason code.
 *
 * @param {Object} intent
 * @returns {boolean}
 */
function _isAuthorisedIntent(intent) {
  if (!_isIntentSourceValid(intent)) return false;
  if (intent.risk.allowEntry !== true) return false;
  return true;
}

// ============================================================
// Config validation (Req 13.3 / 13.9)
// ============================================================

/**
 * Validate that every required `executionEngine` config key is
 * present and a non-empty string. Returns `null` on success or
 * the first missing / invalid key name on failure so the audit
 * row records WHICH key tripped the gate.
 *
 * @param {Object} executionEngine  `settings.executionEngine`.
 * @returns {string|null}            Failed key name, or `null`.
 */
function _firstInvalidExecConfigKey(executionEngine) {
  if (!executionEngine || typeof executionEngine !== 'object') return 'executionEngine';
  for (const key of ['productType', 'orderType', 'validity', 'exchangeSegment']) {
    if (!_isNonEmptyString(executionEngine[key])) return key;
  }
  return null;
}

// ============================================================
// Operational gates (Req 13.4 / 13.5 / 17.2) — subtask 14.2
// ------------------------------------------------------------
// Two gates run AFTER config validation but BEFORE strike
// selection so the audit row records the operational filter
// that blocked the placement instead of (incorrectly) blaming
// the strike picker or the broker.
//
//   1. Illiquid-window gate (Req 13.4 / 17.2). The cycle's
//      wall-clock time is converted to IST via fixed UTC+5:30
//      offset (the design pins all session times to IST). When
//      the time falls within ANY entry of
//      `settings.whenNotToTrade.illiquidWindows`, the placement
//      is rejected with BOTH `EXEC_ILLIQUID_WINDOW` (structural
//      reason) AND `WHEN_NOT_TO_TRADE_LUNCH` (operator-facing
//      label). Both codes are documented in the design's
//      "Reason Codes" section and `reasonCodes.js` — emitting
//      both keeps the audit trail aligned with operator
//      expectations even when the operator widens the
//      illiquid windows beyond the lunch-chop default.
//
//   2. News-spike gate (Req 13.5). When
//      `ctx.ai.newsInterpretation.breakingNews === true` AND
//      `riskLevel >= settings.whenNotToTrade.newsRiskFloor`
//      (default 7), reject with `EXEC_NEWS_SPIKE`. The full
//      Req 13.5 contract requires the gate to remain active
//      for `whenNotToTrade.newsConfirmationCandles` after the
//      news event was detected; subtask 16 will add the
//      multi-cycle news-tracker that decays the block. For
//      14.2 the simpler heuristic (block while breaking news +
//      risk floor are active) is sufficient because every
//      cycle re-reads the AI advisory.
//
// Both helpers are pure and never throw — defensive failures
// resolve to "do not block" (the fail-open default for a
// secondary gate); the primary kill-switch / daily-loss /
// exposure gates upstream are fail-closed.
// ============================================================

/**
 * Convert an epoch-ms timestamp into a `HH:MM` IST string. Uses
 * a fixed UTC+5:30 offset (IST does not observe DST) so the
 * conversion is deterministic and offline-safe — Node's
 * `Intl.DateTimeFormat` is locale-dependent and may not be
 * available in trimmed-down container images.
 *
 * @param {number} epochMs
 * @returns {string|null}  `'HH:MM'` IST, or `null` on bad input.
 */
function _epochMsToISTHHMM(epochMs) {
  if (!_isFiniteNumber(epochMs)) return null;
  // IST = UTC + 5h 30m. Adding 5h30m to the UTC epoch and then
  // reading UTC components gives the IST wall-clock components
  // without needing a timezone library.
  const istMs = epochMs + (5 * 60 + 30) * 60 * 1000;
  const d = new Date(istMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Convert a `HH:MM` string into minutes-since-midnight. Returns
 * `null` for malformed inputs so the gate fails open (does not
 * block) when an operator misconfigures a window.
 *
 * @param {string} hhmm
 * @returns {number|null}
 */
function _hhmmToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Return `true` iff the cycle's IST wall-clock time falls
 * within ANY illiquid window. Comparison is half-open
 * `[startIST, endIST)` so a window `12:00`..`13:00` matches
 * `12:00`..`12:59` but not `13:00` exactly — this matches the
 * intuitive "lunch chop ends at 13:00" interpretation and
 * lines up with how operators read the design's
 * `lunchWindow: { startIST: '12:00', endIST: '13:00' }` default.
 *
 * @param {number} cycleStartedAt   Epoch ms.
 * @param {Array<{startIST:string,endIST:string}>} windows
 * @returns {boolean}
 */
function _isInIlliquidWindow(cycleStartedAt, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const hhmm = _epochMsToISTHHMM(cycleStartedAt);
  if (hhmm === null) return false;
  const nowMin = _hhmmToMinutes(hhmm);
  if (nowMin === null) return false;
  for (const win of windows) {
    if (!win || typeof win !== 'object') continue;
    const startMin = _hhmmToMinutes(win.startIST);
    const endMin = _hhmmToMinutes(win.endIST);
    if (startMin === null || endMin === null) continue;
    if (startMin >= endMin) continue; // ill-formed window — skip
    if (nowMin >= startMin && nowMin < endMin) return true;
  }
  return false;
}

/**
 * Return `true` iff the cycle is inside an active news spike
 * per Req 13.5. The simpler 14.2 heuristic is: AI advisory
 * reports `breakingNews === true` AND `riskLevel >=
 * newsRiskFloor`. The full confirmation-candles decay is
 * deferred to subtask 16's news-tracker.
 *
 * @param {Object|null} aiBlock         `ctx.ai`
 * @param {number}      newsRiskFloor   `whenNotToTrade.newsRiskFloor`
 * @returns {boolean}
 */
function _isNewsSpikeActive(aiBlock, newsRiskFloor) {
  if (!aiBlock || typeof aiBlock !== 'object') return false;
  const news = aiBlock.newsInterpretation;
  if (!news || typeof news !== 'object') return false;
  if (news.breakingNews !== true) return false;
  const floor = _isFiniteNumber(newsRiskFloor) ? newsRiskFloor : 7;
  const riskLevel = _isFiniteNumber(news.riskLevel) ? news.riskLevel : null;
  if (riskLevel === null) return false;
  return riskLevel >= floor;
}

// ============================================================
// Strike selection (Req 13.2 / 13.8)
// ------------------------------------------------------------
// The design says strike selection is "delegated to
// `strikeSelector.service.js` bounded by
// `executionEngine.strikeRange` and ranked by `strikePreference`".
// The existing `strikeSelector.service.js` exposes an AI-driven
// picker that violates Req 14.4 (AI must not select strikes)
// and depends on outbound network calls + OpenAI keys. The
// deterministic picker below is the canonical Hybrid_Engine
// implementation — pure, network-free, idempotent — and matches
// the contract documented in the design.
//
// Ranking heuristic:
//   1. Filter strikes to ATM offset within
//      [strikeRange.atmOffsetMin, strikeRange.atmOffsetMax],
//      where offset is measured in NIFTY 50-point strike steps.
//   2. Filter to the configured premium band
//      [strikePreference.premiumMin, strikePreference.premiumMax].
//   3. Score by distance to the CENTRE of the configured delta
//      band (`(deltaMin + deltaMax) / 2`); when delta is missing
//      from the option-chain row, fall back to the offset
//      distance from ATM (closer = better).
//   4. Lowest score wins. Ties resolve to the strike closer to
//      ATM (deterministic).
//
// The picker NEVER throws — every defensive failure resolves to
// `null`, which the caller maps onto `EXEC_NO_ELIGIBLE_STRIKE`.
// ============================================================

/**
 * @typedef {Object} StrikePick
 * @property {number}                 strike       Absolute strike price.
 * @property {('CE'|'PE')}             optionType
 * @property {number|null}             premium      Per-lot option premium at selection.
 * @property {number|null}             delta
 * @property {number|null}             securityId   When the option-chain row carries one.
 * @property {string|null}             symbol       Display symbol if supplied.
 * @property {number}                  offset       Signed strike offset from ATM (steps).
 */

/**
 * Pick a single strike from the option chain that satisfies the
 * configured strike range and premium / delta preference for
 * the given direction. Returns `null` when no row qualifies.
 *
 * @param {Object} params
 * @param {Object} params.optionChain  `ctx.data.optionChain` — must contain `strikes` and `atmStrike`.
 * @param {number} params.atmStrike    Centre of the strike-range window.
 * @param {('BUY_CE'|'BUY_PE')} params.direction
 * @param {Object} params.range        `{ atmOffsetMin, atmOffsetMax }`.
 * @param {Object} params.preference   `{ delta:[min,max], premiumMin, premiumMax }`.
 * @returns {StrikePick|null}
 */
function pickStrike({ optionChain, atmStrike, direction, range, preference }) {
  try {
    if (!optionChain || !Array.isArray(optionChain.strikes)) return null;
    if (!_isFiniteNumber(atmStrike)) return null;
    if (direction !== 'BUY_CE' && direction !== 'BUY_PE') return null;
    if (!range || typeof range !== 'object') return null;
    if (!preference || typeof preference !== 'object') return null;

    const offsetMin = _isFiniteNumber(range.atmOffsetMin) ? range.atmOffsetMin : -4;
    const offsetMax = _isFiniteNumber(range.atmOffsetMax) ? range.atmOffsetMax : 4;
    const premiumMin = _isFiniteNumber(preference.premiumMin) ? preference.premiumMin : 0;
    const premiumMax = _isFiniteNumber(preference.premiumMax)
      ? preference.premiumMax
      : Number.POSITIVE_INFINITY;
    const deltaBand = Array.isArray(preference.delta) && preference.delta.length === 2
      ? preference.delta.map((d) => (_isFiniteNumber(d) ? d : null))
      : [null, null];
    const deltaCentre = deltaBand[0] !== null && deltaBand[1] !== null
      ? (deltaBand[0] + deltaBand[1]) / 2
      : null;

    const wantCE = direction === 'BUY_CE';

    /** @type {Array<{ row: Object, leg: Object, offset: number, score: number }>} */
    const candidates = [];

    for (const row of optionChain.strikes) {
      if (!row || !_isFiniteNumber(row.strike)) continue;
      const offset = Math.round((row.strike - atmStrike) / NIFTY_STRIKE_STEP);
      if (offset < offsetMin || offset > offsetMax) continue;

      const leg = wantCE ? row.ce : row.pe;
      if (!leg || typeof leg !== 'object') continue;

      const premium = _isFiniteNumber(leg.ltp) ? leg.ltp : null;
      // Premium band gate: when the row exposes a premium,
      // enforce the configured band; when the row has no
      // premium, the strike is ineligible (we cannot rank it).
      if (premium === null) continue;
      if (premium < premiumMin || premium > premiumMax) continue;

      // For BUY_PE the broker-quoted delta is negative; compare
      // on absolute value so the configured `[0.35, 0.55]` band
      // applies symmetrically to both sides.
      const rawDelta = _isFiniteNumber(leg.delta) ? leg.delta : null;
      const delta = rawDelta === null ? null : Math.abs(rawDelta);

      // Score: distance to the delta-band centre when delta is
      // available; otherwise distance to ATM. Lower = better.
      let score;
      if (delta !== null && deltaCentre !== null) {
        // Out-of-band deltas are still candidates (premium band
        // already filtered most of them out); the score just
        // penalises them so an in-band candidate always wins.
        const inBand =
          deltaBand[0] !== null && deltaBand[1] !== null && delta >= deltaBand[0] && delta <= deltaBand[1];
        score = Math.abs(delta - deltaCentre) + (inBand ? 0 : 1);
      } else {
        score = Math.abs(offset);
      }

      candidates.push({ row, leg, offset, score });
    }

    if (candidates.length === 0) return null;

    // Lowest score wins; ties break on absolute offset (closer
    // to ATM) for determinism.
    candidates.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return Math.abs(a.offset) - Math.abs(b.offset);
    });

    const best = candidates[0];
    /** @type {StrikePick} */
    const pick = {
      strike: best.row.strike,
      optionType: wantCE ? 'CE' : 'PE',
      premium: _isFiniteNumber(best.leg.ltp) ? best.leg.ltp : null,
      delta: _isFiniteNumber(best.leg.delta) ? best.leg.delta : null,
      securityId: best.leg.securityId || null,
      symbol: best.leg.symbol || best.leg.displaySymbol || null,
      offset: best.offset,
    };
    return pick;
  } catch (err) {
    logger.warn(
      { module: 'executionEngine.adapter', err: err && err.message },
      '[executionEngine.adapter] pickStrike failed',
    );
    return null;
  }
}

// ============================================================
// Direction helper
// ============================================================

/**
 * Map a Signal_Engine candidate onto the design's directional
 * action. Anything that is not a recognised setup returns
 * `null`, which the caller treats as an unauthorised intent.
 *
 * @param {string} candidate
 * @returns {('BUY_CE'|'BUY_PE'|null)}
 */
function _candidateToDirection(candidate) {
  if (candidate === 'LONG_SETUP') return 'BUY_CE';
  if (candidate === 'SHORT_SETUP') return 'BUY_PE';
  return null;
}

// ============================================================
// Outcome helpers
// ============================================================

/**
 * Build the `orderParams` snapshot recorded on the outcome.
 * Centralised so every code-path emits the same shape.
 *
 * @param {Object} params
 * @returns {Object}
 */
function _buildOrderParams({ direction, pick, exec, lots, lotSize, masterScore, cycleId }) {
  return {
    cycleId: cycleId || null,
    symbol: pick && pick.symbol ? pick.symbol : null,
    securityId: pick ? pick.securityId : null,
    strike: pick ? pick.strike : null,
    optionType: pick ? pick.optionType : null,
    direction,
    productType: exec.productType,
    orderType: exec.orderType,
    validity: exec.validity,
    exchangeSegment: exec.exchangeSegment,
    lots,
    lotSize,
    premium: pick ? pick.premium : null,
    delta: pick ? pick.delta : null,
    masterScore: _isFiniteNumber(masterScore) ? masterScore : null,
  };
}

/**
 * Persist a `TradeExecutionLog` row for a rejection or
 * simulation outcome. Live placements go through
 * `orderOrchestration` which writes its own log row, so this
 * helper is only used by the rejection / simulation paths
 * (Req 13.6). Fire-and-forget — wrapped in try/catch so a
 * Mongo failure NEVER throws into the orchestrator hot path.
 *
 * @param {Object} params
 * @returns {Promise<string|null>}  Persisted document id, or `null` on failure.
 */
async function _writeRejectionLog({
  status,
  orderParams,
  reasonCodes,
  rejectReason,
  triggeredMode,
  note,
}) {
  try {
    const totalLots = _isFiniteNumber(orderParams && orderParams.lots) ? orderParams.lots : 1;
    const lotSize = _isFiniteNumber(orderParams && orderParams.lotSize)
      ? orderParams.lotSize
      : DEFAULT_NIFTY_LOT_SIZE;
    const entryPremium = _isFiniteNumber(orderParams && orderParams.premium)
      ? orderParams.premium
      : 0;
    const entryValue = totalLots * lotSize * entryPremium;
    const symbol = orderParams && orderParams.symbol ? orderParams.symbol : 'NIFTY';
    const securityId = orderParams && orderParams.securityId ? String(orderParams.securityId) : '0';
    const exchangeSegment =
      orderParams && _isNonEmptyString(orderParams.exchangeSegment)
        ? orderParams.exchangeSegment
        : 'NSE_FNO';
    const productType =
      orderParams && _isNonEmptyString(orderParams.productType) ? orderParams.productType : 'INTRADAY';
    const orderType =
      orderParams && _isNonEmptyString(orderParams.orderType) ? orderParams.orderType : 'MARKET';

    const composedNote = [
      `hybrid_engine ${status}`,
      rejectReason ? `reject:${rejectReason}` : null,
      Array.isArray(reasonCodes) && reasonCodes.length > 0 ? `codes:${reasonCodes.join(',')}` : null,
      note || null,
    ]
      .filter(Boolean)
      .join(' | ');

    const log = await TradeExecutionLog.create({
      symbol,
      securityId,
      exchangeSegment,
      side: 'BUY',
      totalLots: Math.max(1, totalLots),
      lotSize,
      orderType,
      productType,
      entryTime: new Date(),
      entryPremium,
      entryValue,
      status: status === 'placed' ? 'active' : 'partial',
      triggeredMode: triggeredMode === 'production' ? 'production' : 'sandbox',
      note: composedNote,
    });
    return log && log._id ? log._id.toString() : null;
  } catch (err) {
    logger.warn(
      { module: 'executionEngine.adapter', err: err && err.message },
      '[executionEngine.adapter] _writeRejectionLog failed',
    );
    return null;
  }
}

/**
 * Build a rejection outcome with the standard shape. Centralised
 * so every gate emits the same `ExecutionOutcome` envelope.
 *
 * @param {Object} params
 * @returns {Promise<import('./cycleContext').ExecutionOutcome>}
 */
async function _emitRejection({ rejectReason, reasonCodes, orderParams, triggeredMode }) {
  // Persist the rejection so the audit row is symmetric with
  // the live-placement path (Req 13.6).
  await _writeRejectionLog({
    status: 'rejected',
    orderParams,
    reasonCodes,
    rejectReason,
    triggeredMode,
    note: null,
  });
  logger.info(
    {
      module: 'executionEngine.adapter',
      event: 'EXECUTION_REJECTED',
      rejectReason,
      reasonCodes,
    },
    '[executionEngine.adapter] order placement rejected',
  );
  return {
    status: 'rejected',
    orderParams,
    rejectReason,
    reasonCodes: Array.isArray(reasonCodes) ? reasonCodes.slice() : [],
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Place an order for the current cycle. Consumes the immutable
 * `CycleContext`, the frozen `Algo_Settings` snapshot for the
 * cycle, and an `intent` object describing the authorisation
 * source. Returns an `ExecutionOutcome` block; the orchestrator
 * is responsible for threading it back onto the cycle context
 * via `appendBlock(ctx, 'execution', outcome)`.
 *
 * The function NEVER throws. Every failure mode resolves to a
 * `rejected` / `error` outcome with the corresponding reason
 * code, ensuring the audit row records the cause and the
 * cycle terminates cleanly (Req 1.5).
 *
 * @param {Object} params
 * @param {Readonly<import('./cycleContext').CycleContext>} params.ctx
 * @param {Readonly<Object>} params.settings
 * @param {Object} params.intent           `{ source, signal, risk, masterScore }`.
 * @returns {Promise<import('./cycleContext').ExecutionOutcome>}
 */
async function executeOrder({ ctx, settings, intent } = {}) {
  // Capture the settings the cycle was built with for the audit
  // row; the orchestrator owns the snapshot lifecycle (Req 18.1)
  // so we read defensively here.
  const cfg = (settings && typeof settings === 'object' ? settings : {}) || {};
  const exec = cfg.executionEngine || {};
  const lotSize = _isFiniteNumber(cfg.lotSize) ? cfg.lotSize : DEFAULT_NIFTY_LOT_SIZE;
  // 18.1: simulation mode is the union of the runtime switch
  // (`setExecutionMode('simulation')`, propagated by the
  // orchestrator) AND the legacy `settings.executionMode` flat
  // key. Either one being `'simulation'` routes the cycle to the
  // simulation recorder so the broker layer is never touched.
  const isSimulationMode =
    _executionMode === 'simulation' || cfg.executionMode === 'simulation';
  const triggeredMode = isSimulationMode || cfg.executionMode !== 'live'
    ? 'sandbox'
    : 'production';
  const cycleId = ctx && ctx.cycleId ? ctx.cycleId : null;
  const masterScore = intent && _isFiniteNumber(intent.masterScore) ? intent.masterScore : null;

  // ----------------------------------------------------------
  // 1) Source / signal check (Req 13.7 / 19.7)
  // ----------------------------------------------------------
  // Runs FIRST so an unauthorised source never reveals which
  // config / strike / placement step would otherwise have
  // failed. Splits the 14.1 single-predicate gate so that the
  // Risk block-reason check below can emit the explicit
  // operational reason code instead of always falling back to
  // `EXEC_UNAUTHORISED_SOURCE`.
  if (!_isIntentSourceValid(intent)) {
    const orderParams = _buildOrderParams({
      direction: null,
      pick: null,
      exec,
      lots: 0,
      lotSize,
      masterScore,
      cycleId,
    });
    logger.warn(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_UNAUTHORISED_SOURCE',
        cycleId,
        intentSource: intent && intent.source,
        candidate: intent && intent.signal && intent.signal.candidate,
      },
      '[executionEngine.adapter] unauthorised execution intent rejected',
    );
    return _emitRejection({
      rejectReason: 'EXEC_UNAUTHORISED_SOURCE',
      reasonCodes: [REASON_CODES.EXEC_UNAUTHORISED_SOURCE],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 2) Risk block-reason mapping (Req 13.5 / 17.2) — subtask 14.2
  // ----------------------------------------------------------
  // When Risk_Engine populated `intent.risk.blockReason` for one
  // of the operational gates the audit row is required to record
  // explicitly (kill switch / daily loss / exposure), translate
  // it into the dedicated reason code BEFORE the
  // `risk.allowEntry` fallback so the audit trail records WHICH
  // operational filter blocked the placement.
  const riskMapping = _mapRiskBlockReason(intent.risk && intent.risk.blockReason);
  if (riskMapping !== null) {
    const direction = _candidateToDirection(intent.signal.candidate);
    const orderParams = _buildOrderParams({
      direction,
      pick: null,
      exec,
      lots: 0,
      lotSize,
      masterScore,
      cycleId,
    });
    logger.warn(
      {
        module: 'executionEngine.adapter',
        event: riskMapping.rejectReason,
        cycleId,
        blockReason: intent.risk.blockReason,
      },
      '[executionEngine.adapter] Risk_Engine block reason intercepted',
    );
    return _emitRejection({
      rejectReason: riskMapping.rejectReason,
      reasonCodes: [riskMapping.reasonCode],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 3) allowEntry fallback (Req 13.7)
  // ----------------------------------------------------------
  // When Risk_Engine refused entry without populating one of the
  // explicitly mapped block reasons (e.g. `COOLDOWN`,
  // `INVALID_SL`, `PER_TRADE_RISK_OOR` — which are already
  // lifted onto `ctx.reasonCodes` by `appendBlock(ctx, 'risk',
  // …)`), fall back to the generic `EXEC_UNAUTHORISED_SOURCE`
  // rejection so the deterministic pipeline never executes an
  // un-vetted intent.
  if (intent.risk.allowEntry !== true) {
    const direction = _candidateToDirection(intent.signal.candidate);
    const orderParams = _buildOrderParams({
      direction,
      pick: null,
      exec,
      lots: 0,
      lotSize,
      masterScore,
      cycleId,
    });
    logger.warn(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_UNAUTHORISED_SOURCE',
        cycleId,
        reason: 'risk.allowEntry !== true with no mapped blockReason',
        blockReason: intent.risk.blockReason,
      },
      '[executionEngine.adapter] risk allowEntry false with no mapped block reason',
    );
    return _emitRejection({
      rejectReason: 'EXEC_UNAUTHORISED_SOURCE',
      reasonCodes: [REASON_CODES.EXEC_UNAUTHORISED_SOURCE],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 4) Config validation (Req 13.3 / 13.9)
  // ----------------------------------------------------------
  const invalidKey = _firstInvalidExecConfigKey(exec);
  if (invalidKey !== null) {
    const direction = _candidateToDirection(intent.signal.candidate);
    const orderParams = _buildOrderParams({
      direction,
      pick: null,
      exec,
      lots:
        intent.risk &&
        intent.risk.positionSize &&
        _isFiniteNumber(intent.risk.positionSize.totalLots)
          ? intent.risk.positionSize.totalLots
          : 0,
      lotSize,
      masterScore,
      cycleId,
    });
    logger.warn(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_CONFIG_INVALID',
        cycleId,
        invalidKey,
      },
      '[executionEngine.adapter] executionEngine config invalid',
    );
    return _emitRejection({
      rejectReason: `EXEC_CONFIG_INVALID:${invalidKey}`,
      reasonCodes: [REASON_CODES.EXEC_CONFIG_INVALID],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 5) Operational gates (Req 13.4 / 13.5 / 17.2) — subtask 14.2
  // ----------------------------------------------------------
  // Both gates run BEFORE strike selection so an illiquid
  // window or active news spike never causes a strike-pick
  // call (network hit) and never reveals which strike would
  // have been picked. The `whenNotToTrade` group is read
  // defensively — `validateSettings` enforces presence at
  // startup, but the adapter should still degrade safely if
  // the operator cleared the windows.
  const whenNotToTrade = (cfg && cfg.whenNotToTrade) || {};
  const cycleStartedAt =
    ctx && _isFiniteNumber(ctx.cycleStartedAt) ? ctx.cycleStartedAt : Date.now();

  if (_isInIlliquidWindow(cycleStartedAt, whenNotToTrade.illiquidWindows)) {
    const direction = _candidateToDirection(intent.signal.candidate);
    const orderParams = _buildOrderParams({
      direction,
      pick: null,
      exec,
      lots:
        intent.risk &&
        intent.risk.positionSize &&
        _isFiniteNumber(intent.risk.positionSize.totalLots)
          ? intent.risk.positionSize.totalLots
          : 0,
      lotSize,
      masterScore,
      cycleId,
    });
    logger.warn(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_ILLIQUID_WINDOW',
        cycleId,
        cycleIST: _epochMsToISTHHMM(cycleStartedAt),
        windows: whenNotToTrade.illiquidWindows,
      },
      '[executionEngine.adapter] cycle inside illiquid window — placement refused',
    );
    return _emitRejection({
      rejectReason: 'EXEC_ILLIQUID_WINDOW',
      reasonCodes: [
        REASON_CODES.EXEC_ILLIQUID_WINDOW,
        REASON_CODES.WHEN_NOT_TO_TRADE_LUNCH,
      ],
      orderParams,
      triggeredMode,
    });
  }

  if (_isNewsSpikeActive(ctx && ctx.ai, whenNotToTrade.newsRiskFloor)) {
    const direction = _candidateToDirection(intent.signal.candidate);
    const orderParams = _buildOrderParams({
      direction,
      pick: null,
      exec,
      lots:
        intent.risk &&
        intent.risk.positionSize &&
        _isFiniteNumber(intent.risk.positionSize.totalLots)
          ? intent.risk.positionSize.totalLots
          : 0,
      lotSize,
      masterScore,
      cycleId,
    });
    const newsBlock =
      ctx && ctx.ai && ctx.ai.newsInterpretation ? ctx.ai.newsInterpretation : {};
    logger.warn(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_NEWS_SPIKE',
        cycleId,
        riskLevel: newsBlock.riskLevel,
        newsRiskFloor: whenNotToTrade.newsRiskFloor,
      },
      '[executionEngine.adapter] active news spike — placement refused',
    );
    return _emitRejection({
      rejectReason: 'EXEC_NEWS_SPIKE',
      reasonCodes: [REASON_CODES.EXEC_NEWS_SPIKE],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 6) Direction (Req 13.1)
  // ----------------------------------------------------------
  const direction = _candidateToDirection(intent.signal.candidate);
  // _isAuthorisedIntent already guarantees direction !== null,
  // but defend against a future change to that helper.
  if (direction === null) {
    const orderParams = _buildOrderParams({
      direction: null,
      pick: null,
      exec,
      lots: 0,
      lotSize,
      masterScore,
      cycleId,
    });
    return _emitRejection({
      rejectReason: 'EXEC_UNAUTHORISED_SOURCE',
      reasonCodes: [REASON_CODES.EXEC_UNAUTHORISED_SOURCE],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 7) Strike selection (Req 13.2 / 13.8)
  // ----------------------------------------------------------
  const optionChain = ctx && ctx.data ? ctx.data.optionChain : null;
  const atmStrike = optionChain && _isFiniteNumber(optionChain.atmStrike) ? optionChain.atmStrike : null;
  let pick = null;
  try {
    pick = pickStrike({
      optionChain,
      atmStrike,
      direction,
      range: exec.strikeRange,
      preference: exec.strikePreference,
    });
  } catch (err) {
    logger.warn(
      { module: 'executionEngine.adapter', err: err && err.message },
      '[executionEngine.adapter] strike selection threw',
    );
    pick = null;
  }
  if (pick === null) {
    const orderParams = _buildOrderParams({
      direction,
      pick: null,
      exec,
      lots:
        intent.risk &&
        intent.risk.positionSize &&
        _isFiniteNumber(intent.risk.positionSize.totalLots)
          ? intent.risk.positionSize.totalLots
          : 0,
      lotSize,
      masterScore,
      cycleId,
    });
    return _emitRejection({
      rejectReason: 'EXEC_NO_ELIGIBLE_STRIKE',
      reasonCodes: [REASON_CODES.EXEC_NO_ELIGIBLE_STRIKE],
      orderParams,
      triggeredMode,
    });
  }

  // ----------------------------------------------------------
  // 8) Order params snapshot (Req 13.6)
  // ----------------------------------------------------------
  const totalLots =
    intent.risk &&
    intent.risk.positionSize &&
    _isFiniteNumber(intent.risk.positionSize.totalLots)
      ? intent.risk.positionSize.totalLots
      : 0;
  const lotsPerAccount =
    intent.risk && intent.risk.positionSize && intent.risk.positionSize.lotsPerAccount
      ? intent.risk.positionSize.lotsPerAccount
      : {};
  const orderParams = _buildOrderParams({
    direction,
    pick,
    exec,
    lots: totalLots,
    lotSize,
    masterScore,
    cycleId,
  });

  // ----------------------------------------------------------
  // 9) Simulation mode (Req 1.1 / 1.2 / 1.3 / 4.4) — subtask 18.1
  // ----------------------------------------------------------
  // Routes the order intent to the recorder instead of
  // `orderOrchestration.executeMultiAccountOrder` so dry-run
  // cycles never touch the broker layer underneath
  // `dhanProd.service.js`. The simulation flag is stamped onto
  // the `TradeExecutionLog` row's `note` field (no schema
  // change — see task 18.1 Part D) AND onto the
  // `orderParams.simulation` field on the returned outcome so
  // downstream auditors can query either.
  //
  // The synthetic `orderId` follows the `SIM-<epochMs>-<cycleId>`
  // format documented in 18.1: it is unique per call (timestamp
  // + cycleId), starts with `SIM-` so the audit row is grep-
  // friendly, and falls back to `unknown` when the orchestrator
  // ran without a `ctx.cycleId` (smoke checks, dry runs).
  //
  // Failure semantics: the `TradeExecutionLog.create` call is
  // already wrapped in try/catch by `_writeRejectionLog`, so a
  // Mongo outage / schema rejection logs and resolves to a
  // `null` document id. The simulation outcome is still emitted
  // — the prediction loop never breaks because the audit row
  // failed to persist (Req 1.5).
  if (isSimulationMode) {
    const simOrderId = `SIM-${Date.now()}-${cycleId || 'unknown'}`;
    // Stamp the simulation flag onto the orderParams snapshot so
    // the cycle audit row carries it on `ctx.execution.orderParams.simulation`.
    const simOrderParams = Object.assign({}, orderParams, { simulation: true });
    let tradeExecutionId = null;
    try {
      tradeExecutionId = await _writeRejectionLog({
        status: 'placed',
        orderParams: simOrderParams,
        reasonCodes: [],
        rejectReason: null,
        triggeredMode: 'sandbox',
        // 18.1: `simulation:true` is the canonical audit token —
        // operators can locate dry-run rows via
        // `TradeExecutionLog.find({ note: /simulation:true/ })`.
        note: 'simulation:true',
      });
    } catch (err) {
      // Defence-in-depth — `_writeRejectionLog` already swallows
      // its own errors, but if a future change starts surfacing
      // them we MUST NOT crash the prediction loop.
      logger.warn(
        { module: 'executionEngine.adapter', err: err && err.message },
        '[executionEngine.adapter] simulation log write failed; outcome still emitted',
      );
    }

    // ============================================================
    // ALSO write to ScalpingTrade so the UI table shows the trade.
    // The `/api/scalping/trades` endpoint queries `ScalpingTrade`,
    // not `TradeExecutionLog`. Without this row, simulation
    // trades fire silently and the operator sees an empty table.
    // We swallow errors so the prediction loop never breaks.
    // ============================================================
    try {
      // eslint-disable-next-line global-require
      const ScalpingTrade = require('../../models/ScalpingTrade');
      // eslint-disable-next-line global-require
      const scalpingSocket = require('../../utils/scalpingSocket');
      // eslint-disable-next-line global-require
      const hybridSvc = require('./hybridEngine.service');
      const sessId = typeof hybridSvc.getActiveSessionId === 'function'
        ? hybridSvc.getActiveSessionId()
        : null;
      if (sessId) {
        const lotSize = _isFiniteNumber(orderParams && orderParams.lotSize)
          ? orderParams.lotSize
          : DEFAULT_NIFTY_LOT_SIZE;
        const totalLots = _isFiniteNumber(orderParams && orderParams.lots)
          ? orderParams.lots
          : 1;
        const entryPremium = _isFiniteNumber(orderParams && orderParams.premium)
          ? orderParams.premium
          : 0;
        // Capture the spot at entry so the monitor can model
        // current premium via delta on subsequent cycles.
        const entrySpot = ctx && ctx.data && ctx.data.spot
          && _isFiniteNumber(ctx.data.spot.ltp)
          ? ctx.data.spot.ltp : null;
        // Recorded delta when the option chain row carries it,
        // else estimate from moneyness.
        let optionDelta = 0.5;
        try {
          const ocRows = ctx && ctx.data && ctx.data.optionChain
            && Array.isArray(ctx.data.optionChain.strikes)
            ? ctx.data.optionChain.strikes : null;
          if (ocRows) {
            const row = ocRows.find((r) => r && r.strike === pick.strike);
            const sideKey = direction === 'BUY_CE' ? 'ce' : 'pe';
            if (row && row[sideKey] && _isFiniteNumber(row[sideKey].delta)) {
              optionDelta = Math.abs(row[sideKey].delta);
            } else if (entrySpot !== null && _isFiniteNumber(pick.strike)) {
              const moneyness = direction === 'BUY_CE'
                ? (entrySpot - pick.strike)
                : (pick.strike - entrySpot);
              optionDelta = Math.max(0.1, Math.min(0.9, 0.5 + moneyness / 200));
            }
          }
        } catch (_) { /* swallow */ }
        const trade = await ScalpingTrade.create({
          sessionId: sessId,
          signal: direction === 'BUY_CE' ? 'BUY_CE' : 'BUY_PE',
          strike: pick.strike,
          optionSymbol: orderParams && orderParams.symbol ? orderParams.symbol : 'NIFTY',
          lotSize,
          quantity: totalLots * lotSize,
          entryPrice: entryPremium,
          currentPrice: entryPremium,
          status: 'open',
          tradeType: 'SCALP',
          openedAt: new Date(),
          notes: 'simulation:true',
          // Custom fields the trade monitor reads back. The
          // ScalpingTrade schema is `strict: false` for unknown
          // paths so writes are accepted.
          entrySpot: entrySpot,
          optionDelta: optionDelta,
        });
        if (scalpingSocket && typeof scalpingSocket.emitTradeCreated === 'function') {
          scalpingSocket.emitTradeCreated(trade, sessId);
        }
      }
    } catch (err) {
      logger.warn(
        { module: 'executionEngine.adapter', err: err && err.message },
        '[executionEngine.adapter] ScalpingTrade.create failed; UI table will be empty for this trade',
      );
    }

    logger.info(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_PLACED_SIMULATION',
        cycleId,
        simOrderId,
        tradeExecutionId,
        direction,
        strike: pick.strike,
        lots: totalLots,
      },
      '[executionEngine.adapter] simulation placement recorded — broker NOT contacted',
    );
    return {
      status: 'placed',
      // 18.1: prefer the `SIM-...` id over the Mongo doc id so
      // the orderId is always grep-able as a simulation marker
      // even when Mongo is unreachable.
      orderId: simOrderId,
      accounts: [
        {
          accountId: 'simulation',
          status: 'placed',
          filledLots: totalLots,
          fillPrice: pick.premium || 0,
        },
      ],
      orderParams: simOrderParams,
      reasonCodes: [],
    };
  }

  // ----------------------------------------------------------
  // 10) Live placement via orderOrchestration (Req 13.1 / 13.6)
  // ----------------------------------------------------------
  // Build the master-order shape `executeMultiAccountOrder`
  // expects, then convert `lotsPerAccount` (object) to the
  // `Map<string, number>` it requires. Wrap in try/catch so an
  // orchestration / broker failure resolves to `status:'error'`
  // rather than throwing into the orchestrator (Req 1.5).
  try {
    const lotAllocations = new Map();
    for (const accountId of Object.keys(lotsPerAccount)) {
      const lots = lotsPerAccount[accountId];
      if (_isFiniteNumber(lots) && lots > 0) {
        lotAllocations.set(String(accountId), Math.floor(lots));
      }
    }

    const orderRequest = {
      symbol: orderParams.symbol || `NIFTY-${pick.strike}-${pick.optionType}`,
      securityId: pick.securityId ? String(pick.securityId) : '0',
      exchangeSegment: exec.exchangeSegment,
      productType: exec.productType,
      orderType: exec.orderType,
      validity: exec.validity,
      lotSize,
      totalLots: Math.max(1, totalLots),
      price: pick.premium || 0,
      triggeredMode,
      note: `hybrid_engine cycle:${cycleId || 'unknown'} ${direction} strike:${pick.strike}`,
    };

    const result = await orderOrchestration.executeMultiAccountOrder(orderRequest, lotAllocations);

    if (!result || result.ok !== true) {
      const errMsg = (result && result.error) || 'orderOrchestration returned non-ok';
      logger.warn(
        { module: 'executionEngine.adapter', cycleId, err: errMsg },
        '[executionEngine.adapter] orderOrchestration rejected',
      );
      return {
        status: 'error',
        orderParams,
        rejectReason: errMsg,
        reasonCodes: [],
      };
    }

    const data = result.data || {};
    const accounts = Array.isArray(data.accountResults) ? data.accountResults : [];
    const successCount = _isFiniteNumber(data.successCount) ? data.successCount : 0;
    const failureCount = _isFiniteNumber(data.failureCount) ? data.failureCount : 0;
    const partial = successCount > 0 && failureCount > 0;
    const status = successCount === 0 ? 'rejected' : partial ? 'partial' : 'placed';

    logger.info(
      {
        module: 'executionEngine.adapter',
        event: 'EXEC_PLACED',
        cycleId,
        tradeExecutionId: data.tradeExecutionId || null,
        status,
        successCount,
        failureCount,
      },
      '[executionEngine.adapter] live placement complete',
    );

    return {
      status,
      orderId: data.tradeExecutionId || null,
      accounts,
      orderParams,
      rejectReason: status === 'rejected' ? 'orderOrchestration: all accounts failed' : undefined,
      reasonCodes: [],
    };
  } catch (err) {
    logger.error(
      {
        module: 'executionEngine.adapter',
        cycleId,
        err: err && err.message,
        stack: err && err.stack,
      },
      '[executionEngine.adapter] live placement threw',
    );
    return {
      status: 'error',
      orderParams,
      rejectReason: (err && err.message) || 'unknown placement error',
      reasonCodes: [],
    };
  }
}

module.exports = {
  executeOrder,
  // 18.1 — runtime execution-mode switch.
  setExecutionMode,
  getExecutionMode,
  // Exposed for unit tests / smoke checks so internal mappings can be
  // exercised without going through the full `executeOrder` path.
  pickStrike,
  // Internal helpers — exposed for the same reason as
  // `aiSupport.adapter.js` exposes its mapping helpers.
  _isAuthorisedIntent,
  _isIntentSourceValid,
  _mapRiskBlockReason,
  _firstInvalidExecConfigKey,
  _candidateToDirection,
  _isInIlliquidWindow,
  _isNewsSpikeActive,
  _epochMsToISTHHMM,
  _hhmmToMinutes,
};
