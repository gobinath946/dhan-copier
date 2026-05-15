/**
 * Re-fetch a single day's data to verify/correct discrepancies
 * 
 * Usage: node scripts/refetch-single-day.js 2026-05-13
 */
require('dotenv').config();
const { backfillDay } = require('../src/services/historicalBackfill.service');
const logger = require('../src/utils/logger');

async function main() {
  const date = process.argv[2] || '2026-05-13';
  
  logger.info({ date }, 'Re-fetching single day data');
  
  try {
    const result = await backfillDay(date, {
      window: 6,
      expiryFlag: 'WEEK',
      expiryCode: 1,
      overwrite: true, // OVERWRITE existing data
    });
    
    console.log('\n=== REFETCH RESULT ===\n');
    console.log(`Date: ${date}`);
    console.log(`Folder: ${result.folder}`);
    console.log(`Open Price: ${result.meta.openPrice}`);
    console.log(`Opening ATM: ${result.meta.openingAtm}`);
    console.log(`Futures Open: ${result.meta.futuresOpen}`);
    console.log(`Futures Premium: ${result.meta.futuresOpenPremium}`);
    console.log(`\nCounts:`);
    console.log(`  Spot ticks: ${result.counts.spot}`);
    console.log(`  1m candles: ${result.counts.candles1m}`);
    console.log(`  Futures 1m: ${result.counts.futures1m}`);
    console.log(`  Chain snapshots: ${result.counts.chain}`);
    console.log('\n======================\n');
    
    process.exit(0);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'Refetch failed');
    console.error('Refetch failed:', error.message);
    process.exit(1);
  }
}

main();
