/**
 * Copy-trade fan-out engine.
 *
 * For a single master order, look up all enabled accounts in the requested mode,
 * scale the quantity per-account by riskMultiplier, and place orders concurrently
 * via Promise.allSettled. Persist a TradeExecution doc and one TradeAccountResult
 * per account leg. No external queue (Bull/Redis) — purely in-process.
 */
const Account = require('../models/Account');
const TradeExecution = require('../models/TradeExecution');
const TradeAccountResult = require('../models/TradeAccountResult');
const dhanService = require('./dhan.service');
const { decrypt } = require('./crypto.service');
const logger = require('../utils/logger');

function scaleQuantity(masterQty, multiplier) {
  const scaled = Math.floor(Number(masterQty) * Number(multiplier || 1));
  return Math.max(1, scaled);
}

/**
 * Build the Dhan order payload for a single account.
 * Master order shape from frontend:
 *   { symbol, securityId, exchangeSegment, side, quantity,
 *     orderType, productType, price, triggerPrice, stopLoss, target, validity }
 */
function buildDhanOrder(master, scaledQty) {
  return {
    transactionType: master.side, // BUY | SELL
    exchangeSegment: master.exchangeSegment, // e.g. NSE_EQ
    productType: master.productType,
    orderType: master.orderType,
    validity: master.validity || 'DAY',
    securityId: master.securityId,
    quantity: scaledQty,
    price: master.orderType === 'LIMIT' ? master.price || 0 : 0,
    triggerPrice: master.triggerPrice || 0,
    disclosedQuantity: 0,
    afterMarketOrder: false,
  };
}

async function executeCopyTrade(master) {
  const accounts = await Account.find({ enabled: true, mode: master.triggeredMode });

  const execution = await TradeExecution.create({
    symbol: master.symbol,
    securityId: master.securityId,
    exchangeSegment: master.exchangeSegment,
    side: master.side,
    quantity: master.quantity,
    orderType: master.orderType,
    productType: master.productType,
    price: master.price || 0,
    triggerPrice: master.triggerPrice || 0,
    stopLoss: master.stopLoss || 0,
    target: master.target || 0,
    triggeredMode: master.triggeredMode,
    note: master.note,
  });

  if (accounts.length === 0) {
    logger.warn({ mode: master.triggeredMode }, 'No enabled accounts for mode — nothing to copy');
    return { execution, results: [] };
  }

  const settlements = await Promise.allSettled(
    accounts.map(async (account) => {
      const scaledQty = scaleQuantity(master.quantity, account.riskMultiplier);
      const dhanOrder = buildDhanOrder(master, scaledQty);
      const accessToken = decrypt(account.accessTokenEncrypted);
      const result = await dhanService.placeOrder(
        { clientId: account.clientId, accessToken, mode: account.mode },
        dhanOrder
      );
      return { account, scaledQty, result };
    })
  );

  const resultDocs = await Promise.all(
    settlements.map(async (s, idx) => {
      const account = accounts[idx];
      if (s.status === 'rejected') {
        return TradeAccountResult.create({
          tradeExecutionId: execution._id,
          accountId: account._id,
          accountName: account.accountName,
          scaledQuantity: scaleQuantity(master.quantity, account.riskMultiplier),
          status: 'failed',
          attemptCount: 1,
          errorMessage: (s.reason && s.reason.message) || 'Unknown error',
        });
      }
      const { scaledQty, result } = s.value;
      return TradeAccountResult.create({
        tradeExecutionId: execution._id,
        accountId: account._id,
        accountName: account.accountName,
        scaledQuantity: scaledQty,
        status: result.ok ? 'success' : 'failed',
        attemptCount: 1,
        errorMessage: result.ok ? null : result.error,
        dhanOrderId: result.ok ? (result.data && (result.data.orderId || result.data.order_id)) || null : null,
        responsePayload: result.ok ? result.data : result.raw,
      });
    })
  );

  return { execution, results: resultDocs };
}

/**
 * Retry a single failed leg by id. Reuses the original master order parameters.
 */
async function retryLeg(resultId) {
  const result = await TradeAccountResult.findById(resultId);
  if (!result) throw Object.assign(new Error('Trade leg not found'), { status: 404 });
  if (result.status === 'success') {
    return result; // nothing to do
  }
  const [account, execution] = await Promise.all([
    Account.findById(result.accountId),
    TradeExecution.findById(result.tradeExecutionId),
  ]);
  if (!account || !execution) {
    throw Object.assign(new Error('Account or execution missing'), { status: 404 });
  }
  if (!account.enabled) {
    throw Object.assign(new Error('Account is disabled'), { status: 400 });
  }

  result.status = 'retrying';
  result.attemptCount += 1;
  await result.save();

  const dhanOrder = buildDhanOrder(execution.toObject(), result.scaledQuantity);
  const accessToken = decrypt(account.accessTokenEncrypted);
  const apiResult = await dhanService.placeOrder(
    { clientId: account.clientId, accessToken, mode: account.mode },
    dhanOrder
  );

  result.status = apiResult.ok ? 'success' : 'failed';
  result.errorMessage = apiResult.ok ? null : apiResult.error;
  result.dhanOrderId = apiResult.ok
    ? (apiResult.data && (apiResult.data.orderId || apiResult.data.order_id)) || null
    : result.dhanOrderId;
  result.responsePayload = apiResult.ok ? apiResult.data : apiResult.raw;
  await result.save();
  return result;
}

module.exports = { executeCopyTrade, retryLeg, scaleQuantity };
