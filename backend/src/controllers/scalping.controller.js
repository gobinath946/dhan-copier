const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const engine = require('../services/scalpingEngine.service');
const { isMarketOpen } = require('../services/marketHours.service');
const ScalpingSession = require('../models/ScalpingSession');
const ScalpingTrade = require('../models/ScalpingTrade');
const engineLogger = require('../services/engineLogger.service');
const algoSettings = require('../config/algoSettings');

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
  
  const validation = algoSettings.validateSettings({ ...algoSettings.getSettings(), ...updates });
  
  if (!validation.valid) {
    throw new HttpError(400, `Invalid settings: ${validation.errors.join(', ')}`);
  }
  
  const updatedSettings = algoSettings.updateSettings(updates);
  res.json({ ok: true, settings: updatedSettings, message: 'Settings updated successfully' });
});

exports.start = asyncHandler(async (req, res) => {
  // In production mode, use the environment token; otherwise use the header
  const authKey = req.headers['x-dhan-bypass-key'] || process.env.DHAN_ACCESS_TOKEN;
  if (!authKey) throw new HttpError(400, 'Missing authentication - no bypass key or production token available');

  // Use backend settings by default, but allow frontend override for backward compatibility
  const backendSettings = algoSettings.getSettings();
  const { settings: frontendSettings, aiModel: frontendAiModel } = req.body || {};
  
  // Merge: backend settings as base, frontend can override specific values
  const settings = frontendSettings ? { ...backendSettings, ...frontendSettings } : backendSettings;
  const aiModel = frontendAiModel || backendSettings.aiModel;
  
  // LOG: Show received settings for debugging
  console.log('[scalping.controller] Using settings:', JSON.stringify({
    source: frontendSettings ? 'frontend_override' : 'backend',
    minLots: settings?.minLots,
    maxLots: settings?.maxLots,
    lotSize: settings?.lotSize,
    targetPoints: settings?.targetPoints,
    capital: settings?.capital
  }, null, 2));
  
  if (!settings || !settings.capital || !settings.lotSize) {
    throw new HttpError(400, 'Settings with capital and lotSize are required');
  }

  try {
    const session = await engine.start({ authKey, settings, aiModel });
    res.json({ ok: true, session });
  } catch (e) {
    throw new HttpError(e.status || 400, e.message);
  }
});

exports.stop = asyncHandler(async (_req, res) => {
  await engine.stop({ reason: 'Stopped by user' });
  res.json({ ok: true });
});

exports.status = asyncHandler(async (_req, res) => {
  const status = await engine.getStatus();
  res.json({ ok: true, ...status });
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
