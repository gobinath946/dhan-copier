/**
 * Historical backfill controller
 */
const backfill = require('../services/historicalBackfill.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');

/**
 * POST /api/backfill
 * body: { date?: 'YYYY-MM-DD', window?: 6, expiryFlag?: 'WEEK', expiryCode?: 0, overwrite?: false }
 * If date is missing, defaults to yesterday (IST).
 */
exports.runBackfill = asyncHandler(async (req, res) => {
  const {
    date,
    window = 6,
    expiryFlag = 'WEEK',
    expiryCode = 0,
    overwrite = false,
  } = req.body || {};

  try {
    const out = await backfill.backfillDay(date, { window, expiryFlag, expiryCode, overwrite });
    res.json({ ok: true, ...out });
  } catch (e) {
    throw new HttpError(500, e.message || 'backfill failed');
  }
});

/** POST /api/backfill/yesterday — shortcut */
exports.backfillYesterday = asyncHandler(async (_req, res) => {
  const out = await backfill.backfillDay(null, { window: 6, overwrite: true });
  res.json({ ok: true, ...out });
});

/**
 * POST /api/backfill/range
 * body: { days?: 7, window?: 6, expiryFlag?: 'WEEK', expiryCode?: 1, overwrite?: true, toDate?: 'YYYY-MM-DD' }
 * Backfills the last N trading days (skipping weekends).
 */
exports.backfillRange = asyncHandler(async (req, res) => {
  const {
    days = 7,
    window = 6,
    expiryFlag = 'WEEK',
    expiryCode = 1,
    overwrite = true,
    toDate,
  } = req.body || {};

  try {
    const out = await backfill.backfillRange(days, { window, expiryFlag, expiryCode, overwrite, toDate });
    res.json({ ok: true, ...out });
  } catch (e) {
    throw new HttpError(500, e.message || 'backfill range failed');
  }
});

/** POST /api/backfill/week — convenience shortcut = last 7 trading days */
exports.backfillWeek = asyncHandler(async (_req, res) => {
  const out = await backfill.backfillRange(7, {
    window: 6, expiryFlag: 'WEEK', expiryCode: 1, overwrite: true,
  });
  res.json({ ok: true, ...out });
});
