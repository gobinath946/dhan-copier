/**
 * Nifty50 Orders Controller
 * 
 * Handles API endpoints for intelligent Nifty 50 order execution system.
 * Provides multi-account order execution, live price tracking, and P&L reporting.
 */

const Account = require('../models/Account');
const TradeExecutionLog = require('../models/TradeExecutionLog');
const TradePLRecord = require('../models/TradePLRecord');
const lotAllocationService = require('../services/lotAllocation.service');
const orderOrchestrationService = require('../services/orderOrchestration.service');
const plCalculationService = require('../services/plCalculation.service');
const priceFeedService = require('../services/priceFeed.service');
const HttpError = require('../utils/HttpError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

/**
 * POST /api/nifty50-orders/execute
 * Execute multi-account BUY order for Nifty 50 options
 */
exports.execute = asyncHandler(async (req, res) => {
  const {
    symbol,
    securityId,
    exchangeSegment,
    totalLots,
    orderType,
    productType,
    price,
    triggeredMode,
    accountIds,
  } = req.body;

  // Validate Nifty 50 instrument (basic check - symbol should contain "NIFTY")
  if (!symbol.toUpperCase().includes('NIFTY')) {
    throw new HttpError(400, 'Only Nifty 50 options are allowed');
  }

  // Validate account selection
  if (!accountIds || accountIds.length === 0) {
    throw new HttpError(400, 'At least one account must be selected');
  }

  // Fetch selected accounts
  const accounts = await Account.find({
    _id: { $in: accountIds },
    enabled: true,
  });

  if (accounts.length === 0) {
    throw new HttpError(400, 'No enabled accounts found');
  }

  // Get current premium (use provided price or fetch from market)
  const premium = price || 0;
  if (premium <= 0) {
    throw new HttpError(400, 'Premium must be positive');
  }

  // Standard Nifty 50 lot size
  const lotSize = 50;

  // Calculate lot allocation
  const allocationResult = lotAllocationService.allocateLots(
    accounts,
    totalLots,
    premium,
    lotSize
  );

  if (!allocationResult.ok) {
    throw new HttpError(400, allocationResult.error, allocationResult.details);
  }

  const lotAllocations = allocationResult.data;

  // Build order request
  const orderRequest = {
    symbol,
    securityId,
    exchangeSegment,
    totalLots,
    lotSize,
    orderType: orderType || 'MARKET',
    productType: productType || 'INTRADAY',
    price: premium,
    triggeredMode: triggeredMode || 'production',
    accountIds,
  };

  // Execute multi-account order
  const executionResult = await orderOrchestrationService.executeMultiAccountOrder(
    orderRequest,
    lotAllocations
  );

  if (!executionResult.ok) {
    throw new HttpError(500, executionResult.error);
  }

  logger.info({
    tradeExecutionId: executionResult.data.tradeExecutionId,
    symbol,
    totalLots,
    accountCount: accounts.length,
    successCount: executionResult.data.successCount,
  }, 'Nifty50 order execution completed');

  res.status(202).json({
    ok: true,
    tradeExecutionId: executionResult.data.tradeExecutionId,
    summary: {
      totalAccounts: executionResult.data.totalAccounts,
      successCount: executionResult.data.successCount,
      failureCount: executionResult.data.failureCount,
    },
    accountResults: executionResult.data.accountResults,
  });
});

/**
 * POST /api/nifty50-orders/exit
 * Execute synchronized SELL orders for all active positions
 */
exports.exit = asyncHandler(async (req, res) => {
  const { tradeExecutionId } = req.body;

  if (!tradeExecutionId) {
    throw new HttpError(400, 'Trade execution ID is required');
  }

  // Get trade log to fetch current exit premium
  const tradeLog = await TradeExecutionLog.findById(tradeExecutionId);
  if (!tradeLog) {
    throw new HttpError(404, 'Trade execution not found');
  }

  // Fetch current exit premium from market
  const account = await Account.findOne({ enabled: true });
  if (!account) {
    throw new HttpError(500, 'No enabled accounts available for price fetch');
  }

  const exitPremium = await priceFeedService.getCurrentPrice(
    tradeLog.securityId,
    tradeLog.exchangeSegment,
    account
  );

  if (!exitPremium) {
    throw new HttpError(503, 'Exit premium unavailable');
  }

  // Execute synchronized exit
  const exitResult = await orderOrchestrationService.executeSynchronizedExit(
    tradeExecutionId
  );

  if (!exitResult.ok) {
    throw new HttpError(500, exitResult.error);
  }

  // Calculate final P&L with the fetched exit premium
  const plResult = await plCalculationService.calculateFinalPL(
    tradeExecutionId,
    exitPremium
  );

  let finalPL = null;
  if (plResult.ok) {
    finalPL = plResult.data;
  }

  logger.info({
    tradeExecutionId,
    exitPremium,
    successCount: exitResult.data.successCount,
    failureCount: exitResult.data.failureCount,
    totalPL: finalPL ? finalPL.totalPL : null,
  }, 'Nifty50 exit execution completed');

  res.json({
    ok: true,
    exitSummary: {
      totalAccounts: exitResult.data.totalAccounts,
      successCount: exitResult.data.successCount,
      failureCount: exitResult.data.failureCount,
      exitPremium,
      finalPL: finalPL ? finalPL.totalPL : null,
    },
    exitResults: exitResult.data.exitResults,
    plData: finalPL,
  });
});

/**
 * GET /api/nifty50-orders/live-prices/:tradeExecutionId
 * Get current prices and P&L for active positions
 */
exports.getLivePrices = asyncHandler(async (req, res) => {
  const { tradeExecutionId } = req.params;

  // Retrieve trade execution log
  const tradeLog = await TradeExecutionLog.findById(tradeExecutionId);
  if (!tradeLog) {
    throw new HttpError(404, 'Trade execution not found');
  }

  if (tradeLog.status === 'exited') {
    throw new HttpError(400, 'Trade already exited');
  }

  // Get current price from price feed service
  // We need to pass an account to fetch the price
  const accounts = await Account.findOne({ enabled: true });
  if (!accounts) {
    throw new HttpError(500, 'No enabled accounts available for price fetch');
  }

  const currentPrice = await priceFeedService.getCurrentPrice(
    tradeLog.securityId,
    tradeLog.exchangeSegment,
    accounts
  );

  if (!currentPrice) {
    throw new HttpError(503, 'Current price unavailable');
  }

  // Calculate live P&L
  const livePrices = new Map();
  livePrices.set(tradeLog.securityId, currentPrice);

  const plResult = await plCalculationService.calculateLivePL(
    tradeExecutionId,
    livePrices
  );

  if (!plResult.ok) {
    throw new HttpError(500, plResult.error);
  }

  res.json({
    ok: true,
    tradeExecutionId,
    symbol: plResult.data.symbol,
    entryPremium: plResult.data.entryPremium,
    currentPremium: plResult.data.currentPremium,
    totalPL: plResult.data.totalPL,
    accountPLs: plResult.data.accountPLs,
  });
});

/**
 * GET /api/nifty50-orders/premium/:securityId
 * Get current premium for a Nifty 50 option
 */
exports.getPremium = asyncHandler(async (req, res) => {
  const { securityId } = req.params;
  const { exchangeSegment } = req.query;

  if (!exchangeSegment) {
    throw new HttpError(400, 'Exchange segment is required');
  }

  // Get an enabled account to fetch price
  const account = await Account.findOne({ enabled: true });
  if (!account) {
    throw new HttpError(500, 'No enabled accounts available for price fetch');
  }

  const premium = await priceFeedService.getCurrentPrice(
    securityId,
    exchangeSegment,
    account
  );

  if (!premium) {
    throw new HttpError(503, 'Premium unavailable');
  }

  res.json({
    ok: true,
    securityId,
    premium,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/nifty50-orders/pl/aggregate
 * Get aggregate P&L across all accounts
 */
exports.getAggregatePL = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  const dateRange = {};
  if (startDate) dateRange.startDate = startDate;
  if (endDate) dateRange.endDate = endDate;

  const plResult = await plCalculationService.getAggregatePL(dateRange);

  if (!plResult.ok) {
    throw new HttpError(500, plResult.error);
  }

  res.json({
    ok: true,
    ...plResult.data,
  });
});

/**
 * GET /api/nifty50-orders/pl/account/:accountId
 * Get P&L for specific account
 */
exports.getAccountPL = asyncHandler(async (req, res) => {
  const { accountId } = req.params;
  const { startDate, endDate } = req.query;

  const dateRange = {};
  if (startDate) dateRange.startDate = startDate;
  if (endDate) dateRange.endDate = endDate;

  const plResult = await plCalculationService.getAccountPL(accountId, dateRange);

  if (!plResult.ok) {
    throw new HttpError(500, plResult.error);
  }

  res.json({
    ok: true,
    ...plResult.data,
  });
});

/**
 * GET /api/nifty50-orders/pl/trades
 * Get all trade P&L records
 */
exports.getTradePL = asyncHandler(async (req, res) => {
  const { startDate, endDate, sortBy, order } = req.query;

  // Build query filter
  const filter = {};
  if (startDate || endDate) {
    filter.exitTime = {};
    if (startDate) filter.exitTime.$gte = new Date(startDate);
    if (endDate) filter.exitTime.$lte = new Date(endDate);
  }

  // Build sort options
  const sortOptions = {};
  if (sortBy === 'pl') {
    sortOptions.pl = order === 'asc' ? 1 : -1;
  } else {
    sortOptions.createdAt = order === 'asc' ? 1 : -1;
  }

  // Query trade P&L records
  const trades = await TradePLRecord.find(filter)
    .sort(sortOptions)
    .limit(1000); // Limit to prevent excessive data transfer

  // Calculate aggregate statistics
  const totalPL = trades.reduce((sum, t) => sum + t.pl, 0);
  const totalProfit = trades.filter(t => t.pl > 0).reduce((sum, t) => sum + t.pl, 0);
  const totalLoss = trades.filter(t => t.pl < 0).reduce((sum, t) => sum + t.pl, 0);
  const profitableTrades = trades.filter(t => t.pl > 0).length;
  const winRate = trades.length > 0 ? (profitableTrades / trades.length) * 100 : 0;

  res.json({
    ok: true,
    trades: trades.map(t => ({
      _id: t._id,
      tradeExecutionId: t.tradeExecutionId,
      accountId: t.accountId,
      accountName: t.accountName,
      symbol: t.symbol,
      lots: t.lots,
      lotSize: t.lotSize,
      entryTime: t.entryTime,
      entryPremium: t.entryPremium,
      entryValue: t.entryValue,
      exitTime: t.exitTime,
      exitPremium: t.exitPremium,
      exitValue: t.exitValue,
      pl: t.pl,
      plPercentage: t.plPercentage,
    })),
    aggregateStats: {
      totalPL,
      totalProfit,
      totalLoss,
      totalTrades: trades.length,
      profitableTrades,
      losingTrades: trades.length - profitableTrades,
      winRate,
    },
  });
});

/**
 * GET /api/nifty50-orders/accounts
 * Get all accounts with capital information
 */
exports.getAccounts = asyncHandler(async (req, res) => {
  const accounts = await Account.find().sort({ accountName: 1 });

  const accountsWithCapital = accounts.map(account => {
    const usableCapital = account.capitalAmount * (account.capitalPercentage / 100);
    
    return {
      accountId: account._id,
      accountName: account.accountName,
      capitalAmount: account.capitalAmount,
      capitalPercentage: account.capitalPercentage,
      usableCapital,
      enabled: account.enabled,
      mode: account.mode,
    };
  });

  res.json({
    ok: true,
    accounts: accountsWithCapital,
  });
});
