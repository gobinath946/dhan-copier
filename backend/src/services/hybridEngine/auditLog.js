/**
 * ============================================================
 * AUDIT LOG — per-cycle CYCLE_AUDIT row writer
 * ============================================================
 * Hybrid_Engine persists exactly one `EngineEventLog` row per
 * pipeline cycle so every NO_TRADE / setup decision can be replayed
 * after the fact. This module owns that single write, including the
 * candle-array redaction needed to keep document size sane.
 *
 * The orchestrator (task 16.2) calls `writeCycleAudit(ctx, opts)`
 * from a single termination point per cycle. Stage adapters do NOT
 * call this directly — they only populate the immutable
 * `CycleContext` (see `./cycleContext.js`) which we then serialise.
 *
 * Spec references:
 *   - Req 17.7 — every NO_TRADE / block decision carries reason codes
 *     in the audit row.
 *   - Req 18.4 — single CYCLE_AUDIT row per cycle containing
 *     cycleId, timestamp, settingsHash, and a structured payload.
 *   - Design "Per-Cycle Audit Row Schema":
 *
 *     EngineEventLog {
 *       type: 'CYCLE_AUDIT',
 *       cycleId,
 *       timestamp,
 *       settingsHash,
 *       payload: {
 *         finalAction,
 *         masterScore,
 *         reasonCodes,
 *         aiAdvisory: 'used' | 'ignored' | 'disabled' | 'unavailable',
 *         blocks: { regime?, liquidity?, risk?, exec?, whenNotToTrade? },
 *         signal: { candidate, mandatoryResults, oiConfirmations, riskReward, provenance },
 *         risk: { stopLossPoints, targetPoints, positionSize },
 *         execution: { orderId?, accounts?, status? } | null
 *       }
 *     }
 *
 * Schema mapping note:
 *   The design uses `type` as the discriminator field. The existing
 *   Mongoose `EngineEventLog` model (see `../../models/EngineEventLog.js`)
 *   already uses `eventType` for the same concept — we map
 *   design.type → schema.eventType verbatim. The model also requires
 *   `sessionId` and `message`; both are taken from `opts.sessionId` (the
 *   orchestrator's `ScalpingSession._id`) and a synthesised message.
 *
 * Failure semantics:
 *   This function MUST NEVER throw. A DB outage, a malformed context,
 *   or a serialiser crash must not propagate up to the prediction loop
 *   — the loop has to keep ticking. All failures are caught, logged,
 *   and the function resolves to `null`.
 *
 * Validates: Requirements 17.7, 18.4
 * ============================================================
 */

'use strict';

const EngineEventLog = require('../../models/EngineEventLog');
const logger = require('../../utils/logger');

// ============================================================
// Candle-array redaction
// ------------------------------------------------------------
// `DataSnapshot.candles` carries up to ~hundreds of OHLCV bars
// across `{ spot, futures } × { 1m, 5m, 15m, 1H }`. Persisting all
// of that on every cycle (one cycle every few seconds during RTH)
// blows MongoDB document size and noise-floods the audit log.
// We replace each candle array with a `{ count, lastTimestamp }`
// summary — enough to confirm "the snapshot wasn't empty" and
// "the freshest bar matches `tickAt`" without storing the bars.
// The full bars are still queryable from the recorded JSONL
// (`live-feed/<date>_NIFTY_50/`) keyed by `cycleStartedAt`.
//
// Same rationale applies to `oi.gammaPressure.perStrike` if the
// adapter emits a heavy per-strike array.
// ============================================================

/**
 * Pick the most plausible "timestamp" field off a candle bar without
 * being prescriptive about which schema variant the aggregator used.
 * Returns `null` when no recognisable timestamp is present.
 *
 * @param {*} bar
 * @returns {number|string|null}
 */
function extractBarTimestamp(bar) {
  if (!bar || typeof bar !== 'object') return null;
  if (bar.timestamp !== undefined && bar.timestamp !== null) return bar.timestamp;
  if (bar.t !== undefined && bar.t !== null) return bar.t;
  if (bar.time !== undefined && bar.time !== null) return bar.time;
  if (bar.ts !== undefined && bar.ts !== null) return bar.ts;
  if (bar.closeTime !== undefined && bar.closeTime !== null) return bar.closeTime;
  return null;
}

/**
 * Replace a candle array with a `{ count, lastTimestamp }` summary.
 * Non-array inputs are passed through unchanged so this is safe to
 * apply blindly across the candles map.
 *
 * @param {*} arr
 * @returns {{ count: number, lastTimestamp: (number|string|null) }|*}
 */
function summariseCandleArray(arr) {
  if (!Array.isArray(arr)) return arr;
  if (arr.length === 0) return { count: 0, lastTimestamp: null };
  return {
    count: arr.length,
    lastTimestamp: extractBarTimestamp(arr[arr.length - 1]),
  };
}

/**
 * Walk `data.candles = { spot: { '1m':[...], ... }, futures: { ... } }`
 * and replace every leaf bar array with `summariseCandleArray(arr)`.
 * Preserves the outer shape so downstream queries can still ask
 * "how many 5m bars did we see for futures on cycle X?" without
 * paging in the bars themselves.
 *
 * @param {*} candles
 * @returns {*}
 */
function redactCandlesMap(candles) {
  if (!candles || typeof candles !== 'object' || Array.isArray(candles)) return candles;
  const out = {};
  for (const root of Object.keys(candles)) {
    const tfMap = candles[root];
    if (!tfMap || typeof tfMap !== 'object' || Array.isArray(tfMap)) {
      out[root] = tfMap;
      continue;
    }
    const redactedTf = {};
    for (const tf of Object.keys(tfMap)) {
      redactedTf[tf] = summariseCandleArray(tfMap[tf]);
    }
    out[root] = redactedTf;
  }
  return out;
}

/**
 * Redact heavy arrays out of a `DataSnapshot` while preserving every
 * other field. The cloned object is plain JSON so Mongoose can
 * serialise it without surprises.
 *
 * @param {*} data
 * @returns {*}
 */
function redactDataSnapshot(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    candles: redactCandlesMap(data.candles),
  };
}

/**
 * Redact `oi.gammaPressure.perStrike` when it is a heavy per-strike
 * array. Some adapters emit a small object map keyed by strike
 * instead — those are kept intact.
 *
 * @param {*} gammaPressure
 * @returns {*}
 */
function redactGammaPressure(gammaPressure) {
  if (!gammaPressure || typeof gammaPressure !== 'object') return gammaPressure;
  const perStrike = gammaPressure.perStrike;
  if (!Array.isArray(perStrike)) return gammaPressure;
  return {
    ...gammaPressure,
    perStrike: { count: perStrike.length },
  };
}

/**
 * Apply `redactGammaPressure` to an `OIOutput` block.
 *
 * @param {*} oi
 * @returns {*}
 */
function redactOIOutput(oi) {
  if (!oi || typeof oi !== 'object') return oi;
  if (!oi.gammaPressure) return oi;
  return {
    ...oi,
    gammaPressure: redactGammaPressure(oi.gammaPressure),
  };
}

// ============================================================
// Payload assembly
// ============================================================

/**
 * Resolve the `aiAdvisory` discriminator for the audit row. The
 * design enum is `'used' | 'ignored' | 'disabled' | 'unavailable'`.
 * We honour the explicit `ctx.ai.state` produced by the AI adapter
 * and fall back to `'disabled'` when no AI block was emitted (which
 * is the deterministic-only default per Req 14.6).
 *
 * @param {*} ai
 * @returns {('used'|'ignored'|'disabled'|'unavailable')}
 */
function resolveAiAdvisoryState(ai) {
  if (!ai) return 'disabled';
  const state = ai.state;
  if (state === 'used' || state === 'ignored' || state === 'disabled' || state === 'unavailable') {
    return state;
  }
  return 'disabled';
}

/**
 * Build the redacted `payload` block per the design's
 * "Per-Cycle Audit Row Schema". Every field is plain JSON so the
 * resulting object is stable under `JSON.stringify` / Mongoose
 * serialisation.
 *
 * The shape intentionally exposes both:
 *   - the DESIGN-LEVEL aliases (`mandatoryResults`, `oiConfirmations`,
 *     `RR`, `provenance`) flattened up from the signal block, so
 *     audit queries don't have to dig into `payload.signal.*`;
 *   - the per-stage `blocks` map covering every stage output
 *     (`data, regime, structure, liquidity, oi, pcr, signal, risk, ai`)
 *     for full provenance reconstruction (task 2.3 description).
 *
 * @param {*} ctx
 * @returns {Object}
 */
function buildAuditPayload(ctx) {
  const signal = ctx.signal || null;
  const risk = ctx.risk || null;
  const execution = ctx.execution || null;

  // Heavy-array redaction (see redaction comment block above).
  const dataRedacted = redactDataSnapshot(ctx.data);
  const oiRedacted = redactOIOutput(ctx.oi);

  return {
    finalAction: ctx.finalAction !== undefined ? ctx.finalAction : null,
    masterScore: ctx.masterScore !== undefined ? ctx.masterScore : null,
    reasonCodes: Array.isArray(ctx.reasonCodes) ? ctx.reasonCodes.slice() : [],
    aiAdvisory: resolveAiAdvisoryState(ctx.ai),

    // Flattened signal provenance (design "payload.signal.*" aliases
    // hoisted to the top level for query ergonomics).
    mandatoryResults: signal && signal.mandatoryResults ? signal.mandatoryResults : null,
    oiConfirmations:
      signal && Array.isArray(signal.oiConfirmations) ? signal.oiConfirmations.slice() : [],
    RR: signal && signal.riskReward !== undefined ? signal.riskReward : null,
    provenance: signal && signal.provenance ? signal.provenance : null,

    // Per-stage blocks (full outputs after candle/gamma redaction).
    blocks: {
      data: dataRedacted || null,
      regime: ctx.regime || null,
      structure: ctx.structure || null,
      liquidity: ctx.liquidity || null,
      oi: oiRedacted || null,
      pcr: ctx.pcr || null,
      signal: signal || null,
      risk: risk || null,
      ai: ctx.ai || null,
    },

    // Top-level signal / risk / execution per design schema.
    signal: signal
      ? {
          candidate: signal.candidate !== undefined ? signal.candidate : null,
          mandatoryResults: signal.mandatoryResults || null,
          oiConfirmations: Array.isArray(signal.oiConfirmations)
            ? signal.oiConfirmations.slice()
            : [],
          riskReward: signal.riskReward !== undefined ? signal.riskReward : null,
          provenance: signal.provenance || null,
        }
      : null,
    risk: risk
      ? {
          stopLossPoints: risk.stopLossPoints !== undefined ? risk.stopLossPoints : null,
          targetPoints: risk.targetPoints !== undefined ? risk.targetPoints : null,
          positionSize: risk.positionSize !== undefined ? risk.positionSize : null,
        }
      : null,
    execution: execution
      ? {
          status: execution.status !== undefined ? execution.status : null,
          orderId: execution.orderId !== undefined ? execution.orderId : null,
          accounts: Array.isArray(execution.accounts) ? execution.accounts.slice() : null,
        }
      : null,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Persist a single CYCLE_AUDIT row for the cycle described by `ctx`.
 *
 * The function NEVER throws — a DB failure cannot crash the
 * orchestrator. On any error it logs via the standard logger and
 * resolves to `null`.
 *
 * Schema mapping (design → mongoose):
 *   design.type           ⇒ EngineEventLog.eventType    ('CYCLE_AUDIT')
 *   design.cycleId        ⇒ data.cycleId
 *   design.timestamp      ⇒ data.timestamp              (ms epoch)
 *   design.settingsHash   ⇒ data.settingsHash
 *   design.payload        ⇒ data.payload                (redacted)
 *
 * `EngineEventLog` additionally requires `sessionId` and `message`.
 * The orchestrator passes the active `ScalpingSession._id` as
 * `opts.sessionId`; the message is synthesised from cycleId +
 * finalAction so audit-log scrolls are still readable as plain text.
 *
 * @param {Readonly<import('./cycleContext').CycleContext>} ctx
 * @param {Object}  [opts]
 * @param {string}  [opts.type='CYCLE_AUDIT']  Event type discriminator.
 * @param {*}       [opts.sessionId]           Active ScalpingSession id (required by the model).
 * @param {Object}  [opts.model]               Mongoose model override (used by tests to stub `.create`).
 * @returns {Promise<Object|null>}             The created document on success, `null` on failure.
 */
async function writeCycleAudit(ctx, opts) {
  const options = opts || {};
  const type = typeof options.type === 'string' && options.type.length > 0
    ? options.type
    : 'CYCLE_AUDIT';
  const sessionId = options.sessionId !== undefined ? options.sessionId : null;
  const Model = options.model || EngineEventLog;

  try {
    if (!ctx || typeof ctx !== 'object') {
      logger.warn({ type }, 'writeCycleAudit: missing or invalid ctx; skipping persist');
      return null;
    }

    const payload = buildAuditPayload(ctx);
    const cycleId = ctx.cycleId || null;
    const timestamp = ctx.cycleStartedAt || Date.now();
    const settingsHash = ctx.settingsHash || null;
    const finalAction = payload.finalAction || 'NO_TRADE';

    if (!sessionId) {
      // Without a sessionId the row would fail Mongoose validation.
      // Log and bail — an orchestrator integration bug shouldn't
      // crash the prediction loop.
      logger.warn(
        { cycleId, type },
        'writeCycleAudit: missing sessionId; skipping persist (orchestrator must supply ScalpingSession._id)'
      );
      return null;
    }

    const doc = await Model.create({
      sessionId,
      eventType: type, // design.type → schema.eventType
      level: 'info',
      message: `CYCLE_AUDIT ${cycleId || '<no-id>'} ${finalAction}`,
      data: {
        cycleId,
        timestamp,
        settingsHash,
        payload,
      },
    });

    return doc;
  } catch (err) {
    // Never throw. The audit log is observability infrastructure;
    // its failure must not interrupt the prediction loop.
    try {
      logger.error(
        { err: err && err.message, cycleId: ctx && ctx.cycleId },
        'writeCycleAudit: failed to persist CYCLE_AUDIT row'
      );
    } catch (_) {
      // Logger itself failed — fall back to console.error so the
      // failure is at least visible somewhere.
      // eslint-disable-next-line no-console
      console.error('writeCycleAudit error:', err && err.message);
    }
    return null;
  }
}

/**
 * Persist a single MONITORING_SNAPSHOT row produced by
 * `monitoringEngine.adapter.runMonitoringTick` (subtask 16.3 /
 * Req 15.7).
 *
 * The row uses the same `EngineEventLog` collection that
 * `writeCycleAudit` writes into, so a single Mongo query keyed
 * on `eventType` returns the full per-cycle audit trail
 * (CYCLE_AUDIT) interleaved with the per-tick monitoring
 * stream (MONITORING_SNAPSHOT). The orchestrator wires this
 * function into `monitoringEngineAdapter.setEventLogWriter` at
 * `start()` so the active `ScalpingSession._id` flows through
 * — Mongoose validation requires it.
 *
 * Failure semantics mirror `writeCycleAudit`:
 *   - The function NEVER throws.
 *   - A missing / malformed snapshot logs a warning and
 *     returns `null`.
 *   - A missing `sessionId` logs a warning and returns `null`
 *     (the model rejects the row otherwise).
 *   - The snapshot payload is already redacted by
 *     `monitoringEngine.adapter._redact` before reaching this
 *     writer, so we persist the payload verbatim.
 *
 * @param {Object}  snapshot                Redacted monitoring snapshot.
 * @param {Object}  [opts]
 * @param {*}       [opts.sessionId]        Active ScalpingSession id (required).
 * @param {Object}  [opts.model]            Mongoose model override (used by tests).
 * @returns {Promise<Object|null>}
 */
async function writeMonitoringSnapshot(snapshot, opts) {
  const options = opts || {};
  const Model = options.model || EngineEventLog;
  const sessionId = options.sessionId !== undefined ? options.sessionId : null;
  try {
    if (!snapshot || typeof snapshot !== 'object') {
      try {
        logger.warn('writeMonitoringSnapshot: invalid snapshot; skipping persist');
      } catch (_) {
        /* swallow */
      }
      return null;
    }
    if (!sessionId) {
      try {
        logger.warn(
          { tickAt: snapshot.tickAt },
          'writeMonitoringSnapshot: missing sessionId; skipping persist'
        );
      } catch (_) {
        /* swallow */
      }
      return null;
    }
    const tickAtIso = typeof snapshot.tickAt === 'string' ? snapshot.tickAt : null;
    const tickAtMs = tickAtIso ? Date.parse(tickAtIso) : NaN;
    const totalLivePnL =
      typeof snapshot.totalLivePnL === 'number' && Number.isFinite(snapshot.totalLivePnL)
        ? snapshot.totalLivePnL
        : 0;
    const pipelineLatencyMs =
      typeof snapshot.pipelineLatencyMs === 'number' &&
      Number.isFinite(snapshot.pipelineLatencyMs)
        ? snapshot.pipelineLatencyMs
        : 0;
    const doc = await Model.create({
      sessionId,
      eventType: 'MONITORING_SNAPSHOT',
      level: snapshot.error === true ? 'warn' : 'info',
      message:
        `MONITORING_SNAPSHOT tickAt=${tickAtIso || '<no-tickAt>'} ` +
        `totalPnL=${totalLivePnL} latency=${pipelineLatencyMs}ms`,
      data: {
        tickAt: tickAtIso,
        timestamp: Number.isFinite(tickAtMs) ? tickAtMs : Date.now(),
        payload: snapshot,
      },
    });
    return doc;
  } catch (err) {
    try {
      logger.error(
        { err: err && err.message, tickAt: snapshot && snapshot.tickAt },
        'writeMonitoringSnapshot: failed to persist MONITORING_SNAPSHOT row'
      );
    } catch (_) {
      // eslint-disable-next-line no-console
      console.error('writeMonitoringSnapshot error:', err && err.message);
    }
    return null;
  }
}

module.exports = {
  writeCycleAudit,
  writeMonitoringSnapshot,
  // Exposed for unit tests / orchestrator-side reuse.
  buildAuditPayload,
  redactCandlesMap,
  redactDataSnapshot,
  redactGammaPressure,
  redactOIOutput,
  summariseCandleArray,
};
