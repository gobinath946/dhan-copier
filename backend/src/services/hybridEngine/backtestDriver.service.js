'use strict';

/**
 * ============================================================
 * BACKTEST DRIVER — replay recorded JSONL through Hybrid_Engine
 * ============================================================
 * The Hybrid_Engine orchestrator already supports a per-cycle
 * `replayFolder` (subtask 18.1) that points its Data_Engine at a
 * recorded `live-feed/<YYYY-MM-DD>_NIFTY_50/` folder instead of
 * the live Dhan WebSocket / API. This driver is the operator-
 * facing entry point that:
 *
 *   1. Resolves a target replay date (default = last Friday).
 *   2. Locates the recorded folder under `live-feed/`.
 *   3. Opens a fresh `ScalpingSession` row tagged
 *      `notes: 'backtest|<date>'` so live and backtest sessions
 *      never collide in the audit trail.
 *   4. Hands off to `hybridEngineLifecycle.startWithSession({
 *      executionMode: 'simulation', replayFolder })` so every
 *      simulated fill lands in `TradeExecutionLog` with
 *      `simulation: true` and never touches the broker.
 *
 * It does NOT itself contain a cycle loop — the orchestrator's
 * own `setInterval` does the ticking. The driver only owns the
 * lifecycle (start / stop / status).
 *
 * Failure semantics (Req 1.5):
 *   - `start({ ... })` NEVER throws. Every failure mode returns
 *     a structured `{ started: false, reason, ... }` object.
 *   - `stop()` is idempotent.
 *
 * Spec references:
 *   - Req 1.1 / 1.2 / 1.3 — local-only operation, no cloud, JSONL.
 *   - Req 4.4               — recorded JSONL is the preferred data
 *                              source when same-day data exists.
 *   - Req 18.1              — `executionMode = 'simulation'` and
 *                              `setReplayFolder(...)` switches.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const logger = require('../../utils/logger');
const ScalpingSession = require('../../models/ScalpingSession');
const algoSettings = require('../../config/algoSettings');
const lifecycle = require('./hybridEngineLifecycle');
const hybridEngine = require('./hybridEngine.service');
const dataEngine = require('./dataEngine.adapter');

const LIVE_FEED_ROOT = path.join(__dirname, '..', '..', '..', 'live-feed');
const UNDERLYING_SUFFIX = '_NIFTY_50';

// Backtest cadence — we override the live-mode predictionIntervalMs
// (5000 ms) with a much faster tick so a 6-hour recorded session
// finishes in a few minutes of wall clock. The replay clock inside
// `dataEngine.adapter` advances proportionally (1× session-time per
// 1× wall-time) which keeps the tick-staleness gate honest.
//
// The default below ticks 25× per second, so a 375-minute session
// (09:15 → 15:30 IST) covers in ~15 seconds of wall clock at the
// equivalent simulated cycle cadence the live engine would produce.
const DEFAULT_BACKTEST_PREDICTION_INTERVAL_MS = 200;

// Soft auto-stop. The replay clock is clamped to 15:30 IST inside
// `dataEngine`, so cycles past close keep ticking but produce
// identical snapshots. We auto-stop after this many cycles past
// the simulated close so the audit log doesn't grow unbounded.
const POST_CLOSE_GRACE_CYCLES = 20;

// ============================================================
// Module-level state
// ============================================================

/**
 * @typedef {Object} ActiveBacktest
 * @property {string} sessionId       Mongoose `ScalpingSession._id` as string.
 * @property {string} replayDate      `YYYY-MM-DD`.
 * @property {string} replayFolder    Absolute folder path.
 * @property {number} startedAt       Epoch ms.
 * @property {number} predictionIntervalMs
 */

/** @type {ActiveBacktest|null} */
let _active = null;

/** @type {NodeJS.Timeout|null} Soft auto-stop watchdog. */
let _autoStopTimer = null;

// ============================================================
// Helpers
// ============================================================

/**
 * Format a `Date` as IST `YYYY-MM-DD`. Live-feed folders are
 * always named with the IST trading-session date so we have to
 * convert from a UTC `Date` into IST before stringifying.
 *
 * @param {Date} date
 * @returns {string}
 */
function _formatISTDate(date) {
  const istMs = date.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolve "last Friday" relative to `now`. If `now` is a Friday
 * AFTER market close (≥ 16:00 IST), use it; otherwise step back
 * to the previous Friday. Used as the default replay date when
 * the operator doesn't specify one.
 *
 * @param {Date} [now]
 * @returns {string}  YYYY-MM-DD
 */
function _resolveLastFriday(now) {
  const ref = now instanceof Date ? new Date(now.getTime()) : new Date();
  // Convert to IST so weekday math matches the local trading day.
  const istMs = ref.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istMs);
  const dow = ist.getUTCDay(); // 0=Sun, 5=Fri
  let daysBack;
  if (dow === 5) {
    // Today is Friday in IST. Use today only if past 16:00 IST,
    // else step back a full week.
    const istHour = ist.getUTCHours();
    daysBack = istHour >= 16 ? 0 : 7;
  } else if (dow === 6) {
    daysBack = 1; // Sat → previous Fri
  } else if (dow === 0) {
    daysBack = 2; // Sun → previous Fri
  } else {
    daysBack = dow + 2; // Mon→3, Tue→4, Wed→5, Thu→6
  }
  const target = new Date(ref.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return _formatISTDate(target);
}

/**
 * Build the absolute folder path for a given replay date.
 *
 * @param {string} date  YYYY-MM-DD
 * @returns {string}
 */
function _replayFolderFor(date) {
  return path.join(LIVE_FEED_ROOT, `${date}${UNDERLYING_SUFFIX}`);
}

/**
 * Confirm the folder exists AND has the minimum file set the
 * Data_Engine reads on every cycle. Missing optional files
 * (e.g. `option-chain.jsonl`) are tolerated — Data_Engine
 * already handles `optionChain: null` by emitting the
 * `OPTION_CHAIN_UNAVAILABLE` reason code.
 *
 * @param {string} folder
 * @returns {{ ok: boolean, missing?: string[] }}
 */
function _validateReplayFolder(folder) {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return { ok: false, missing: [folder] };
  }
  const required = ['candles-1m.jsonl'];
  const missing = required.filter((f) => !fs.existsSync(path.join(folder, f)));
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

/**
 * List every recorded date under `live-feed/`. Used by the
 * `listAvailableDates()` API so the UI can offer a dropdown.
 *
 * @returns {string[]}  Sorted YYYY-MM-DD list (ascending).
 */
function listAvailableDates() {
  if (!fs.existsSync(LIVE_FEED_ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(LIVE_FEED_ROOT)) {
    if (!entry.endsWith(UNDERLYING_SUFFIX)) continue;
    const datePart = entry.slice(0, entry.length - UNDERLYING_SUFFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;
    out.push(datePart);
  }
  return out.sort();
}

/**
 * Resolve a caller-supplied date (or `null`) to the actual date
 * that will be replayed, plus the absolute folder. Pure and
 * synchronous so the controller can preview the choice before
 * committing to a session row.
 *
 * @param {string|null|undefined} date
 * @returns {{ date: string, folder: string, available: boolean }}
 */
function resolveReplay(date) {
  const target = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : _resolveLastFriday();
  const folder = _replayFolderFor(target);
  const validation = _validateReplayFolder(folder);
  return { date: target, folder, available: validation.ok };
}

/**
 * Read the operator-confirmed capital from Algo_Settings. The
 * legacy engine stores capital in `settings.capital`; we mirror
 * the Hybrid_Engine convention by also accepting nested
 * `riskEngine.capital` if a future Algo_Settings revision
 * introduces one. Falls back to 100000 (₹1 lakh) — Risk_Engine's
 * daily-loss math degrades safely on a zero baseline so this
 * fallback is just to keep the audit row meaningful.
 *
 * @returns {number}
 */
function _readBacktestCapital() {
  try {
    const settings = algoSettings.snapshot();
    if (settings && typeof settings.capital === 'number' && Number.isFinite(settings.capital)) {
      return settings.capital;
    }
    if (
      settings &&
      settings.riskEngine &&
      typeof settings.riskEngine.capital === 'number' &&
      Number.isFinite(settings.riskEngine.capital)
    ) {
      return settings.riskEngine.capital;
    }
  } catch (_) {
    /* swallow */
  }
  return 100000;
}

// ============================================================
// Public API
// ============================================================

/**
 * Start a backtest run.
 *
 *   1. Resolves the target replay date (default = last Friday).
 *   2. Confirms the recorded JSONL folder exists.
 *   3. Opens a fresh `ScalpingSession` row tagged for backtest.
 *   4. Hands off to `hybridEngineLifecycle.startWithSession({
 *      executionMode: 'simulation', replayFolder })`.
 *   5. On any failure, marks the session row `status: 'error'`
 *      so the audit trail records the abort.
 *
 * NEVER throws. Every failure mode returns a structured
 * `{ started: false, reason, ... }` object.
 *
 * @param {Object} [opts]
 * @param {string} [opts.date]                 Optional `YYYY-MM-DD` override.
 * @param {number} [opts.predictionIntervalMs] Optional cadence override (default = Algo_Settings).
 * @returns {Promise<{ started: boolean, reason?: string, session?: Object, replayDate?: string, replayFolder?: string, error?: string, errors?: Object, available?: string[] }>}
 */
async function start(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};

  if (_active) {
    // Stale-state recovery: if the driver thinks a backtest is
    // running but the orchestrator isn't actually ticking
    // (cycleStats.isRunning === false), force-clear `_active` so
    // the operator can re-Start without restarting the backend.
    let staleActive = false;
    try {
      const stats = hybridEngine.getCycleStats();
      if (stats && stats.isRunning !== true) staleActive = true;
    } catch (_) {
      staleActive = true;
    }
    if (staleActive) {
      try {
        logger.warn(
          {
            module: 'backtestDriver',
            staleSessionId: _active.sessionId,
            staleReplayDate: _active.replayDate,
          },
          '[backtestDriver] discarding stale _active marker; orchestrator is not ticking'
        );
      } catch (_) {
        /* swallow */
      }
      // Best-effort cleanup of the stale session row.
      try { await stop({ reason: 'Stale state cleared' }); } catch (_) { /* swallow */ }
    } else {
      return {
        started: false,
        reason: 'BACKTEST_ALREADY_RUNNING',
        replayDate: _active.replayDate,
        replayFolder: _active.replayFolder,
      };
    }
  }

  // Step 1/2 — resolve folder.
  const resolution = resolveReplay(options.date);
  if (!resolution.available) {
    return {
      started: false,
      reason: 'REPLAY_FOLDER_NOT_FOUND',
      replayDate: resolution.date,
      replayFolder: resolution.folder,
      available: listAvailableDates(),
    };
  }

  // Step 3 — open a backtest-tagged session row. Capital comes
  // from Algo_Settings so the survival-layer math has a
  // baseline; the row itself is identical in shape to a live
  // session, just with `notes` carrying the backtest tag.
  const capital = _readBacktestCapital();
  let session;
  try {
    session = await ScalpingSession.create({
      status: 'running',
      aiModel: 'gpt-4o-mini',
      settings: {
        capital,
        executionMode: 'simulation',
      },
      initialCapital: capital,
      currentCapital: capital,
      notes: `backtest|${resolution.date}`,
    });
  } catch (err) {
    try {
      logger.error(
        { module: 'backtestDriver', err: err && err.message },
        '[backtestDriver] failed to open ScalpingSession; refusing to start'
      );
    } catch (_) {
      /* swallow */
    }
    return {
      started: false,
      reason: 'SESSION_OPEN_FAILED',
      error: err && err.message ? err.message : String(err),
    };
  }

  // Step 3a — anchor the replay clock at session open (09:15 IST
  // for the resolved date). Without this, the very first cycle
  // would inherit whatever cursor the previous backtest left
  // behind. `dataEngine` exposes the reset helper for exactly
  // this case.
  try {
    if (typeof dataEngine.resetReplayClock === 'function') {
      dataEngine.resetReplayClock(resolution.folder);
    }
  } catch (_) {
    /* swallow — driver still works without the reset */
  }

  // Step 3b — override the prediction cadence for the backtest
  // run only. We mutate Algo_Settings via `updateSettings` so
  // the orchestrator's `start()` reads the faster cadence on
  // the snapshot it takes; the live default (5 s) is restored
  // by `stop()` below.
  const overrideCadenceMs =
    typeof options.predictionIntervalMs === 'number' && Number.isFinite(options.predictionIntervalMs)
      ? Math.max(50, options.predictionIntervalMs)
      : DEFAULT_BACKTEST_PREDICTION_INTERVAL_MS;
  try {
    algoSettings.updateSettings({
      signalEngine: { predictionIntervalMs: overrideCadenceMs },
    });
  } catch (err) {
    try {
      logger.warn(
        { module: 'backtestDriver', err: err && err.message },
        '[backtestDriver] failed to override predictionIntervalMs; continuing with current setting'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Step 4 — hand off to the lifecycle wrapper.
  let lifecycleResult;
  try {
    lifecycleResult = await lifecycle.startWithSession({
      session,
      executionMode: 'simulation',
      replayFolder: resolution.folder,
    });
  } catch (err) {
    // Defence-in-depth: lifecycle.startWithSession is
    // documented as never-throw but we still wrap.
    lifecycleResult = {
      started: false,
      reason: 'LIFECYCLE_THREW',
      error: err && err.message ? err.message : String(err),
    };
  }

  if (!lifecycleResult || lifecycleResult.started !== true) {
    // Mark the session row as `error` so the audit trail
    // records the abort cause.
    try {
      session.status = 'error';
      session.endedAt = new Date();
      session.lastError = lifecycleResult ? lifecycleResult.reason : 'UNKNOWN';
      session.notes = `backtest|${resolution.date}|${lifecycleResult ? lifecycleResult.reason : 'UNKNOWN'}`;
      await session.save();
    } catch (_) {
      /* swallow — audit row update is best-effort */
    }
    return {
      ...lifecycleResult,
      replayDate: resolution.date,
      replayFolder: resolution.folder,
    };
  }

  // Optional cadence override — mutate after lifecycle has
  // already started so the orchestrator timer reflects it on
  // its next tick. We re-call `setInterval` indirectly via
  // stop()+start() only when explicitly requested.
  // For 18.x scope we skip mid-flight cadence rewiring; the
  // operator can stop and restart with a different value.

  _active = {
    sessionId: String(session._id),
    replayDate: resolution.date,
    replayFolder: resolution.folder,
    startedAt: Date.now(),
    predictionIntervalMs:
      typeof lifecycleResult.predictionIntervalMs === 'number'
        ? lifecycleResult.predictionIntervalMs
        : 5000,
  };

  // Soft auto-stop watchdog. The replay clock clamps at 15:30
  // IST so cycles past close are no-ops, but we don't want the
  // audit log growing forever. Once the orchestrator has
  // produced enough cycles to cover a full session at the
  // current cadence, plus the post-close grace, we trigger a
  // graceful stop.
  const sessionDurationMs = (6 * 60 + 15) * 60 * 1000; // 09:15 → 15:30 IST
  const totalCycles =
    Math.ceil(sessionDurationMs / Math.max(50, _active.predictionIntervalMs)) +
    POST_CLOSE_GRACE_CYCLES;
  const watchdogTimeoutMs = totalCycles * Math.max(50, _active.predictionIntervalMs);
  try {
    _autoStopTimer = setTimeout(() => {
      stop({ reason: 'Session replay completed' }).catch(() => {});
    }, watchdogTimeoutMs);
    if (typeof _autoStopTimer.unref === 'function') _autoStopTimer.unref();
  } catch (_) {
    /* swallow — manual stop still works */
  }

  try {
    logger.info(
      {
        module: 'backtestDriver',
        sessionId: _active.sessionId,
        replayDate: _active.replayDate,
        replayFolder: _active.replayFolder,
        predictionIntervalMs: _active.predictionIntervalMs,
      },
      '[backtestDriver] backtest started'
    );
  } catch (_) {
    /* swallow */
  }

  return {
    started: true,
    session: {
      _id: String(session._id),
      status: session.status,
      startedAt: session.startedAt,
      notes: session.notes,
    },
    replayDate: _active.replayDate,
    replayFolder: _active.replayFolder,
    predictionIntervalMs: _active.predictionIntervalMs,
  };
}

/**
 * Stop the active backtest run. Idempotent — calling on an
 * inactive driver is a no-op. NEVER throws.
 *
 * @param {Object} [opts]
 * @param {string} [opts.reason]
 * @returns {Promise<{ stopped: boolean, sessionId?: string }>}
 */
async function stop(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (!_active) {
    return { stopped: false, reason: 'NOT_RUNNING' };
  }
  const sessionId = _active.sessionId;
  const replayDate = _active.replayDate;
  const reason = options.reason || 'Stopped by user';

  // Cancel the auto-stop watchdog if it's still pending.
  if (_autoStopTimer !== null) {
    try { clearTimeout(_autoStopTimer); } catch (_) { /* swallow */ }
    _autoStopTimer = null;
  }

  // Tear down the orchestrator + monitoring loop.
  try {
    lifecycle.stopWithSession({ session: { _id: sessionId } });
  } catch (err) {
    try {
      logger.warn(
        { module: 'backtestDriver', err: err && err.message },
        '[backtestDriver] lifecycle.stopWithSession failed; continuing cleanup'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Mark the session row as stopped so it shows up correctly
  // in the audit UI.
  try {
    const session = await ScalpingSession.findById(sessionId);
    if (session) {
      session.status = 'stopped';
      session.endedAt = new Date();
      session.notes = `backtest|${replayDate}|${reason}`;
      await session.save();
    }
  } catch (err) {
    try {
      logger.warn(
        { module: 'backtestDriver', err: err && err.message },
        '[backtestDriver] failed to mark backtest session stopped; continuing'
      );
    } catch (_) {
      /* swallow */
    }
  }

  // Restore live-mode cadence in Algo_Settings so the next live
  // session boots with the operator-configured 5 s default.
  try {
    algoSettings.updateSettings({
      signalEngine: { predictionIntervalMs: 5000 },
    });
  } catch (_) {
    /* swallow */
  }

  // Clear the replay-clock state so a subsequent backtest run
  // anchors fresh at session open.
  try {
    if (typeof dataEngine.resetReplayClock === 'function') {
      dataEngine.resetReplayClock();
    }
  } catch (_) {
    /* swallow */
  }

  _active = null;
  return { stopped: true, sessionId, replayDate, reason };
}

/**
 * Read the current driver state. Used by the controller's
 * `/backtest/status` endpoint and by tests.
 *
 * @returns {{ running: boolean, active?: ActiveBacktest, cycleStats?: Object }}
 */
function getStatus() {
  if (!_active) return { running: false };
  let cycleStats = null;
  try {
    cycleStats = hybridEngine.getCycleStats();
  } catch (_) {
    cycleStats = null;
  }
  return {
    running: true,
    active: { ..._active },
    cycleStats,
  };
}

/**
 * Test-only reset of module state. Used by smoke / property
 * tests to wipe the active marker between scenarios. Production
 * callers MUST NOT touch this.
 *
 * @returns {void}
 */
function __resetForTest() {
  _active = null;
}

module.exports = {
  start,
  stop,
  getStatus,
  resolveReplay,
  listAvailableDates,
  // Test helpers
  __resetForTest,
  // Constants exposed for tests / consumers.
  LIVE_FEED_ROOT,
  UNDERLYING_SUFFIX,
};
