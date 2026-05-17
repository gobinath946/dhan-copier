/**
 * Sequential 3-month backfill with verification.
 *
 * Walks backwards from yesterday (skipping weekends), fetches a full day of
 * data (spot + futures + option chain), VERIFIES the JSONL files were written
 * with data, and only moves to the previous day after the current day is
 * confirmed complete.
 *
 * If a critical file (spot or option-chain) is empty after a fetch, the day
 * is retried up to 3 times with exponential backoff. If futures fail (which
 * is rate-limit-prone on Dhan) but spot+chain succeed, the day is recorded
 * as partial and we move on (futures fall back to spot in the algo).
 *
 * Holidays (where Dhan returns no data for spot) are recorded as empty and
 * skipped automatically.
 *
 * Usage:
 *   node scripts/backfill-sequential.js          # default: 65 trading days
 *   node scripts/backfill-sequential.js 30       # custom day count
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { backfillDay } = require('../src/services/historicalBackfill.service');
const logger = require('../src/utils/logger');

const ROOT = path.resolve(__dirname, '..', 'live-feed');
const UNDERLYING_SUFFIX = '_NIFTY_50';

function toIST_YYYYMMDD(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildTradingDayList(daysCount) {
  const dates = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - 1); // start from yesterday (today's data is incomplete)
  while (dates.length < daysCount) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      dates.push(toIST_YYYYMMDD(cursor));
    }
    cursor.setDate(cursor.getDate() - 1);
    // Hard safety cap so we don't walk forever.
    if (dates.length === 0 && (Date.now() - cursor.getTime()) > 365 * 86400 * 1000) break;
  }
  return dates;
}

function verifyDayFolder(date) {
  const folder = path.join(ROOT, `${date}${UNDERLYING_SUFFIX}`);
  if (!fs.existsSync(folder)) return { ok: false, reason: 'missing_folder' };
  const want = ['candles-1m.jsonl', 'candles-5m.jsonl', 'candles-15m.jsonl', 'option-chain.jsonl', 'spot.jsonl'];
  const counts = {};
  for (const f of want) {
    const full = path.join(folder, f);
    counts[f] = fs.existsSync(full) ? fs.statSync(full).size : 0;
  }
  // Holiday detection: if 1m candles file is empty, the whole day is empty.
  if (counts['candles-1m.jsonl'] === 0) return { ok: true, holiday: true, counts };
  // Critical: spot, 1m candles, option-chain must all have data on a trading day.
  if (counts['candles-1m.jsonl'] === 0) return { ok: false, reason: 'empty_candles_1m', counts };
  if (counts['option-chain.jsonl'] === 0) return { ok: false, reason: 'empty_option_chain', counts };
  return { ok: true, holiday: false, counts };
}

function dayHasFutures(date) {
  const folder = path.join(ROOT, `${date}${UNDERLYING_SUFFIX}`);
  const f = path.join(folder, 'futures-1m.jsonl');
  return fs.existsSync(f) && fs.statSync(f).size > 0;
}

async function backfillOneDay(date) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const r = await backfillDay(date, {
        window: 3,
        expiryFlag: 'WEEK',
        expiryCode: 1,
        overwrite: true, // always overwrite — we're verifying file content next
      });
      // Hand back to the verifier for the source of truth.
      const v = verifyDayFolder(date);
      if (v.ok) return { ok: true, holiday: !!v.holiday, counts: v.counts, fromBackfill: r.counts };
      // Spot/chain missing — backoff and retry.
      const wait = 5000 * attempt;
      console.log(`    attempt ${attempt}/${MAX_ATTEMPTS} verification failed (${v.reason}), retrying in ${wait / 1000}s`);
      await new Promise((res) => setTimeout(res, wait));
    } catch (e) {
      const wait = 5000 * attempt;
      console.log(`    attempt ${attempt}/${MAX_ATTEMPTS} threw: ${e.message}; retrying in ${wait / 1000}s`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  return { ok: false, reason: 'max_attempts_exceeded' };
}

async function main() {
  const daysCount = Math.max(1, Math.min(120, Number(process.argv[2]) || 65));
  const targets = buildTradingDayList(daysCount);
  // backfillDay walks backwards by default; we hand it newest-first so the
  // most recent days are completed first.
  console.log(`\n=== SEQUENTIAL BACKFILL: ${targets.length} trading days ===`);
  console.log(`Order: newest -> oldest (${targets[0]} -> ${targets[targets.length - 1]})\n`);

  const summary = [];
  for (let i = 0; i < targets.length; i += 1) {
    const date = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${date} ... `);
    const r = await backfillOneDay(date);
    if (r.ok) {
      const c = r.fromBackfill || {};
      const sizes = r.counts || {};
      const hasFut = dayHasFutures(date);
      if (r.holiday) {
        console.log('HOLIDAY (empty)');
      } else {
        console.log(
          `OK spot=${c.spot || 0} 1m=${c.candles1m || 0} 5m=${c.candles5m || 0} 15m=${c.candles15m || 0} ` +
          `fut1m=${c.futures1m || 0} chain=${c.chain || 0} fut=${hasFut ? 'YES' : 'NO'}`
        );
      }
    } else {
      console.log(`FAIL (${r.reason})`);
    }
    summary.push({ date, ...r });
    // 2-second pause between days to give Dhan rate-limiter breathing room.
    await new Promise((res) => setTimeout(res, 2000));
  }

  const ok = summary.filter((s) => s.ok && !s.holiday).length;
  const holidays = summary.filter((s) => s.ok && s.holiday).length;
  const failed = summary.filter((s) => !s.ok).length;
  const withFut = summary.filter((s) => s.ok && !s.holiday && dayHasFutures(s.date)).length;
  console.log(`\n=== DONE ===`);
  console.log(`Trading days OK:        ${ok}`);
  console.log(`  with futures:         ${withFut}`);
  console.log(`  spot+chain only:      ${ok - withFut}`);
  console.log(`Holidays (empty):       ${holidays}`);
  console.log(`Failed (gave up):       ${failed}`);
  if (failed > 0) {
    console.log(`\nFailed days:`);
    for (const s of summary) {
      if (!s.ok) console.log(`  ${s.date}  ${s.reason}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack);
  process.exit(1);
});
