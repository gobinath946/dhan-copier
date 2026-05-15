const Account = require('../models/Account');
const dhanService = require('../services/dhan.service');
const { decrypt } = require('../services/crypto.service');
const copyTrade = require('../services/copyTrade.service');
const HttpError = require('../utils/HttpError');
const asyncHandler = require('../utils/asyncHandler');

exports.execute = asyncHandler(async (req, res) => {
  const master = req.body;
  const { execution, results } = await copyTrade.executeCopyTrade(master);
  res.status(202).json({
    executionId: execution._id,
    triggeredMode: execution.triggeredMode,
    summary: summarize(results),
    results,
  });
});

exports.retryLeg = asyncHandler(async (req, res) => {
  const { resultId } = req.body;
  const updated = await copyTrade.retryLeg(resultId);
  res.json({ result: updated });
});

exports.modify = asyncHandler(async (req, res) => {
  const { accountId, dhanOrderId, patch } = req.body;
  const account = await Account.findById(accountId);
  if (!account) throw new HttpError(404, 'Account not found');
  const accessToken = decrypt(account.accessTokenEncrypted);
  const result = await dhanService.modifyOrder(
    { clientId: account.clientId, accessToken, mode: account.mode },
    dhanOrderId,
    patch
  );
  if (!result.ok) throw new HttpError(result.status || 502, result.error);
  res.json(result.data);
});

exports.cancel = asyncHandler(async (req, res) => {
  const { accountId, dhanOrderId } = req.body;
  const account = await Account.findById(accountId);
  if (!account) throw new HttpError(404, 'Account not found');
  const accessToken = decrypt(account.accessTokenEncrypted);
  const result = await dhanService.cancelOrder(
    { clientId: account.clientId, accessToken, mode: account.mode },
    dhanOrderId
  );
  if (!result.ok) throw new HttpError(result.status || 502, result.error);
  res.json(result.data);
});

function summarize(results) {
  const summary = { total: results.length, success: 0, failed: 0 };
  for (const r of results) {
    if (r.status === 'success') summary.success += 1;
    else if (r.status === 'failed') summary.failed += 1;
  }
  return summary;
}
