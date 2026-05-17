'use strict';
const path = require('path');

for (const m of ['EngineEventLog', 'ScalpingSession', 'ScalpingTrade', 'TradeExecutionLog', 'TradeAccountResult', 'TradePLRecord']) {
  require.cache[require.resolve('../src/models/' + m)] = {
    exports: {
      create: async () => ({ _id: 'fk', save: async () => {}, markModified: () => {} }),
      findById: async () => null, findOne: async () => null,
      find: function () { const q = { sort: () => q, limit: () => q, lean: () => Promise.resolve([]), then: (r, j) => Promise.resolve([]).then(r, j), catch: (j) => Promise.resolve([]).catch(j) }; return q; },
      countDocuments: async () => 0, deleteMany: async () => ({ deletedCount: 0 }),
    },
  };
}

const algoSettings = require('../src/config/algoSettings');
const dataEngine = require('../src/services/hybridEngine/dataEngine.adapter');
const regimeEngine = require('../src/services/hybridEngine/regimeEngine.adapter');
const structureEngine = require('../src/services/hybridEngine/structureEngine.adapter');
const liquidityEngine = require('../src/services/hybridEngine/liquidityEngine.adapter');
const oiEngine = require('../src/services/hybridEngine/oiEngine.adapter');
const pcrEngine = require('../src/services/hybridEngine/pcrEngine.adapter');
const signalEngine = require('../src/services/hybridEngine/signalEngine.evaluator');
const cycleContext = require('../src/services/hybridEngine/cycleContext');

const date = process.argv[2] || '2026-05-11';
const cycles = (process.argv[3] || '0,15,30,40,60,90,120').split(',').map(Number);

signalEngine.__resetUtBotCacheForTest();
dataEngine.resetReplayClock();

(async () => {
  const settings = algoSettings.snapshot();
  const folder = path.join(__dirname, '..', 'live-feed', date + '_NIFTY_50');
  for (const i of cycles) {
    const wallNow = Date.now() + i * 60 * 1000;
    let ctx = cycleContext.buildCycleContext({ settings, settingsHash: 'h' });
    const data = await dataEngine.fetchDataSnapshot({ settings, now: wallNow, replayFolder: folder });
    ctx = cycleContext.appendBlock(ctx, 'data', data);
    ctx = cycleContext.appendBlock(ctx, 'regime', regimeEngine.classifyRegime({ ctx, settings }));
    ctx = cycleContext.appendBlock(ctx, 'structure', structureEngine.analyzeStructure({ ctx, settings }) || {});
    ctx = cycleContext.appendBlock(ctx, 'liquidity', liquidityEngine.analyzeLiquidity({ ctx, settings }) || {});
    ctx = cycleContext.appendBlock(ctx, 'oi', oiEngine.classifyOI({ ctx, settings }) || {});
    ctx = cycleContext.appendBlock(ctx, 'pcr', pcrEngine.computePCR({ ctx, settings }) || {});
    const sig = signalEngine.evaluateSignal({ ctx, settings });
    const ist = data.tickAt + (5 * 60 + 30) * 60 * 1000;
    const dist = new Date(ist);
    const istStr = String(dist.getUTCHours()).padStart(2, '0') + ':' + String(dist.getUTCMinutes()).padStart(2, '0');
    const reasons = (sig.reasonCodes || []).slice(0, 3).join(',');
    const mr = sig.mandatoryResults || {};
    console.log(`c${i} IST=${istStr} cand=${sig.candidate} reasons=${reasons} | bias=${mr.DAY_BIAS_LONG} insideOR=${mr.INSIDE_OR_KILL} regime=${mr[`LONG_REGIME`] !== undefined ? mr[`LONG_REGIME`] : mr[`SHORT_REGIME`]} confluence=${mr[`LONG_CONFLUENCE_COUNT`] !== undefined ? mr[`LONG_CONFLUENCE_COUNT`] : mr[`SHORT_CONFLUENCE_COUNT`]}`);
  }
  process.exit(0);
})();
