const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/trade.controller');

const router = express.Router();
router.use(requireAuth);

const executeSchema = z.object({
  symbol: z.string().min(1).max(50),
  securityId: z.string().min(1).max(50),
  exchangeSegment: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.number().int().min(1).max(1_000_000),
  orderType: z.enum(['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_MARKET']),
  productType: z.enum(['INTRADAY', 'CNC', 'MARGIN', 'MTF', 'CO', 'BO']),
  validity: z.enum(['DAY', 'IOC']).optional(),
  price: z.number().min(0).optional(),
  triggerPrice: z.number().min(0).optional(),
  stopLoss: z.number().min(0).optional(),
  target: z.number().min(0).optional(),
  triggeredMode: z.enum(['sandbox', 'production']),
  note: z.string().max(500).optional(),
});

const modifySchema = z.object({
  accountId: z.string().min(1),
  dhanOrderId: z.string().min(1),
  patch: z.record(z.any()),
});

const cancelSchema = z.object({
  accountId: z.string().min(1),
  dhanOrderId: z.string().min(1),
});

const retrySchema = z.object({
  resultId: z.string().min(1),
});

router.post('/execute', validateBody(executeSchema), ctrl.execute);
router.post('/modify', validateBody(modifySchema), ctrl.modify);
router.post('/cancel', validateBody(cancelSchema), ctrl.cancel);
router.post('/retry-leg', validateBody(retrySchema), ctrl.retryLeg);

module.exports = router;
