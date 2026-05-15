const express = require('express');
const { z } = require('zod');
const { validateBody } = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/account.controller');

const router = express.Router();
router.use(requireAuth);

const modeEnum = z.enum(['sandbox', 'production']);

const createSchema = z.object({
  accountName: z.string().min(1).max(100),
  clientId: z.string().min(1).max(100),
  accessToken: z.string().min(10).max(4000),
  mode: modeEnum,
  riskMultiplier: z.number().min(0.01).max(100).optional(),
  capitalPercentage: z.number().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  accountName: z.string().min(1).max(100).optional(),
  clientId: z.string().min(1).max(100).optional(),
  accessToken: z.string().min(10).max(4000).optional(),
  mode: modeEnum.optional(),
  riskMultiplier: z.number().min(0.01).max(100).optional(),
  capitalPercentage: z.number().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});

router.get('/', ctrl.list);
router.post('/', validateBody(createSchema), ctrl.create);
router.put('/:id', validateBody(updateSchema), ctrl.update);
router.delete('/:id', ctrl.remove);
router.post('/:id/test', ctrl.test);
router.post('/update-capital', ctrl.updateAllCapital);

module.exports = router;
