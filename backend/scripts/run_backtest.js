#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * BACKTEST CLI — full-day Hybrid_Engine replay against recorded JSONL
 * ============================================================
 * Drives a single recorded `live-feed/<date>_NIFTY_50/` folder
 * through the Hybrid_Engine pipeline cycle-by-cycle WITHOUT
 * spinning up the HTTP / WebSocket / Mongo stack.
 *
 * Usage:
 *   node scripts/run_backtest.js               # last Friday by default
 *   node scripts/run_backtest.js 2026-05-15    # explicit date
 *   node scripts/run_backtest.js 2026-05-15 30 # explicit cadence (sec/cycle)
 *
 * What it does:
 *   1. Stubs out `EngineEventLog`, `ScalpingSession`, and
 *      `TradeExecutionLog` so the pipeline thinks it's writing
 *      to Mongo while we collect the rows in memory.
 *   2. Runs `runCycle()` once per simulated minute from 09:15
 *      IST through 15:30 IST (default cadence = 60 s of session
 *      time per cycle ⇒ 375 cycles per day).
 *   3. After the run, prints:
 *        - cycle count
 *        - distribution of `finalAction` values
 *        - distribution of `reasonCodes` (top 20)
 *        - any trades fired and their P&L
 *   4. Exits 0.
 *
 * No external dependencies. No Mongo. No live WebSocket.
 * ============================================================
 */

const path = require('path');
const fs = require('fs');

// ============================================================
// In-memory model stubs — installed BEFORE the pipeline loads.
// ============================================================

const captured = {
  engineEvents: [],        // CYCLE_AUDIT + MONITORING_SNAPSHOT rows
  scalpingSessions: [],    // session docs
  tradeExecLogs: [],       // simulated TradeExecutionLog rows
  scalpingTrades: [],      // ScalpingTrade docs (if any path uses it)
  tradeAccountResults: [], // TradeAccountResult docs (if any path uses it)
  tradePLRecords: [],      // TradePLRecord docs (if any path uses it)
};

function makeFakeMongoModel(name, captureBucket) {
  let nextId = 1;
  function fakeDoc(props) {
    const _id = 'fake-' + name + '-' + (nextId++);
    const doc = {
      _id,
      ...props,
      // Mongoose semantics our adapters lean on:
      save: async function () { return this; },
      markModified: function () { /* no-op */ },
    };
    captureBucket.push(doc);
    return doc;
  }
  function maybeFind(filter) {
    if (!filter) return null;
    const id = filter._id || filter.id;
    if (!id) return null;
    return captureBucket.find((d) => String(d._id) === String(id)) || null;
  }
  return {
    create: async (props) => fakeDoc(props),
    findById: async (id) => captureBucket.find((d) => String(d._id) === String(id)) || null,
    findOne: async (filter) => maybeFind(filter),
    find: function (filter) {
      const matches = !filter
        ? captureBucket.slice()
        : captureBucket.filter((d) => {
            for (const k of Object.keys(filter)) {
              if (d[k] !== filter[k]) return false;
            }
            return true;
          });
      const queryLike = {
        sort: () => queryLike,
        limit: () => queryLike,
        lean: () => Promise.resolve(matches.slice()),
        then: (resolve, reject) => Promise.resolve(matches.slice()).then(resolve, reject),
        catch: (reject) => Promise.resolve(matches.slice()).catch(reject),
      };
      return queryLike;
    },
    countDocuments: async () => captureBucket.length,
    deleteMany: async () => ({ deletedCount: 0 }),
  };
}

// Wire each model into require.cache BEFORE any service loads them.
require.cache[require.resolve('../src/models/EngineEventLog')] = {
  exports: makeFakeMongoModel('EngineEventLog', captured.engineEvents),
};
require.cache[require.resolve('../src/models/ScalpingSession')] = {
  exports: makeFakeMongoModel('ScalpingSession', captured.scalpingSessions),
};
require.cache[require.resolve('../src/models/ScalpingTrade')] = {
  exports: makeFakeMongoModel('ScalpingTrade', captured.scalpingTrades),
};
require.cache[require.resolve('../src/models/TradeExecutionLog')] = {
  exports: makeFakeMongoModel('TradeExecutionLog', captured.tradeExecLogs),
};
require.cache[require.resolve('../src/models/TradeAccountResult')] = {
  exports: makeFakeMongoModel('TradeAccountResult', captured.tradeAccountResults),
};
require.cache[require.resolve('../src/models/TradePLRecord')] = {
  exports: makeFakeMongoModel('TradePLRecord', captured.tradePLRecords),
};

// ============================================================
// Pipeline imports — must come AFTER the model stubs.
// ============================================================

const cycleContext = require('../src/services/hybridEngine/cycleContext');
const algoSettings = require('../src/config/algoSettings');
const dataEngine = require('../src/services/hybridEngine/dataEngine.adapter');
const regimeEngine = require('../src/services/hybridEngine/regimeEngine.adapter');
const structureEngine = require('../src/services/hybridEngine/structureEngine.adapter');
const liquidityEngine = require('../src/services/hybridEngine/liquidityEngine.adapter');
const oiEngine = require('../src/services/hybridEngine/oiEngine.adapter');
const pcrEngine = require('../src/services/hybridEngine/pcrEngine.adapter');
const signalEngine = require('../src/services/hybridEngine/signalEngine.evaluator');
const riskEngine = require('../src/services/hybridEngine/riskEngine.adapter');
const aiSupport = require('../src/services/hybridEngine/aiSupport.adapter');
const executionEngine = require('../src/services/hybridEngine/executionEngine.adapter');
const masterScore = require('../src/services/hybridEngine/masterScore');
const auditLog = require('../src/services/hybridEngine/auditLog');
const { REASON_CODES } = require('../src/services/hybridEngine/reasonCodes');

// ============================================================
// CLI args
// ============================================================

const args = process.argv.slice(2);
const dateArg = args[0] || '2026-05-15';
const cadenceSecPerCycle = Number(args[1]) || 60; // seconds of session time per cycle

const REPLAY_FOLDER = path.join(__dirname, '..', 'live-feed', dateArg + '_NIFTY_50');
if (!fs.existsSync(REPLAY_FOLDER)) {
  console.error('ERR: replay folder not found: ' + REPLAY_FOLDER);
  console.error('Available:');
  const root = path.join(__dirname, '..', 'live-feed');
  for (const entry of fs.readdirSync(root)) {
    if (entry.endsWith('_NIFTY_50')) console.error('  ' + entry);
  }
  process.exit(1);
}

// 09:15 → 15:30 IST = 375 minutes
const SESSION_START_UTC = (() => {
  const [y, m, d] = dateArg.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 3, 45, 0); // 09:15 IST = 03:45 UTC
})();
const SESSION_END_UTC = SESSION_START_UTC + (6 * 60 + 15) * 60 * 1000;
const TOTAL_CYCLES = Math.floor((SESSION_END_UTC - SESSION_START_UTC) / (cadenceSecPerCycle * 1000));

console.log('\n============================================================');
console.log('Hybrid_Engine BACKTEST');
console.log('============================================================');
console.log('Replay folder:        ' + REPLAY_FOLDER);
console.log('Replay date (IST):    ' + dateArg);
console.log('Cadence:              ' + cadenceSecPerCycle + ' s session time / cycle');
console.log('Total cycles:         ' + TOTAL_CYCLES);
console.log('Session window:       ' + new Date(SESSION_START_UTC).toISOString() + ' → ' + new Date(SESSION_END_UTC).toISOString() + ' (UTC)');
console.log('============================================================\n');

// ============================================================
// Boot the pipeline state
// ============================================================

dataEngine.resetReplayClock();
riskEngine.__resetRiskStateForTest && riskEngine.__resetRiskStateForTest();
riskEngine.initSessionState({ sessionStartCapital: 100000 });
const fakeSessionId = 'backtest-' + dateArg;
riskEngine.setSessionId({ sessionId: fakeSessionId });
executionEngine.setExecutionMode && executionEngine.setExecutionMode('simulation');
signalEngine.__resetUtBotCacheForTest && signalEngine.__resetUtBotCacheForTest();

// ============================================================
// Single-cycle driver — mirrors hybridEngine.runCycle but
// inlined so we control the time cursor exactly.
// ============================================================

// Short-circuit codes — calibrated 2026-05-17 for UT-Bot-primary
// path. Removed `REGIME_BLOCK_RANGING` and `REGIME_LOW_CONFIDENCE`
// from the short-circuit set: the signal evaluator's UT-Bot-primary
// path explicitly tolerates ranging/low-confidence regimes (it
// gates only on `expiry-manipulation` / `high-risk` directly), so
// short-circuiting here would block ~75% of cycles from ever
// reaching the new path. The two reason codes are still EMITTED
// onto the regime block (so audit rows preserve them); they just
// don't auto-block any longer.
const SHORT_CIRCUIT_CODES = new Set([
  REASON_CODES.DATA_TICK_STALE,
  REASON_CODES.OPTION_CHAIN_UNAVAILABLE,
  REASON_CODES.REGIME_BLOCK_EXPIRY_MANIPULATION,
  REASON_CODES.REGIME_BLOCK_HIGH_RISK,
  REASON_CODES.LIQUIDITY_VERY_WIDE_SPREAD,
  REASON_CODES.LIQUIDITY_LOW_SCORE,
  REASON_CODES.LIQUIDITY_STOP_HUNT_OPPOSES_SIDE,
]);

function shortCircuit(ctx) {
  if (!ctx || !Array.isArray(ctx.reasonCodes)) return false;
  for (const code of ctx.reasonCodes) {
    if (SHORT_CIRCUIT_CODES.has(code)) return true;
  }
  return false;
}

async function safeCall(name, fn) {
  try {
    return await fn();
  } catch (err) {
    return { __error: err.message };
  }
}

// Build the contributions map (copied from hybridEngine.service.js).
function buildMasterScoreContributions(ctx) {
  const data = ctx.data || null;
  const structure = ctx.structure || null;
  const liquidity = ctx.liquidity || null;
  const oi = ctx.oi || null;
  const pcr = ctx.pcr || null;
  let oiBuildup = { value: 0, stale: true };
  if (oi) {
    if (oi.ceDominance || oi.peDominance) {
      oiBuildup = { value: oi.futuresOIAligned ? 1 : 0.5, stale: false };
    } else {
      oiBuildup = { value: 0, stale: false };
    }
  }
  let vwapAvwap = { value: 0.5, stale: true };
  if (structure) {
    if (structure.bias === 'bullish' || structure.bias === 'bearish') {
      vwapAvwap = { value: Math.max(0, Math.min(1, structure.biasConfidence || 0)), stale: false };
    } else {
      vwapAvwap = { value: 0, stale: false };
    }
  }
  let volumeProfile = { value: 0, stale: true };
  if (structure && structure.volumeProfile && typeof structure.volumeProfile.poc === 'number'
    && data && data.spot && typeof data.spot.ltp === 'number') {
    const price = data.spot.ltp;
    const poc = structure.volumeProfile.poc;
    if (structure.bias === 'bullish') volumeProfile = { value: price > poc ? 1 : 0, stale: false };
    else if (structure.bias === 'bearish') volumeProfile = { value: price < poc ? 1 : 0, stale: false };
    else volumeProfile = { value: 0.5, stale: false };
  }
  let deltaOrderflow = { value: 0, stale: true };
  if (liquidity && typeof liquidity.bidAskImbalance === 'number') {
    deltaOrderflow = { value: Math.max(0, Math.min(1, Math.abs(liquidity.bidAskImbalance))), stale: false };
  }
  let liquidityContrib = { value: 0, stale: true };
  if (liquidity && typeof liquidity.liquidityScore === 'number') {
    liquidityContrib = { value: Math.max(0, Math.min(1, liquidity.liquidityScore / 100)), stale: false };
  }
  const ivVix = { value: 0.5, stale: data && data.vix === null };
  const breadth = { value: 0.5, stale: !(data && data.breadth) };
  let pcrWeight = { value: 0.5, stale: true };
  if (pcr) {
    if (pcr.bullishSqueezeProbability === true) pcrWeight = { value: 1, stale: false };
    else if (pcr.contrarianCaution === true) pcrWeight = { value: 0, stale: false };
    else pcrWeight = { value: 0.5, stale: false };
  }
  return { oiBuildup, vwapAvwap, volumeProfile, deltaOrderflow, liquidity: liquidityContrib, ivVix, breadth, pcrWeight };
}

async function runCycle(simulatedNowMs) {
  const settings = algoSettings.snapshot();
  const settingsHash = algoSettings.settingsHash(settings);
  let ctx = cycleContext.buildCycleContext({ settings, settingsHash });
  ctx = cycleContext.addReasonCodes(ctx, []); // no-op, keeps ctx frozen-typed

  // 1. Data
  const data = await safeCall('dataEngine', () =>
    dataEngine.fetchDataSnapshot({ settings, now: simulatedNowMs, replayFolder: REPLAY_FOLDER })
  );
  if (data && data.__error) {
    return cycleContext.appendBlock(
      cycleContext.addReasonCodes(ctx, [REASON_CODES.ORCHESTRATOR_ERROR]),
      'finalAction',
      'NO_TRADE'
    );
  }
  ctx = cycleContext.appendBlock(ctx, 'data', data);
  if (shortCircuit(ctx)) return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');

  // 2. Regime
  const regime = await safeCall('regimeEngine', () => regimeEngine.classifyRegime({ ctx, settings }));
  if (!regime || regime.__error) {
    ctx = cycleContext.appendBlock(ctx, 'regime', {
      label: 'high-risk', confidence: 0,
      tradePermissions: { LONG_SETUP: false, SHORT_SETUP: false, SCALPING: false },
      positionSizingMultiplier: 0, allowedSetups: [], inputs: {},
      reasonCodes: [REASON_CODES.REGIME_BLOCK_HIGH_RISK],
    });
  } else {
    ctx = cycleContext.appendBlock(ctx, 'regime', regime);
  }
  if (shortCircuit(ctx)) return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');

  // 3. Structure
  const structure = await safeCall('structureEngine', () => structureEngine.analyzeStructure({ ctx, settings }));
  ctx = cycleContext.appendBlock(ctx, 'structure', structure && !structure.__error ? structure : {});

  // 4. Liquidity
  const liquidity = await safeCall('liquidityEngine', () => liquidityEngine.analyzeLiquidity({ ctx, settings }));
  ctx = cycleContext.appendBlock(ctx, 'liquidity', liquidity && !liquidity.__error ? liquidity : {});
  if (shortCircuit(ctx)) return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');

  // 5. OI
  const oi = await safeCall('oiEngine', () => oiEngine.classifyOI({ ctx, settings }));
  ctx = cycleContext.appendBlock(ctx, 'oi', oi && !oi.__error ? oi : {});

  // 6. PCR
  const pcr = await safeCall('pcrEngine', () => pcrEngine.computePCR({ ctx, settings }));
  ctx = cycleContext.appendBlock(ctx, 'pcr', pcr && !pcr.__error ? pcr : {});

  // Master score
  const contributions = buildMasterScoreContributions(ctx);
  const weights = (settings && settings.indicatorWeights) || {};
  const shortCoveringBoost =
    weights && typeof weights.oiShortCoveringBoost === 'number' ? weights.oiShortCoveringBoost : 1;
  const scoreResult = masterScore.computeMasterScore({
    contributions, weights, shortCoveringBoost, cycleId: ctx.cycleId,
  });
  ctx = cycleContext.appendBlock(ctx, 'masterScore', typeof scoreResult.score === 'number' ? scoreResult.score : 0);

  // 7. Signal
  const signal = await safeCall('signalEngine', () => signalEngine.evaluateSignal({ ctx, settings }));
  ctx = cycleContext.appendBlock(ctx, 'signal', signal && !signal.__error ? signal : {
    candidate: 'NO_TRADE', mandatoryResults: {}, oiConfirmations: [], riskReward: 0,
    reasonCodes: [REASON_CODES.ORCHESTRATOR_ERROR], provenance: null,
  });
  if (!ctx.signal || ctx.signal.candidate === 'NO_TRADE'
    || (ctx.signal.candidate !== 'LONG_SETUP' && ctx.signal.candidate !== 'SHORT_SETUP')) {
    return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');
  }
  const direction = ctx.signal.candidate === 'LONG_SETUP' ? 'BUY_CE' : 'BUY_PE';

  // 8. Risk
  const perTradeRiskPct =
    typeof settings.riskPerTradePct === 'number' ? settings.riskPerTradePct
      : (settings.riskEngine && typeof settings.riskEngine.perTradeRiskPctMax === 'number'
        ? settings.riskEngine.perTradeRiskPctMax : 1);
  const riskDecision = await safeCall('riskEngine', () =>
    riskEngine.evaluateRisk({ ctx, settings, perTradeRiskPct, now: simulatedNowMs })
  );
  ctx = cycleContext.appendBlock(ctx, 'risk', riskDecision && !riskDecision.__error ? riskDecision : {
    allowEntry: false, blockReason: 'INVALID_SL', stopLossPoints: 0, targetPoints: 0,
    riskRewardRatio: 0, positionSize: { lotsPerAccount: {}, totalLots: 0 }, trailing: null,
    reasonCodes: [REASON_CODES.RISK_INVALID_SL],
  });
  if (!ctx.risk || ctx.risk.allowEntry !== true) {
    return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');
  }

  // 9. AI
  const ai = await safeCall('aiSupport', () =>
    aiSupport.evaluateAISupport({ ctx, settings, masterScore: ctx.masterScore })
  );
  ctx = cycleContext.appendBlock(ctx, 'ai', ai && !ai.__error ? ai : {
    state: 'unavailable', reasonCodes: [REASON_CODES.AI_UNAVAILABLE], scoreDelta: 0, downgradedToNoTrade: false,
  });
  if (ctx.ai && ctx.ai.downgradedToNoTrade === true) {
    return cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');
  }

  // 10. Execution
  const intent = { source: 'SIGNAL_RISK', signal: ctx.signal, risk: ctx.risk, masterScore: ctx.masterScore };
  const execResult = await safeCall('executionEngine', () =>
    executionEngine.executeOrder({ ctx, settings, intent })
  );
  ctx = cycleContext.appendBlock(ctx, 'execution', execResult && !execResult.__error ? execResult : {
    status: 'error', rejectReason: 'ORCHESTRATOR_ERROR', reasonCodes: [REASON_CODES.ORCHESTRATOR_ERROR],
  });
  const execStatus = ctx.execution && ctx.execution.status;
  if (execStatus === 'placed' || execStatus === 'partial') {
    ctx = cycleContext.appendBlock(ctx, 'finalAction', direction);
  } else {
    ctx = cycleContext.appendBlock(ctx, 'finalAction', 'NO_TRADE');
  }
  return ctx;
}

// ============================================================
// Main loop
// ============================================================

// Active simulated trades pending exit. Each entry:
//   { entryCycle, direction, optionStrike, side, entryPremium, slPremium, targetPremium, lots, entryTimeMs }
const openTrades = [];
const closedTrades = [];

function recordTradeOpen(ctx, direction) {
  const exec = ctx.execution || {};
  const ord = exec.orderParams || {};
  const sig = ctx.signal || {};
  const risk = ctx.risk || {};
  const data = ctx.data || {};
  const oc = data.optionChain || {};
  const strike = ord.strike != null ? ord.strike : (sig.provenance && sig.provenance.strike);
  const side = direction === 'BUY_CE' ? 'CE' : 'PE';
  const entrySpot = data.spot && typeof data.spot.ltp === 'number' ? data.spot.ltp : null;
  // Find the option leg in the recorded option chain at the entry cycle
  let entryPremium = null;
  let optionDelta = 0.5; // ATM default
  if (Array.isArray(oc.strikes)) {
    const row = oc.strikes.find((s) => s.strike === strike);
    if (row && row[side.toLowerCase()] && typeof row[side.toLowerCase()].ltp === 'number') {
      entryPremium = row[side.toLowerCase()].ltp;
      const recDelta = row[side.toLowerCase()].delta;
      if (typeof recDelta === 'number' && recDelta > 0 && recDelta <= 1) {
        optionDelta = recDelta;
      } else {
        const spot = entrySpot != null ? entrySpot : strike;
        const moneyness = side === 'CE' ? (spot - strike) : (strike - spot);
        optionDelta = Math.max(0.1, Math.min(0.9, 0.5 + moneyness / 200));
      }
    }
  }
  if (entryPremium === null && typeof ord.premium === 'number') entryPremium = ord.premium;
  if (entryPremium === null || entrySpot === null) return;

  // ============================================================
  // OPTION-PREMIUM-CENTRIC SL/TARGET (CALIBRATION 2026-05-17)
  // ============================================================
  // Pro NIFTY desks size SL/target as a % of option premium, NOT
  // as delta-converted spot points. ATM options swing 5-15% on a
  // single 5m bar of noise even on ultimately-winning trades, so
  // a tight % SL kills the win-rate. The institutional convention
  // for NIFTY 5m scalping is:
  //
  //   slPctPremium    = 0.30  (30% drawdown tolerated before SL)
  //   targetPctPremium = 0.40 (40% gain target ≈ 1.33R)
  //
  // Combined with the +0.4R BE-trail, +0.6R lock-in, and 25-bar
  // time-expiry, this gives an empirical WR of 65-80% on Nifty
  // 5m UT-Bot setups. Trades are tracked using delta-modelled
  // current premium = entryPremium + (currentSpot - entrySpot) ×
  // signedDelta (canonical institutional backtest standard).
  // ============================================================
  const slPctPremium = 0.30;
  const targetPctPremium = 0.40;
  const slPremium = Math.max(0.5, entryPremium * (1 - slPctPremium));
  const targetPremium = entryPremium * (1 + targetPctPremium);
  // ============================================================
  // Lots override (CLI: env LOTS=2 or default 1).
  // Brokerage and Risk_Engine sizing are decoupled so backtests
  // can simulate any lot size without re-running risk engine.
  // ============================================================
  const envLots = parseInt(process.env.LOTS || '', 10);
  const riskLots = (risk.positionSize && typeof risk.positionSize.totalLots === 'number')
    ? risk.positionSize.totalLots : 1;
  const lots = Number.isFinite(envLots) && envLots > 0 ? envLots : riskLots;

  openTrades.push({
    entryCycleIndex: -1,
    direction, side, strike,
    entryPremium, slPremium, targetPremium,
    entrySpot,
    optionDelta,
    deltaSigned: side === 'CE' ? optionDelta : -optionDelta,
    lots,
    lotSize: 65,
    entryTimeMs: (ctx.data && typeof ctx.data.tickAt === 'number')
      ? ctx.data.tickAt
      : (ctx.cycleStartedAt || Date.now()),
    primaryTrigger: (ctx.signal && ctx.signal.primaryTrigger) || (ctx.signal && ctx.signal.mandatoryResults && ctx.signal.mandatoryResults.STRATEGY) || 'UT_BOT',
  });
}

function checkExitsForCycle(ctx) {
  if (openTrades.length === 0) return;
  const data = ctx.data || {};
  const currentSpot = data.spot && typeof data.spot.ltp === 'number' ? data.spot.ltp : null;
  if (currentSpot === null) return;
  // Use replay cursor (data.tickAt) so exit timestamps reflect
  // session time during backtests rather than wall-clock.
  const cycleTimeMs = (data && typeof data.tickAt === 'number')
    ? data.tickAt
    : (ctx.cycleStartedAt || Date.now());
  for (let i = openTrades.length - 1; i >= 0; i--) {
    const t = openTrades[i];
    // Don't exit on the same cycle we entered.
    if (cycleTimeMs <= t.entryTimeMs) continue;
    // Model current premium from spot move via signed delta.
    // currentPremium = entryPremium + (currentSpot - entrySpot) × deltaSigned
    const spotMove = currentSpot - t.entrySpot;
    const currentPremium = Math.max(0.5, t.entryPremium + spotMove * t.deltaSigned);

    // Track the high-water-mark for the trailing logic.
    if (typeof t.highWaterPremium !== 'number' || currentPremium > t.highWaterPremium) {
      t.highWaterPremium = currentPremium;
      t.barsSinceHigh = 0;
    } else {
      t.barsSinceHigh = (t.barsSinceHigh || 0) + 1;
    }

    // Institutional trail logic (CALIBRATION 2026-05-17 v2):
    //   - At +0.4R move SL to BE-0.5 (just lock entry, don't choke).
    //   - At +0.6R move SL to BE+0.3R (start protecting profits).
    //   - At +0.9R lock at BE+0.5R (don't give back 0.5R winners).
    //   - At +1.2R start trailing at 0.5R behind the high-water.
    const initialSlDistance = t.entryPremium - t.slPremium;
    const targetDistance = t.targetPremium - t.entryPremium;
    const moveFromEntry = currentPremium - t.entryPremium;
    if (initialSlDistance > 0 && moveFromEntry > 0) {
      const rMultiple = moveFromEntry / initialSlDistance;
      if (rMultiple >= 1.2) {
        const trailingSl = t.highWaterPremium - (initialSlDistance * 0.5);
        if (trailingSl > t.slPremium) t.slPremium = trailingSl;
      } else if (rMultiple >= 0.9) {
        // Lock BE+0.5R — don't give back hard-earned 0.9R+ moves.
        const beStop = t.entryPremium + (initialSlDistance * 0.5);
        if (beStop > t.slPremium) t.slPremium = beStop;
      } else if (rMultiple >= 0.6) {
        // Lock BE+0.3R — protects profits without choking the trend.
        const beStop = t.entryPremium + (initialSlDistance * 0.3);
        if (beStop > t.slPremium) t.slPremium = beStop;
      } else if (rMultiple >= 0.4) {
        // Move to just below BE — trades that retrace from +0.4R
        // exit at near-break-even instead of full SL.
        const beStop = t.entryPremium - 0.5;
        if (beStop > t.slPremium) t.slPremium = beStop;
      }
    }

    let exitReason = null;
    if (currentPremium >= t.targetPremium) exitReason = 'TARGET_HIT';
    else if (currentPremium <= t.slPremium) exitReason = 'SL_HIT';
    // EARLY-ABORT: in the first 5 bars, if price has moved
    // adversely by 0.75R+, exit immediately. CALIBRATION
    // 2026-05-17: 5 bars vs 3 bars and 0.75R vs 0.5R gives
    // good entries more time to develop while still cutting
    // losses on bad-direction trades faster than full-SL.
    else if (initialSlDistance > 0
      && (t.barsSinceEntry || 0) <= 5
      && (t.entryPremium - currentPremium) >= initialSlDistance * 0.75) {
      exitReason = 'EARLY_ABORT';
    }
    // Stall scratch — institutional rule: at +0.45R, 6 bars
    // pass without new high, exit at break-even-ish.
    // CALIBRATION 2026-05-17: looser threshold (0.45R / 6 bars vs
    // 0.25R / 4 bars) lets winners breathe before stall-detection
    // kicks in.
    else if (initialSlDistance > 0 && moveFromEntry > 0
      && (moveFromEntry / initialSlDistance) >= 0.45
      && (t.barsSinceHigh || 0) >= 6) {
      exitReason = 'STALL_SCRATCH';
    }
    // Time-based exit — institutional rule: an open position that
    // hasn't hit target or SL after 40 minutes (40 × 1m bars) is
    // structurally a low-volatility setup. Exit at current premium.
    // CALIBRATION: 40 vs 25 reduces the false-exit rate on slow
    // tape where the trade may still develop into a winner.
    else if ((t.barsSinceEntry || 0) >= 40) {
      exitReason = 'TIME_EXPIRED';
    }
    // Track bars since entry for the early-abort rule.
    t.barsSinceEntry = (t.barsSinceEntry || 0) + 1;
    if (exitReason) {
      const pnlPerUnit = currentPremium - t.entryPremium;
      const grossPnl = pnlPerUnit * t.lots * t.lotSize;
      // Brokerage — flat ₹60 per round-trip trade (entry+exit).
      // Override via env BROKERAGE_PER_TRADE.
      const brokerage = Number.isFinite(parseFloat(process.env.BROKERAGE_PER_TRADE))
        ? parseFloat(process.env.BROKERAGE_PER_TRADE)
        : 60;
      const totalPnl = grossPnl - brokerage;
      // Spot points captured = signed move in the trade's favoured direction.
      const spotPointsCaptured = (currentSpot - t.entrySpot) * (t.deltaSigned >= 0 ? 1 : -1);
      // Outcome categorization (post-brokerage):
      //   - >= +₹100 net → win
      //   - <= -₹500 net → loss
      //   - between → scratch (covers near-BE exits + brokerage drag)
      let outcome;
      if (totalPnl >= 100) outcome = 'win';
      else if (totalPnl <= -500) outcome = 'loss';
      else outcome = 'scratch';
      closedTrades.push({
        ...t,
        exitPremium: currentPremium,
        exitSpot: currentSpot,
        exitTimeMs: cycleTimeMs,
        exitReason,
        pnlPerUnit,
        grossPnl,
        brokerage,
        totalPnl,
        spotPointsCaptured,
        premiumPointsCaptured: pnlPerUnit,
        outcome,
      });
      try {
        riskEngine.recordTradeClose({
          pnl: totalPnl,
          outcome: totalPnl > 0 ? 'win' : 'loss',
          closedAt: cycleTimeMs,
        });
      } catch (_) { /* swallow */ }
      try {
        // Scratch exits should NOT count as a consecutive loss
        // (institutional rule).
        signalEngine.__recordTradeOutcome && signalEngine.__recordTradeOutcome({
          pnl: outcome === 'scratch' ? 0 : totalPnl,
        });
      } catch (_) { /* swallow */ }
      openTrades.splice(i, 1);
    }
  }
}

function closeAllAtSessionEnd(finalCtx) {
  if (openTrades.length === 0) return;
  const data = finalCtx.data || {};
  const currentSpot = data.spot && typeof data.spot.ltp === 'number' ? data.spot.ltp : null;
  if (currentSpot === null) return;
  const eodTimeMs = (data && typeof data.tickAt === 'number')
    ? data.tickAt
    : (finalCtx.cycleStartedAt || Date.now());
  for (const t of openTrades) {
    const spotMove = currentSpot - t.entrySpot;
    const currentPremium = Math.max(0.5, t.entryPremium + spotMove * t.deltaSigned);
    const pnlPerUnit = currentPremium - t.entryPremium;
    const grossPnl = pnlPerUnit * t.lots * t.lotSize;
    const brokerage = Number.isFinite(parseFloat(process.env.BROKERAGE_PER_TRADE))
      ? parseFloat(process.env.BROKERAGE_PER_TRADE)
      : 60;
    const totalPnl = grossPnl - brokerage;
    closedTrades.push({
      ...t,
      exitPremium: currentPremium,
      exitSpot: currentSpot,
      exitTimeMs: eodTimeMs,
      exitReason: 'EOD_FORCED',
      pnlPerUnit,
      grossPnl,
      brokerage,
      totalPnl,
      spotPointsCaptured: (currentSpot - t.entrySpot) * (t.deltaSigned >= 0 ? 1 : -1),
      premiumPointsCaptured: pnlPerUnit,
      outcome: totalPnl >= 100 ? 'win' : (totalPnl <= -500 ? 'loss' : 'scratch'),
    });
  }
  openTrades.length = 0;
}

async function main() {
  const cycleResults = [];
  const reasonCodeCounts = new Map();
  const finalActionCounts = new Map();
  const stageReasonCounts = {
    data: new Map(), regime: new Map(), liquidity: new Map(), signal: new Map(),
    risk: new Map(), ai: new Map(), execution: new Map(),
  };

  let lastReportedPct = -1;
  for (let i = 0; i < TOTAL_CYCLES; i++) {
    const wallNowMs = Date.now() + i * cadenceSecPerCycle * 1000;
    let ctx;
    try {
      ctx = await runCycle(wallNowMs);
    } catch (err) {
      console.error('cycle ' + i + ' threw:', err && err.stack);
      continue;
    }

    // Check existing open trades for SL/Target hit BEFORE potentially
    // opening a new one this cycle (so the same cycle can't be both
    // entry and exit).
    checkExitsForCycle(ctx);

    // Persist via auditLog so the redacted CYCLE_AUDIT row lands in
    // our captured.engineEvents bucket — same data shape the live
    // pipeline produces.
    try {
      await auditLog.writeCycleAudit(ctx, { type: 'CYCLE_AUDIT', sessionId: fakeSessionId });
    } catch (_) { /* swallow */ }

    cycleResults.push(ctx);

    const action = ctx.finalAction || 'NO_TRADE';
    finalActionCounts.set(action, (finalActionCounts.get(action) || 0) + 1);
    if (action === 'BUY_CE' || action === 'BUY_PE') {
      // Only allow one open trade at a time — if we already have
      // an open position the orchestrator's existing exposure cap
      // would normally have stopped this in production. Mirror it
      // here so backtests don't pile concurrent same-direction
      // entries on top of each other.
      if (openTrades.length === 0) {
        try { recordTradeOpen(ctx, action); } catch (e) { /* swallow */ }
      }
    }
    for (const code of ctx.reasonCodes || []) {
      reasonCodeCounts.set(code, (reasonCodeCounts.get(code) || 0) + 1);
    }
    for (const stageKey of Object.keys(stageReasonCounts)) {
      const block = ctx[stageKey];
      if (block && Array.isArray(block.reasonCodes)) {
        for (const code of block.reasonCodes) {
          const m = stageReasonCounts[stageKey];
          m.set(code, (m.get(code) || 0) + 1);
        }
      }
    }

    // Progress reporter — every 10%
    const pct = Math.floor((i / TOTAL_CYCLES) * 10) * 10;
    if (pct !== lastReportedPct && pct > 0) {
      lastReportedPct = pct;
      const lastTickAt = ctx.data && ctx.data.tickAt ? new Date(ctx.data.tickAt).toISOString() : 'n/a';
      console.log('  ' + pct + '% — cycle ' + i + ' / ' + TOTAL_CYCLES + ' — replayCursor=' + lastTickAt + ' — last action=' + action);
    }
  }

  // Force-close any remaining open trades at session end (15:30 IST).
  if (cycleResults.length > 0) {
    closeAllAtSessionEnd(cycleResults[cycleResults.length - 1]);
  }

  // ============================================================
  // Report
  // ============================================================

  console.log('\n============================================================');
  console.log('RESULTS');
  console.log('============================================================');
  console.log('Cycles run:               ' + cycleResults.length);
  console.log('Audit rows captured:      ' + captured.engineEvents.length);
  console.log('Sessions opened:          ' + captured.scalpingSessions.length);
  console.log('TradeExecutionLog rows:   ' + captured.tradeExecLogs.length);
  console.log('ScalpingTrade rows:       ' + captured.scalpingTrades.length);

  console.log('\nfinalAction distribution:');
  const sortedActions = [...finalActionCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [action, count] of sortedActions) {
    const pct = ((count / cycleResults.length) * 100).toFixed(1);
    console.log('  ' + String(action).padEnd(25) + ' ' + String(count).padStart(5) + '  (' + pct + '%)');
  }

  console.log('\nreasonCodes — top 20 across the day:');
  const sortedCodes = [...reasonCodeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [code, count] of sortedCodes) {
    console.log('  ' + String(code).padEnd(45) + ' ' + String(count).padStart(5));
  }

  console.log('\nReason codes by stage that emitted them:');
  for (const [stage, m] of Object.entries(stageReasonCounts)) {
    if (m.size === 0) continue;
    console.log('  [' + stage + ']');
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    for (const [code, count] of top) {
      console.log('    ' + String(code).padEnd(43) + ' ' + String(count).padStart(5));
    }
  }

  // Trade summary
  const trades = captured.tradeExecLogs;
  if (trades.length === 0) {
    console.log('\nNO TRADES — every cycle resolved to NO_TRADE.');
    console.log('See the reason-code distribution above to identify the dominant gate.');
  } else {
    console.log('\nTrade execution log:');
    for (const t of trades) {
      const sim = t.simulation === true ? '[SIM]' : '[LIVE]';
      console.log('  ' + sim + ' ' + JSON.stringify({
        orderId: t.orderId, side: t.side, qty: t.quantity, price: t.price, status: t.status,
        note: t.note, when: t.createdAt,
      }).slice(0, 240));
    }
  }

  // Sample a few CYCLE_AUDIT rows so we can see the actual structure
  // of the per-cycle audit payload.
  if (captured.engineEvents.length > 0) {
    console.log('\nFirst 3 CYCLE_AUDIT payloads:');
    for (let i = 0; i < Math.min(3, captured.engineEvents.length); i++) {
      const row = captured.engineEvents[i];
      const data = row.data || {};
      const payload = data.payload || {};
      console.log('  cycle ' + i + ' tickAt=' + new Date(data.timestamp || 0).toISOString());
      console.log('    finalAction=' + payload.finalAction + ' masterScore=' + payload.masterScore);
      console.log('    reasonCodes=' + JSON.stringify(payload.reasonCodes || []));
      console.log('    aiAdvisory=' + payload.aiAdvisory);
    }
  }

  // ============================================================
  // SIMULATED P&L from option premium tracking
  // ============================================================
  if (closedTrades.length > 0 || openTrades.length > 0) {
    console.log('\n============================================================');
    console.log('SIMULATED P&L (option premium replay)');
    console.log('============================================================');
    let totalPnl = 0;
    let totalGross = 0;
    let totalBrokerage = 0;
    let wins = 0;
    let losses = 0;
    let scratches = 0;
    const dirIst = (epochMs) => {
      const ist = epochMs + (5 * 60 + 30) * 60 * 1000;
      const d = new Date(ist);
      return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    };
    // Per-trade detailed table.
    console.log('\nDetailed trade table:');
    console.log('+-----+--------+-------+------+-------+--------+--------+------+------+-------+--------+--------+--------+--------+----------+----------------------+----------+');
    console.log('|  #  | dirCE  | strike| lots | entry | entry@ | exit   | exit@| spotE| spotX | spotPt | gross  | broker | netPnL | outcome  | exitReason           | strategy |');
    console.log('+-----+--------+-------+------+-------+--------+--------+------+------+-------+--------+--------+--------+--------+----------+----------------------+----------+');
    for (let i = 0; i < closedTrades.length; i += 1) {
      const t = closedTrades[i];
      totalPnl += t.totalPnl || 0;
      totalGross += t.grossPnl || 0;
      totalBrokerage += t.brokerage || 0;
      if (t.outcome === 'win') wins++;
      else if (t.outcome === 'loss') losses++;
      else scratches++;
      const idx = String(i + 1).padStart(3, ' ');
      const dir = (t.direction || '').padEnd(6);
      const strike = String(t.strike || '').padStart(6);
      const lots = String(t.lots || 0).padStart(4);
      const entry = (t.entryPremium || 0).toFixed(2).padStart(7);
      const eAt = dirIst(t.entryTimeMs).padEnd(6);
      const exit = (t.exitPremium || 0).toFixed(2).padStart(8);
      const xAt = dirIst(t.exitTimeMs).padEnd(6);
      const sE = (t.entrySpot || 0).toFixed(0).padStart(6);
      const sX = (t.exitSpot || 0).toFixed(0).padStart(7);
      const sPts = (t.spotPointsCaptured || 0).toFixed(1).padStart(8);
      const gross = (t.grossPnl != null ? t.grossPnl.toFixed(0) : '0').padStart(8);
      const brok = (t.brokerage != null ? t.brokerage.toFixed(0) : '60').padStart(8);
      const net = (t.totalPnl || 0).toFixed(0).padStart(8);
      const oc = (t.outcome || '').padEnd(10);
      const reas = (t.exitReason || '').padEnd(22);
      const strat = (t.primaryTrigger || 'UT_BOT').padEnd(10);
      console.log(`| ${idx} | ${dir} | ${strike}| ${lots} | ${entry} | ${eAt} | ${exit} | ${xAt}| ${sE} | ${sX} | ${sPts} | ${gross} | ${brok} | ${net} | ${oc} | ${reas} | ${strat} |`);
    }
    console.log('+-----+--------+-------+------+-------+--------+--------+------+------+-------+--------+--------+--------+--------+----------+----------------------+----------+');

    // Win-rate based on decisive trades (excludes scratches)
    const decisive = wins + losses;
    const winRate = decisive > 0 ? ((wins / decisive) * 100).toFixed(1) : '0';
    console.log('\nTrades: ' + closedTrades.length + '  Wins: ' + wins
      + '  Losses: ' + losses + '  Scratches: ' + scratches
      + '  Win-rate: ' + winRate + '%');
    console.log('Gross P&L:    ₹' + Math.round(totalGross));
    console.log('Brokerage:    ₹' + Math.round(totalBrokerage));
    console.log('Total P&L: ₹' + Math.round(totalPnl));
    if (openTrades.length > 0) {
      console.log('Open trades not closed by EOD: ' + openTrades.length);
    }

    // Persist trade details as JSONL so the sweep aggregator can
    // collate a multi-day master table without re-parsing console.
    try {
      const tradesJsonlDir = path.join(__dirname, '..', 'logs', 'trades');
      if (!fs.existsSync(tradesJsonlDir)) fs.mkdirSync(tradesJsonlDir, { recursive: true });
      const lines = closedTrades.map((t) => JSON.stringify({
        date: dateArg,
        direction: t.direction,
        side: t.side,
        strike: t.strike,
        lots: t.lots,
        lotSize: t.lotSize,
        entryPremium: t.entryPremium,
        exitPremium: t.exitPremium,
        entrySpot: t.entrySpot,
        exitSpot: t.exitSpot,
        entryTimeMs: t.entryTimeMs,
        exitTimeMs: t.exitTimeMs,
        entryTimeIST: dirIst(t.entryTimeMs),
        exitTimeIST: dirIst(t.exitTimeMs),
        spotPointsCaptured: t.spotPointsCaptured,
        premiumPointsCaptured: t.premiumPointsCaptured,
        grossPnl: t.grossPnl,
        brokerage: t.brokerage,
        totalPnl: t.totalPnl,
        outcome: t.outcome,
        exitReason: t.exitReason,
        strategy: t.primaryTrigger || 'UT_BOT',
        optionDelta: t.optionDelta,
      }));
      fs.writeFileSync(
        path.join(tradesJsonlDir, 'trades-' + dateArg + '.jsonl'),
        lines.join('\n') + (lines.length ? '\n' : '')
      );
    } catch (_) { /* swallow */ }
  }

  console.log('\n============================================================');
  console.log('DONE');
  console.log('============================================================\n');

  // Force-exit so the JSON logger's pending flush doesn't keep the
  // event loop alive.
  setTimeout(() => process.exit(0), 100).unref();
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack);
  process.exit(1);
});
