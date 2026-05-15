const logger = require('../utils/logger');
const env = require('../config/env');

// 404 fallthrough
function notFoundHandler(req, res, _next) {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
}

// Centralized error handler
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const isServerError = status >= 500;

  if (isServerError) {
    logger.error({ err: err.message, stack: err.stack, path: req.originalUrl }, 'Unhandled error');
  } else {
    logger.warn({ err: err.message, path: req.originalUrl, status }, 'Client error');
  }

  const body = {
    error: isServerError && env.nodeEnv === 'production' ? 'Internal server error' : err.message,
  };
  if (err.details) body.details = err.details;

  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
