/**
 * AI I/O Logger
 * 
 * Captures EVERY ChatGPT request (prompt, model, context) and every response
 * (content, usage, latency) to a dedicated daily file so we can audit exactly
 * what the engine is sending to ChatGPT and what it gets back.
 *
 * Also echoes a compact summary through the main logger so it shows up in the
 * session JSON log and the terminal.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const logger = require('./logger');

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function getLogFileName() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `ai-io-${date}.jsonl`);
}

let writeQueue = [];
let flushTimer = null;

async function flushQueue() {
  if (writeQueue.length === 0) return;
  try {
    const lines = writeQueue.map(e => JSON.stringify(e)).join('\n') + '\n';
    const batch = writeQueue.length;
    writeQueue = [];
    await fsp.appendFile(getLogFileName(), lines);
    logger.debug({ batch }, '[aiIOLogger] flushed');
  } catch (err) {
    logger.error({ err: err.message }, '[aiIOLogger] flush failed');
  }
}

function enqueue(entry) {
  writeQueue.push(entry);
  if (writeQueue.length >= 10) {
    clearTimeout(flushTimer);
    flushTimer = null;
    flushQueue();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, 1000);
  }
}

function truncate(text, max = 4000) {
  if (typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max) + `... [truncated ${text.length - max} chars]` : text;
}

/**
 * Log a ChatGPT request + response pair.
 * Must not throw — failure here should never break trading.
 */
function logAICall({
  purpose,       // e.g. "master_algorithm_validation", "strike_selection"
  model,
  systemPrompt,
  userPrompt,
  responseText,
  parsedResponse,
  usage,
  latencyMs,
  error,
  sessionId,
}) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: sessionId || null,
      purpose: purpose || 'unspecified',
      model: model || 'unknown',
      latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
      systemPromptPreview: truncate(systemPrompt, 1000),
      userPromptPreview: truncate(userPrompt, 6000),
      responsePreview: truncate(responseText, 4000),
      parsedResponse: parsedResponse || null,
      usage: usage || null,
      error: error ? String(error) : null,
    };

    enqueue(entry);

    // Compact summary to pino (goes to terminal + session JSON)
    logger.info(
      {
        aiCall: purpose || 'unspecified',
        model,
        latencyMs,
        usage,
        ok: !error,
      },
      `[aiIO] ${purpose || 'call'} ${error ? 'FAILED' : 'ok'}`
    );
  } catch (err) {
    try {
      logger.error({ err: err.message }, '[aiIOLogger] logAICall crashed');
    } catch (_) { /* swallow */ }
  }
}

// Periodic safety flush
setInterval(() => {
  if (writeQueue.length > 0) flushQueue();
}, 5000);

process.on('beforeExit', flushQueue);
process.on('SIGINT', async () => { await flushQueue(); });
process.on('SIGTERM', async () => { await flushQueue(); });

module.exports = {
  logAICall,
  flushQueue,
};
