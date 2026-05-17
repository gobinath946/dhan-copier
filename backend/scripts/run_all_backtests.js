#!/usr/bin/env node
'use strict';

/**
 * Sweep all recorded `live-feed/<date>_NIFTY_50/` folders through
 * `run_backtest.js` and produce a consolidated multi-day summary.
 *
 * Per day:
 *   - spawn `node scripts/run_backtest.js <date> 60`
 *   - tee output to `logs/backtest-report-<date>.txt`
 *   - extract: cycles, finalAction counts, trade rows, top reason codes
 *
 * Final summary row: total cycles, total trades, per-day P&L.
 *
 * Usage: node scripts/run_all_backtests.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'live-feed');
const LOGS = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });

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

function parseReport(text) {
  const out = {
    cycles: 0,
    auditRows: 0,
    tradeRows: 0,
    finalActions: {},
    topReasons: [],
    trades: [],
    pnlTotal: 0,
    pnlTrades: 0,
    pnlWins: 0,
    pnlLosses: 0,
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    let m;
    if ((m = ln.match(/^Cycles run:\s+(\d+)/))) out.cycles = +m[1];
    else if ((m = ln.match(/^Audit rows captured:\s+(\d+)/))) out.auditRows = +m[1];
    else if ((m = ln.match(/^TradeExecutionLog rows:\s+(\d+)/))) out.tradeRows = +m[1];
    else if ((m = ln.match(/^Total P&L:\s+₹?(-?\d+)/))) out.pnlTotal = +m[1];
    else if ((m = ln.match(/^Trades:\s+(\d+)\s+Wins:\s+(\d+)\s+Losses:\s+(\d+)(?:\s+Scratches:\s+(\d+))?/))) {
      out.pnlTrades = +m[1]; out.pnlWins = +m[2]; out.pnlLosses = +m[3];
      out.pnlScratches = m[4] ? +m[4] : 0;
    }
  }
  // finalAction distribution lines look like "  NO_TRADE   375  (100.0%)"
  let inActions = false;
  let inReasons = false;
  let inTrades = false;
  for (const ln of lines) {
    if (ln.startsWith('finalAction distribution:')) { inActions = true; inReasons = false; inTrades = false; continue; }
    if (ln.startsWith('reasonCodes')) { inActions = false; inReasons = true; inTrades = false; continue; }
    if (ln.startsWith('Reason codes by stage')) { inReasons = false; continue; }
    if (ln.startsWith('Trade execution log:')) { inTrades = true; inReasons = false; continue; }
    if (ln.startsWith('First 3 CYCLE_AUDIT')) { inTrades = false; continue; }

    if (inActions) {
      const m = ln.match(/^\s+(\S+)\s+(\d+)\s+\(([\d.]+)%\)/);
      if (m) out.finalActions[m[1]] = { count: +m[2], pct: +m[3] };
    } else if (inReasons) {
      const m = ln.match(/^\s+(\S+)\s+(\d+)\s*$/);
      if (m && out.topReasons.length < 10) out.topReasons.push({ code: m[1], count: +m[2] });
    } else if (inTrades) {
      const t = ln.trim();
      if (t.startsWith('[SIM]') || t.startsWith('[LIVE]')) out.trades.push(t);
    }
  }
  return out;
}

function main() {
  const dates = listDays();
  console.log('=== HYBRID_ENGINE 10-DAY SWEEP ===');
  console.log('Days to run: ' + dates.length);
  for (const d of dates) console.log('  ' + d);

  const results = [];
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    console.log('\n[' + (i + 1) + '/' + dates.length + '] running ' + date);
    const reportPath = path.join(LOGS, 'backtest-report-' + date + '.txt');
    const r = spawnSync('node', ['scripts/run_backtest.js', date, '60'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    const stdout = r.stdout || '';
    fs.writeFileSync(reportPath, stdout);
    if (r.status !== 0) {
      console.log('  ✗ exit=' + r.status + ' (see ' + reportPath + ')');
      results.push({ date, ok: false, error: 'exit=' + r.status });
      continue;
    }
    const parsed = parseReport(stdout);
    const tradesFired = (parsed.finalActions.BUY_CE?.count || 0) + (parsed.finalActions.BUY_PE?.count || 0);
    console.log('  ✓ cycles=' + parsed.cycles + ' trades=' + tradesFired + ' execLog=' + parsed.tradeRows);
    if (tradesFired > 0) {
      console.log('  → BUY_CE=' + (parsed.finalActions.BUY_CE?.count || 0)
        + ' BUY_PE=' + (parsed.finalActions.BUY_PE?.count || 0));
    }
    if (parsed.trades.length > 0) {
      for (const t of parsed.trades) console.log('  ' + t.slice(0, 200));
    }
    results.push({ date, ok: true, parsed, tradesFired });
  }

  // -------- consolidated summary --------
  console.log('\n\n============================================================');
  console.log('SWEEP SUMMARY');
  console.log('============================================================');

  let totalCycles = 0;
  let totalTrades = 0;
  let totalExecRows = 0;
  let totalPnl = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalScratches = 0;
  for (const r of results) {
    if (!r.ok) {
      console.log(r.date.padEnd(12) + 'FAILED — ' + r.error);
      continue;
    }
    const tf = r.tradesFired;
    totalCycles += r.parsed.cycles;
    totalTrades += tf;
    totalExecRows += r.parsed.tradeRows;
    totalPnl += r.parsed.pnlTotal || 0;
    totalWins += r.parsed.pnlWins || 0;
    totalLosses += r.parsed.pnlLosses || 0;
    totalScratches += r.parsed.pnlScratches || 0;
    const tag = tf === 0 ? 'NO_TRADE' : 'TRADES=' + tf;
    const decisive = (r.parsed.pnlWins || 0) + (r.parsed.pnlLosses || 0);
    const wr = decisive > 0 ? ((r.parsed.pnlWins / decisive) * 100).toFixed(0) : '-';
    const pnlTag = r.parsed.pnlTrades > 0
      ? ' P&L=₹' + r.parsed.pnlTotal + ' (W:' + r.parsed.pnlWins + '/L:' + r.parsed.pnlLosses
        + (r.parsed.pnlScratches ? '/S:' + r.parsed.pnlScratches : '')
        + ' WR=' + wr + '%)'
      : '';
    const top = r.parsed.topReasons.slice(0, 3).map((x) => x.code + ':' + x.count).join(' ');
    console.log(r.date.padEnd(12) + 'cycles=' + String(r.parsed.cycles).padEnd(5)
      + tag.padEnd(15) + pnlTag.padEnd(40) + 'top: ' + top);
  }
  console.log('------------------------------------------------------------');
  const decisiveTotal = totalWins + totalLosses;
  const winRateTotal = decisiveTotal > 0 ? ((totalWins / decisiveTotal) * 100).toFixed(1) : '0';
  console.log('TOTAL  cycles=' + totalCycles + '  trades=' + totalTrades
    + '  W:' + totalWins + ' L:' + totalLosses + ' S:' + totalScratches
    + '  WR=' + winRateTotal + '%'
    + '  total P&L=₹' + totalPnl);
  console.log('============================================================');

  // Write a consolidated file too.
  const sweepPath = path.join(LOGS, 'backtest-sweep.txt');
  let sweep = '=== HYBRID_ENGINE SWEEP — ' + new Date().toISOString() + ' ===\n\n';
  for (const r of results) {
    sweep += '\n----- ' + r.date + ' -----\n';
    if (!r.ok) { sweep += 'FAILED: ' + r.error + '\n'; continue; }
    sweep += 'cycles=' + r.parsed.cycles + '  trades=' + r.tradesFired + '  execRows=' + r.parsed.tradeRows + '\n';
    sweep += 'finalActions: ' + JSON.stringify(r.parsed.finalActions) + '\n';
    sweep += 'top10 reasonCodes:\n';
    for (const tr of r.parsed.topReasons) sweep += '  ' + tr.code + '  ' + tr.count + '\n';
    if (r.parsed.trades.length) {
      sweep += 'trade rows:\n';
      for (const t of r.parsed.trades) sweep += '  ' + t + '\n';
    }
  }
  sweep += '\n=== TOTAL cycles=' + totalCycles + ' trades=' + totalTrades + ' execLog=' + totalExecRows + ' ===\n';
  fs.writeFileSync(sweepPath, sweep);
  console.log('\nSweep summary written to ' + sweepPath);
  process.exit(0);
}

main();
