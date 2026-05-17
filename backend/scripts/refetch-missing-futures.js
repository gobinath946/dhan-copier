#!/usr/bin/env node
'use strict';

/**
 * Refetch the days whose `futures-1m.jsonl` is empty (rate-limited
 * during the original backfill). Paces 30 s between days so Dhan's
 * minute-window rate limit has time to recover.
 *
 * Usage: node scripts/refetch-missing-futures.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { backfillDay } = require('../src/services/historicalBackfill.service');
const logger = require('../src/utils/logger');

const ROOT = path.join(__dirname, '..', 'live-feed');
const PAUSE_MS_BETWEEN_DAYS = 30000;

function findEmptyFuturesDays() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(ROOT)) {
    if (!entry.endsWith('_NIFTY_50')) continue;
    const fut1m = path.join(ROOT, entry, 'futures-1m.jsonl');
    if (!fs.existsSync(fut1m)) continue;
    if (fs.statSync(fut1m).size === 0) {
      out.push(entry.split('_')[0]);
    }
  }
  return out.sort();
}

async function main() {
  const dates = findEmptyFuturesDays();
  console.log('=== REFETCH MISSING FUTURES ===');
  console.log('Days to refetch: ' + dates.length);
  for (const d of dates) console.log('  ' + d);
  if (dates.length === 0) {
    console.log('Nothing to do — all days have futures-1m data.');
    process.exit(0);
  }

  const summary = [];
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    console.log('\n[' + (i + 1) + '/' + dates.length + '] refetching ' + date);
    try {
      const result = await backfillDay(date, {
        window: 6,
        expiryFlag: 'WEEK',
        expiryCode: 1,
        overwrite: true,
      });
      const c = result.counts || {};
      console.log('  ✓ done: 1m=' + c.candles1m + ' fut1m=' + c.futures1m + ' chain=' + c.chain);
      summary.push({ date, ok: true, counts: c });
    } catch (err) {
      console.log('  ✗ failed: ' + err.message);
      summary.push({ date, ok: false, error: err.message });
    }

    if (i < dates.length - 1) {
      console.log('  pausing ' + (PAUSE_MS_BETWEEN_DAYS / 1000) + 's to dodge Dhan rate limit...');
      await new Promise((r) => setTimeout(r, PAUSE_MS_BETWEEN_DAYS));
    }
  }

  console.log('\n=== REFETCH SUMMARY ===');
  for (const s of summary) {
    if (s.ok) {
      console.log('  ✓ ' + s.date + ' fut1m=' + s.counts.futures1m + ' chain=' + s.counts.chain);
    } else {
      console.log('  ✗ ' + s.date + ' — ' + s.error);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Refetch loop failed');
  console.error('FATAL:', err.message);
  process.exit(1);
});
