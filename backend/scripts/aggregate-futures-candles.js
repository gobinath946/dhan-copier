/**
 * Script to manually aggregate futures candles from ticks
 * Run this to populate the futures-1m.jsonl, futures-5m.jsonl, futures-15m.jsonl files
 * 
 * Usage: node scripts/aggregate-futures-candles.js [YYYY-MM-DD]
 */

const futuresCandleAggregator = require('../src/services/futuresCandleAggregator.service');

async function main() {
  const date = process.argv[2] || new Date().toISOString().split('T')[0];
  
  console.log(`\n🔄 Aggregating futures candles for ${date}...\n`);
  
  try {
    const candles = await futuresCandleAggregator.aggregateFuturesCandles(date);
    
    console.log('📊 Aggregation Results:');
    console.log(`  • 1m candles:  ${candles['1'].length}`);
    console.log(`  • 5m candles:  ${candles['5'].length}`);
    console.log(`  • 15m candles: ${candles['15'].length}`);
    
    if (candles['1'].length === 0) {
      console.log('\n⚠️  No ticks found. Make sure futures-ticks.jsonl has data.');
      process.exit(1);
    }
    
    console.log('\n💾 Writing candles to files...\n');
    await futuresCandleAggregator.writeCandlesToFiles(date, candles);
    
    console.log('✅ Done! Futures candles aggregated successfully.\n');
    console.log('📁 Files created:');
    console.log(`  • live-feed/${date}_NIFTY_50/futures-1m.jsonl`);
    console.log(`  • live-feed/${date}_NIFTY_50/futures-5m.jsonl`);
    console.log(`  • live-feed/${date}_NIFTY_50/futures-15m.jsonl\n`);
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
