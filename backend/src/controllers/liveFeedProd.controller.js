/**
 * Live Feed (production WebSocket) controller
 * Thin HTTP layer to inspect and control the singleton live feed.
 */
const { instance: liveFeed, SNAPSHOT_FILE } = require('../services/dhanLiveFeedProd.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');
const fs = require('fs');

/** GET /api/live-feed-prod/status */
exports.getStatus = asyncHandler(async (_req, res) => {
  res.json(liveFeed.getStatus());
});

/** GET /api/live-feed-prod/snapshot  — full in-memory snapshot */
exports.getSnapshot = asyncHandler(async (_req, res) => {
  res.json({
    capturedAt: new Date().toISOString(),
    status: liveFeed.getStatus(),
    ticks: liveFeed.getSnapshot(),
  });
});

/** GET /api/live-feed-prod/tick?exchangeSegment=IDX_I&securityId=13 */
exports.getTick = asyncHandler(async (req, res) => {
  const { exchangeSegment, securityId } = req.query;
  if (!exchangeSegment || !securityId) {
    throw new HttpError(400, 'exchangeSegment and securityId query params are required');
  }
  const tick = liveFeed.getTick(exchangeSegment, securityId);
  if (!tick) return res.status(404).json({ ok: false, error: 'No tick for this instrument yet' });
  res.json(tick);
});

/** POST /api/live-feed-prod/subscribe  body: { instruments: [{exchangeSegment, securityId}], mode: 'TICKER'|'QUOTE'|'FULL' } */
exports.subscribe = asyncHandler(async (req, res) => {
  const { instruments, mode = 'FULL' } = req.body || {};
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new HttpError(400, 'instruments array required');
  }
  liveFeed.subscribe(instruments, mode);
  res.json({ ok: true, subscribed: instruments.length, mode, status: liveFeed.getStatus() });
});

/** POST /api/live-feed-prod/unsubscribe */
exports.unsubscribe = asyncHandler(async (req, res) => {
  const { instruments, mode = 'FULL' } = req.body || {};
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new HttpError(400, 'instruments array required');
  }
  liveFeed.unsubscribe(instruments, mode);
  res.json({ ok: true, unsubscribed: instruments.length, status: liveFeed.getStatus() });
});

/** GET /api/live-feed-prod/snapshot-file — stream the on-disk snapshot json */
exports.getSnapshotFile = asyncHandler(async (_req, res) => {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return res.status(404).json({ ok: false, error: 'Snapshot file not generated yet' });
  }
  res.sendFile(SNAPSHOT_FILE);
});
