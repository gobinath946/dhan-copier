const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const engine = require('../services/scalpingEngine.service');
const { isMarketOpen } = require('../services/marketHours.service');
const ScalpingSession = require('../models/ScalpingSession');
const ScalpingTrade = require('../models/ScalpingTrade');
const engineLogger = require('../services/engineLogger.service');
const algoSettings = require('../config/algoSettings');
const backtestDriver = require('../services/hybridEngine/backtestDriver.service');
const path = require('path');
const fs = require('fs');
const hybridLifecycle = require('../services/hybridEngine/hybridEngineLifecycle');
const hybridEngine = require('../services/hybridEngine/hybridEngine.service');

// ============================================================
// Live-feed folder discovery (used when executionMode = 'simulation')
// ============================================================
const LIVE_FEED_ROOT = path.join(__dirname, '..', '..', 'live-feed');
const UNDERLYING_SUFFIX = '_NIFTY_50';

/**
 * Return all available replay dates sorted ascending. A date is
 * "available" when its `<YYYY-MM-DD>_NIFTY_50/candles-1m.jsonl`
 * exists and is non-empty.
 *
 * @returns {string[]}
 */
function _listReplayDates() {
  if (!fs.existsSync(LIVE_FEED_ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(LIVE_FEED_ROOT)) {
    if (!entry.endsWith(UNDERLYING_SUFFIX)) continue;
    const datePart = entry.slice(0, entry.length - UNDERLYING_SUFFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;
    const f = path.join(LIVE_FEED_ROOT, entry, 'candles-1m.jsonl');
    if (fs.existsSync(f) && fs.statSync(f).size > 0) out.push(datePart);
  }
  return out.sort();
}

exports.marketStatus = asyncHandler(async (_req, res) => {
  res.json({ ok: true, ...isMarketOpen() });
});

exports.getSettings = asyncHandler(async (_req, res) => {
  const settings = algoSettings.getSettings();
  res.json({ ok: true, settings, aiModel: settings.aiModel });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const { settings: updates } = req.body;
  
  if (!updates || typeof updates !== 'object') {
    throw new HttpError(400, 'Settings object is required');
  }

  // Atomic hot-reload (Req 2.4 / 2.5): updateSettings now performs the
  // deep-merge → validate → atomic-swap flow internally. On invalid input
  // it returns `{ applied: false, errors, warnings, settings }` WITHOUT
  // mutating the previously active configuration; on valid input it swaps
  // the active container and returns the new snapshot under `.settings`.
  const result = algoSettings.updateSettings(updates);

  if (!result.applied) {
    throw new HttpError(400, `Invalid settings: ${result.errors.join(', ')}`);
  }

  res.json({
    ok: true,
    settings: result.settings,
    warnings: result.warnings.map((w) => w.toString()),
    message: 'Settings updated successfully',
  });
});

exports.start = asyncHandler(async (req, res) => {
  // ============================================================
  // UNIFIED START PREDICTION
  // ============================================================
  // Routes through the Hybrid_Engine (UT-Bot-primary + 12-mandatory
  // + AI advisory layer) regardless of execution mode. Mode selection:
  //
  //   live        → Data_Engine reads from Dhan WebSocket / API.
  //   simulation  → Data_Engine reads from `live-feed/<date>_NIFTY_50/`
  //                 JSONL recordings. Speed multiplier compresses the
  //                 5s prediction interval (×1=5000ms, ×10=500ms).
  //
  // Body:
  //   { executionMode?: 'live'|'simulation',
  //     speedMultiplier?: 1|2|5|10,
  //     replayDate?: 'YYYY-MM-DD',
  //     settings?: {...},
  //     aiModel?: string }
  //
  // Falls back to `algoSettings.executionMode` when body omits it.
  // ============================================================
  const authKey = req.headers['x-dhan-bypass-key'] || process.env.DHAN_ACCESS_TOKEN;
  if (!authKey) {
    throw new HttpError(400, 'Missing authentication - no bypass key or production token available');
  }

  const body = req.body || {};
  const backendSettings = algoSettings.getSettings();
  const settings = body.settings ? { ...backendSettings, ...body.settings } : backendSettings;

  if (!settings || !settings.capital || !settings.lotSize) {
    throw new HttpError(400, 'Settings with capital and lotSize are required');
  }

  // Resolve execution mode (request body wins over algoSettings default).
  const requestedMode = (body.executionMode || settings.executionMode || 'live').toLowerCase();
  const executionMode = requestedMode === 'simulation' ? 'simulation' : 'live';

  // Resolve speed multiplier (simulation only). Allowed: 1, 2, 5, 10.
  // Speed multiplier divides the configured `signalEngine.predictionIntervalMs`.
  let speedMultiplier = 1;
  const reqSpeed = parseFloat(body.speedMultiplier);
  if (Number.isFinite(reqSpeed) && reqSpeed >= 1 && reqSpeed <= 100) {
    speedMultiplier = reqSpeed;
  }

  // Resolve replay folder when in simulation. Default = oldest
  // available trading day so the operator gets to walk forward
  // through the full backtest history. The body can override with
  // `replayDate: 'YYYY-MM-DD'` to start from a specific day.
  let replayFolder = null;
  let replayDate = null;
  let availableDates = [];
  if (executionMode === 'simulation') {
    availableDates = _listReplayDates();
    if (availableDates.length === 0) {
      throw new HttpError(400, 'No replay data available under live-feed/. Run scripts/backfill-sequential.js first.');
    }
    if (body.replayDate && /^\d{4}-\d{2}-\d{2}$/.test(body.replayDate)) {
      if (!availableDates.includes(body.replayDate)) {
        throw new HttpError(400, `Replay date ${body.replayDate} not available. Available: ${availableDates.join(', ')}`);
      }
      replayDate = body.replayDate;
    } else {
      // Default to OLDEST available so simulation walks forward.
      replayDate = availableDates[0];
    }
    replayFolder = path.join(LIVE_FEED_ROOT, `${replayDate}${UNDERLYING_SUFFIX}`);
  }

  // Apply speed multiplier to BOTH the prediction loop and the
  // replay clock. The prediction interval shrinks (cycles fire
  // faster) AND the replay cursor advances faster (so a 6h15m
  // session compresses proportionally).
  const baseIntervalMs = settings.signalEngine && settings.signalEngine.predictionIntervalMs
    ? settings.signalEngine.predictionIntervalMs
    : 5000;
  const targetIntervalMs = Math.max(100, Math.round(baseIntervalMs / speedMultiplier));
  if (executionMode === 'simulation' && targetIntervalMs !== baseIntervalMs) {
    algoSettings.updateSettings({
      signalEngine: { predictionIntervalMs: targetIntervalMs },
    });
  }
  // Wire the speed multiplier into Data_Engine's replay clock.
  if (executionMode === 'simulation') {
    try {
      const dataEngineAdapter = require('../services/hybridEngine/dataEngine.adapter');
      dataEngineAdapter.setReplaySpeedMultiplier(speedMultiplier);
      // Reset the clock anchor so the cursor starts at session-open
      // for the chosen replay folder (independent of any prior run).
      dataEngineAdapter.resetReplayClock(replayFolder);
    } catch (err) {
      console.warn('[scalping.controller] dataEngine speed-multiplier wire failed:', err.message);
    }
  }

  // Create a fresh ScalpingSession row (notes-tagged so live + sim
  // sessions are easy to tell apart in the audit trail).
  const session = await ScalpingSession.create({
    settings,
    executionMode,
    notes: executionMode === 'simulation'
      ? `simulation|${replayDate}|speed:${speedMultiplier}x`
      : 'live|hybrid_engine',
    status: 'running',
    capital: settings.capital,
    initialCapital: settings.capital,
    currentCapital: settings.capital,
    startTime: new Date(),
  });

  // Wire the session id into the JSON event logger so all log
  // events written from now on land in
  // `backend/logs/session-<sessionId>-<YYYY-MM-DD>.json` instead
  // of the generic `events-<YYYY-MM-DD>.json`. Makes per-session
  // debugging trivial: one file per Start click.
  try {
    const jsonEventLogger = require('../utils/jsonEventLogger');
    jsonEventLogger.setSessionId(String(session._id));
  } catch (err) {
    console.warn('[scalping.controller] jsonEventLogger session-binding failed:', err.message);
  }

  // Hand off to Hybrid_Engine through the lifecycle wrapper.
  const result = await hybridLifecycle.startWithSession({
    session,
    executionMode,
    replayFolder,
  });

  if (!result.started) {
    // Mark session row as error so the audit trail records the abort.
    try {
      session.status = 'error';
      session.errorReason = result.reason || 'UNKNOWN';
      await session.save();
    } catch (_) { /* swallow */ }
    throw new HttpError(400, `Engine start failed: ${result.reason || 'UNKNOWN'}`, result);
  }

  console.log('[scalping.controller] Hybrid_Engine started', {
    sessionId: String(session._id),
    executionMode,
    replayDate,
    speedMultiplier,
    predictionIntervalMs: result.predictionIntervalMs,
  });

  res.json({
    ok: true,
    session,
    executionMode,
    replayDate,
    speedMultiplier,
    predictionIntervalMs: result.predictionIntervalMs,
    availableReplayDates: availableDates,
  });
});

exports.stop = asyncHandler(async (_req, res) => {
  // Stop both legacy + hybrid (idempotent — whichever is running stops).
  let hybridStopped = false;
  try {
    await hybridEngine.stop();
    hybridStopped = true;
  } catch (_) { /* swallow */ }
  try {
    await engine.stop({ reason: 'Stopped by user' });
  } catch (_) { /* swallow */ }
  res.json({ ok: true, hybridStopped });
});

exports.status = asyncHandler(async (_req, res) => {
  // Surface both engines' state. The UI prefers Hybrid_Engine when running.
  let hybridStats = null;
  try {
    hybridStats = hybridEngine.getCycleStats();
  } catch (_) { /* swallow */ }
  const legacyStatus = await engine.getStatus().catch(() => null);
  const running = (hybridStats && hybridStats.isRunning === true)
    || (legacyStatus && legacyStatus.running === true);
  res.json({
    ok: true,
    running,
    engine: hybridStats && hybridStats.isRunning ? 'hybrid' : 'legacy',
    hybrid: hybridStats || null,
    ...(legacyStatus || {}),
  });
});

exports.listTrades = asyncHandler(async (req, res) => {
  const { sessionId, limit = 100 } = req.query;
  const q = sessionId ? { sessionId } : {};
  const trades = await ScalpingTrade.find(q).sort({ openedAt: -1 }).limit(Number(limit));
  res.json({ ok: true, trades });
});

exports.listSessions = asyncHandler(async (_req, res) => {
  const sessions = await ScalpingSession.find().sort({ createdAt: -1 }).limit(50);
  res.json({ ok: true, sessions });
});

exports.exitTrade = asyncHandler(async (req, res) => {
  const trade = await engine.manualExit(req.params.id);
  res.json({ ok: true, trade });
});

exports.getLogs = asyncHandler(async (req, res) => {
  const { sessionId, page = 1, limit = 100, eventType, level, startDate, endDate } = req.query;
  
  if (!sessionId) {
    throw new HttpError(400, 'sessionId query parameter is required');
  }

  const result = await engineLogger.getSessionLogs(sessionId, {
    page: Number(page),
    limit: Number(limit),
    eventType,
    level,
    startDate,
    endDate,
  });

  res.json({ ok: true, ...result });
});

exports.getLogsStats = asyncHandler(async (req, res) => {
  const { sessionId } = req.query;
  
  if (!sessionId) {
    throw new HttpError(400, 'sessionId query parameter is required');
  }

  const stats = await engineLogger.getSessionStats(sessionId);
  res.json({ ok: true, stats });
});

exports.getEvents = asyncHandler(async (req, res) => {
  const jsonEventLogger = require('../utils/jsonEventLogger');
  const { date, limit = 500 } = req.query;
  
  const events = await jsonEventLogger.readEvents(date, Number(limit));
  res.json({ ok: true, events, count: events.length });
});

// ============================================================
// Backtest endpoints (Hybrid_Engine in simulation mode)
// ============================================================
//
// These three endpoints sit alongside `/start` and `/stop` so the
// frontend can drive a recorded-JSONL replay through the
// Hybrid_Engine without touching the live broker. Auto-detect
// fallback: when the existing `/start` is invoked on a closed
// market, the frontend can call `/backtest/start` instead with
// no body and get last Friday's session by default.
//
// Trigger surfaces (per design):
//   1. Explicit  — frontend posts to `/backtest/start` with
//                  optional `{ date: 'YYYY-MM-DD' }`.
//   2. Auto-detect — frontend's `handleStart` falls through here
//                    when `marketStatus.open === false`.
//
// All routing happens through the Hybrid_Engine, never the legacy
// engine, so simulation tags and audit rows behave consistently.

exports.backtestList = asyncHandler(async (_req, res) => {
  const dates = backtestDriver.listAvailableDates();
  res.json({ ok: true, dates });
});

exports.backtestStart = asyncHandler(async (req, res) => {
  const { date } = (req.body && typeof req.body === 'object') ? req.body : {};

  // Pre-resolve so the operator gets a clear error before we
  // open a session row when the requested folder is missing.
  const preview = backtestDriver.resolveReplay(date);
  if (!preview.available) {
    throw new HttpError(404, `Recorded folder not found for ${preview.date}`, {
      replayDate: preview.date,
      replayFolder: preview.folder,
      available: backtestDriver.listAvailableDates(),
    });
  }

  const result = await backtestDriver.start({ date: preview.date });
  if (!result.started) {
    throw new HttpError(400, `Backtest failed: ${result.reason || 'UNKNOWN'}`, result);
  }
  res.json({ ok: true, ...result });
});

exports.backtestStop = asyncHandler(async (_req, res) => {
  const result = await backtestDriver.stop({ reason: 'Stopped by user' });
  res.json({ ok: true, ...result });
});

exports.backtestStatus = asyncHandler(async (_req, res) => {
  const status = backtestDriver.getStatus();
  res.json({ ok: true, ...status });
});

// ============================================================
// Replay-dates endpoint (simulation mode picker for the UI)
// ============================================================
exports.replayDates = asyncHandler(async (_req, res) => {
  const dates = _listReplayDates();
  res.json({ ok: true, dates, root: LIVE_FEED_ROOT });
});
