'use strict';

/**
 * ============================================================
 * HYBRID TRADE MONITOR ADAPTER
 * ============================================================
 * Per-cycle exit-decision engine for OPEN `ScalpingTrade` rows
 * created by Hybrid_Engine. Mirrors the institutional trail/
 * early-abort/stall-scratch logic from `run_backtest.js` so live
 * + simulation behave identically:
 *
 *   - SL via 30% premium drawdown (delta-modelled in simulation)
 *   - Target via 40% premium gain
 *   - Trail @ +0.4R  → BE - 0.5
 *   - Trail @ +0.6R  → BE + 0.3R
 *   - Trail @ +0.9R  → BE + 0.5R
 *   - Trail @ +1.2R  → highWater - 0.5R (true trailing stop)
 *   - EARLY_ABORT    : within 5 bars, -0.75R adverse move
 *   - STALL_SCRATCH  : after 6 bars without new high at +0.45R+
 *   - TIME_EXPIRED   : 40 bars (~40min) since entry
 *
 * The monitor is INTENTIONALLY DETERMINISTIC — the AI advisory
 * layer (Req 14) is invoked elsewhere in the prediction cycle.
 * Mixing AI exits with deterministic exits leaks subjectivity
 * into a code path that's supposed to be auditable.
 *
 * On every exit:
 *   - Mark `ScalpingTrade.status = 'closed'` with `result`,
 *     `pnl`, `pnlPct`, `exitPrice`, `closedAt`, `exitReason`.
 *   - Broadcast `scalpingTradeUpdate` (type: 'trade_closed') so
 *     the UI table updates without a manual refresh.
 *   - Update `ScalpingSession.realizedPnL` / `currentCapital`.
 *
 * On every non-exit cycle:
 *   - Update `ScalpingTrade.currentPrice` / `unrealizedPnl`.
 *   - Broadcast `scalpingTradeUpdate` (type: 'trade_updated',
 *     updateType: 'price') so the UI shows live P&L.
 * ============================================================
 */

const ScalpingTrade = require('../../models/ScalpingTrade');
const ScalpingSession = require('../../models/ScalpingSession');
const scalpingSocket = require('../../utils/scalpingSocket');
const logger = require('../../utils/logger');

// Brokerage per round-trip (same as backtest convention).
const BROKERAGE_PER_TRADE = 60;

// Premium-based SL/target percentages (institutional NIFTY norms).
const SL_PCT_PREMIUM = 0.30;
const TARGET_PCT_PREMIUM = 0.40;

// Time-based exit (bars since entry — 1 bar ≈ 1 cycle).
const TIME_EXIT_BARS = 40;

// Early-abort / stall-scratch thresholds.
const EARLY_ABORT_BARS = 5;
const EARLY_ABORT_R = 0.75;
const STALL_SCRATCH_BARS = 6;
const STALL_SCRATCH_R = 0.45;

/**
 * Estimate option delta from moneyness when the option chain
 * row didn't include a recorded delta.
 *
 * @param {('CE'|'PE')} side
 * @param {number} strike
 * @param {number} spot
 * @returns {number}  0..1
 */
function _estimateDelta(side, strike, spot) {
  if (!Number.isFinite(strike) || !Number.isFinite(spot)) return 0.5;
  const moneyness = side === 'CE' ? (spot - strike) : (strike - spot);
  return Math.max(0.1, Math.min(0.9, 0.5 + moneyness / 200));
}

/**
 * Compute the live premium for an open trade by replaying spot
 * moves through delta. This matches the canonical institutional
 * options-backtest model and works for both live + simulation.
 *
 * The trade row stores `entryPrice` (entry premium) and
 * `entrySpot` (spot at entry — added in this monitor on first
 * sight). On subsequent cycles we read `data.spot.ltp` and
 * compute:
 *
 *     currentPremium = entryPremium + (spotNow - entrySpot) × deltaSigned
 *
 * where `deltaSigned = +delta` for CE longs, `-delta` for PE longs.
 *
 * @param {Object} trade
 * @param {number} spotNow
 * @returns {number}  Current premium (clamped >= 0.5).
 */
function _modelCurrentPremium(trade, spotNow) {
  if (!Number.isFinite(spotNow)) return trade.currentPrice || trade.entryPrice || 0;
  const side = trade.signal === 'BUY_CE' ? 'CE' : 'PE';
  const entrySpot = Number.isFinite(trade.entrySpot)
    ? trade.entrySpot
    : (Number.isFinite(trade.openSpot) ? trade.openSpot : spotNow);
  const delta = Number.isFinite(trade.optionDelta)
    ? trade.optionDelta
    : _estimateDelta(side, trade.strike, entrySpot);
  const deltaSigned = side === 'CE' ? delta : -delta;
  const move = spotNow - entrySpot;
  return Math.max(0.5, trade.entryPrice + move * deltaSigned);
}

/**
 * Apply the institutional SL trail (BE-trail at +0.4R, +0.6R,
 * +0.9R, true trail at +1.2R). Returns the new SL premium.
 *
 * @param {Object} trade
 * @param {number} currentPremium
 * @param {number} highWaterPremium
 * @returns {number}  New SL premium (never less than current).
 */
function _applyTrail(trade, currentPremium, highWaterPremium) {
  const initialSlDistance = trade.entryPrice - trade.slPremium;
  if (initialSlDistance <= 0) return trade.slPremium;
  const moveFromEntry = currentPremium - trade.entryPrice;
  if (moveFromEntry <= 0) return trade.slPremium;
  const rMultiple = moveFromEntry / initialSlDistance;
  let newSl = trade.slPremium;
  if (rMultiple >= 1.2) {
    const trailingSl = highWaterPremium - (initialSlDistance * 0.5);
    if (trailingSl > newSl) newSl = trailingSl;
  } else if (rMultiple >= 0.9) {
    const beStop = trade.entryPrice + (initialSlDistance * 0.5);
    if (beStop > newSl) newSl = beStop;
  } else if (rMultiple >= 0.6) {
    const beStop = trade.entryPrice + (initialSlDistance * 0.3);
    if (beStop > newSl) newSl = beStop;
  } else if (rMultiple >= 0.4) {
    const beStop = trade.entryPrice - 0.5;
    if (beStop > newSl) newSl = beStop;
  }
  return newSl;
}

/**
 * Decide the exit reason for a single trade. Returns one of:
 *   'TARGET_HIT' | 'SL_HIT' | 'EARLY_ABORT' | 'STALL_SCRATCH' |
 *   'TIME_EXPIRED' | null (no exit this cycle).
 *
 * Mutates `trade.barsSinceEntry`, `trade.barsSinceHigh`,
 * `trade.highWaterPremium`, `trade.slPremium` (trail).
 *
 * @param {Object} trade
 * @param {number} currentPremium
 * @returns {string|null}
 */
function _resolveExitReason(trade, currentPremium) {
  // Initialise tracking fields on first monitor cycle.
  if (!Number.isFinite(trade.slPremium)) {
    trade.slPremium = Math.max(0.5, trade.entryPrice * (1 - SL_PCT_PREMIUM));
  }
  if (!Number.isFinite(trade.targetPremium)) {
    trade.targetPremium = trade.entryPrice * (1 + TARGET_PCT_PREMIUM);
  }
  if (!Number.isFinite(trade.highWaterPremium) || currentPremium > trade.highWaterPremium) {
    trade.highWaterPremium = currentPremium;
    trade.barsSinceHigh = 0;
  } else {
    trade.barsSinceHigh = (trade.barsSinceHigh || 0) + 1;
  }

  // Apply trail to slPremium.
  trade.slPremium = _applyTrail(trade, currentPremium, trade.highWaterPremium);

  const initialSlDistance = trade.entryPrice - trade.slPremium;
  const moveFromEntry = currentPremium - trade.entryPrice;
  const barsSinceEntry = (trade.barsSinceEntry || 0) + 1;
  trade.barsSinceEntry = barsSinceEntry;

  if (currentPremium >= trade.targetPremium) return 'TARGET_HIT';
  if (currentPremium <= trade.slPremium) return 'SL_HIT';
  if (initialSlDistance > 0
    && barsSinceEntry <= EARLY_ABORT_BARS
    && (trade.entryPrice - currentPremium) >= initialSlDistance * EARLY_ABORT_R) {
    return 'EARLY_ABORT';
  }
  if (initialSlDistance > 0
    && moveFromEntry > 0
    && (moveFromEntry / initialSlDistance) >= STALL_SCRATCH_R
    && (trade.barsSinceHigh || 0) >= STALL_SCRATCH_BARS) {
    return 'STALL_SCRATCH';
  }
  if (barsSinceEntry >= TIME_EXIT_BARS) return 'TIME_EXPIRED';
  return null;
}

/**
 * Persist + broadcast a closed trade. Updates the
 * `ScalpingSession` realized P&L counter on the way out.
 */
async function _closeTrade(trade, currentPremium, exitReason) {
  const grossPnl = (currentPremium - trade.entryPrice) * (trade.quantity || 0);
  const netPnl = grossPnl - BROKERAGE_PER_TRADE;
  const pnlPct = trade.entryPrice > 0
    ? ((currentPremium - trade.entryPrice) / trade.entryPrice) * 100
    : 0;
  let result = 'BREAKEVEN';
  if (netPnl >= 100) result = 'WIN';
  else if (netPnl <= -500) result = 'LOSS';

  trade.status = 'closed';
  trade.exitPrice = currentPremium;
  trade.currentPrice = currentPremium;
  trade.closedAt = new Date();
  trade.pnl = netPnl;
  trade.pnlPct = pnlPct;
  trade.result = result;
  trade.exitReason = exitReason;
  trade.brokerage = BROKERAGE_PER_TRADE;
  await trade.save();

  // Update session counters (best-effort).
  try {
    const session = await ScalpingSession.findById(trade.sessionId);
    if (session) {
      session.realizedPnL = (session.realizedPnL || 0) + netPnl;
      session.totalBrokerageCharges = (session.totalBrokerageCharges || 0) + BROKERAGE_PER_TRADE;
      session.currentCapital = (session.currentCapital || session.initialCapital || 0) + netPnl;
      session.totalTrades = (session.totalTrades || 0) + 1;
      if (result === 'WIN') session.winCount = (session.winCount || 0) + 1;
      else if (result === 'LOSS') session.lossCount = (session.lossCount || 0) + 1;
      await session.save();
    }
  } catch (err) {
    logger.warn(
      { module: 'tradeMonitor.adapter', err: err && err.message },
      '[tradeMonitor.adapter] session-counter update failed; trade still closed',
    );
  }

  // Broadcast to UI.
  try {
    if (scalpingSocket && typeof scalpingSocket.emitTradeClosed === 'function') {
      scalpingSocket.emitTradeClosed(trade, String(trade.sessionId));
    }
  } catch (_) { /* swallow */ }

  logger.info(
    {
      module: 'tradeMonitor.adapter',
      tradeId: String(trade._id),
      direction: trade.signal,
      entryPrice: trade.entryPrice,
      exitPrice: currentPremium,
      pnl: netPnl,
      result,
      exitReason,
    },
    '[tradeMonitor.adapter] trade closed',
  );
}

/**
 * Persist + broadcast a price-tick update for a still-open trade.
 */
async function _updateTrade(trade, currentPremium) {
  trade.currentPrice = currentPremium;
  trade.unrealizedPnl = (currentPremium - trade.entryPrice) * (trade.quantity || 0);
  await trade.save();
  try {
    if (scalpingSocket && typeof scalpingSocket.emitTradeUpdated === 'function') {
      scalpingSocket.emitTradeUpdated(trade, String(trade.sessionId), 'price');
    }
  } catch (_) { /* swallow */ }
}

/**
 * Run one monitor cycle for the given session id. Reads all
 * open trades, decides hold/exit per trade, persists changes,
 * and broadcasts to the UI. Never throws.
 *
 * @param {Object} args
 * @param {string|null} args.sessionId  Active ScalpingSession id.
 * @param {Object} args.ctx             Hybrid_Engine cycle context (for spot LTP).
 * @returns {Promise<{ checked:number, closed:number, updated:number }>}
 */
async function runMonitorCycle({ sessionId, ctx }) {
  if (!sessionId) return { checked: 0, closed: 0, updated: 0 };
  const data = ctx && ctx.data;
  const spotNow = data && data.spot && Number.isFinite(data.spot.ltp)
    ? data.spot.ltp : null;
  if (spotNow === null) return { checked: 0, closed: 0, updated: 0 };

  let openTrades;
  try {
    openTrades = await ScalpingTrade.find({ sessionId, status: 'open' });
  } catch (err) {
    logger.warn(
      { module: 'tradeMonitor.adapter', err: err && err.message },
      '[tradeMonitor.adapter] ScalpingTrade.find failed',
    );
    return { checked: 0, closed: 0, updated: 0 };
  }
  if (!openTrades || openTrades.length === 0) {
    return { checked: 0, closed: 0, updated: 0 };
  }

  let closed = 0;
  let updated = 0;
  for (const trade of openTrades) {
    try {
      // First-time fields stamped here so we don't change the
      // ScalpingTrade schema. The model uses Mongoose's
      // strict:false default for unknown paths so writes are
      // accepted via assignment.
      if (!Number.isFinite(trade.entrySpot)) {
        // Fall back to current spot when entry-time spot wasn't
        // recorded — best we can do; future-proof by stamping
        // it on creation in executionEngine.adapter.
        trade.entrySpot = spotNow;
      }
      const currentPremium = _modelCurrentPremium(trade, spotNow);
      const exitReason = _resolveExitReason(trade, currentPremium);
      if (exitReason) {
        await _closeTrade(trade, currentPremium, exitReason);
        closed += 1;
      } else {
        await _updateTrade(trade, currentPremium);
        updated += 1;
      }
    } catch (err) {
      logger.warn(
        {
          module: 'tradeMonitor.adapter',
          tradeId: String(trade && trade._id),
          err: err && err.message,
        },
        '[tradeMonitor.adapter] per-trade monitor failed',
      );
    }
  }
  return { checked: openTrades.length, closed, updated };
}

module.exports = {
  runMonitorCycle,
};
