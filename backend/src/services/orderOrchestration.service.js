/**
 * Order Orchestration Service
 * 
 * Executes orders concurrently across multiple accounts and handles failures gracefully.
 * Manages both entry (BUY) and exit (SELL) order execution.
 */

const Account = require('../models/Account');
const TradeExecutionLog = require('../models/TradeExecutionLog');
const TradeAccountResult = require('../models/TradeAccountResult');
const dhanService = require('./dhan.service');
const { decrypt } = require('./crypto.service');
const logger = require('../utils/logger');

/**
 * Build Dhan order payload for a single account
 */
function buildDhanOrder(orderRequest, lots, side = 'BUY') {
  const quantity = lots * (orderRequest.lotSize || 50); // Default Nifty 50 lot size
  
  return {
    transactionType: side,
    exchangeSegment: orderRequest.exchangeSegment,
    productType: orderRequest.productType || 'INTRADAY',
    orderType: orderRequest.orderType || 'MARKET',
    validity: orderRequest.validity || 'DAY',
    securityId: orderRequest.securityId,
    quantity,
    price: orderRequest.orderType === 'LIMIT' ? (orderRequest.price || 0) : 0,
    triggerPrice: orderRequest.triggerPrice || 0,
    disclosedQuantity: 0,
    afterMarketOrder: false,
  };
}

/**
 * Execute BUY orders across multiple accounts
 * @param {Object} orderRequest - Master order details
 * @param {Map<string, number>} lotAllocations - Pre-calculated lot allocations (accountId -> lots)
 * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
 */
async function executeMultiAccountOrder(orderRequest, lotAllocations) {
  try {
    // Validation
    if (!orderRequest || !lotAllocations || lotAllocations.size === 0) {
      return { ok: false, error: 'Invalid order request or lot allocations' };
    }

    const accountIds = Array.from(lotAllocations.keys());
    const accounts = await Account.find({ 
      _id: { $in: accountIds },
      enabled: true 
    });

    if (accounts.length === 0) {
      return { ok: false, error: 'No enabled accounts found' };
    }

    // Calculate entry value
    const lotSize = orderRequest.lotSize || 50;
    const entryPremium = orderRequest.price || 0;
    const totalLots = orderRequest.totalLots;
    const entryValue = totalLots * lotSize * entryPremium;

    // Create Trade Execution Log entry
    const tradeLog = await TradeExecutionLog.create({
      symbol: orderRequest.symbol,
      securityId: orderRequest.securityId,
      exchangeSegment: orderRequest.exchangeSegment,
      side: 'BUY',
      totalLots,
      lotSize,
      orderType: orderRequest.orderType || 'MARKET',
      productType: orderRequest.productType || 'INTRADAY',
      entryTime: new Date(),
      entryPremium,
      entryValue,
      status: 'active',
      triggeredMode: orderRequest.triggeredMode || 'production',
      note: orderRequest.note || null,
    });

    logger.info({
      tradeExecutionId: tradeLog._id.toString(),
      symbol: orderRequest.symbol,
      totalLots,
      accountCount: accounts.length,
    }, 'Starting multi-account order execution');

    // Execute orders concurrently using Promise.allSettled
    const orderPromises = accounts.map(async (account) => {
      const allocatedLots = lotAllocations.get(account._id.toString()) || 0;
      
      if (allocatedLots === 0) {
        return {
          account,
          allocatedLots: 0,
          result: { ok: false, error: 'No lots allocated (insufficient capital)' },
        };
      }

      const dhanOrder = buildDhanOrder(orderRequest, allocatedLots, 'BUY');
      const accessToken = decrypt(account.accessTokenEncrypted);
      
      const result = await dhanService.placeOrder(
        { 
          clientId: account.clientId, 
          accessToken, 
          mode: account.mode 
        },
        dhanOrder
      );

      return { account, allocatedLots, result };
    });

    const settlements = await Promise.allSettled(orderPromises);

    // Process results and create Account Result entries
    let successCount = 0;
    let failureCount = 0;
    const accountResults = [];

    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i];
      const account = accounts[i];
      const allocatedLots = lotAllocations.get(account._id.toString()) || 0;

      let accountResult;

      if (settlement.status === 'rejected') {
        // Promise itself rejected (unexpected error)
        failureCount++;
        accountResult = await TradeAccountResult.create({
          tradeExecutionId: tradeLog._id,
          accountId: account._id,
          accountName: account.accountName,
          scaledQuantity: allocatedLots,
          status: 'failed',
          attemptCount: 1,
          errorMessage: settlement.reason?.message || 'Unknown error',
        });
      } else {
        // Promise fulfilled, check API result
        const { allocatedLots: lots, result } = settlement.value;
        
        if (result.ok) {
          successCount++;
          accountResult = await TradeAccountResult.create({
            tradeExecutionId: tradeLog._id,
            accountId: account._id,
            accountName: account.accountName,
            scaledQuantity: lots,
            status: 'success',
            attemptCount: 1,
            dhanOrderId: result.data?.orderId || result.data?.order_id || null,
            executedQuantity: lots * lotSize,
            responsePayload: result.data,
          });
        } else {
          failureCount++;
          accountResult = await TradeAccountResult.create({
            tradeExecutionId: tradeLog._id,
            accountId: account._id,
            accountName: account.accountName,
            scaledQuantity: lots,
            status: 'failed',
            attemptCount: 1,
            errorMessage: result.error || 'Order placement failed',
            responsePayload: result.raw,
          });
        }
      }

      accountResults.push({
        accountId: account._id.toString(),
        accountName: account.accountName,
        allocatedLots,
        status: accountResult.status,
        dhanOrderId: accountResult.dhanOrderId,
        errorMessage: accountResult.errorMessage,
      });
    }

    // Update trade log status if all failed
    if (successCount === 0) {
      tradeLog.status = 'partial'; // Mark as partial even if all failed
      await tradeLog.save();
    }

    logger.info({
      tradeExecutionId: tradeLog._id.toString(),
      totalAccounts: accounts.length,
      successCount,
      failureCount,
    }, 'Multi-account order execution completed');

    return {
      ok: true,
      data: {
        tradeExecutionId: tradeLog._id.toString(),
        totalAccounts: accounts.length,
        successCount,
        failureCount,
        accountResults,
      },
    };

  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, 'Order orchestration error');
    
    return { 
      ok: false, 
      error: error.message || 'Order execution failed' 
    };
  }
}

/**
 * Execute synchronized SELL orders for active positions
 * @param {string} tradeExecutionId - ID of the trade to exit
 * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
 */
async function executeSynchronizedExit(tradeExecutionId) {
  try {
    // Retrieve trade execution log
    const tradeLog = await TradeExecutionLog.findById(tradeExecutionId);
    if (!tradeLog) {
      return { ok: false, error: 'Trade execution not found' };
    }

    if (tradeLog.status === 'exited') {
      return { ok: false, error: 'Trade already exited' };
    }

    // Retrieve successful account results for this trade
    const accountResults = await TradeAccountResult.find({
      tradeExecutionId,
      status: 'success',
    });

    if (accountResults.length === 0) {
      return { ok: false, error: 'No successful positions to exit' };
    }

    // Get accounts
    const accountIds = accountResults.map(r => r.accountId);
    const accounts = await Account.find({ 
      _id: { $in: accountIds },
      enabled: true 
    });

    logger.info({
      tradeExecutionId,
      symbol: tradeLog.symbol,
      accountCount: accounts.length,
    }, 'Starting synchronized exit execution');

    // Build exit order request
    const exitOrderRequest = {
      symbol: tradeLog.symbol,
      securityId: tradeLog.securityId,
      exchangeSegment: tradeLog.exchangeSegment,
      orderType: tradeLog.orderType,
      productType: tradeLog.productType,
      lotSize: tradeLog.lotSize,
      triggeredMode: tradeLog.triggeredMode,
    };

    // Execute exit orders concurrently
    const exitPromises = accounts.map(async (account) => {
      const accountResult = accountResults.find(
        r => r.accountId.toString() === account._id.toString()
      );
      
      if (!accountResult) {
        return {
          account,
          lots: 0,
          result: { ok: false, error: 'No entry position found' },
        };
      }

      const lots = accountResult.scaledQuantity;
      const dhanOrder = buildDhanOrder(exitOrderRequest, lots, 'SELL');
      const accessToken = decrypt(account.accessTokenEncrypted);
      
      const result = await dhanService.placeOrder(
        { 
          clientId: account.clientId, 
          accessToken, 
          mode: account.mode 
        },
        dhanOrder
      );

      return { account, lots, result, accountResultId: accountResult._id };
    });

    const settlements = await Promise.allSettled(exitPromises);

    // Process exit results
    let successCount = 0;
    let failureCount = 0;
    const exitResults = [];

    for (let i = 0; i < settlements.length; i++) {
      const settlement = settlements[i];
      const account = accounts[i];

      if (settlement.status === 'rejected') {
        failureCount++;
        exitResults.push({
          accountId: account._id.toString(),
          accountName: account.accountName,
          status: 'failed',
          errorMessage: settlement.reason?.message || 'Unknown error',
        });
      } else {
        const { lots, result, accountResultId } = settlement.value;
        
        if (result.ok) {
          successCount++;
          
          // Update the account result with exit info
          await TradeAccountResult.findByIdAndUpdate(accountResultId, {
            $set: {
              status: 'success',
              responsePayload: result.data,
            }
          });

          exitResults.push({
            accountId: account._id.toString(),
            accountName: account.accountName,
            lots,
            status: 'success',
            dhanOrderId: result.data?.orderId || result.data?.order_id || null,
          });
        } else {
          failureCount++;
          exitResults.push({
            accountId: account._id.toString(),
            accountName: account.accountName,
            lots,
            status: 'failed',
            errorMessage: result.error || 'Exit order failed',
          });
        }
      }
    }

    // Update trade execution log with exit details
    // Note: exitPremium and exitValue should be calculated by P&L service
    tradeLog.exitTime = new Date();
    tradeLog.status = failureCount > 0 ? 'partial' : 'exited';
    await tradeLog.save();

    logger.info({
      tradeExecutionId,
      totalAccounts: accounts.length,
      successCount,
      failureCount,
    }, 'Synchronized exit execution completed');

    return {
      ok: true,
      data: {
        tradeExecutionId,
        totalAccounts: accounts.length,
        successCount,
        failureCount,
        exitResults,
      },
    };

  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, 'Exit orchestration error');
    
    return { 
      ok: false, 
      error: error.message || 'Exit execution failed' 
    };
  }
}

module.exports = {
  executeMultiAccountOrder,
  executeSynchronizedExit,
};
