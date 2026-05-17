#!/usr/bin/env node
'use strict';

/**
 * Per-cycle Signal_Engine diagnostic for one day.
 * Captures the full 24-key mandatoryResults map and shows:
 *   - which mandatories ARE passing across the day
 *   - which are failing most
 *   - Pre/Lunch/Post bucket breakdown
 *   - top 20 cycles closest to firing (fewest fails)
 *
 * Usage: node scripts/diagnose_signal.js 2026-05-07
 */

const path = require('path');
const fs = require('fs');

// ---------- model stubs ----------
const captured = { engineEvents: [], scalpingSessions: [], tradeExecLogs: [], scalpingTrades: [], tradeAccountResults: [], tradePLRecords: [] };
function makeFakeMongoModel(name, b) {
  let n = 1;
  return {
    create: async (props) => { const _id='fk-'+name+(n++); const d={_id,...props,save:async()=>d,markModified:()=>{}}; b.push(d); return d; },
    findById: async (id) => b.find((d) => String(d._id) === String(id)) || null,
    findOne: async () => null,
    find: function () { const q={sort:()=>q,limit:()=>q,lean:()=>Promise.resolve([]),then:(r,j)=>Promise.resolve([]).then(r,j),catch:(j)=>Promise.resolve([]).catch(j)}; return q; },
    countDocuments: async () => b.length,
    deleteMany: async () => ({ deletedCount: 0 }),
  };
}
require.cache[require.resolve('../src/models/EngineEventLog')] = { exports: makeFakeMongoModel('e', captured.engineEvents) };
require.cache[require.resolve('../src/models/ScalpingSession')] = { exports: makeFakeMongoModel('s', captured.scalpingSessions) };
require.cache[require.resolve('../src/models/ScalpingTrade')] = { exports: makeFakeMongoModel('st', captured.scalpingTrades) };
require.cache[require.resolve('../src/models/TradeExecutionLog')] = { exports: makeFakeMongoModel('t', captured.tradeExecLogs) };
require.cache[require.resolve('../src/models/TradeAccountResult')] = { exports: makeFakeMongoModel('a', captured.tradeAccountResults) };
require.cache[require.resolve('../src/models/TradePLRecord')] = { exports: makeFakeMongoModel('p', captured.tradePLRecords) };

const cycleContext = require('../src/services/hybridEngine/cycleContext');
const algoSettings = require('../src/config/algoSettings');
const dataEngine = require('../src/services/hybridEngine/dataEngine.adapter');
const regimeEngine = require('../src/services/hybridEngine/regimeEngine.adapter');
const structureEngine = require('../src/services/hybridEngine/structureEngine.adapter');
const liquidityEngine = require('../src/services/hybridEngine/liquidityEngine.adapter');
const oiEngine = require('../src/services/hybridEngine/oiEngine.adapter');
const pcrEngine = require('../src/services/hybridEngine/pcrEngine.adapter');
const signalEngine = require('../src/services/hybridEngine/signalEngine.evaluator');

const dateArg = process.argv[2] || '2026-05-07';
const REPLAY_FOLDER = path.join(__dirname, '..', 'live-feed', dateArg + '_NIFTY_50');
const [Y, M, D] = dateArg.split('-').map(Number);
const SESSION_START_UTC = Date.UTC(Y, M - 1, D, 3, 45, 0);

dataEngine.resetReplayClock();

function istHHMM(epochMs) {
  const ist = epochMs + (5 * 60 + 30) * 60 * 1000;
  const d = new Date(ist);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function bucket(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const mins = h * 60 + m;
  if (mins < 12 * 60) return 'pre';
  if (mins < 13 * 60) return 'lunch';
  return 'post';
}

async function main() {
  const settings = algoSettings.snapshot();
  const settingsHash = algoSettings.settingsHash(settings);
  const TOTAL_CYCLES = 375;
  const rows = [];
  for (let i = 0; i < TOTAL_CYCLES; i++) {
    const wallNowMs = Date.now() + i * 60 * 1000;
    let ctx = cycleContext.buildCycleContext({ settings, settingsHash });
    const data = await dataEngine.fetchDataSnapshot({ settings, now: wallNowMs, replayFolder: REPLAY_FOLDER });
    ctx = cycleContext.appendBlock(ctx, 'data', data);
    const regime = regimeEngine.classifyRegime({ ctx, settings });
    ctx = cycleContext.appendBlock(ctx, 'regime', regime);
    const structure = structureEngine.analyzeStructure({ ctx, settings });
    ctx = cycleContext.appendBlock(ctx, 'structure', structure || {});
    const liquidity = liquidityEngine.analyzeLiquidity({ ctx, settings });
    ctx = cycleContext.appendBlock(ctx, 'liquidity', liquidity || {});
    const oi = oiEngine.classifyOI({ ctx, settings });
    ctx = cycleContext.appendBlock(ctx, 'oi', oi || {});
    const pcr = pcrEngine.computePCR({ ctx, settings });
    ctx = cycleContext.appendBlock(ctx, 'pcr', pcr || {});
    const signal = signalEngine.evaluateSignal({ ctx, settings });

    const sessionMs = SESSION_START_UTC + i * 60 * 1000;
    const hhmm = istHHMM(sessionMs);
    rows.push({
      i, hhmm, bucket: bucket(hhmm),
      candidate: signal.candidate,
      mandatoryResults: signal.mandatoryResults || {},
      oiConfirmations: signal.oiConfirmations || [],
      regimeLabel: regime.label,
      regimeConf: regime.confidence,
      regimePerm: regime.tradePermissions,
      reasonCodes: signal.reasonCodes || [],
    });
  }

  // ---- aggregate ----
  const longIds = ['LONG_VWAP','LONG_EMA','LONG_ATR','LONG_PE_SHORT_BUILDUP','LONG_FUTURES_BIAS',
    'LONG_CUMULATIVE_DELTA','LONG_VOLUME_BREAKOUT','LONG_BREADTH','LONG_LIQUIDITY','LONG_PRICE_VS_POC','LONG_REGIME','LONG_RR'];
  const shortIds = ['SHORT_VWAP','SHORT_EMA','SHORT_ATR','SHORT_CE_SHORT_BUILDUP','SHORT_FUTURES_BIAS',
    'SHORT_CUMULATIVE_DELTA','SHORT_VOLUME_BREAKDOWN','SHORT_BREADTH','SHORT_LIQUIDITY','SHORT_PRICE_VS_POC','SHORT_REGIME','SHORT_RR'];

  const passCount = {};
  for (const id of [...longIds, ...shortIds]) passCount[id] = 0;

  // count cycles where regime PERMITS a side AND track each mandatory
  let regimePermissiveLong = 0, regimePermissiveShort = 0;
  for (const r of rows) {
    const mr = r.mandatoryResults;
    if (r.regimePerm && r.regimePerm.LONG_SETUP) regimePermissiveLong++;
    if (r.regimePerm && r.regimePerm.SHORT_SETUP) regimePermissiveShort++;
    for (const id of longIds) if (mr[id] === true) passCount[id]++;
    for (const id of shortIds) if (mr[id] === true) passCount[id]++;
  }

  console.log('=== SIGNAL DIAGNOSTIC ' + dateArg + ' ===');
  console.log('Total cycles: ' + rows.length);
  console.log('Regime-permitted LONG cycles:  ' + regimePermissiveLong);
  console.log('Regime-permitted SHORT cycles: ' + regimePermissiveShort);
  console.log();
  console.log('LONG mandatory pass-counts (out of ' + rows.length + '):');
  for (const id of longIds) {
    const c = passCount[id];
    const pct = ((c / rows.length) * 100).toFixed(1);
    console.log('  ' + id.padEnd(28) + String(c).padStart(4) + '  (' + pct + '%)');
  }
  console.log('\nSHORT mandatory pass-counts:');
  for (const id of shortIds) {
    const c = passCount[id];
    const pct = ((c / rows.length) * 100).toFixed(1);
    console.log('  ' + id.padEnd(28) + String(c).padStart(4) + '  (' + pct + '%)');
  }

  // ---- find cycles closest to firing (fewest LONG fails) ----
  const closest = rows.map((r) => {
    const longFails = longIds.filter((id) => r.mandatoryResults[id] !== true);
    const shortFails = shortIds.filter((id) => r.mandatoryResults[id] !== true);
    return { ...r, longFails, shortFails, longFailCount: longFails.length, shortFailCount: shortFails.length };
  }).sort((a, b) => Math.min(a.longFailCount, a.shortFailCount) - Math.min(b.longFailCount, b.shortFailCount));

  console.log('\nTop 20 closest-to-firing cycles:');
  for (const r of closest.slice(0, 20)) {
    const minFails = Math.min(r.longFailCount, r.shortFailCount);
    const side = r.longFailCount <= r.shortFailCount ? 'LONG' : 'SHORT';
    const failsList = side === 'LONG' ? r.longFails : r.shortFails;
    const oiOk = side === 'LONG'
      ? r.oiConfirmations.some(c => c.startsWith('LONG_OI'))
      : r.oiConfirmations.some(c => c.startsWith('SHORT_OI'));
    console.log('  ' + r.hhmm + ' (' + r.bucket + ') ' + side
      + ' regime=' + r.regimeLabel + ' conf=' + r.regimeConf
      + ' fails=' + minFails + ' oi=' + (oiOk?'YES':'no')
      + ' [' + failsList.map(s => s.replace(/^(LONG|SHORT)_/, '')).join(',') + ']');
  }

  // ---- bucket: what mandatories pass in lunch vs other ----
  const buckStats = { pre: {}, lunch: {}, post: {} };
  for (const b of ['pre','lunch','post']) {
    buckStats[b] = { count: 0 };
    for (const id of [...longIds, ...shortIds]) buckStats[b][id] = 0;
  }
  for (const r of rows) {
    buckStats[r.bucket].count++;
    for (const id of [...longIds, ...shortIds]) {
      if (r.mandatoryResults[id] === true) buckStats[r.bucket][id]++;
    }
  }
  console.log('\nLONG_VOLUME_BREAKOUT pass distribution by bucket:');
  for (const b of ['pre','lunch','post']) {
    const s = buckStats[b];
    console.log('  ' + b.padEnd(8) + 'pass=' + s.LONG_VOLUME_BREAKOUT + '/' + s.count
      + '  ATR=' + s.LONG_ATR + '/' + s.count
      + '  EMA=' + s.LONG_EMA + '/' + s.count
      + '  REGIME=' + s.LONG_REGIME + '/' + s.count
      + '  RR=' + s.LONG_RR + '/' + s.count);
  }
  console.log('\nSHORT_VOLUME_BREAKDOWN pass distribution by bucket:');
  for (const b of ['pre','lunch','post']) {
    const s = buckStats[b];
    console.log('  ' + b.padEnd(8) + 'pass=' + s.SHORT_VOLUME_BREAKDOWN + '/' + s.count
      + '  ATR=' + s.SHORT_ATR + '/' + s.count
      + '  EMA=' + s.SHORT_EMA + '/' + s.count
      + '  REGIME=' + s.SHORT_REGIME + '/' + s.count
      + '  RR=' + s.SHORT_RR + '/' + s.count);
  }

  // ---- volume / ATR sample at the lunch near-miss ----
  console.log('\nVolume / ATR samples around 12:30-12:50:');
  const data5m = (rows[0]||{}).mandatoryResults; // dummy access
  // Just print 5m candle volumes around lunch cycle
  setTimeout(() => process.exit(0), 100).unref();
}

main().catch(e => { console.error(e.stack); process.exit(1); });
