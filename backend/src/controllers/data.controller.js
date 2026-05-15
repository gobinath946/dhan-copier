const Account = require('../models/Account');
const TradeAccountResult = require('../models/TradeAccountResult');
const TradeExecution = require('../models/TradeExecution');
const dhanService = require('../services/dhan.service');
const { decrypt } = require('../services/crypto.service');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Aggregate positions across all enabled accounts in the given mode.
 * Returns per-account breakdown with errors so the UI can show partial state.
 */
exports.positions = asyncHandler(async (req, res) => {
  const mode = req.validatedQuery.mode;
  const accounts = await Account.find({ enabled: true, mode });
  const results = await Promise.allSettled(
    accounts.map(async (a) => {
      const accessToken = decrypt(a.accessTokenEncrypted);
      const r = await dhanService.getPositions({
        clientId: a.clientId,
        accessToken,
        mode: a.mode,
      });
      return { account: { id: a._id, name: a.accountName }, ...r };
    })
  );
  res.json({
    mode,
    fetchedAt: new Date().toISOString(),
    accounts: results.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : { ok: false, error: (s.reason && s.reason.message) || 'Unknown error' }
    ),
  });
});

exports.holdings = asyncHandler(async (req, res) => {
  const mode = req.validatedQuery.mode;
  const accounts = await Account.find({ enabled: true, mode });
  const results = await Promise.allSettled(
    accounts.map(async (a) => {
      const accessToken = decrypt(a.accessTokenEncrypted);
      const r = await dhanService.getHoldings({
        clientId: a.clientId,
        accessToken,
        mode: a.mode,
      });
      return { account: { id: a._id, name: a.accountName }, ...r };
    })
  );
  res.json({
    mode,
    fetchedAt: new Date().toISOString(),
    accounts: results.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : { ok: false, error: (s.reason && s.reason.message) || 'Unknown error' }
    ),
  });
});

exports.quote = asyncHandler(async (req, res) => {
  const { mode, exchangeSegment, securityId } = req.validatedQuery;
  // Use the first enabled account in the mode just to make the API call.
  const account = await Account.findOne({ enabled: true, mode });
  if (!account) {
    return res.json({ ok: false, error: 'No enabled accounts available for this mode' });
  }
  const accessToken = decrypt(account.accessTokenEncrypted);
  const result = await dhanService.getLtp(
    { clientId: account.clientId, accessToken, mode: account.mode },
    { exchangeSegment, securityId }
  );
  res.json(result);
});

/**
 * Dashboard stats — derived from MongoDB (no external API call):
 * - tradesToday, totalTrades
 * - successCount, failedCount, winRatePct (success / (success+failed))
 * - byDay equity-curve series (success count per day, last 30 days)
 * - perAccount summary
 *
 * NOTE: True P&L requires polling Dhan positions per account; the frontend
 * combines this with /api/data/positions for live numbers.
 */
exports.dashboardStats = asyncHandler(async (req, res) => {
  const mode = req.validatedQuery.mode;
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [accounts, totals, todayCount, byDay, perAccount] = await Promise.all([
    Account.find({ mode }),
    TradeAccountResult.aggregate([
      { $lookup: { from: 'tradeexecutions', localField: 'tradeExecutionId', foreignField: '_id', as: 'exec' } },
      { $unwind: '$exec' },
      { $match: { 'exec.triggeredMode': mode } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    TradeExecution.countDocuments({ triggeredMode: mode, createdAt: { $gte: start } }),
    TradeAccountResult.aggregate([
      { $lookup: { from: 'tradeexecutions', localField: 'tradeExecutionId', foreignField: '_id', as: 'exec' } },
      { $unwind: '$exec' },
      { $match: { 'exec.triggeredMode': mode, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    TradeAccountResult.aggregate([
      { $lookup: { from: 'tradeexecutions', localField: 'tradeExecutionId', foreignField: '_id', as: 'exec' } },
      { $unwind: '$exec' },
      { $match: { 'exec.triggeredMode': mode } },
      {
        $group: {
          _id: '$accountId',
          name: { $first: '$accountName' },
          total: { $sum: 1 },
          success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const byStatus = totals.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {});
  const success = byStatus.success || 0;
  const failed = byStatus.failed || 0;
  const winRatePct = success + failed === 0 ? 0 : Math.round((success / (success + failed)) * 100);

  res.json({
    mode,
    accountCount: accounts.length,
    enabledAccountCount: accounts.filter((a) => a.enabled).length,
    tradesToday: todayCount,
    totalLegs: success + failed + (byStatus.pending || 0) + (byStatus.retrying || 0),
    successCount: success,
    failedCount: failed,
    winRatePct,
    byDay,
    perAccount,
  });
});

exports.logs = asyncHandler(async (req, res) => {
  const { accountId, status, from, to, page, limit } = req.validatedQuery;
  const filter = {};
  if (accountId) filter.accountId = accountId;
  if (status) filter.status = status;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    TradeAccountResult.find(filter)
      .populate('tradeExecutionId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    TradeAccountResult.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
});
