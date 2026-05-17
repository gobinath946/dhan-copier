#!/usr/bin/env node
/**
 * Run the multi-day backtest sweep with custom lot size + brokerage,
 * then collate every per-day trade JSONL into a single master
 * markdown table. The table includes:
 *
 *   #, Date, Dir(CE/PE), Strike, Lots, Entry@time, Exit@time,
 *   Entry/Exit spot, Spot pts captured, Premium move, Gross PnL,
 *   Brokerage, Net PnL, Outcome, Exit Reason, Strategy.
 *
 * Usage:
 *   node scripts/run_sweep_with_table.js              # default LOTS=1
 *   node scripts/run_sweep_with_table.js 2 60         # 2 lots, ₹60 brokerage
 *   node scripts/run_sweep_with_table.js 2 60 logs/sweep-2lots.md
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'live-feed');
const LOGS = path.join(__dirname, '..', 'logs');
const TRADES_DIR = path.join(LOGS, 'trades');
if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });
if (!fs.existsSync(TRADES_DIR)) fs.mkdirSync(TRADES_DIR, { recursive: true });

const lots = parseInt(process.argv[2] || '1', 10);
const brokerage = parseFloat(process.argv[3] || '60');
const outFile = process.argv[4] || path.join(LOGS, `sweep-table-${lots}lot-${Math.round(brokerage)}br.md`);

function listDays() {
  if (!fs.existsSync(ROOT)) return [];
  const dates = [];
  for (const entry of fs.readdirSync(ROOT)) {
    if (!entry.endsWith('_NIFTY_50')) continue;
    const f = path.join(ROOT, entry, 'candles-1m.jsonl');
    if (!fs.existsSync(f) || fs.statSync(f).size === 0) continue;
    dates.push(entry.split('_')[0]);
  }
  return dates.sort();
}

function clearOldTradeJsonls() {
  if (!fs.existsSync(TRADES_DIR)) return;
  for (const f of fs.readdirSync(TRADES_DIR)) {
    if (f.startsWith('trades-') && f.endsWith('.jsonl')) {
      try { fs.unlinkSync(path.join(TRADES_DIR, f)); } catch (_) {}
    }
  }
}

function runOneDay(date, env) {
  const r = spawnSync('node', ['scripts/run_backtest.js', date, '60'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    env,
  });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim().length);
  return lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function fmt(n, w, dec) {
  if (n == null || !Number.isFinite(n)) return ''.padStart(w);
  const s = dec != null ? n.toFixed(dec) : String(n);
  return s.padStart(w);
}

function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '';
  if (n >= 0) return '+' + Math.round(n);
  return String(Math.round(n));
}

function buildMarkdownTable(trades) {
  const headers = [
    '#', 'Date', 'Dir', 'Strike', 'Lots',
    'Entry₹', 'EntryT', 'Exit₹', 'ExitT',
    'EntrySpot', 'ExitSpot', 'SpotPts',
    'PremPts', 'Gross₹', 'Brok₹', 'Net₹',
    'Outcome', 'Exit Reason', 'Strategy',
  ];
  const rows = [];
  for (let i = 0; i < trades.length; i += 1) {
    const t = trades[i];
    rows.push([
      String(i + 1),
      t.date || '',
      t.direction === 'BUY_CE' ? 'CE' : (t.direction === 'BUY_PE' ? 'PE' : (t.direction || '')),
      String(t.strike || ''),
      String(t.lots || 0),
      (t.entryPremium != null ? t.entryPremium.toFixed(2) : ''),
      t.entryTimeIST || '',
      (t.exitPremium != null ? t.exitPremium.toFixed(2) : ''),
      t.exitTimeIST || '',
      (t.entrySpot != null ? Math.round(t.entrySpot) : ''),
      (t.exitSpot != null ? Math.round(t.exitSpot) : ''),
      (t.spotPointsCaptured != null ? t.spotPointsCaptured.toFixed(1) : ''),
      (t.premiumPointsCaptured != null ? t.premiumPointsCaptured.toFixed(2) : ''),
      fmtSigned(t.grossPnl),
      String(Math.round(t.brokerage || 0)),
      fmtSigned(t.totalPnl),
      t.outcome || '',
      t.exitReason || '',
      t.strategy || '',
    ]);
  }
  // markdown table
  let md = '| ' + headers.join(' | ') + ' |\n';
  md += '|' + headers.map(() => '---').join('|') + '|\n';
  for (const r of rows) md += '| ' + r.join(' | ') + ' |\n';
  return md;
}

function main() {
  const dates = listDays();
  console.log(`\n=== SWEEP WITH MASTER TABLE ===`);
  console.log(`Days: ${dates.length}`);
  console.log(`Lots: ${lots}`);
  console.log(`Brokerage per trade: ₹${brokerage}`);
  console.log(`Output: ${outFile}\n`);

  clearOldTradeJsonls();

  const env = Object.assign({}, process.env, {
    LOTS: String(lots),
    BROKERAGE_PER_TRADE: String(brokerage),
  });

  // Per-day summary
  const dayResults = [];
  for (let i = 0; i < dates.length; i += 1) {
    const d = dates[i];
    process.stdout.write(`[${i + 1}/${dates.length}] ${d} ... `);
    const r = runOneDay(d, env);
    if (!r.ok) {
      console.log('FAIL');
      dayResults.push({ date: d, ok: false });
      continue;
    }
    const trades = readJsonl(path.join(TRADES_DIR, `trades-${d}.jsonl`));
    const wins = trades.filter((t) => t.outcome === 'win').length;
    const losses = trades.filter((t) => t.outcome === 'loss').length;
    const scratches = trades.filter((t) => t.outcome === 'scratch').length;
    const totalPnl = trades.reduce((a, t) => a + (t.totalPnl || 0), 0);
    const decisive = wins + losses;
    const wr = decisive > 0 ? ((wins / decisive) * 100).toFixed(0) : '-';
    console.log(`OK trades=${trades.length} W:${wins} L:${losses} S:${scratches} WR=${wr}% PnL=₹${Math.round(totalPnl)}`);
    dayResults.push({ date: d, ok: true, trades: trades.length, wins, losses, scratches, totalPnl });
  }

  // Aggregate everything.
  const allTrades = [];
  for (const f of fs.readdirSync(TRADES_DIR).sort()) {
    if (!f.startsWith('trades-') || !f.endsWith('.jsonl')) continue;
    for (const t of readJsonl(path.join(TRADES_DIR, f))) allTrades.push(t);
  }
  const sortedTrades = allTrades.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.entryTimeMs || 0) - (b.entryTimeMs || 0);
  });

  // Totals
  const totWins = allTrades.filter((t) => t.outcome === 'win').length;
  const totLosses = allTrades.filter((t) => t.outcome === 'loss').length;
  const totScratches = allTrades.filter((t) => t.outcome === 'scratch').length;
  const totDecisive = totWins + totLosses;
  const totWr = totDecisive > 0 ? ((totWins / totDecisive) * 100).toFixed(1) : '0';
  const totGross = allTrades.reduce((a, t) => a + (t.grossPnl || 0), 0);
  const totBrokerage = allTrades.reduce((a, t) => a + (t.brokerage || 0), 0);
  const totNet = allTrades.reduce((a, t) => a + (t.totalPnl || 0), 0);

  // Build markdown report.
  const lines = [];
  lines.push('# Backtest Sweep Master Table');
  lines.push('');
  lines.push(`- **Lots per trade:** ${lots}`);
  lines.push(`- **Brokerage per trade:** ₹${brokerage}`);
  lines.push(`- **Days tested:** ${dates.length}`);
  lines.push(`- **Total trades:** ${allTrades.length}`);
  lines.push(`- **Wins:** ${totWins}`);
  lines.push(`- **Losses:** ${totLosses}`);
  lines.push(`- **Scratches:** ${totScratches}`);
  lines.push(`- **Win-rate (decisive):** ${totWr}%`);
  lines.push(`- **Gross P&L:** ₹${Math.round(totGross)}`);
  lines.push(`- **Brokerage:** ₹${Math.round(totBrokerage)}`);
  lines.push(`- **Net P&L:** ₹${Math.round(totNet)}`);
  lines.push('');
  lines.push('## Per-day summary');
  lines.push('');
  lines.push('| Date | Trades | Wins | Losses | Scratches | WR | Net P&L |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const d of dayResults) {
    if (!d.ok) {
      lines.push(`| ${d.date} | FAIL | - | - | - | - | - |`);
      continue;
    }
    const dec = d.wins + d.losses;
    const wr = dec > 0 ? ((d.wins / dec) * 100).toFixed(0) + '%' : '-';
    lines.push(`| ${d.date} | ${d.trades} | ${d.wins} | ${d.losses} | ${d.scratches} | ${wr} | ₹${Math.round(d.totalPnl)} |`);
  }
  lines.push('');
  lines.push(`## All trades (${allTrades.length})`);
  lines.push('');
  lines.push(buildMarkdownTable(sortedTrades));

  fs.writeFileSync(outFile, lines.join('\n'));

  console.log('\n=== TOTALS ===');
  console.log(`Total trades:    ${allTrades.length}`);
  console.log(`Wins:            ${totWins}`);
  console.log(`Losses:          ${totLosses}`);
  console.log(`Scratches:       ${totScratches}`);
  console.log(`Win-rate:        ${totWr}%`);
  console.log(`Gross P&L:       ₹${Math.round(totGross)}`);
  console.log(`Brokerage:       ₹${Math.round(totBrokerage)}`);
  console.log(`Net P&L:         ₹${Math.round(totNet)}`);
  console.log(`\nMaster table written to: ${outFile}`);
  process.exit(0);
}

main();
