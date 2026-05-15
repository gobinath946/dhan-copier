/**
 * Backfill 2 weeks of NIFTY 50 data (spot + futures + option chain)
 * 
 * Usage: node scripts/backfill-2weeks.js
 */
require('dotenv').config();
const { backfillRange } = require('../src/services/historicalBackfill.service');
const logger = require('../src/utils/logger');

async function main() {
  logger.info('Starting 2-week backfill for NIFTY 50 (spot + futures + option chain)');
  
  try {
    // Backfill 10 trading days (2 weeks) with ATM ± 6 strikes
    const result = await backfillRange(10, {
      window: 6,           // ATM ± 6 strikes
      expiryFlag: 'WEEK',  // Weekly expiry
      expiryCode: 1,       // Current expiry (1 = near, 2 = next)
      overwrite: false,    // Don't overwrite existing data
    });
    
    logger.info({ 
      totalDays: result.days.length,
      successful: result.days.filter(d => d.ok).length,
      failed: result.days.filter(d => !d.ok).length,
    }, 'Backfill complete');
    
    // Print summary
    console.log('\n=== BACKFILL SUMMARY ===\n');
    for (const day of result.days) {
      if (day.ok) {
        console.log(`✓ ${day.date}: ${day.counts.spot} ticks, ${day.counts.candles1m} 1m candles, ${day.counts.futures1m} futures 1m, ${day.counts.chain} chain snapshots`);
      } else {
        console.log(`✗ ${day.date}: ${day.error}`);
      }
    }
    console.log('\n========================\n');
    
    process.exit(0);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'Backfill failed');
    console.error('Backfill failed:', error.message);
    process.exit(1);
  }
}

main();
