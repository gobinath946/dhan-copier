const express = require('express');
const { z } = require('zod');
const { validateQuery } = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/data.controller');

const router = express.Router();
router.use(requireAuth);

const modeQuery = z.object({ mode: z.enum(['sandbox', 'production']) });

const quoteQuery = z.object({
  mode: z.enum(['sandbox', 'production']),
  exchangeSegment: z.string().min(1).max(20),
  securityId: z.string().min(1).max(50),
});

const logsQuery = z.object({
  accountId: z.string().optional(),
  status: z.enum(['success', 'failed', 'pending', 'retrying']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/positions', validateQuery(modeQuery), ctrl.positions);
router.get('/holdings', validateQuery(modeQuery), ctrl.holdings);
router.get('/quote', validateQuery(quoteQuery), ctrl.quote);
router.get('/dashboard-stats', validateQuery(modeQuery), ctrl.dashboardStats);
router.get('/logs', validateQuery(logsQuery), ctrl.logs);

module.exports = router;
