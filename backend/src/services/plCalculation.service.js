/**
 * P&L Calculation Service
 * 
 * Calculates profit and loss at multiple granularities with real-time updates.
 * Handles live P&L for active positions and final P&L after trade exit.
 */

const TradeExecutionLog = require('../models/TradeExecutionLog');
const TradeAccountResult = require('../models/TradeAccountResult');
const TradePLRecord = require('../models/TradePLRecord');
const AccountPLTracker = require('../models/AccountPLTracker');
const logger = require('../utils/logger');

/**
 * Calculate current P&L for active positions using live prices
 * @param {string} tradeExecutionId - ID of active trade
 * @param {Map<string, number>} livePrices - Current market prices (securityId -> price)
 * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
 */
async function calculateLivePL(tradeExecutionId, livePrices) {
  try {
    // Retrieve trade execution log
    const tradeLog = await TradeExecutionLog.findById(tradeExecutionId);
    if (!tradeLog) {
      return { ok: false, error: 'Trade execution not found' };
    }

    // Get current premium from livePrices map
    const currentPremium = livePrices.get(tradeLog.securityId);
    if (!currentPremium || currentPremium <= 0) {
      return { ok: false, error: 'Current premium not available' };
    }

    // Retrieve successful account results
    const accountResults = await TradeAccountResult.find({
      tradeExecutionId,
      status: 'success',
    }).populate('accountId', 'accountName');

    if (accountResults.length === 0) {
      return { ok: false, error: 'No successful positions found' };
    }

    // Calculate P&L for each account
    const accountPLs = accountResults.map(result => {
      const lots = result.scaledQuantity;
      const lotSize = tradeLog.lotSize;
      const entryPremium = tradeLog.entryPremium;

      const entryValue = lots * lotSize * entryPremium;
      const currentValue = lots * lotSize * currentPremium;
      const pl = currentValue - entryValue;
      const plPercentage = entryValue > 0 ? (pl / entryValue) * 100 : 0;

      return {
        accountId: result.accountId._id.toString(),
        accountName: result.accountName,
        lots,
        entryPremium,
        currentPremium,
        entryValue,
        currentValue,
        pl,
        plPercentage,
      };
    });

    // Calculate total P&L
    const totalPL = accountPLs.reduce((sum, acc) => sum + acc.pl, 0);

    logger.debug({
      tradeExecutionId,
      currentPremium,
      totalPL,
      accountCount: accountPLs.length,
    }, 'Live P&L calculated');

    return {
      ok: true,
      data: {
        tradeExecutionId,
        symbol: tradeLog.symbol,
        entryPremium: tradeLog.entryPremium,
        currentPremium,
        totalPL,
        accountPLs,
      },
    };

  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, 'Live P&L calculation error');
    
    return { 
      ok: false, 
      error: error.message || 'Live P&L calculation failed' 
    };
  }
}

/**
 * Calculate and persist final P&L after trade exit
 * @param {string} tradeExecutionId - ID of completed trade
 * @param {number} exitPremium - Exit premium/price
 * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
 */
async function calculateFinalPL(tradeExecutionId, exitPremium) {
  try {
    // Retrieve trade execution log
    const tradeLog = await TradeExecutionLog.findById(tradeExecutionId);
    if (!tradeLog) {
      return { ok: false, error: 'Trade execution not found' };
    }

    if (!exitPremium || exitPremium <= 0) {
      return { ok: false, error: 'Exit premium must be positive' };
    }

    // Retrieve successful account results
    const accountResults = await TradeAccountResult.find({
      tradeExecutionId,
      status: 'success',
    }).populate('accountId', 'accountName');

    if (accountResults.length === 0) {
      return { ok: false, error: 'No successful positions found' };
    }

    const lotSize = tradeLog.lotSize;
    const entryPremium = tradeLog.entryPremium;
    const exitTime = tradeLog.exitTime || new Date();

    // Calculate exit value
    const totalExitValue = tradeLog.totalLots * lotSize * exitPremium;

    // Update trade execution log with exit details
    tradeLog.exitPremium = exitPremium;
    tradeLog.exitValue = totalExitValue;
    if (!tradeLog.exitTime) {
      tradeLog.exitTime = exitTime;
    }
    await tradeLog.save();

    // Create Trade P&L Records for each account
    const tradePLRecords = [];
    const accountPLUpdates = [];
    let totalPL = 0;

    for (const result of accountResults) {
      const lots = result.scaledQuantity;
      const entryValue = lots * lotSize * entryPremium;
      const exitValue = lots * lotSize * exitPremium;
      const pl = exitValue - entryValue;
      const plPercentage = entryValue > 0 ? (pl / entryValue) * 100 : 0;

      // Create Trade P&L Record
      const plRecord = await TradePLRecord.create({
        tradeExecutionId,
        accountId: result.accountId._id,
        accountName: result.accountName,
        symbol: tradeLog.symbol,
        lots,
        lotSize,
        entryTime: tradeLog.entryTime,
        entryPremium,
        entryValue,
        exitTime,
        exitPremium,
        exitValue,
        pl,
        plPercentage,
      });

      tradePLRecords.push(plRecord);
      totalPL += pl;

      // Update Account P&L Tracker
      const accountId = result.accountId._id;
      const accountName = result.accountName;
      const month = exitTime.toISOString().substring(0, 7); // "YYYY-MM"

      let tracker = await AccountPLTracker.findOne({ accountId });
      
      if (!tracker) {
        // Create new tracker
        tracker = new AccountPLTracker({
          accountId,
          accountName,
          totalPL: pl,
          totalTrades: 1,
          profitableTrades: pl > 0 ? 1 : 0,
          losingTrades: pl < 0 ? 1 : 0,
          monthlyPL: [{ month, pl, trades: 1 }],
        });
      } else {
        // Update existing tracker
        tracker.totalPL += pl;
        tracker.totalTrades += 1;
        if (pl > 0) {
          tracker.profitableTrades += 1;
        } else if (pl < 0) {
          tracker.losingTrades += 1;
        }

        // Update monthly breakdown
        const monthlyEntry = tracker.monthlyPL.find(m => m.month === month);
        if (monthlyEntry) {
          monthlyEntry.pl += pl;
          monthlyEntry.trades += 1;
        } else {
          tracker.monthlyPL.push({ month, pl, trades: 1 });
        }
      }

      await tracker.save();

      accountPLUpdates.push({
        accountId: accountId.toString(),
        accountName,
        pl,
        plPercentage,
        totalPL: tracker.totalPL,
        winRate: tracker.winRate,
      });
    }

    logger.info({
      tradeExecutionId,
      exitPremium,
      totalPL,
      accountCount: accountResults.length,
    }, 'Final P&L calculated and persisted');

    return {
      ok: true,
      data: {
        tradeExecutionId,
        totalPL,
        tradePLRecords: tradePLRecords.map(r => ({
          accountId: r.accountId.toString(),
          accountName: r.accountName,
          pl: r.pl,
          plPercentage: r.plPercentage,
        })),
        accountPLUpdates,
      },
    };

  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, 'Final P&L calculation error');
    
    return { 
      ok: false, 
      error: error.message || 'Final P&L calculation failed' 
    };
  }
}

/**
 * Get aggregate P&L across all accounts
 * @param {Object} dateRange - Optional date filter { startDate, endDate }
 * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
 */
async function getAggregatePL(dateRange = {}) {
  try {
    const { startDate, endDate } = dateRange;

    // Build query filter
    const filter = {};
    if (startDate || endDate) {
      filter.exitTime = {};
      if (startDate) filter.exitTime.$gte = new Date(startDate);
      if (endDate) filter.exitTime.$lte = new Date(endDate);
    }

    // Get all trade P&L records
    const plRecords = await TradePLRecord.find(filter);

    if (plRecords.length === 0) {
      return {
        ok: true,
        data: {
          totalPL: 0,
          totalTrades: 0,
          profitableTrades: 0,
          losingTrades: 0,
          winRate: 0,
          bestAccount: null,
          worstAccount: null,
        },
      };
    }

    // Calculate aggregate metrics
    const totalPL = plRecords.reduce((sum, r) => sum + r.pl, 0);
    const totalTrades = plRecords.length;
    const profitableTrades = plRecords.filter(r => r.pl > 0).length;
    const losingTrades = plRecords.filter(r => r.pl < 0).length;
    const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;

    // Calculate per-account totals
    const accountTotals = new Map();
    plRecords.forEach(record => {
      const accountId = record.accountId.toString();
      if (!accountTotals.has(accountId)) {
        accountTotals.set(accountId, {
          accountId,
          accountName: record.accountName,
          pl: 0,
        });
      }
      const account = accountTotals.get(accountId);
      account.pl += record.pl;
    });

    // Find best and worst accounts
    const accountArray = Array.from(accountTotals.values());
    const bestAccount = accountArray.reduce((best, acc) => 
      acc.pl > best.pl ? acc : best
    , accountArray[0]);
    
    const worstAccount = accountArray.reduce((worst, acc) => 
      acc.pl < worst.pl ? acc : worst
    , accountArray[0]);

    logger.debug({
      totalPL,
      totalTrades,
      winRate,
      dateRange,
    }, 'Aggregate P&L calculated');

    return {
      ok: true,
      data: {
        totalPL,
        totalTrades,
        profitableTrades,
        losingTrades,
        winRate,
        bestAccount,
        worstAccount,
      },
    };

  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, 'Aggregate P&L calculation error');
    
    return { 
      ok: false, 
      error: error.message || 'Aggregate P&L calculation failed' 
    };
  }
}

/**
 * Get P&L for specific account
 * @param {string} accountId - Account identifier
 * @param {Object} dateRange - Optional date filter { startDate, endDate }
 * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
 */
async function getAccountPL(accountId, dateRange = {}) {
  try {
    // Get account P&L tracker
    const tracker = await AccountPLTracker.findOne({ accountId });
    
    if (!tracker) {
      return {
        ok: true,
        data: {
          accountId,
          accountName: 'Unknown',
          totalPL: 0,
          totalTrades: 0,
          winRate: 0,
          monthlyBreakdown: [],
        },
      };
    }

    // Filter monthly breakdown by date range if provided
    let monthlyBreakdown = tracker.monthlyPL;
    if (dateRange.startDate || dateRange.endDate) {
      const startMonth = dateRange.startDate 
        ? new Date(dateRange.startDate).toISOString().substring(0, 7)
        : null;
      const endMonth = dateRange.endDate 
        ? new Date(dateRange.endDate).toISOString().substring(0, 7)
        : null;

      monthlyBreakdown = monthlyBreakdown.filter(m => {
        if (startMonth && m.month < startMonth) return false;
        if (endMonth && m.month > endMonth) return false;
        return true;
      });
    }

    logger.debug({
      accountId,
      totalPL: tracker.totalPL,
      totalTrades: tracker.totalTrades,
      dateRange,
    }, 'Account P&L retrieved');

    return {
      ok: true,
      data: {
        accountId: tracker.accountId.toString(),
        accountName: tracker.accountName,
        totalPL: tracker.totalPL,
        totalTrades: tracker.totalTrades,
        profitableTrades: tracker.profitableTrades,
        losingTrades: tracker.losingTrades,
        winRate: tracker.winRate,
        monthlyBreakdown,
      },
    };

  } catch (error) {
    logger.error({ 
      error: error.message, 
      stack: error.stack 
    }, 'Account P&L retrieval error');
    
    return { 
      ok: false, 
      error: error.message || 'Account P&L retrieval failed' 
    };
  }
}

module.exports = {
  calculateLivePL,
  calculateFinalPL,
  getAggregatePL,
  getAccountPL,
};
