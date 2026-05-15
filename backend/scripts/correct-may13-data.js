/**
 * Manual correction for May 13, 2026 data
 * Dhan API returned incorrect open price (23447.3 vs actual 23362.45)
 * 
 * This script corrects the first candle and metadata based on actual chart data
 */
const fs = require('fs');
const path = require('path');

const FOLDER = path.join(__dirname, '../live-feed/2026-05-13_NIFTY_50');
const CORRECT_OPEN = 23362.45;
const CORRECT_ATM = 23350; // Rounded to nearest 50

async function main() {
  console.log('Correcting May 13, 2026 data...\n');
  
  // 1. Read and correct 1m candles
  const candles1mFile = path.join(FOLDER, 'candles-1m.jsonl');
  const lines = fs.readFileSync(candles1mFile, 'utf8').split('\n').filter(Boolean);
  
  console.log(`Found ${lines.length} 1m candles`);
  
  // Parse first candle
  const firstCandle = JSON.parse(lines[0]);
  console.log('\nOriginal first candle:');
  console.log(`  Open: ${firstCandle.o}`);
  console.log(`  High: ${firstCandle.h}`);
  console.log(`  Low: ${firstCandle.l}`);
  console.log(`  Close: ${firstCandle.c}`);
  
  // Correct the first candle
  firstCandle.o = CORRECT_OPEN;
  // Keep other values as they might be correct
  
  console.log('\nCorrected first candle:');
  console.log(`  Open: ${firstCandle.o}`);
  console.log(`  High: ${firstCandle.h}`);
  console.log(`  Low: ${firstCandle.l}`);
  console.log(`  Close: ${firstCandle.c}`);
  
  // Write back
  lines[0] = JSON.stringify(firstCandle);
  fs.writeFileSync(candles1mFile, lines.join('\n') + '\n');
  console.log('\n✓ Updated candles-1m.jsonl');
  
  // 2. Correct spot.jsonl (synthetic ticks)
  const spotFile = path.join(FOLDER, 'spot.jsonl');
  const spotLines = fs.readFileSync(spotFile, 'utf8').split('\n').filter(Boolean);
  const firstTick = JSON.parse(spotLines[0]);
  
  firstTick.ltp = CORRECT_OPEN;
  firstTick.open = CORRECT_OPEN;
  
  spotLines[0] = JSON.stringify(firstTick);
  fs.writeFileSync(spotFile, spotLines.join('\n') + '\n');
  console.log('✓ Updated spot.jsonl');
  
  // 3. Correct metadata
  const metaFile = path.join(FOLDER, 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  
  console.log('\nOriginal metadata:');
  console.log(`  openPrice: ${meta.openPrice}`);
  console.log(`  openingAtm: ${meta.openingAtm}`);
  
  meta.openPrice = CORRECT_OPEN;
  meta.openingAtm = CORRECT_ATM;
  meta.openCandle.open = CORRECT_OPEN;
  meta.correctedManually = true;
  meta.correctionReason = 'Dhan API returned incorrect open price (23447.3 vs actual 23362.45 from chart)';
  meta.correctedAt = Date.now();
  
  // Recalculate futures premium with correct spot open
  if (meta.futuresOpen) {
    meta.futuresOpenPremium = Number((meta.futuresOpen - CORRECT_OPEN).toFixed(2));
  }
  
  console.log('\nCorrected metadata:');
  console.log(`  openPrice: ${meta.openPrice}`);
  console.log(`  openingAtm: ${meta.openingAtm}`);
  console.log(`  futuresOpenPremium: ${meta.futuresOpenPremium}`);
  
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log('✓ Updated metadata.json');
  
  console.log('\n=== CORRECTION COMPLETE ===\n');
  console.log('Note: This is a manual correction due to Dhan API data quality issue.');
  console.log('The API returned 23447.3 but the actual chart shows 23362.45 as the open.');
  console.log('\nAll files have been updated with the correct values.\n');
}

main().catch(console.error);
