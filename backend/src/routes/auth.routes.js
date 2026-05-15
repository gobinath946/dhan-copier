const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { validateBody } = require('../utils/validate');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later.' },
});

const loginSchema = z.object({
  password: z.string().min(1).max(200),
});

router.post('/login', loginLimiter, validateBody(loginSchema), ctrl.login);
router.get('/me', requireAuth, ctrl.me);

module.exports = router;
