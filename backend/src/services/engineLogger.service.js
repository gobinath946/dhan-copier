/**
 * Engine Logger Service
 * Logs engine events to both database and file system
 */
const EngineEventLog = require('../models/EngineEventLog');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Get current date for log file name
function getLogFileName() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `engine-${date}.log`);
}

// Write to file
function writeToFile(logEntry) {
  try {
    const logLine = `[${new Date().toISOString()}] [${logEntry.level.toUpperCase()}] [${logEntry.eventType}] ${logEntry.message}\n`;
    fs.appendFileSync(getLogFileName(), logLine);
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to write engine log to file');
  }
}

/**
 * Log an engine event
 * @param {Object} params - Event parameters
 */
async function logEvent({
  sessionId,
  eventType,
  level = 'info',
  message,
  data = {},
  tradeId = null,
  aiDecision = null,
  marketSnapshot = null,
}) {
  try {
    // Create database entry
    const logEntry = await EngineEventLog.create({
      sessionId,
      eventType,
      level,
      message,
      data,
      tradeId,
      aiDecision,
      marketSnapshot,
    });

    // Write to file
    writeToFile(logEntry);

    // Also log to console via pino
    const logData = {
      sessionId,
      eventType,
      tradeId,
      ...data,
    };

    if (level === 'error') {
      logger.error(logData, `[engine] ${message}`);
    } else if (level === 'warn') {
      logger.warn(logData, `[engine] ${message}`);
    } else {
      logger.info(logData, `[engine] ${message}`);
    }

    return logEntry;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to create engine event log');
  }
}

/**
 * Get engine logs for a session
 * @param {String} sessionId - Session ID
 * @param {Object} options - Query options
 */
async function getSessionLogs(sessionId, options = {}) {
  const {
    page = 1,
    limit = 100,
    eventType = null,
    level = null,
    startDate = null,
    endDate = null,
  } = options;

  const query = { sessionId };

  if (eventType) query.eventType = eventType;
  if (level) query.level = level;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const total = await EngineEventLog.countDocuments(query);
  const logs = await EngineEventLog.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip((page - 1) * limit)
    .populate('tradeId', 'signal strike entryPrice exitPrice pnl status')
    .lean();

  return {
    logs,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get event statistics for a session
 */
async function getSessionStats(sessionId) {
  const mongoose = require('mongoose');
  
  const stats = await EngineEventLog.aggregate([
    { $match: { sessionId: new mongoose.Types.ObjectId(sessionId) } },
    {
      $group: {
        _id: '$eventType',
        count: { $sum: 1 },
      },
    },
  ]);

  const levelStats = await EngineEventLog.aggregate([
    { $match: { sessionId: new mongoose.Types.ObjectId(sessionId) } },
    {
      $group: {
        _id: '$level',
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    byEventType: stats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
    byLevel: levelStats.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
  };
}

/**
 * Delete logs for a session
 */
async function deleteSessionLogs(sessionId) {
  return await EngineEventLog.deleteMany({ sessionId });
}

module.exports = {
  logEvent,
  getSessionLogs,
  getSessionStats,
  deleteSessionLogs,
};
