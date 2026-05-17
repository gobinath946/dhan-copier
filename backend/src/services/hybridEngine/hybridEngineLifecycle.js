'use strict';

/**
 * ============================================================
 * HYBRID_ENGINE LIFECYCLE WRAPPER (subtask 18.2)
 * ============================================================
 *
 * Minimal-blast-radius integration shim between the existing
 * `ScalpingSession` lifecycle (driven by
 * `services/scalpingEngine.service.js`) and the new
 * `Hybrid_Engine` orchestrator (`services/hybridEngine/hybridEngine.service.js`).
 *
 * Why a wrapper instead of editing `scalpingEngine.service.js`?
 *   The legacy scalping engine is the only path currently used
 *   in production; modifying its `start()` / `stop()` directly
 *   risks breaking the live engine when the operator only wants
 *   to evaluate the hybrid pipeline against recorded JSONL.
 *   This wrapper exposes two named hooks that an integrator can
 *   opt-in to from the existing service (or from a future
 *   feature-flagged route handler) without changing the legacy
 *   behaviour by default.
 *
 * Failure semantics (Req 1.5 / 2.6 / 2.8):
 *   - `startWithSession` NEVER throws. Every failure mode
 *     (`INVALID_SESSION`, `ALGO_SETTINGS_LOAD_FAILED`,
 *     `ALGO_SETTINGS_INVALID`, `ALGO_SETTINGS_VALIDATION_THREW`)
 *     resolves to a structured `{ started: false, reason, ... }`.
 *   - `stopWithSession` NEVER throws — best-effort teardown of
 *     the orchestrator timers and a defensive clear of the
 *     Risk_Engine's auto-persist session id.
 *
 * Spec references:
 *   - Req 1.1 — single hybrid engine, lifecycle gated by
 *     `ScalpingSession`.
 *   - Req 2.6 — refuse to start on Algo_Settings validation
 *     failure and surface per-key errors.
 *   - Req 2.8 — refuse to start on Algo_Settings load failure
 *     and surface the failure cause.
 * ============================================================
 */

const algoSettings = require('../../config/algoSettings');
const hybridEngine = require('./hybridEngine.service');
const riskEngineAdapter = require('./riskEngine.adapter');
const logger = require('../../utils/logger');

/**
 * Boot the Hybrid_Engine alongside an active `ScalpingSession`.
 *
 * The bring-up order is:
 *   1. Validate the supplied session has a usable `_id`.
 *   2. Snapshot Algo_Settings; on a load failure (Req 2.8)
 *      return `{ reason: 'ALGO_SETTINGS_LOAD_FAILED' }`.
 *   3. Run `algoSettings.validateSettings(...)` (Req 2.6); on
 *      a validation failure return `{ reason: 'ALGO_SETTINGS_INVALID',
 *      errors }` where `errors` is a `{ key: reason }` map.
 *   4. Initialise Risk_Engine session-state with the session's
 *      capital baseline so daily-loss / exposure gates have a
 *      denominator (Req 12.x).
 *   5. Wire the active session id into Risk_Engine's auto-
 *      persist hooks so survival-layer counters land in
 *      `ScalpingSession.payload.riskState` (Req 12.12).
 *   6. Best-effort restore of any prior in-process risk state
 *      so an operator-triggered restart within a single trading
 *      day resumes the kill-switch / consecutive-loss counters
 *      identically (Req 12.12 / Req 18.6).
 *   7. Hand off to `hybridEngine.start({ sessionId, ... })`
 *      which itself re-runs the validate gate and installs the
 *      process-level shutdown handlers — that's intentional
 *      defence-in-depth so a future caller of `start()` outside
 *      this wrapper still gets the same protection.
 *
 * @param {Object} params
 * @param {Object} params.session                       Active `ScalpingSession` document or plain object.
 * @param {('live'|'simulation')} [params.executionMode] Forwarded to `hybridEngine.start`.
 * @param {string|null}           [params.replayFolder]  Forwarded to `hybridEngine.start`.
 * @returns {Promise<{ started: boolean, reason?: string, errors?: Object, error?: string, predictionIntervalMs?: number, executionMode?: string, replayFolder?: (string|null) }>}
 */
async function startWithSession({ session, executionMode, replayFolder } = {}) {
  // Step 1 — session sanity. We accept any object that exposes
  // an `_id` (Mongoose docs OR plain test fixtures); the id is
  // stringified before being threaded onward.
  if (!session || typeof session !== 'object' || !session._id) {
    return { started: false, reason: 'INVALID_SESSION' };
  }
  const sessionId = String(
    typeof session._id.toString === 'function' ? session._id.toString() : session._id
  );

  // Step 2 — Algo_Settings load gate (Req 2.8).
  let settings;
  try {
    settings = algoSettings.snapshot();
  } catch (err) {
    try {
      logger.error(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] Algo_Settings load failure; refusing to start session (Req 2.8)'
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

  // Step 3 — Algo_Settings validation gate (Req 2.6).
  let validation;
  try {
    validation = algoSettings.validateSettings(settings);
  } catch (err) {
    try {
      logger.error(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] Algo_Settings validation threw; refusing to start session (Req 2.6)'
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
  if (validation && validation.valid === false) {
    const perKeyErrors = {};
    if (Array.isArray(validation.errors)) {
      for (const e of validation.errors) {
        if (e && typeof e.key === 'string') {
          perKeyErrors[e.key] = e.reason || 'invalid';
        }
      }
    }
    try {
      logger.error(
        { module: 'hybridEngineLifecycle', errors: perKeyErrors },
        '[hybridEngineLifecycle] Algo_Settings invalid; refusing to start session (Req 2.6)'
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

  // Step 4 — initialise Risk_Engine session-state with the
  // capital baseline. Prefer the explicit `currentCapital` /
  // `initialCapital` fields persisted on `ScalpingSession`,
  // fall back to a flat `payload.capital` (test fixtures), and
  // finally to a plain `session.capital` (also test fixtures).
  // Risk_Engine itself defends against zero / negative capital;
  // we just forward whatever the caller provided.
  const sessionStartCapital = _resolveCapital(session);
  try {
    if (typeof riskEngineAdapter.initSessionState === 'function') {
      riskEngineAdapter.initSessionState({ sessionStartCapital });
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] riskEngineAdapter.initSessionState failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Step 5 — bind the session id into the Risk_Engine adapter's
  // auto-persist hooks. This is independent of the orchestrator's
  // own `setSessionId` (which `start()` will also wire below) —
  // the adapter writes survival-layer counters into
  // `ScalpingSession.payload.riskState` regardless of whether the
  // orchestrator has started yet.
  try {
    if (typeof riskEngineAdapter.setSessionId === 'function') {
      riskEngineAdapter.setSessionId({ sessionId });
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] riskEngineAdapter.setSessionId failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Step 6 — best-effort restore from any prior in-process
  // restart within the same `ScalpingSession`.
  try {
    if (typeof riskEngineAdapter.restoreRiskState === 'function') {
      await riskEngineAdapter.restoreRiskState({ sessionId });
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] restoreRiskState failed; continuing with fresh state'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Step 7 — hand off to the orchestrator. `start()` itself
  // re-runs the validate gate (defence-in-depth) and installs
  // the process-level SIGINT/SIGTERM shutdown handlers.
  return hybridEngine.start({ executionMode, replayFolder, sessionId });
}

/**
 * Tear down the Hybrid_Engine alongside a `ScalpingSession` stop.
 *
 *   - Calls `hybridEngine.stop()` (idempotent).
 *   - Clears the Risk_Engine adapter's auto-persist session id
 *     so subsequent stray writes (e.g. from a delayed adapter
 *     callback) become no-ops rather than landing on an
 *     unrelated session.
 *
 * NEVER throws.
 *
 * @param {Object} [params]
 * @param {Object} [params.session]
 * @returns {{ stopped: boolean }}
 */
function stopWithSession({ session } = {}) {
  try {
    hybridEngine.stop();
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] hybridEngine.stop failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }
  // Defensive clear — even if `stopWithSession` is called without
  // a session reference we want the adapter's auto-persist hook
  // to go quiet so it cannot mis-route a write.
  try {
    if (typeof riskEngineAdapter.setSessionId === 'function') {
      riskEngineAdapter.setSessionId({ sessionId: null });
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'hybridEngineLifecycle', err: err && err.message },
        '[hybridEngineLifecycle] riskEngineAdapter.setSessionId(null) failed; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }
  // `session` is accepted for symmetry with `startWithSession`
  // and to leave room for future per-session cleanup hooks; we
  // currently log the id so an operator can correlate the stop
  // with the session in the audit trail.
  if (session && session._id) {
    try {
      logger.info(
        { module: 'hybridEngineLifecycle', sessionId: String(session._id) },
        '[hybridEngineLifecycle] hybrid engine stopped for session'
      );
    } catch (_) {
      /* swallow */
    }
  }
  return { stopped: true };
}

/**
 * Resolve the session's starting capital from the heterogeneous
 * shapes that production / tests / fixtures may provide:
 *   - `session.currentCapital` (Mongoose default, kept fresh by
 *     the legacy engine)
 *   - `session.initialCapital` (Mongoose default, set on create)
 *   - `session.payload.capital` (free-form payload escape hatch)
 *   - `session.capital`         (test fixtures)
 *   - 0 fallback                (defensive — Risk_Engine's
 *                                daily-loss math handles 0).
 *
 * @param {Object} session
 * @returns {number}
 */
function _resolveCapital(session) {
  if (!session || typeof session !== 'object') return 0;
  if (typeof session.currentCapital === 'number' && Number.isFinite(session.currentCapital)) {
    return session.currentCapital;
  }
  if (typeof session.initialCapital === 'number' && Number.isFinite(session.initialCapital)) {
    return session.initialCapital;
  }
  if (
    session.payload &&
    typeof session.payload === 'object' &&
    typeof session.payload.capital === 'number' &&
    Number.isFinite(session.payload.capital)
  ) {
    return session.payload.capital;
  }
  if (typeof session.capital === 'number' && Number.isFinite(session.capital)) {
    return session.capital;
  }
  return 0;
}

module.exports = {
  startWithSession,
  stopWithSession,
  // Exported for unit / smoke tests.
  _resolveCapital,
};
