'use strict';

/**
 * ============================================================
 * TRADE MONITOR SERVICE — legacy compatibility stub
 * ============================================================
 * The legacy scalping engine imported `./tradeMonitor.service`
 * for an in-process per-trade EXIT/HOLD decision path. The
 * Hybrid_Engine (Req 3 / Req 15) replaces that path with
 * `monitorEngine.service.js` (the "new centralised monitor
 * decision") and `hybridEngine/monitoringEngine.adapter.js`
 * (per-tick survival / re-evaluation routing). The legacy
 * call site inside `scalpingEngine.service.js` is now fully
 * commented out — only the top-level `require()` remains.
 *
 * Removing the require would touch a load-bearing legacy file.
 * Instead this stub exports a contract-compatible `monitorTrade`
 * function that:
 *
 *   1. Logs a deprecation warning so any caller that resurfaces
 *      this code path is visible in the audit trail.
 *   2. Returns a safe-default `{ action: 'HOLD', ... }` decision
 *      so the legacy engine's monitor branch (if ever
 *      re-enabled) does not crash and does not flip a position
 *      based on a now-stale heuristic.
 *
 * The Hybrid_Engine pipeline is the canonical exit decision
 * path. New code MUST NOT call into this module.
 *
 * Spec references:
 *   - Req 3.11   — remove / disable redundant orchestration paths
 *   - Req 14.4   — AI/legacy heuristics may not override exits
 *   - Req 19.7   — every survival action routes through Risk_Engine
 * ============================================================
 */

const logger = require('../utils/logger');

const DEPRECATION_TAG =
  '[HybridEngine: removed per Req 3.11] tradeMonitor.service is deprecated; '
  + 'route exit decisions through monitorEngine.service.js / '
  + 'hybridEngine/monitoringEngine.adapter.js';

let _warned = false;

function _warnOnce() {
  if (_warned) return;
  _warned = true;
  try {
    logger.warn({ module: 'tradeMonitor.service' }, DEPRECATION_TAG);
  } catch (_) {
    // eslint-disable-next-line no-console
    console.warn(DEPRECATION_TAG);
  }
}

/**
 * Legacy entry point used by `scalpingEngine.service.js` before
 * the Hybrid_Engine wiring. Returns a safe-default HOLD decision
 * with `source: 'tradeMonitor_deprecated'` so any caller that
 * still invokes it is observable on the audit trail.
 *
 * @param {Object} _trade            Open trade (ignored).
 * @param {string} _authKey          Dhan auth (ignored).
 * @param {*}      _rest             Any further legacy arguments.
 * @returns {Promise<Object>}        Stable HOLD decision.
 */
async function monitorTrade(_trade, _authKey, ..._rest) {
  _warnOnce();
  return {
    action: 'HOLD',
    confidence: 0,
    reasoning:
      'tradeMonitor.service is deprecated; exit decisions are now owned by '
      + 'monitorEngine.service.js / hybridEngine/monitoringEngine.adapter.js',
    source: 'tradeMonitor_deprecated',
    deprecated: true,
  };
}

module.exports = {
  monitorTrade,
  // Constant exported so any caller can test for the deprecation
  // banner without parsing log output.
  DEPRECATION_TAG,
};
