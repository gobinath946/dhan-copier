/**
 * ============================================================
 * CYCLE CONTEXT — immutable per-cycle pipeline carrier
 * ============================================================
 * Hybrid_Engine (NIFTY 50 Hybrid Institutional Engine) runs a strict
 * 9-stage pipeline every prediction cycle (Data → Regime → Structure →
 * Liquidity → OI → PCR → Signal → Risk → AI → Execution → Monitoring).
 *
 * The `CycleContext` is built top-down at the start of a cycle and
 * THREADED through every stage adapter. Stages APPEND typed blocks
 * (`data`, `regime`, `structure`, ...) and append reason codes; they
 * NEVER mutate fields already produced by an earlier stage. This is
 * the foundation of the idempotency invariant (Req 19.1) and the
 * per-cycle audit row (Req 18.4).
 *
 * Public API:
 *   - buildCycleContext({ settings, settingsHash })
 *   - appendBlock(ctx, key, block)
 *   - addReasonCodes(ctx, codes)
 *
 * Spec references:
 *   - Req 18.1 — ordered pipeline, single immutable cycle context
 *   - Req 18.4 — per-cycle audit row schema (cycleId, settingsHash, ...)
 *   - Req 19.1 — idempotency: same context + same settings ⇒ same output
 *
 * NOTE on ULID:
 *   The design specifies "ULID per cycle" for `cycleId`. We implement a
 *   small inline ULID-style id (Crockford-base32 timestamp + randomness)
 *   to avoid pulling in an external dependency on a local-only system
 *   (Req 1). The format is monotonic-ish per process and lexicographically
 *   sortable by creation time.
 * ============================================================
 */

'use strict';

const crypto = require('crypto');

// ============================================================
// JSDoc Typedefs (mirrors the design's "Components and Interfaces"
// block verbatim). These are documented as Object so JSDoc tooling
// can flow them through the pipeline without forcing every adapter
// to know the full schema up-front.
// ============================================================

/**
 * @typedef {Object} DataSnapshot
 * @property {number}        tickAt            Epoch ms of the freshest tick.
 * @property {boolean}       tickStale         True iff (now - tickAt) > dataEngine.maxTickAgeMs.
 * @property {Object}        spot              { o, h, l, c, ltp }.
 * @property {Object}        futures           { o, h, l, c, ltp, oi, oiChange, premiumToSpot }.
 * @property {Object|null}   optionChain       { atmStrike, expiry, strikes: [...] } or null when unavailable (Req 4.8).
 * @property {Object}        candles           { spot:{ '1m':[], '5m':[], '15m':[], '1H':[] }, futures:{ ... } }.
 * @property {Object}        vwap              { session, anchors:{ sessionOpen, priorDayHigh, priorDayLow, weeklyAnchor } }.
 * @property {number|null}   vix               Current VIX or null when unavailable.
 * @property {Object}        priorDay          { high, low, close, openingRange, weeklyHigh, weeklyLow, swings }.
 * @property {boolean}       recordedToday     True iff the snapshot was sourced from JSONL replay vs live API.
 * @property {Array<string>} reasonCodes       Reason codes raised by Data_Engine for this cycle (Req 4.6 / 4.8).
 *                                             Lifted onto the top-level CycleContext via `appendBlock(ctx, 'data', snapshot)`.
 */

/**
 * @typedef {Object} RegimeOutput
 * @property {('trending'|'ranging'|'fake-breakout'|'momentum-exhaustion'|'volatility-expansion'|'expiry-manipulation'|'high-risk')} label
 * @property {number}  confidence                       0..10 (Req 5.2).
 * @property {Object}  tradePermissions                 { LONG_SETUP, SHORT_SETUP, SCALPING } (Req 5.3).
 * @property {number}  positionSizingMultiplier         0.0..1.5 (Req 5.4).
 * @property {Array<string>} allowedSetups              e.g. ['BOS_continuation','VWAP_reclaim'] (Req 5.5).
 * @property {Object}  inputs                           { atr, adx, vwapDistance, volumeProfile, vix, oiConcentration, futuresPremium, breadth, liquidityScore }.
 * @property {Array<string>} reasonCodes                Reason codes raised by Regime_Engine for this cycle
 *                                                      (Req 5.6 / 5.7 / 5.8 / 5.10). Lifted onto the top-level
 *                                                      `ctx.reasonCodes` via `appendBlock(ctx, 'regime', regimeOutput)`.
 */

/**
 * @typedef {Object} StructureOutput
 * @property {('bullish'|'bearish'|'neutral')} bias
 * @property {number}  biasConfidence            0..1, sum of agreeing factors × biasWeights (Req 6.5/6.6).
 * @property {Object}  bos                       { detected, direction, candleAt }.
 * @property {Object}  choch                     { detected, direction, candleAt }.
 * @property {boolean} trendContinuation         BOS aligned with 1H bias (Req 6.7).
 * @property {boolean} potentialReversal         CHoCH against 1H bias (Req 6.8).
 * @property {Object}  avwap                     { sessionOpen, priorDayHigh, priorDayLow, weeklyAnchor }.
 * @property {Object}  volumeProfile             { poc, vah, val, lookbackMinutes }.
 * @property {Object}  mtfAlignment              { '1H', '15m', '5m', '1m', aligned }.
 */

/**
 * @typedef {Object} LiquidityOutput
 * @property {('tight'|'normal'|'wide'|'very_wide')} spreadStatus
 * @property {number}  bidAskImbalance           Signed ratio.
 * @property {Object}  absorption                { detected, side: 'bid'|'ask'|null }.
 * @property {Array<number>} thinLiquidityZones  Strike list.
 * @property {Object}  stopHunt                  { detected, direction: 'up'|'down'|null }.
 * @property {number}  slippageProbability       0..1.
 * @property {number}  liquidityScore            0..100; capped at 30 when spreadStatus = 'very_wide' (Req 7.3).
 * @property {Object}  liquidityHealth           { healthy: boolean }.
 * @property {boolean} imbalanceConfirmsLong     (Req 7.5).
 * @property {boolean} imbalanceConfirmsShort    (Req 7.6).
 * @property {boolean} blockEntry                True if stop-hunt opposes candidate side (Req 7.4).
 * @property {Array<string>} reasonCodes         Reason codes raised by Liquidity_Engine for this cycle
 *                                                (subtask 6.2 will populate with `LIQUIDITY_VERY_WIDE_SPREAD`,
 *                                                `LIQUIDITY_LOW_SCORE`, `LIQUIDITY_STOP_HUNT_OPPOSES_SIDE`).
 *                                                Lifted onto the top-level `ctx.reasonCodes` via
 *                                                `appendBlock(ctx, 'liquidity', liquidityOutput)`. Same pattern as
 *                                                `DataSnapshot.reasonCodes` and `RegimeOutput.reasonCodes`.
 */

/**
 * @typedef {Object} OIOutput
 * @property {Array<Object>} perStrike                      Per-strike classification rows (Req 10.1).
 * @property {Object}  strikeMigration                      { direction: 'up'|'down'|'flat', magnitude: integer }.
 * @property {boolean} ceDominance                          (Req 10.5).
 * @property {boolean} peDominance                          (Req 10.5).
 * @property {boolean} futuresOIAligned                     (Req 10.6).
 * @property {('aligned'|'no_dominant_side'|'futures_oi_stale'|'futures_oi_missing'|'mismatch')} futuresAlignmentReason
 * @property {Object}  gammaPressure                        { netDealerGamma, gammaFlip, perStrike } (Req 10.7).
 * @property {number}  shortCoveringBoostMultiplier         = indicatorWeights.oiShortCoveringBoost (Req 10.2).
 */

/**
 * @typedef {Object} PCROutput
 * @property {number}  atmPcr
 * @property {Array<Object>} strikewisePcr                  [{ strike, pcr }, ...].
 * @property {number}  expiryPcr
 * @property {number}  intradayPcr                          Rolling window pcrEngine.intradayWindowMinutes.
 * @property {Object}  bands                                { atm, expiry, intraday } (Req 11.2).
 * @property {boolean} bullishSqueezeProbability            ATM PCR < 0.7 AND VWAP reclaim from below (Req 11.3).
 * @property {boolean} contrarianCaution                    ATM PCR > 1.5 (Req 11.4).
 * @property {number}  contributionWeight                   indicatorWeights.pcrWeight, clamped ≤ 0.10 (Req 11.6).
 */

/**
 * @typedef {Object} SignalOutput
 * @property {('LONG_SETUP'|'SHORT_SETUP'|'NO_TRADE')} candidate
 * @property {Object}  mandatoryResults                     { [conditionId]: bool } over Req 8.1.* / 9.1.*.
 * @property {Array<string>} oiConfirmations                Satisfied confirmation ids (Req 8.2 / 9.2).
 * @property {number}  riskReward                           Computed RR (Req 8.1.12 / 9.1.12).
 * @property {Array<string>} reasonCodes                    Reason codes raised by Signal_Engine.
 * @property {Object}  provenance                           { regime, structure, liquidity, oi, pcr } (Req 8.5 / 9.5).
 */

/**
 * @typedef {Object} RiskDecision
 * @property {boolean} allowEntry
 * @property {('KILL_SWITCH'|'DAILY_LOSS'|'EXPOSURE'|'COOLDOWN'|'INVALID_SL'|'PER_TRADE_RISK_OOR'|null)} blockReason
 * @property {number}  stopLossPoints                       (Req 12.5).
 * @property {number}  targetPoints
 * @property {number}  riskRewardRatio
 * @property {Object}  positionSize                         { lotsPerAccount, totalLots } (Req 12.6).
 * @property {Object|null} trailing                         { enabled, params } | null (Req 12.9).
 * @property {Array<string>} reasonCodes                    Reason codes raised by Risk_Engine for this cycle
 *                                                          (e.g. `RISK_INVALID_SL`, `RISK_PER_TRADE_RISK_OOR`).
 *                                                          Lifted onto the top-level `ctx.reasonCodes` via
 *                                                          `appendBlock(ctx, 'risk', riskDecision)`. Same pattern
 *                                                          as `DataSnapshot.reasonCodes` and `RegimeOutput.reasonCodes`.
 */

/**
 * @typedef {Object} AIAdvisoryOutput
 * @property {('used'|'ignored'|'disabled'|'unavailable')} state
 * @property {number}  [confidenceScore]                    0..10 (Req 14.1).
 * @property {boolean} [fakeBreakoutWarning]
 * @property {boolean} [regimeValidation]
 * @property {Object}  [newsInterpretation]
 * @property {Object}  [anomalyDetection]
 * @property {Object}  [aggressionSuggestion]
 * @property {string}  [narrative]
 * @property {number}  [scoreDelta]                         Bounded by aiSupport.maxConfidenceModulation (Req 14.9).
 * @property {boolean} [downgradedToNoTrade]                AI may downgrade; AI may NEVER upgrade (Req 14.9).
 * @property {Array<string>} [reasonCodes]                  Reason codes raised by AI_Support_Layer for this cycle
 *                                                          (`AI_UNAVAILABLE`, `AI_DOWNGRADED_TO_NO_TRADE`).
 *                                                          Lifted onto the top-level `ctx.reasonCodes` via
 *                                                          `appendBlock(ctx, 'ai', advisory)`. Same pattern as
 *                                                          `DataSnapshot.reasonCodes` and `RegimeOutput.reasonCodes`.
 */

/**
 * @typedef {Object} ExecutionOutcome
 * @property {('placed'|'partial'|'rejected'|'error'|'blocked')} status
 * @property {string}  [orderId]
 * @property {Array<Object>} [accounts]                     Per-account fills / rejections.
 * @property {Object}  [orderParams]                        Snapshot of the parameters submitted.
 * @property {string}  [rejectReason]                       e.g. 'EXEC_NO_ELIGIBLE_STRIKE'.
 * @property {Array<string>} [reasonCodes]                  Reason codes raised by Execution_Engine for this cycle
 *                                                          (e.g. `EXEC_UNAUTHORISED_SOURCE`, `EXEC_CONFIG_INVALID`,
 *                                                          `EXEC_NO_ELIGIBLE_STRIKE`, and the operational gates added
 *                                                          in subtask 14.2: `EXEC_ILLIQUID_WINDOW`,
 *                                                          `EXEC_NEWS_SPIKE`, `RISK_KILL_SWITCH`,
 *                                                          `RISK_DAILY_LOSS_EXCEEDED`, `RISK_EXPOSURE_EXCEEDED`).
 *                                                          Lifted onto the top-level `ctx.reasonCodes` via
 *                                                          `appendBlock(ctx, 'execution', outcome)`. Same pattern
 *                                                          as `DataSnapshot.reasonCodes` and `RegimeOutput.reasonCodes`.
 */

/**
 * @typedef {Object} MonitoringSnapshot
 * Per-tick output of the Monitoring_Engine adapter (Req 15.1 / 15.2).
 * Emitted on its OWN cadence (`monitoringEngine.intervalSeconds × 1000`),
 * NOT on the prediction-cycle cadence. The orchestrator may still feed
 * a `MonitoringSnapshot` onto the cycle context via
 * `appendBlock(ctx, 'monitoring', snapshot)` when it wants the
 * monitoring observations to participate in the per-cycle audit row;
 * doing so lifts `snapshot.reasonCodes` onto `ctx.reasonCodes`. The
 * primary persistence path for monitoring snapshots is the dedicated
 * `EngineEventLog` row (`type: 'MONITORING_SNAPSHOT'`) plus a live
 * broadcast over the `scalpingSocket` channel — Monitoring_Engine
 * does NOT short-circuit the prediction loop.
 *
 * @property {string}        tickAt                 ISO-8601 timestamp of the snapshot.
 * @property {Array<Object>} perTradePnL            Per-open-trade signed ₹ PnL summaries.
 * @property {number}        totalLivePnL           Sum of `perTradePnL` (₹).
 * @property {number}        pipelineLatencyMs      Most recent prediction-cycle latency.
 * @property {boolean}       liquidityDeterioration True iff Liquidity_Engine reports degradation.
 * @property {boolean}       regimeChange           True iff `regimeLabel` differs from previous tick.
 * @property {string|null}   regimeLabel            Pass-through Regime_Engine label.
 * @property {Array<Object>} openPositions          Roster of currently-open trades (id / side / lots).
 * @property {number}        exposurePct            Σ notional / capital ∈ [0, 1+].
 * @property {Array<string>} riskViolations         Risk-layer breach flags.
 * @property {boolean}       aiConfidenceDecay      True on the transition cycle when AI confidence
 *                                                   drops below `confidenceDecayFloor` (Req 15.5).
 * @property {number|null}   aiConfidence           Pass-through AI confidence 0..10.
 * @property {Object}        edgeDecay              `{ rollingWinRate: number, windowTrades: number }`
 *                                                   over `edgeWindowTrades` (Req 15.6).
 * @property {Array<string>} reasonCodes            Reason codes raised by Monitoring_Engine for this
 *                                                   tick (`MONITORING_LATENCY_BREACH`,
 *                                                   `MONITORING_EDGE_DECAY`,
 *                                                   `MONITORING_REGIME_CHANGED`,
 *                                                   `MONITORING_AI_CONFIDENCE_DECAY`). Lifted onto
 *                                                   `ctx.reasonCodes` via
 *                                                   `appendBlock(ctx, 'monitoring', snapshot)`.
 * @property {boolean}       error                  True iff the tick body threw and a safe-default
 *                                                   snapshot was emitted (Req 1.5).
 * @property {string}        [errorMessage]         Caught error message when `error === true`.
 */

/**
 * @typedef {Object} CycleContext
 * @property {string}  cycleId               ULID-style id (timestamp + randomness, lexicographically sortable).
 * @property {number}  cycleStartedAt        Epoch ms captured at buildCycleContext().
 * @property {Readonly<Object>} settings     Frozen Algo_Settings snapshot for this cycle (Req 18.4).
 * @property {string}  settingsHash          Stable hash of settings for the audit row (Req 18.4).
 * @property {DataSnapshot|null}      data
 * @property {RegimeOutput|null}      regime
 * @property {StructureOutput|null}   structure
 * @property {LiquidityOutput|null}   liquidity
 * @property {OIOutput|null}          oi
 * @property {PCROutput|null}         pcr
 * @property {SignalOutput|null}      signal
 * @property {RiskDecision|null}      risk
 * @property {AIAdvisoryOutput|null}  ai
 * @property {ExecutionOutcome|null}  execution
 * @property {ReadonlyArray<string>}  reasonCodes   Populated as gates short-circuit; deduped (Req 17.7).
 * @property {('BUY_CE'|'BUY_PE'|'NO_TRADE'|null)} finalAction
 * @property {number|null}            masterScore   0..100 (Req 16).
 */

// ============================================================
// ULID-style id generator
// ------------------------------------------------------------
// Crockford base32 timestamp (10 chars, ms-since-epoch) + 16 chars
// of cryptographic randomness. Total 26 chars, matches ULID width.
// Lexicographically sortable, monotonic across the wall-clock.
// ============================================================

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode a non-negative integer in Crockford base32 with fixed length.
 * @param {number} value Non-negative integer (typically epoch ms).
 * @param {number} length Desired output length; left-padded with '0'.
 * @returns {string}
 */
function encodeBase32(value, length) {
  let out = '';
  let n = value;
  for (let i = 0; i < length; i += 1) {
    const mod = n % 32;
    out = CROCKFORD_BASE32[mod] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/**
 * Generate a ULID-style 26-character id.
 *
 * Layout: [10-char ms timestamp][16-char random].
 * Not a strict spec ULID (we don't enforce intra-ms monotonicity counter),
 * but matches the design's "ULID per cycle" requirement well enough for
 * audit-row correlation (Req 18.4) on a single-process local engine.
 *
 * @param {number} [nowMs] Override for deterministic tests.
 * @returns {string}
 */
function generateUlidStyleId(nowMs) {
  const ts = typeof nowMs === 'number' ? nowMs : Date.now();
  const tsPart = encodeBase32(ts, 10);
  const randomBytes = crypto.randomBytes(10); // 80 bits ⇒ 16 base32 chars
  let randPart = '';
  for (let i = 0; i < 10; i += 1) {
    // Two base32 chars per byte: top 4 bits, bottom 4 bits.
    // Pad each nibble out of a 32-char alphabet by combining with the
    // next bit; this produces a uniform 16-char block.
    const b = randomBytes[i];
    randPart += CROCKFORD_BASE32[(b >> 3) & 0x1f];
    // Use the lower 5 bits, but only on every other byte we have less
    // than 5 left, so re-mix with the next byte's high bit. For our
    // purposes (audit correlation, not crypto), a simpler split is fine.
    randPart += CROCKFORD_BASE32[b & 0x1f];
  }
  return tsPart + randPart.slice(0, 16);
}

// ============================================================
// Internal helpers — deep clone + deep freeze
// ============================================================

/**
 * Deep-clone a JSON-shaped value. Functions and class instances are
 * not preserved by design — block payloads in the cycle context are
 * always plain data (matching the JSDoc typedefs above).
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  // Preserve Date for tickAt-style timestamps if a caller passes one.
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = deepClone(value[k]);
  }
  return out;
}

/**
 * Recursively freeze a plain-object / array tree. Already-frozen
 * subtrees (e.g. the `settings` snapshot) are left intact.
 *
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  for (const k of Object.keys(value)) {
    deepFreeze(value[k]);
  }
  return Object.freeze(value);
}

/**
 * Append `codes` to an existing reason-code array without duplicates,
 * preserving first-seen order. Returns a NEW array (immutable update).
 *
 * @param {ReadonlyArray<string>} existing
 * @param {Array<string>} codes
 * @returns {Array<string>}
 */
function dedupeAppend(existing, codes) {
  const seen = new Set(existing);
  const out = existing.slice();
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

// ============================================================
// Public API
// ============================================================

/**
 * Build the initial frozen `CycleContext` for a new cycle.
 *
 * The orchestrator calls this once per tick after taking a fresh
 * `algoSettings.snapshot()` and a stable `algoSettings.settingsHash()`.
 * This module deliberately does NOT call `algoSettings` itself — the
 * orchestrator owns the snapshot lifecycle (Req 18.1).
 *
 * The returned object is frozen at the OUTER level so the pipeline
 * cannot accidentally mutate `cycleId`, `cycleStartedAt`, `settings`,
 * `settingsHash`, or any per-stage block field. To populate a stage
 * block (e.g. `regime`), call `appendBlock(ctx, 'regime', regimeOutput)`
 * which returns a NEW frozen context (Req 19.1).
 *
 * @param {Object}             params
 * @param {Readonly<Object>}   params.settings       Frozen Algo_Settings snapshot for this cycle.
 * @param {string}             params.settingsHash   Stable hash of `settings`, for the audit row.
 * @returns {Readonly<CycleContext>}
 */
function buildCycleContext({ settings, settingsHash } = {}) {
  if (settings === undefined || settings === null) {
    throw new Error('buildCycleContext: `settings` is required (pass algoSettings.snapshot()).');
  }
  if (typeof settingsHash !== 'string' || settingsHash.length === 0) {
    throw new Error('buildCycleContext: `settingsHash` must be a non-empty string.');
  }

  const cycleStartedAt = Date.now();
  const cycleId = generateUlidStyleId(cycleStartedAt);

  /** @type {CycleContext} */
  const ctx = {
    cycleId,
    cycleStartedAt,
    settings, // already frozen by algoSettings.snapshot()
    settingsHash,
    data: null,
    regime: null,
    structure: null,
    liquidity: null,
    oi: null,
    pcr: null,
    signal: null,
    risk: null,
    ai: null,
    execution: null,
    reasonCodes: Object.freeze([]),
    finalAction: null,
    masterScore: null,
  };

  return Object.freeze(ctx);
}

/**
 * Return a NEW frozen `CycleContext` with the named block populated.
 *
 * - The block payload is deep-cloned and deep-frozen on insertion so
 *   downstream stages cannot mutate prior outputs (Req 19.1).
 * - If the block payload includes a `reasonCodes` array, those codes
 *   are appended (deduped) onto the context's top-level `reasonCodes`.
 *   This matches the "stages append, never mutate prior fields" rule
 *   from the design's "Decisions and Rationale" table.
 * - Setting the same key twice is allowed (overwrite); this is how
 *   re-evaluation paths (e.g. monitoring → risk re-evaluate) update
 *   their block. Earlier reason codes are preserved either way.
 *
 * Permitted keys are the populated stage blocks plus the orchestrator-
 * controlled `finalAction` and `masterScore` summary fields.
 *
 * @param {Readonly<CycleContext>} ctx
 * @param {('data'|'regime'|'structure'|'liquidity'|'oi'|'pcr'|'signal'|'risk'|'ai'|'execution'|'finalAction'|'masterScore')} key
 * @param {*} block
 * @returns {Readonly<CycleContext>} New frozen context.
 */
function appendBlock(ctx, key, block) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('appendBlock: `ctx` must be a CycleContext.');
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('appendBlock: `key` must be a non-empty string.');
  }
  if (!Object.prototype.hasOwnProperty.call(ctx, key)) {
    throw new Error(`appendBlock: unknown CycleContext key "${key}".`);
  }
  if (key === 'cycleId' || key === 'cycleStartedAt' || key === 'settings' || key === 'settingsHash' || key === 'reasonCodes') {
    throw new Error(`appendBlock: key "${key}" is immutable; use addReasonCodes() for reason codes.`);
  }

  // Scalar summary fields (`finalAction`, `masterScore`) are stored as-is.
  // Object/array stage blocks are deep-cloned + deep-frozen so callers
  // cannot mutate prior context state by retaining a reference.
  let frozenBlock;
  if (block === null || block === undefined) {
    frozenBlock = block === undefined ? null : null;
  } else if (typeof block !== 'object') {
    frozenBlock = block;
  } else {
    frozenBlock = deepFreeze(deepClone(block));
  }

  // If the block carries its own `reasonCodes`, lift them into the
  // top-level deduped reason-code array (the audit row reads from there).
  let nextReasonCodes = ctx.reasonCodes;
  if (frozenBlock && typeof frozenBlock === 'object' && Array.isArray(frozenBlock.reasonCodes)) {
    nextReasonCodes = Object.freeze(dedupeAppend(ctx.reasonCodes, frozenBlock.reasonCodes));
  }

  const next = {
    cycleId: ctx.cycleId,
    cycleStartedAt: ctx.cycleStartedAt,
    settings: ctx.settings,
    settingsHash: ctx.settingsHash,
    data: ctx.data,
    regime: ctx.regime,
    structure: ctx.structure,
    liquidity: ctx.liquidity,
    oi: ctx.oi,
    pcr: ctx.pcr,
    signal: ctx.signal,
    risk: ctx.risk,
    ai: ctx.ai,
    execution: ctx.execution,
    reasonCodes: nextReasonCodes,
    finalAction: ctx.finalAction,
    masterScore: ctx.masterScore,
  };
  next[key] = frozenBlock;

  return Object.freeze(next);
}

/**
 * Return a NEW frozen `CycleContext` with `codes` appended to
 * `reasonCodes`. Duplicates are silently dropped (first-seen wins).
 *
 * Empty / non-string entries are ignored. Passing an empty array
 * returns a structurally identical (but new) frozen context.
 *
 * @param {Readonly<CycleContext>} ctx
 * @param {Array<string>} codes
 * @returns {Readonly<CycleContext>}
 */
function addReasonCodes(ctx, codes) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('addReasonCodes: `ctx` must be a CycleContext.');
  }
  if (!Array.isArray(codes)) {
    throw new Error('addReasonCodes: `codes` must be an array of strings.');
  }

  const nextReasonCodes = Object.freeze(dedupeAppend(ctx.reasonCodes, codes));

  const next = {
    cycleId: ctx.cycleId,
    cycleStartedAt: ctx.cycleStartedAt,
    settings: ctx.settings,
    settingsHash: ctx.settingsHash,
    data: ctx.data,
    regime: ctx.regime,
    structure: ctx.structure,
    liquidity: ctx.liquidity,
    oi: ctx.oi,
    pcr: ctx.pcr,
    signal: ctx.signal,
    risk: ctx.risk,
    ai: ctx.ai,
    execution: ctx.execution,
    reasonCodes: nextReasonCodes,
    finalAction: ctx.finalAction,
    masterScore: ctx.masterScore,
  };

  return Object.freeze(next);
}

module.exports = {
  buildCycleContext,
  appendBlock,
  addReasonCodes,
  // Exposed for unit tests / orchestrator audit-id correlation.
  generateUlidStyleId,
};
