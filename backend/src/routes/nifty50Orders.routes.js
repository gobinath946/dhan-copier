/**
 * Nifty50 Orders Routes
 * 
 * API routes for intelligent Nifty 50 order execution system.
 */

const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const { validateBody } = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/nifty50Orders.controller');

const router = express.Router();

// Apply authentication to all routes
router.use(requireAuth);

// Rate limiter for order execution endpoints (max 10 requests/minute)
const orderExecutionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: {
    ok: false,
    error: 'Too many order execution requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation schemas
const executeSchema = z.object({
  symbol: z.string().min(1).max(100),
  securityId: z.string().min(1).max(50),
  exchangeSegment: z.string().min(1).max(20),
  totalLots: z.number().int().min(1).max(1000),
  orderType: z.enum(['MARKET', 'LIMIT']).optional(),
  productType: z.enum(['INTRADAY', 'CNC']).optional(),
  price: z.number().min(0).optional(),
  triggeredMode: z.enum(['sandbox', 'production']).optional(),
  accountIds: z.array(z.string()).min(1),
});

const exitSchema = z.object({
  tradeExecutionId: z.string().min(1),
});

// Routes

// Order execution endpoints (with rate limiting)
router.post(
  '/execute',
  orderExecutionLimiter,
  validateBody(executeSchema),
  ctrl.execute
);

router.post(
  '/exit',
  orderExecutionLimiter,
  validateBody(exitSchema),
  ctrl.exit
);

// Live price endpoints
router.get('/live-prices/:tradeExecutionId', ctrl.getLivePrices);
router.get('/premium/:securityId', ctrl.getPremium);

// P&L reporting endpoints
router.get('/pl/aggregate', ctrl.getAggregatePL);
router.get('/pl/account/:accountId', ctrl.getAccountPL);
router.get('/pl/trades', ctrl.getTradePL);

// Account management endpoint
router.get('/accounts', ctrl.getAccounts);

module.exports = router;
