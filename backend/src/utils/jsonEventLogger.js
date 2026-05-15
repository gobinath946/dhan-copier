/**
 * JSON Event Logger
 * Logs ALL backend events to a JSON file for analysis
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fsSync.existsSync(logsDir)) {
  fsSync.mkdirSync(logsDir, { recursive: true });
}

// Current session ID for logging
let currentSessionId = null;

// Get log file name based on session
function getLogFileName() {
  const date = new Date().toISOString().split('T')[0];
  if (currentSessionId) {
    return path.join(logsDir, `session-${currentSessionId}-${date}.json`);
  }
  return path.join(logsDir, `events-${date}.json`);
}

// Queue for batching writes
let writeQueue = [];
let writeTimer = null;

/**
 * Set current session ID for logging
 */
function setSessionId(sessionId) {
  currentSessionId = sessionId;
  // Silent — no console noise for session ID changes
}

/**
 * Flush the write queue to disk
 */
async function flushQueue() {
  if (writeQueue.length === 0) return;
  
  try {
    const logFile = getLogFileName();
    const lines = writeQueue.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    await fs.appendFile(logFile, lines);
    writeQueue = [];
    // Silent flush — no console noise
  } catch (err) {
    originalConsoleError('[JSON Logger] Failed to flush:', err.message);
  }
}

/**
 * Log an event to JSON file (async, batched)
 * @param {Object} event - Event object to log
 */
function logEvent(event) {
  const timestamp = new Date().toISOString();
  
  const logEntry = {
    timestamp,
    sessionId: currentSessionId,
    ...event,
  };
  
  writeQueue.push(logEntry);
  
  // Batch writes every 500ms or when queue reaches 20 items (more aggressive flushing)
  if (writeQueue.length >= 20) {
    clearTimeout(writeTimer);
    flushQueue();
    writeTimer = null;
  } else if (!writeTimer) {
    writeTimer = setTimeout(() => {
      flushQueue();
      writeTimer = null;
    }, 500);
  }
}

/**
 * Read events from JSON log file
 * @param {String} sessionId - Session ID (optional)
 * @param {String} date - Date in YYYY-MM-DD format (optional, defaults to today)
 * @param {Number} limit - Maximum number of events to return
 */
async function readEvents(sessionId = null, date = null, limit = 1000) {
  try {
    const logDate = date || new Date().toISOString().split('T')[0];
    let logFile;
    
    if (sessionId) {
      logFile = path.join(logsDir, `session-${sessionId}-${logDate}.json`);
    } else {
      logFile = path.join(logsDir, `events-${logDate}.json`);
    }
    
    // Check if file exists
    try {
      await fs.access(logFile);
    } catch {
      return [];
    }
    
    const content = await fs.readFile(logFile, 'utf8');
    const lines = content.trim().split('\n');
    
    const events = lines
      .slice(-limit)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    
    return events;
  } catch (err) {
    console.error('[JSON Logger] Failed to read:', err.message);
    return [];
  }
}

// Intercept console.log, console.info, console.warn, console.error
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function(...args) {
  logEvent({
    type: 'console',
    level: 'info',
    msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
  });
  originalConsoleLog.apply(console, args);
};

console.info = function(...args) {
  logEvent({
    type: 'console',
    level: 'info',
    msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
  });
  originalConsoleInfo.apply(console, args);
};

console.warn = function(...args) {
  logEvent({
    type: 'console',
    level: 'warn',
    msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
  });
  originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
  logEvent({
    type: 'console',
    level: 'error',
    msg: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
  });
  originalConsoleError.apply(console, args);
};

// Graceful shutdown - flush remaining logs
process.on('SIGINT', async () => {
  originalConsoleLog('[JSON Logger] SIGINT - flushing logs...');
  await flushQueue();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  originalConsoleLog('[JSON Logger] SIGTERM - flushing logs...');
  await flushQueue();
  process.exit(0);
});

process.on('beforeExit', async () => {
  await flushQueue();
});

// Periodic flush every 5 seconds to ensure logs are written
setInterval(() => {
  if (writeQueue.length > 0) {
    flushQueue();
  }
}, 5000);

module.exports = {
  logEvent,
  readEvents,
  flushQueue,
  setSessionId,
};
