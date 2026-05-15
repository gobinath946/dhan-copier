const jwt = require('jsonwebtoken');
const env = require('../config/env');
const HttpError = require('../utils/HttpError');
const asyncHandler = require('../utils/asyncHandler');

// Constant-time string comparison
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

exports.login = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || !safeEqual(password, env.appPassword)) {
    throw new HttpError(401, 'Invalid password');
  }
  const token = jwt.sign({ sub: 'operator' }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
  res.json({ token, expiresIn: env.jwtExpiresIn });
});

exports.me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});
