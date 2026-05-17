#!/usr/bin/env node
'use strict';

/**
 * Per-cycle regime diagnostic.
 *
 * Runs ONE day through the same pipeline as run_backtest.js but
 * captures a per-cycle row with:
 *   - simulated minute (HH:MM IST)
 *   - regime label + confidence
 *   - all confidence inputs (atrPct, adx, vwapDist, vp, vix, oiConc, breadth, liq)
 *   - what would-be label is being downgraded to
 *
 * Then writes both a CSV and a markdown summary that buckets:
 *   - Pre-lunch (09:15-12:00)
 *   - Lunch     (12:00-13:00)
 *   - Post-lunch (13:00-15:30)
 *
 * Usage:
 *   node scripts/diagnose_regime.js 2026-05-07
 */

const path = require('path');
const fs = require('fs');

// ---------- model stubs (same as run_backtest.js) ----------
const captured = {
  engineEvents: [], scalpingSessions: [], tradeExecLogs: [],
  scalpingTrades: [], tradeAccountResults: [], tradePLRecords: [],
};
function makeFakeMongoModel(name, captureBucket) {
  let nextId = 1;
  function fakeDoc(props) {
    const _id = 'fake-' + name + '-' + (nextId++);
    const doc = { _id, ...props, save: async function () { return this; }, markModified: function () {} };
    captureBucket.push(doc);
    return doc;
  }
  return {
    create: async (props) => fakeDoc(props),
    findById: async (id) => captureBucket.find((d) => String(d._id) === String(id)) || null,
    findOne: async () => null,
    find: function () {
      const q = { sort: () => q, limit: () => q, lean: () => Promise.resolve([]),
        then: (r, j) => Promise.resolve([]).then(r, j), catch: (j) => Promise.resolve([]).catch(j) };
      return q;
    },
    countDocuments: async () => captureBucket.length,
    deleteMany: async () => ({ deletedCount: 0 }),
  };
}
require.cache[require.resolve('../src/models/EngineEventLog')] = { exports: makeFakeMongoModel('e', captured.engineEvents) };
require.cache[require.resolve('../src/models/ScalpingSession')] = { exports: makeFakeMongoModel('s', captured.scalpingSessions) };
require.cache[require.resolve('../src/models/ScalpingTrade')] = { exports: makeFakeMongoModel('st', captured.scalpingTrades) };
require.cache[require.resolve('../src/models/TradeExecutionLog')] = { exports: makeFakeMongoModel('t', captured.tradeExecLogs) };
require.cache[require.resolve('../src/models/TradeAccountResult')] = { exports: makeFakeMongoModel('a', captured.tradeAccountResults) };
require.cache[require.resolve('../src/models/TradePLRecord')] = { exports: makeFakeMongoModel('p', captured.tradePLRecords) };

// ---------- pipeline imports ----------
const algoSettings = require('../src/config/algoSettings');
const dataEngine = require('../src/services/hybridEngine/dataEngine.adapter');
const regimeEngine = require('../src/services/hybridEngine/regimeEngine.adapter');

const dateArg = process.argv[2] || '2026-05-07';
const REPLAY_FOLDER = path.join(__dirname, '..', 'live-feed', dateArg + '_NIFTY_50');
if (!fs.existsSync(REPLAY_FOLDER)) {
  console.error('replay folder not found: ' + REPLAY_FOLDER);
  process.exit(1);
}

// 09:15 IST = 03:45 UTC. We'll iterate one cycle per minute = 375 cycles.
const [Y, M, D] = dateArg.split('-').map(Number);
const SESSION_START_UTC = Date.UTC(Y, M - 1, D, 3, 45, 0);

dataEngine.resetReplayClock();

function istHHMM(epochMs) {
  const istMs = epochMs + (5 * 60 + 30) * 60 * 1000;
  const d = new Date(istMs);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function bucket(hhmm) {
  // 09:15 - 11:59 = pre-lunch
  // 12:00 - 12:59 = lunch
  // 13:00 - 15:30 = post-lunch
  const [h, m] = hhmm.split(':').map(Number);
  const minutes = h * 60 + m;
  if (minutes < 12 * 60) return 'pre-lunch';
  if (minutes < 13 * 60) return 'lunch';
  return 'post-lunch';
}

async function main() {
  const settings = algoSettings.snapshot();
  const rows = [];

  // We need to drive Data_Engine in a loop and call regimeEngine.classifyRegime
  // on the resulting ctx. Use the same minimal ctx-shape that the real
  // pipeline uses. dataEngine.fetchDataSnapshot returns a DataSnapshot that
  // we attach as ctx.data.
  const TOTAL_CYCLES = 375;
  for (let i = 0; i < TOTAL_CYCLES; i++) {
    const wallNowMs = Date.now() + i * 60 * 1000;
    const data = await dataEngine.fetchDataSnapshot({ settings, now: wallNowMs, replayFolder: REPLAY_FOLDER });
    const ctx = { data, cycleStartedAt: wallNowMs, reasonCodes: [] };
    const regime = regimeEngine.classifyRegime({ ctx, settings });

    const sessionMs = SESSION_START_UTC + i * 60 * 1000;
    const hhmm = istHHMM(sessionMs);
    const buck = bucket(hhmm);

    const inputs = regime.inputs || {};
    rows.push({
      i,
      hhmm,
      bucket: buck,
      label: regime.label,
      confidence: regime.confidence,
      LONG: regime.tradePermissions.LONG_SETUP,
      SHORT: regime.tradePermissions.SHORT_SETUP,
      reasonCodes: (regime.reasonCodes || []).join('|'),
      atrPct: inputs.atr ? inputs.atr.atrPct : null,
      adx: inputs.adx ? inputs.adx.value : null,
      adxStrength: inputs.adx ? inputs.adx.strength : null,
      vwapDistPct: typeof inputs.vwapDistance === 'number' ? Number(inputs.vwapDistance.toFixed(3)) : null,
      vp_poc: inputs.volumeProfile ? inputs.volumeProfile.poc : null,
      vp_val: inputs.volumeProfile ? inputs.volumeProfile.val : null,
      vp_vah: inputs.volumeProfile ? inputs.volumeProfile.vah : null,
      vix: inputs.vix,
      oiConc: typeof inputs.oiConcentration === 'number' ? Number(inputs.oiConcentration.toFixed(3)) : null,
      futPrem: typeof inputs.futuresPremium === 'number' ? Number(inputs.futuresPremium.toFixed(2)) : null,
      breadthScore: inputs.breadth ? inputs.breadth.score : null,
      liq: inputs.liquidityScore,
      ltp: data && data.spot ? data.spot.ltp : null,
      vwapSession: data && data.vwap ? data.vwap.session : null,
    });
  }

  // ---- summary by bucket ----
  const buckets = ['pre-lunch', 'lunch', 'post-lunch'];
  const buckStats = {};
  for (const b of buckets) {
    const r = rows.filter((x) => x.bucket === b);
    const labels = {};
    let confSum = 0, confCnt = 0, confMax = 0, confMin = 99;
    let atrSum = 0, atrCnt = 0;
    let adxSum = 0, adxCnt = 0;
    let lowConfHits = 0, rangingHits = 0, highRiskHits = 0;
    let longCnt = 0, shortCnt = 0;
    for (const x of r) {
      labels[x.label] = (labels[x.label] || 0) + 1;
      if (typeof x.confidence === 'number') {
        confSum += x.confidence; confCnt++;
        if (x.confidence > confMax) confMax = x.confidence;
        if (x.confidence < confMin) confMin = x.confidence;
      }
      if (typeof x.atrPct === 'number') { atrSum += x.atrPct; atrCnt++; }
      if (typeof x.adx === 'number') { adxSum += x.adx; adxCnt++; }
      if (x.reasonCodes.includes('REGIME_LOW_CONFIDENCE')) lowConfHits++;
      if (x.reasonCodes.includes('REGIME_BLOCK_RANGING')) rangingHits++;
      if (x.reasonCodes.includes('REGIME_BLOCK_HIGH_RISK')) highRiskHits++;
      if (x.LONG) longCnt++;
      if (x.SHORT) shortCnt++;
    }
    buckStats[b] = {
      cycles: r.length,
      labels,
      avgConf: confCnt ? (confSum / confCnt).toFixed(2) : 'n/a',
      minConf: confMin === 99 ? 'n/a' : confMin,
      maxConf: confMax,
      avgAtrPct: atrCnt ? (atrSum / atrCnt).toFixed(4) : 'n/a',
      avgAdx: adxCnt ? (adxSum / adxCnt).toFixed(1) : 'n/a',
      lowConfBlocks: lowConfHits,
      rangingBlocks: rangingHits,
      highRiskBlocks: highRiskHits,
      longPermitted: longCnt,
      shortPermitted: shortCnt,
    };
  }

  // ---- write CSV + markdown ----
  const outDir = path.join(__dirname, '..', 'logs');
  const csvPath = path.join(outDir, 'regime-diagnostic-' + dateArg + '.csv');
  const cols = ['i', 'hhmm', 'bucket', 'label', 'confidence', 'LONG', 'SHORT',
    'reasonCodes', 'atrPct', 'adx', 'adxStrength', 'vwapDistPct',
    'vp_poc', 'vp_val', 'vp_vah', 'vix', 'oiConc', 'futPrem', 'breadthScore', 'liq', 'ltp', 'vwapSession'];
  const csvLines = [cols.join(',')];
  for (const r of rows) {
    csvLines.push(cols.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return String(v);
    }).join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  console.log('=== REGIME DIAGNOSTIC ' + dateArg + ' ===\n');
  console.log('Cycles: ' + rows.length);
  console.log('CSV written to: ' + csvPath + '\n');

  console.log('Per-bucket summary:\n');
  for (const b of buckets) {
    const s = buckStats[b];
    console.log(b.toUpperCase() + '  (' + s.cycles + ' cycles)');
    console.log('  labels:               ' + JSON.stringify(s.labels));
    console.log('  conf avg/min/max:     ' + s.avgConf + ' / ' + s.minConf + ' / ' + s.maxConf);
    console.log('  avg atrPct / adx:     ' + s.avgAtrPct + ' / ' + s.avgAdx);
    console.log('  low-conf blocks:      ' + s.lowConfBlocks);
    console.log('  ranging blocks:       ' + s.rangingBlocks);
    console.log('  high-risk blocks:     ' + s.highRiskBlocks);
    console.log('  cycles where LONG/SHORT permitted: ' + s.longPermitted + ' / ' + s.shortPermitted);
    console.log('');
  }

  // ---- find any cycles where confidence >= minRegimeConfidence AND a side is permitted ----
  const minConf = settings.regimeEngine && typeof settings.regimeEngine.minRegimeConfidence === 'number'
    ? settings.regimeEngine.minRegimeConfidence : 6;
  console.log('Cycles where regime would PASS the gate (conf >= ' + minConf + ' AND LONG or SHORT permitted):');
  let passed = 0;
  for (const r of rows) {
    if (typeof r.confidence === 'number' && r.confidence >= minConf && (r.LONG || r.SHORT)) {
      passed++;
      if (passed <= 30) {
        console.log('  ' + r.hhmm + ' (' + r.bucket + ')  ' + r.label + ' conf=' + r.confidence
          + ' LONG=' + r.LONG + ' SHORT=' + r.SHORT
          + '  atr%=' + r.atrPct + ' adx=' + r.adx + ' vwapΔ%=' + r.vwapDistPct);
      }
    }
  }
  console.log('Total passed: ' + passed + ' / ' + rows.length);

  // ---- highest-confidence cycles in pre-lunch and post-lunch ----
  console.log('\nTop 10 confidence cycles in PRE-LUNCH:');
  const pre = rows.filter((r) => r.bucket === 'pre-lunch')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 10);
  for (const r of pre) {
    console.log('  ' + r.hhmm + '  ' + r.label + ' conf=' + r.confidence
      + '  atr%=' + r.atrPct + ' adx=' + r.adx + ' vwapΔ%=' + r.vwapDistPct
      + ' breadth=' + r.breadthScore + ' vix=' + r.vix);
  }
  console.log('\nTop 10 confidence cycles in LUNCH:');
  const lunch = rows.filter((r) => r.bucket === 'lunch')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 10);
  for (const r of lunch) {
    console.log('  ' + r.hhmm + '  ' + r.label + ' conf=' + r.confidence
      + '  atr%=' + r.atrPct + ' adx=' + r.adx + ' vwapΔ%=' + r.vwapDistPct
      + ' breadth=' + r.breadthScore + ' vix=' + r.vix);
  }
  console.log('\nTop 10 confidence cycles in POST-LUNCH:');
  const post = rows.filter((r) => r.bucket === 'post-lunch')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 10);
  for (const r of post) {
    console.log('  ' + r.hhmm + '  ' + r.label + ' conf=' + r.confidence
      + '  atr%=' + r.atrPct + ' adx=' + r.adx + ' vwapΔ%=' + r.vwapDistPct
      + ' breadth=' + r.breadthScore + ' vix=' + r.vix);
  }

  setTimeout(() => process.exit(0), 100).unref();
}

main().catch((err) => { console.error('FATAL:', err && err.stack); process.exit(1); });
