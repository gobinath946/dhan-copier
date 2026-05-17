/**
 * Re-fill missing futures candles for days that already have spot
 * data. Walks the live-feed/ folder, identifies days with empty
 * futures-1m.jsonl, and re-fetches just the futures candles.
 *
 * Usage: node scripts/refill-futures.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dhanProd = require('../src/services/dhanProd.service');
const logger = require('../src/utils/logger');

const ROOT = path.resolve(__dirname, '..', 'live-feed');

function toISTSec(dateStr, hhmmss) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m, s] = hhmmss.split(':').map(Number);
  const utcMs = Date.UTC(Y, M - 1, D, h - 5, m - 30, s);
  return Math.floor(utcMs / 1000);
}

async function fetchAndWriteFutures(date, folderPath) {
  const futuresSvc = require('../src/services/niftyFuturesProd.service');
  const contract = await futuresSvc.getNearContract();
  if (!contract?.securityId) {
    return { ok: false, reason: 'no_contract' };
  }
  const startTs = toISTSec(date, '09:14:00');
  const endTs = toISTSec(date, '15:30:00');
  const intervals = [
    { iv: '1', file: 'futures-1m.jsonl' },
    { iv: '5', file: 'futures-5m.jsonl' },
    { iv: '15', file: 'futures-15m.jsonl' },
  ];
  const results = {};
  for (const { iv, file } of intervals) {
    const res = await dhanProd.getDhanProdData(null, {
      securityId: contract.securityId,
      exchange: 'NSE',
      segment: 'D',
      instrument: 'FUTIDX',
      startTime: startTs,
      endTime: endTs,
      interval: iv,
    });
    if (!res.ok) {
      results[iv] = 0;
      continue;
    }
    const lines = (res.data.candles || []).map((c) =>
      JSON.stringify({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume || 0 })
    );
    fs.writeFileSync(path.join(folderPath, file), lines.join('\n') + (lines.length ? '\n' : ''));
    results[iv] = lines.length;
    // Throttle between intervals.
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: true, counts: results };
}

async function main() {
  const folders = fs.readdirSync(ROOT).filter((n) => n.endsWith('_NIFTY_50')).sort();
  const targets = [];
  for (const folder of folders) {
    const folderPath = path.join(ROOT, folder);
    const date = folder.split('_')[0];
    const spotFile = path.join(folderPath, 'candles-1m.jsonl');
    const futFile = path.join(folderPath, 'futures-1m.jsonl');
    const hasSpot = fs.existsSync(spotFile) && fs.statSync(spotFile).size > 0;
    const hasFut = fs.existsSync(futFile) && fs.statSync(futFile).size > 0;
    if (hasSpot && !hasFut) targets.push({ date, folderPath });
  }
  console.log(`[refill] ${targets.length} days missing futures`);
  for (const t of targets) console.log('  ' + t.date);

  for (let i = 0; i < targets.length; i += 1) {
    const { date, folderPath } = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${date} ... `);
    try {
      const r = await fetchAndWriteFutures(date, folderPath);
      if (r.ok) {
        console.log(`OK 1m=${r.counts['1']} 5m=${r.counts['5']} 15m=${r.counts['15']}`);
      } else {
        console.log(`SKIP (${r.reason})`);
      }
    } catch (e) {
      console.log(`ERR ${e.message}`);
    }
    // 2s throttle between days.
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e.stack);
  process.exit(1);
});
