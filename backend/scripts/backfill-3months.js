/**
 * Backfill ~3 months (65 trading days) of NIFTY 50 data.
 *
 * Calls backfillRange with a 65-day target. The service walks
 * backwards from `toDate` (defaulting to yesterday) skipping
 * weekends; exchange holidays produce empty files + a warning.
 *
 * Usage: node scripts/backfill-3months.js
 */
require('dotenv').config();
const { backfillRange } = require('../src/services/historicalBackfill.service');
const logger = require('../src/utils/logger');

async function main() {
  logger.info('Starting 3-month (65 trading day) backfill for NIFTY 50');

  const result = await backfillRange(65, {
    window: 3,           // ATM ± 3 strikes (7 strikes total) — half the API calls of ±6
    expiryFlag: 'WEEK',  // Weekly expiry
    expiryCode: 1,       // Current expiry
    overwrite: false,    // Skip days that already have data
  });

  const ok = result.days.filter((d) => d.ok).length;
  const failed = result.days.filter((d) => !d.ok).length;

  console.log('\n=== 3-MONTH BACKFILL SUMMARY ===\n');
  for (const day of result.days) {
    if (day.ok) {
      const c = day.counts || {};
      console.log(`[OK]  ${day.date}: spot=${c.spot || 0} 1m=${c.candles1m || 0} fut1m=${c.futures1m || 0} chain=${c.chain || 0}`);
    } else {
      console.log(`[ERR] ${day.date}: ${day.error}`);
    }
  }
  console.log(`\nTotal: ${result.days.length}  OK: ${ok}  Failed: ${failed}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err && err.stack);
  process.exit(1);
});
