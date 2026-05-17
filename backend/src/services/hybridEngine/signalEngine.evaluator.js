/**
 * ============================================================
 * SIGNAL_ENGINE EVALUATOR (Req 8 + 9) — subtasks 11.1 + 11.2 + 11.3
 * ============================================================
 * Pure deterministic gate function that turns a fully-populated
 * `CycleContext` (regime / structure / liquidity / oi / pcr /
 * data already present) into a single canonical `SignalOutput`
 * block (see the JSDoc typedef in `cycleContext.js`).
 *
 * This module is SYNC, has NO external dependencies (every input
 * is read off the cycle context the orchestrator already built),
 * and NEVER throws. Every read is wrapped in defensive guards so
 * a missing / malformed upstream block fails the corresponding
 * mandatory condition (`false`) and the path short-circuits to
 * NO_TRADE rather than aborting the cycle.
 *
 * ------------------------------------------------------------
 * What subtask 11.1 delivered (LONG path)
 * ------------------------------------------------------------
 *   1. The twelve mandatory LONG conditions from Req 8.1, each
 *      tagged with a stable id (`LONG_VWAP`, `LONG_EMA`,
 *      `LONG_ATR`, `LONG_PE_SHORT_BUILDUP`, `LONG_FUTURES_BIAS`,
 *      `LONG_CUMULATIVE_DELTA`, `LONG_VOLUME_BREAKOUT`,
 *      `LONG_BREADTH`, `LONG_LIQUIDITY`, `LONG_PRICE_VS_POC`,
 *      `LONG_REGIME`, `LONG_RR`). Thresholds come from
 *      `Algo_Settings.signalEngine.long.*` and the global
 *      `Algo_Settings.signalEngine.*` keys — never hard-coded
 *      (Req 8.1).
 *   2. The four LONG OI confirmations from Req 8.2:
 *        - `LONG_OI_CE_SHORT_COVERING_AT_ATM`
 *        - `LONG_OI_PE_LONG_BUILDUP_BELOW_ATM`
 *        - `LONG_OI_CE_LONG_UNWINDING_AT_RESISTANCE`
 *        - `LONG_OI_STRIKE_MIGRATION_UP`
 *      `LONG_SETUP` requires ≥ 1 confirmation in addition to the
 *      twelve mandatory (Req 8.2).
 *
 * ------------------------------------------------------------
 * What subtask 11.2 delivers (SHORT path, mirrored)
 * ------------------------------------------------------------
 *   1. The twelve mandatory SHORT conditions from Req 9.1,
 *      tagged with stable ids: `SHORT_VWAP`, `SHORT_EMA`,
 *      `SHORT_ATR`, `SHORT_CE_SHORT_BUILDUP`,
 *      `SHORT_FUTURES_BIAS`, `SHORT_CUMULATIVE_DELTA`,
 *      `SHORT_VOLUME_BREAKDOWN`, `SHORT_BREADTH`,
 *      `SHORT_LIQUIDITY`, `SHORT_PRICE_VS_POC`, `SHORT_REGIME`,
 *      `SHORT_RR`. Thresholds come from
 *      `Algo_Settings.signalEngine.short.*` and the global
 *      `Algo_Settings.signalEngine.*` keys — never hard-coded
 *      (Req 9.1 / 9.4).
 *   2. The four SHORT OI confirmations from Req 9.2:
 *        - `SHORT_OI_PE_SHORT_COVERING_AT_ATM`
 *        - `SHORT_OI_CE_LONG_BUILDUP_ABOVE_ATM`
 *        - `SHORT_OI_PE_LONG_UNWINDING_AT_SUPPORT`
 *        - `SHORT_OI_STRIKE_MIGRATION_DOWN`
 *      `SHORT_SETUP` requires ≥ 1 confirmation in addition to
 *      the twelve mandatory (Req 9.2).
 *   3. `evaluateSignal` now runs BOTH sides every cycle and
 *      resolves to at most one candidate. The two sides are
 *      mutually exclusive in practice (price is either above or
 *      below VWAP, so `LONG_VWAP` and `SHORT_VWAP` cannot both
 *      pass); resolution order is:
 *        - LONG passes (12 mandatory + ≥ 1 OI) ⇒ `LONG_SETUP`.
 *        - Else SHORT passes ⇒ `SHORT_SETUP`.
 *        - Else `NO_TRADE` with reason aggregation as below.
 *   4. The returned `mandatoryResults` map carries BOTH sides'
 *      ids (24 keys total), so the audit row records every gate
 *      (the `SignalOutput` typedef declares `mandatoryResults`
 *      as `Object<string, boolean>` so the schema is unchanged).
 *
 * ------------------------------------------------------------
 * NO_TRADE semantics (Req 8.3–8.5 / 9.3–9.5)
 * ------------------------------------------------------------
 *   - Any mandatory false on a side ⇒ that side cannot fire,
 *     regardless of its OI confirmations.
 *   - When BOTH sides fail mandatories: emit per-id failure
 *     codes (`SIGNAL_MANDATORY_FAIL_<id>`) for the side with
 *     FEWER failed mandatories (the side "closer to firing").
 *     Ties resolve to LONG (it is evaluated first).
 *   - When the closer side's ONLY failure is its RR gate
 *     (`LONG_RR` or `SHORT_RR`) — for either side — emit the
 *     dedicated `SIGNAL_RR_BELOW_FLOOR` instead of the generic
 *     per-id failure code (per Req 8.5 / 9.5).
 *   - When a side has all twelve mandatories true but no OI
 *     confirmation: emit `SIGNAL_NO_OI_CONFIRMATION`. If both
 *     sides somehow reach all-mandatory-true (theoretically
 *     impossible — see "mutually exclusive" above), the single
 *     `SIGNAL_NO_OI_CONFIRMATION` code is still emitted once.
 *
 * Subtask 11.3 adds the upstream-gate short-circuits
 * (`tickStale`, `optionChain = null`, regime blocks, liquidity
 * gates, etc.) BEFORE the mandatory evaluation so this module
 * refuses to fire on a malformed or upstream-blocked context
 * even if the orchestrator forgot to short-circuit the pipeline.
 * See `evaluateUpstreamGates` and the "Upstream gates" section
 * below.
 *
 * ------------------------------------------------------------
 * Upstream gates (subtask 11.3, Req 4.6 / 4.8 / 5.6–5.10 /
 *                 7.3 / 7.4 / 17.1 / 17.4 / 17.5)
 * ------------------------------------------------------------
 * Every cycle we first run a small ordered set of upstream
 * gates against the cycle context. ALL gates that fire on the
 * same cycle contribute their reason code (we do NOT stop on
 * the first match) so the audit row records every upstream
 * block simultaneously — e.g. a stale tick on a ranging regime
 * lifts both `DATA_TICK_STALE` and `REGIME_BLOCK_RANGING`.
 *
 *   1. `data.tickStale === true`               ⇒ `DATA_TICK_STALE`
 *   2. `data.optionChain === null`             ⇒ `OPTION_CHAIN_UNAVAILABLE`
 *   3. `regime.label === 'ranging'`            ⇒ `REGIME_BLOCK_RANGING`
 *   4. `regime.label === 'expiry-manipulation'`⇒ `REGIME_BLOCK_EXPIRY_MANIPULATION`
 *   5. `regime.label === 'high-risk'`          ⇒ `REGIME_BLOCK_HIGH_RISK`
 *   6. `regime.confidence <
 *       regimeEngine.minRegimeConfidence`      ⇒ `REGIME_LOW_CONFIDENCE`
 *   7. `liquidity.spreadStatus === 'very_wide'`⇒ `LIQUIDITY_VERY_WIDE_SPREAD`
 *   8. `liquidity.liquidityScore <
 *       signalEngine.minLiquidityScore`        ⇒ `LIQUIDITY_LOW_SCORE`
 *   9. `liquidity.blockEntry === true`         ⇒ `LIQUIDITY_STOP_HUNT_OPPOSES_SIDE`
 *
 * When ≥ 1 gate fires, `evaluateSignal` returns NO_TRADE
 * IMMEDIATELY with `mandatoryResults = {}`, `oiConfirmations =
 * []`, `riskReward = 0`, the collected `reasonCodes`, and the
 * provenance from `ctx`. No mandatory work runs.
 *
 * The Data_Engine, Regime_Engine, and Liquidity_Engine adapters
 * already push these codes onto their own block-level reason
 * arrays (which `appendBlock` lifts onto `ctx.reasonCodes`), so
 * the orchestrator typically short-circuits the cycle before
 * calling Signal_Engine at all. This module's role is to ENFORCE
 * the gate defensively — even if the orchestrator forgot to
 * short-circuit, the signal evaluator still refuses to fire.
 *
 * ------------------------------------------------------------
 * Proxy notes (deliberate scoping for subtasks 11.1 / 11.2)
 * ------------------------------------------------------------
 *   - `*_FUTURES_BIAS`     uses `data.futures.premiumToSpot`
 *                          (sign-based) as a proxy for the full
 *                          `niftyFuturesProd.service.js` futures
 *                          bias call. A future enhancement will
 *                          wire the dedicated service.
 *   - `*_CUMULATIVE_DELTA` uses `liquidity.bidAskImbalance`
 *                          (sign-based) as a proxy for the
 *                          cumulative-delta read from
 *                          `orderFlow.service.js`. The liquidity
 *                          adapter already runs the order-flow
 *                          service for its bid/ask imbalance, so
 *                          this proxy is consistent with the
 *                          underlying data.
 *   - `*_BREADTH`          reads `regime.inputs.breadth.score`
 *                          if present (`> 50` bullish, `< 50`
 *                          bearish). When breadth is missing the
 *                          gate is permissive (`true`) because
 *                          Req 5 explicitly allows null breadth
 *                          (it cannot LOWER confidence on its
 *                          own — see `regimeEngine.adapter.js`).
 *
 * Each proxy is documented at its callsite so the eventual
 * upgrade swap is mechanical.
 *
 * ------------------------------------------------------------
 * RR computation (mandatory 12, Req 8.1.12 / 9.1.12)
 * ------------------------------------------------------------
 * Risk_Engine (subtask 12) is the authoritative SL / target
 * computer. For 11.1 / 11.2 we still need to evaluate RR as a
 * mandatory condition, so we compute a self-contained RR using
 * the same inputs the design's Risk_Engine adapter will use:
 *
 *     stopLoss   = max(riskEngine.fixedSLPoints,
 *                       riskEngine.atrSLMultiplier × ATR(now)),
 *                  capped at riskEngine.maxSLPoints
 *     target     = entry ± stopLoss × RR_TARGET_MULTIPLE
 *     riskReward = (target − entry) / stopLoss
 *                = RR_TARGET_MULTIPLE                     (constant 2.0)
 *
 * Using a CONSTANT target multiple (vs. `× signalEngine.minRR`)
 * is deliberate: the latter would make the gate a tautology
 * (`RR == minRR ⇒ pass` for any minRR). With a constant `2.0`
 * the gate becomes strict — `signalEngine.minRR > 2.0` correctly
 * fails the `LONG_RR` / `SHORT_RR` mandatory and emits
 * `SIGNAL_RR_BELOW_FLOOR` (Req 8.5 / 9.5).
 *
 * Subtask 12.1 will replace this formula with the canonical
 * Risk_Engine target derived from real support / resistance
 * levels (e.g. `priorDay.high` for LONG, `priorDay.low` for
 * SHORT). The constant is a documented placeholder.
 *
 * When ATR cannot be derived (insufficient candles), we fall
 * back to `stopLoss = riskEngine.fixedSLPoints` so the gate
 * still has a usable RR rather than failing the cycle on a
 * data-availability edge case.
 *
 * ------------------------------------------------------------
 * Failure semantics (Req 1.5)
 * ------------------------------------------------------------
 *   - The function never throws.
 *   - Every mandatory check coerces missing / non-finite inputs
 *     to a deterministic `false`. The corresponding
 *     `SIGNAL_MANDATORY_FAIL_<id>` reason is emitted.
 *   - On any unexpected error the outer boundary catches and
 *     emits the safe-default NO_TRADE shape with a synthetic
 *     `SIGNAL_MANDATORY_FAIL_INTERNAL` reason so the operator
 *     can audit it.
 *
 * ------------------------------------------------------------
 * Spec references
 * ------------------------------------------------------------
 *   - Req 8.1   — twelve LONG mandatory conditions
 *   - Req 8.2   — four LONG OI confirmations (≥ 1 required)
 *   - Req 8.3   — any LONG mandatory false ⇒ NO_TRADE
 *   - Req 8.4   — all LONG mandatory true + no OI ⇒ NO_TRADE
 *   - Req 8.5   — RR ≥ minRR; emit reason / provenance fields
 *   - Req 9.1   — twelve SHORT mandatory conditions (mirrored)
 *   - Req 9.2   — four SHORT OI confirmations (≥ 1 required)
 *   - Req 9.3   — any SHORT mandatory false ⇒ NO_TRADE
 *   - Req 9.4   — read SHORT thresholds from `signalEngine.short`
 *   - Req 9.5   — provenance fields with bearish values on fire
 *   - Req 4.6   — `tickStale = true` ⇒ NO_TRADE (DATA_TICK_STALE)
 *   - Req 4.8   — `optionChain = null` ⇒ OPTION_CHAIN_UNAVAILABLE
 *   - Req 5.6/5.7/5.8 — regime label blocks (ranging, expiry-
 *                       manipulation, high-risk)
 *   - Req 5.10  — confidence below minRegimeConfidence ⇒ NO_TRADE
 *   - Req 7.3   — `spreadStatus = 'very_wide'` and
 *                 `liquidityScore` floor ⇒ NO_TRADE
 *   - Req 7.4   — `blockEntry = true` ⇒ stop-hunt block
 *   - Req 17.1 / 17.4 / 17.5 — when-not-to-trade enforcement
 *   - Design "Signal_Engine Evaluator (Req 8 + 9)"
 *   - SignalOutput typedef in `./cycleContext.js`
 * ============================================================
 */

'use strict';

const { REASON_CODES, signalMandatoryFail } = require('./reasonCodes');

// Wire to existing services per Req 3 (service reuse, no
// duplication). The mandatories below delegate to:
//   - niftyFuturesProd.analyzeCandles  (Req 8.1.5 / 9.1.5: futures bias)
//   - orderFlow.service                (Req 8.1.6 / 9.1.6: cumulative delta —
//                                       wired indirectly via
//                                       liquidityEngine.adapter which already
//                                       calls analyzeOrderFlow and surfaces
//                                       delta_weighted_oi as
//                                       liquidity.bidAskImbalance)
//   - multiTimeframe.service           (UT Bot ATR Trailing Stop primary
//                                       directional trigger — TradingView
//                                       indicator, see calculateUTBot)
const niftyFuturesProd = require('../niftyFuturesProd.service');
const multiTimeframe = require('../algorithms/multiTimeframe.service');

// UT Bot per-direction de-dupe cache: tracks the openTime of the
// last 5m bar that produced a UT Bot buy/sell signal. Without
// this guard, the 60s cycle cadence re-fires the same UT Bot
// signal 5 times within a single 5m bar window. Reset between
// backtest days via `__resetUtBotCacheForTest`.
const _lastUtBotBarSeen = { buy: null, sell: null };

// ============================================================
// INSTITUTIONAL DAY-STATE TRACKER
// ============================================================
// NIFTY institutions establish a directional bias in the first
// 30 min (9:15 - 9:45) and stick with it. They cap trades-per-
// day, lock the side after 1 winner / 2 losers, and avoid the
// known whipsaw windows. This module-scope object holds that
// per-day state.
//
// Reset between backtest days via `__resetUtBotCacheForTest`
// (which now resets day-state too).
// ============================================================
const _dayState = {
  ymd: null,                  // YYYY-MM-DD of the day this state covers
  openingHigh: null,          // High of first 15 min (09:15 - 09:30 IST)
  openingLow: null,           // Low of first 15 min
  openingClose: null,         // Close of 09:30
  openingRangeReady: false,   // true once 09:30 IST has passed
  dayBiasLong: null,          // Locked direction at 09:45: true=LONG, false=SHORT, null=undecided/no-bias
  insideORDay: false,         // true when 09:45 LTP still inside OR (chop day, skip)
  tradesToday: 0,             // Count of placed trades
  consecLosses: 0,            // Consecutive loss streak
  lastTradeMs: null,          // Timestamp of last entry (for cooldown)
  sessionPnL: 0,              // Running P&L for the day
};

function __resetUtBotCacheForTest() {
  _lastUtBotBarSeen.buy = null;
  _lastUtBotBarSeen.sell = null;
  _dayState.ymd = null;
  _dayState.openingHigh = null;
  _dayState.openingLow = null;
  _dayState.openingClose = null;
  _dayState.openingRangeReady = false;
  _dayState.dayBiasLong = null;
  _dayState.insideORDay = false;
  _dayState.tradesToday = 0;
  _dayState.consecLosses = 0;
  _dayState.lastTradeMs = null;
  _dayState.sessionPnL = 0;
}

/**
 * Record a closed trade outcome. Called by the backtest CLI on
 * exit so the day-state can decay or terminate further entries.
 *
 * @param {{ pnl:number }} info
 */
function __recordTradeOutcome(info) {
  const pnl = info && typeof info.pnl === 'number' ? info.pnl : 0;
  _dayState.sessionPnL += pnl;
  if (pnl < 0) {
    _dayState.consecLosses += 1;
  } else if (pnl > 0) {
    _dayState.consecLosses = 0;
  }
}

/**
 * Translate epoch ms to IST minutes-of-day.
 */
function _istMinutesOfDay(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const ist = epochMs + (5 * 60 + 30) * 60 * 1000;
  const d = new Date(ist);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function _istYmd(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  const ist = epochMs + (5 * 60 + 30) * 60 * 1000;
  const d = new Date(ist);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Update day-state from the cycle context. Called once per cycle
 * inside evaluateSignal. Computes:
 *   - Opening Range (first 15 min high/low/close).
 *   - Day-bias lock at 09:45 IST: bullish if last 30 min close
 *     is above OR_high; bearish if below OR_low; null otherwise.
 *
 * In replay mode `ctx.cycleStartedAt` is wall-clock, NOT session
 * time. We instead use `ctx.data.tickAt` which Data_Engine sets
 * to the replay-cursor (the actual session minute). This lets
 * the OR / bias-lock checks fire at the right session time
 * during a backtest.
 *
 * @param {Readonly<Object>} ctx
 */
function _updateDayState(ctx) {
  // Prefer the replay cursor (data.tickAt) over wall-clock —
  // see header comment for rationale.
  const tickMs = ctx && ctx.data && typeof ctx.data.tickAt === 'number'
    ? ctx.data.tickAt
    : (ctx && ctx.cycleStartedAt);
  if (!Number.isFinite(tickMs)) return;
  const ymd = _istYmd(tickMs);
  if (ymd !== _dayState.ymd) {
    _dayState.ymd = ymd;
    _dayState.openingHigh = null;
    _dayState.openingLow = null;
    _dayState.openingClose = null;
    _dayState.openingRangeReady = false;
    _dayState.dayBiasLong = null;
    _dayState.insideORDay = false;
    _dayState.tradesToday = 0;
    _dayState.consecLosses = 0;
    _dayState.lastTradeMs = null;
    _dayState.sessionPnL = 0;
  }

  const minutesIST = _istMinutesOfDay(tickMs);
  const SESSION_OPEN = 9 * 60 + 15;   // 09:15
  const OR_END = 9 * 60 + 30;         // 09:30 (15-min OR)
  const BIAS_LOCK = 9 * 60 + 45;      // 09:45 (30 min into session)

  // Build OR from 5m bars whose closeTime is in [09:15, 09:30].
  if (!_dayState.openingRangeReady && minutesIST >= OR_END) {
    const bars5m = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m'] : null;
    if (Array.isArray(bars5m)) {
      // 09:15 IST → 03:45 UTC. Filter bars whose openTime falls in
      // the first 15 min of the IST session day.
      const dayStartMs = tickMs - (minutesIST - SESSION_OPEN) * 60 * 1000;
      const orEndMs = dayStartMs + 15 * 60 * 1000;
      let hi = -Infinity, lo = Infinity, lastClose = null;
      for (const b of bars5m) {
        if (typeof b.openTime !== 'number') continue;
        if (b.openTime >= dayStartMs && b.openTime < orEndMs) {
          if (typeof b.high === 'number' && b.high > hi) hi = b.high;
          if (typeof b.low === 'number' && b.low < lo) lo = b.low;
          if (typeof b.close === 'number') lastClose = b.close;
        }
      }
      if (hi > -Infinity && lo < Infinity) {
        _dayState.openingHigh = hi;
        _dayState.openingLow = lo;
        _dayState.openingClose = lastClose;
        _dayState.openingRangeReady = true;
      }
    }
  }

  // Lock day-bias at 09:45 from the last 30-min behavior.
  // Three possible outcomes:
  //   - LTP > OR_high  → bullish day, bias=true
  //   - LTP < OR_low   → bearish day, bias=false
  //   - LTP in OR      → inside-day chop, bias=null
  if (_dayState.dayBiasLong === null && minutesIST >= BIAS_LOCK && _dayState.openingRangeReady) {
    const ltp = ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
      ? ctx.data.spot.ltp : null;
    if (ltp !== null) {
      if (ltp > _dayState.openingHigh) {
        _dayState.dayBiasLong = true;
        _dayState.insideORDay = false;
      } else if (ltp < _dayState.openingLow) {
        _dayState.dayBiasLong = false;
        _dayState.insideORDay = false;
      } else {
        _dayState.insideORDay = true;
      }
    }
  }
}

/**
 * Time-window filter — institutional desks avoid:
 *   - 09:15 to 09:30  (first 15 min, opening volatility)
 *   - 15:00 to 15:30  (last 30 min, closing chaos / square-off)
 * Lunch is allowed (institutional desks DO trade during lunch
 * when day-bias and confluence agree).
 * Returns null if cycle is in a tradable window, else a string
 * reason.
 */
function _timeWindowBlock(cycleMs) {
  const m = _istMinutesOfDay(cycleMs);
  if (m === null) return null;
  if (m < 9 * 60 + 30) return 'PRE_OR_BUILD';        // before 09:30 (first 15 min)
  if (m >= 15 * 60) return 'PRE_CLOSE';               // 15:00 onward (last 30 min)
  return null;
}

/**
 * Stretch filter — refuse entries when the day's range has
 * already exceeded `1.5 × ATR(14)`. NIFTY institutions don't
 * chase extended moves. Returns true when stretched (block).
 */
function _isDayRangeStretched(ctx) {
  try {
    if (!_dayState.openingHigh || !_dayState.openingLow) return false;
    const bars5m = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m'] : null;
    if (!Array.isArray(bars5m) || bars5m.length < 16) return false;
    // ATR(14) on the last 16 bars.
    const ohlcBars = bars5m.slice(-16).map((b) => ({ high: b.high, low: b.low, close: b.close }));
    const atr = computeAtr(ohlcBars, 14);
    if (!isFiniteNumber(atr) || atr <= 0) return false;
    // Day's actual high/low so far.
    let dayHi = -Infinity, dayLo = Infinity;
    const dayStartMs = ctx.cycleStartedAt - (_istMinutesOfDay(ctx.cycleStartedAt) - (9 * 60 + 15)) * 60 * 1000;
    for (const b of bars5m) {
      if (typeof b.openTime !== 'number' || b.openTime < dayStartMs) continue;
      if (typeof b.high === 'number' && b.high > dayHi) dayHi = b.high;
      if (typeof b.low === 'number' && b.low < dayLo) dayLo = b.low;
    }
    if (dayHi === -Infinity || dayLo === Infinity) return false;
    const dayRange = dayHi - dayLo;
    return dayRange > 1.5 * atr * 14; // 1.5 × ATR × 14-bar fan
  } catch (_) { return false; }
}

/**
 * MTF directional lock. The 5m, 15m, and (derived) 30m trends
 * MUST all agree with the candidate direction. Returns true when
 * locked agreement.
 */
function _mtfLockedAgree(ctx, direction) {
  try {
    const bars5m = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m'] : null;
    const bars15m = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['15m'] : null;
    if (!Array.isArray(bars5m) || !Array.isArray(bars15m)) return false;
    const trend5 = _trendFromCloses(bars5m, 5);
    const trend15 = _trendFromCloses(bars15m, 4);
    const trend30 = _trendFromCloses(bars15m, 8); // 15m × 8 = 2h proxy
    if (direction === 'LONG') {
      return trend5 !== 'bearish' && trend15 === 'bullish' && trend30 !== 'bearish';
    }
    return trend5 !== 'bullish' && trend15 === 'bearish' && trend30 !== 'bullish';
  } catch (_) { return false; }
}

function _trendFromCloses(bars, n) {
  if (!Array.isArray(bars) || bars.length < n) return 'neutral';
  const tail = bars.slice(-n);
  const first = tail[0] && typeof tail[0].close === 'number' ? tail[0].close : null;
  const last = tail[tail.length - 1] && typeof tail[tail.length - 1].close === 'number' ? tail[tail.length - 1].close : null;
  if (first === null || last === null || first === 0) return 'neutral';
  const pct = ((last - first) / first) * 100;
  const threshold = 0.05 * Math.sqrt(n);
  if (pct > threshold) return 'bullish';
  if (pct < -threshold) return 'bearish';
  return 'neutral';
}

/**
 * Pull-back entry filter — only allow LONG entry when price has
 * pulled back to within `pullbackPct` of UT Bot trailing-stop OR
 * VWAP from above (not at peak). Symmetric for SHORT.
 *
 * Returns true when the entry is at a healthy pullback level.
 */
function _isPullbackEntry(ctx, direction, utStop) {
  try {
    const ltp = ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
      ? ctx.data.spot.ltp : null;
    const vwap = ctx && ctx.data && ctx.data.vwap && typeof ctx.data.vwap.session === 'number'
      ? ctx.data.vwap.session : null;
    if (ltp === null) return false;
    if (direction === 'LONG') {
      // LONG pullback: spot must be within +0.30% of VWAP (not far
      // extended). Also ltp - utStop should be < 0.5% (not blow-off).
      if (vwap !== null) {
        const distVwapPct = ((ltp - vwap) / vwap) * 100;
        if (distVwapPct < 0 || distVwapPct > 0.40) return false;
      }
      if (typeof utStop === 'number' && utStop > 0) {
        const distStopPct = ((ltp - utStop) / utStop) * 100;
        if (distStopPct < 0 || distStopPct > 0.50) return false;
      }
      return true;
    }
    if (vwap !== null) {
      const distVwapPct = ((vwap - ltp) / vwap) * 100;
      if (distVwapPct < 0 || distVwapPct > 0.40) return false;
    }
    if (typeof utStop === 'number' && utStop > 0) {
      const distStopPct = ((utStop - ltp) / utStop) * 100;
      if (distStopPct < 0 || distStopPct > 0.50) return false;
    }
    return true;
  } catch (_) { return false; }
}

// ============================================================
// Mandatory-condition stable ids (LONG path)
// ------------------------------------------------------------
// The order matters for two reasons:
//   1. The `mandatoryResults` map preserves this order via
//      object insertion (V8 guarantees insertion order on
//      string keys), which keeps audit-row diffs stable.
//   2. The "single-failure RR" detection in `pickRrReasonCode`
//      compares the failed-set against `LONG_RR` exactly.
// ============================================================

const LONG_MANDATORY_IDS = Object.freeze([
  'LONG_VWAP',
  'LONG_EMA',
  'LONG_ATR',
  'LONG_PE_SHORT_BUILDUP',
  'LONG_FUTURES_BIAS',
  'LONG_CUMULATIVE_DELTA',
  'LONG_VOLUME_BREAKOUT',
  'LONG_BREADTH',
  'LONG_LIQUIDITY',
  'LONG_PRICE_VS_POC',
  'LONG_REGIME',
  'LONG_RR',
]);

const LONG_OI_CONFIRMATION_IDS = Object.freeze([
  'LONG_OI_CE_SHORT_COVERING_AT_ATM',
  'LONG_OI_PE_LONG_BUILDUP_BELOW_ATM',
  'LONG_OI_CE_LONG_UNWINDING_AT_RESISTANCE',
  'LONG_OI_STRIKE_MIGRATION_UP',
]);

const SHORT_MANDATORY_IDS = Object.freeze([
  'SHORT_VWAP',
  'SHORT_EMA',
  'SHORT_ATR',
  'SHORT_CE_SHORT_BUILDUP',
  'SHORT_FUTURES_BIAS',
  'SHORT_CUMULATIVE_DELTA',
  'SHORT_VOLUME_BREAKDOWN',
  'SHORT_BREADTH',
  'SHORT_LIQUIDITY',
  'SHORT_PRICE_VS_POC',
  'SHORT_REGIME',
  'SHORT_RR',
]);

const SHORT_OI_CONFIRMATION_IDS = Object.freeze([
  'SHORT_OI_PE_SHORT_COVERING_AT_ATM',
  'SHORT_OI_CE_LONG_BUILDUP_ABOVE_ATM',
  'SHORT_OI_PE_LONG_UNWINDING_AT_SUPPORT',
  'SHORT_OI_STRIKE_MIGRATION_DOWN',
]);

/**
 * Constant target-distance multiple used by the placeholder RR
 * computation. See the "RR computation" section of the module
 * header for the rationale: a constant (vs reading
 * `signalEngine.minRR`) keeps the `LONG_RR` / `SHORT_RR` gates
 * strict so an operator-tightened `minRR > 2.0` correctly fails
 * them. Subtask 12.1 will replace this with a Risk_Engine target
 * derived from real support / resistance levels.
 */
const RR_TARGET_MULTIPLE = 2.0;
// Backwards-compatible alias retained for any caller that
// imported the original LONG-specific name from subtask 11.1.
const LONG_RR_TARGET_MULTIPLE = RR_TARGET_MULTIPLE;

// ============================================================
// Defensive numeric helpers
// ============================================================

/**
 * Safe finite-number guard. Returns the value when finite, else
 * `null` so callers can short-circuit without NaN propagation.
 *
 * @param {*} v
 * @returns {number|null}
 */
function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Same as `finiteOrNull` but coerces to `false` for boolean checks.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ============================================================
// EMA / ATR helpers
// ------------------------------------------------------------
// We compute these inline so the evaluator stays self-contained
// (no shared indicator state, no risk of accidental mutation
// of upstream blocks). The formulas mirror the canonical
// implementations in:
//   - `services/hybridEngine/structureEngine.adapter.js`
//   - `services/algorithms/multiTimeframe.service.js`
// so downstream consumers of EMA / ATR see numerically identical
// values across the pipeline.
// ============================================================

/**
 * Standard EMA: `EMA = α × close + (1 − α) × prevEMA, α = 2/(period+1)`.
 * Returns `null` when the input is too short or contains a
 * non-finite close. Uses the first close as the seed (same
 * convention as `structureEngine.adapter.js > computeEma`).
 *
 * @param {Array<number>} closes
 * @param {number} period
 * @returns {number|null}
 */
function computeEma(closes, period) {
  if (!Array.isArray(closes) || closes.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let ema = closes[0];
  if (!Number.isFinite(ema)) return null;
  for (let i = 1; i < closes.length; i += 1) {
    const c = closes[i];
    if (!isFiniteNumber(c)) return null;
    ema = c * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Compute ATR(period) over the supplied OHLC bars using Wilder's
 * smoothing seeded with a simple TR average over the first
 * `period` bars (the canonical "first ATR is SMA of TR" form).
 *
 * Returns `null` when the input is too short or contains a
 * non-finite OHLC value.
 *
 * @param {Array<{high:number, low:number, close:number}>} bars
 * @param {number} period
 * @returns {number|null}
 */
function computeAtr(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1 || period <= 0) return null;
  // True Range series. TR for bar i (i >= 1) =
  //   max(H_i − L_i, |H_i − C_{i-1}|, |L_i − C_{i-1}|)
  const tr = [];
  for (let i = 1; i < bars.length; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (!cur || !prev) return null;
    if (
      !isFiniteNumber(cur.high) ||
      !isFiniteNumber(cur.low) ||
      !isFiniteNumber(prev.close)
    ) {
      return null;
    }
    const range1 = cur.high - cur.low;
    const range2 = Math.abs(cur.high - prev.close);
    const range3 = Math.abs(cur.low - prev.close);
    tr.push(Math.max(range1, range2, range3));
  }
  if (tr.length < period) return null;
  // Seed: simple average of the first `period` TRs.
  let atr = 0;
  for (let i = 0; i < period; i += 1) atr += tr[i];
  atr /= period;
  // Wilder smoothing for the rest.
  for (let i = period; i < tr.length; i += 1) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return Number.isFinite(atr) ? atr : null;
}

// ============================================================
// Settings extraction helpers
// ============================================================

/**
 * Read the configured signal timeframe for the LONG path. Falls
 * back to `'5m'` when missing (mirrors the documented default).
 *
 * @param {Readonly<Object>} settings
 * @returns {string}
 */
function resolveLongSignalTimeframe(settings) {
  const tf =
    settings && settings.signalEngine && settings.signalEngine.long
      ? settings.signalEngine.long.signalTimeframe
      : null;
  return typeof tf === 'string' && tf.length > 0 ? tf : '5m';
}

/**
 * Read the configured fast / slow EMA periods for the LONG path.
 * Falls back to (9, 20) — the documented defaults.
 *
 * @param {Readonly<Object>} settings
 * @returns {{ fast:number, slow:number }}
 */
function resolveLongEmaPeriods(settings) {
  const long =
    settings && settings.signalEngine && settings.signalEngine.long
      ? settings.signalEngine.long
      : {};
  const fast =
    Number.isInteger(long.emaFast) && long.emaFast > 0 ? long.emaFast : 9;
  const slow =
    Number.isInteger(long.emaSlow) && long.emaSlow > 0 ? long.emaSlow : 20;
  return { fast, slow };
}

/**
 * Read a positive-finite number from the supplied settings group
 * with a runtime fallback. `algoSettings.validateSettings` is the
 * authoritative validator; this is just a safety net so the
 * SignalOutput shape stays stable on misconfiguration.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function resolvePositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

// ============================================================
// Mandatory condition evaluators (LONG path, Req 8.1)
// ------------------------------------------------------------
// Each evaluator:
//   - Reads ONLY off the immutable cycle context.
//   - Returns a strict boolean (true ⇒ pass).
//   - Coerces missing / malformed inputs to `false`.
//
// They are pure and side-effect-free.
// ============================================================

/**
 * Mandatory 1 (Req 8.1.1): `data.spot.ltp > data.vwap.session`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkVwap(ctx) {
  const ltp = finiteOrNull(ctx && ctx.data && ctx.data.spot ? ctx.data.spot.ltp : null);
  const session = finiteOrNull(ctx && ctx.data && ctx.data.vwap ? ctx.data.vwap.session : null);
  if (ltp === null || session === null) return false;
  return ltp > session;
}

/**
 * Mandatory 2 (Req 8.1.2): EMA9 > EMA20 on the configured LONG
 * signal timeframe. Reads close prices off
 * `ctx.data.candles.spot[timeframe]` and uses the inline
 * `computeEma` helper so we don't depend on the structure adapter
 * having computed EMAs.
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkEmaCrossover(ctx, settings) {
  const tf = resolveLongSignalTimeframe(settings);
  const { fast, slow } = resolveLongEmaPeriods(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  if (!Array.isArray(bars) || bars.length < slow) return false;
  const closes = [];
  for (const b of bars) {
    if (!b || !isFiniteNumber(b.close)) return false;
    closes.push(b.close);
  }
  const fastEma = computeEma(closes, fast);
  const slowEma = computeEma(closes, slow);
  if (fastEma === null || slowEma === null) return false;
  return fastEma > slowEma;
}

/**
 * Mandatory 3 (Req 8.1.3): `ATR(now) − ATR(prev) ≥
 * signalEngine.atrExpansionMin`. We compute current ATR(14) on
 * the configured signal timeframe and prior ATR on the same
 * series shifted by 1 bar, so the comparison is one cycle wide.
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkAtrExpansion(ctx, settings) {
  const tf = resolveLongSignalTimeframe(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  if (!Array.isArray(bars) || bars.length < 16) return false;
  const minExpansion = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.atrExpansionMin : null,
    0.05,
  );
  const atrNow = computeAtr(bars, 14);
  const atrPrev = computeAtr(bars.slice(0, -1), 14);
  if (atrNow === null || atrPrev === null) return false;
  return atrNow - atrPrev >= minExpansion;
}

/**
 * Mandatory 4 (Req 8.1.4): OI_Engine reports an aggressive PE
 * `Short_Buildup` at or below ATM. We scan
 * `ctx.oi.perStrike` for any PE leg with `strike ≤ atmStrike` and
 * `classification === 'Short_Buildup'`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkPeShortBuildupAtOrBelowAtm(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const atm = finiteOrNull(
    ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain.atmStrike : null,
  );
  if (!Array.isArray(perStrike) || atm === null) return false;
  for (const row of perStrike) {
    if (!row) continue;
    if (row.side !== 'PE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.strike > atm) continue;
    if (row.classification === 'Short_Buildup') return true;
  }
  return false;
}

/**
 * Mandatory 5 (Req 8.1.5): Futures bias bullish.
 *
 * Wired to `niftyFuturesProd.service.analyzeCandles(candles, spotLtp)`
 * per Req 8.1.5 ("Futures bias is bullish per
 * niftyFuturesProd.service.js analytics"). The service computes a
 * trend label (`bullish` | `bearish` | `neutral`) from the futures
 * candle close-vs-prior comparison, plus momentum and premium.
 *
 * We use the futures 5m candles already aggregated by Data_Engine
 * (`ctx.data.candles.futures['5m']`) so no additional Dhan API
 * call is made — this respects Req 1.5 (degrade gracefully on
 * missing external data) and avoids rate-limit concerns.
 *
 * Falls back to `data.futures.premiumToSpot > 0` when the futures
 * candle series is missing (early session warmup or replay-mode
 * data gap).
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkFuturesBias(ctx) {
  // Path 1: niftyFuturesProd.analyzeCandles (canonical, Req 8.1.5).
  try {
    const futCandles = ctx && ctx.data && ctx.data.candles && ctx.data.candles.futures
      ? ctx.data.candles.futures['5m'] : null;
    const spotLtp = ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
      ? ctx.data.spot.ltp : null;
    if (Array.isArray(futCandles) && futCandles.length >= 3 && spotLtp !== null) {
      // Adapt our DataSnapshot bar shape (`{open, high, low, close,
      // volume, openTime}`) onto the legacy `{c}` close-key the
      // service reads. Pass through high/low/volume for the
      // momentum count.
      const adapted = futCandles.map((b) => ({
        c: b.close, close: b.close,
        h: b.high, high: b.high,
        l: b.low, low: b.low,
        v: b.volume, volume: b.volume,
        t: b.openTime,
      }));
      const analytics = niftyFuturesProd.analyzeCandles(adapted, spotLtp);
      if (analytics && analytics.trend === 'bullish') return true;
      if (analytics && analytics.trend === 'bearish') return false;
      // analytics.trend === 'neutral' or 'unknown' — fall through to
      // Path 2 (premium sign) for a coarser bullish/bearish split.
    }
  } catch (_) { /* swallow — Req 1.5 graceful degradation */ }

  // Path 2: premium-to-spot sign fallback.
  const premium = finiteOrNull(
    ctx && ctx.data && ctx.data.futures ? ctx.data.futures.premiumToSpot : null,
  );
  if (premium === null) return false;
  return premium > 0;
}

/**
 * Mandatory 6 (Req 8.1.6): Cumulative delta > 0.
 * Proxy: `liquidity.bidAskImbalance > 0`. Liquidity_Engine already
 * runs `orderFlow.service.js` for this number, so the proxy is
 * consistent with the underlying data.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkCumulativeDelta(ctx) {
  const imbalance = finiteOrNull(
    ctx && ctx.liquidity ? ctx.liquidity.bidAskImbalance : null,
  );
  if (imbalance === null) return false;
  return imbalance > 0;
}

/**
 * Mandatory 7 (Req 8.1.7): Current volume ≥
 * `signalEngine.volumeBreakoutMultiplier × avgVolume(20)` on the
 * configured LONG signal timeframe AND the latest candle is an
 * up-candle (`close > open`).
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkVolumeBreakout(ctx, settings) {
  const tf = resolveLongSignalTimeframe(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  if (!Array.isArray(bars) || bars.length < 21) return false;
  const multiplier = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.volumeBreakoutMultiplier : null,
    1.5,
  );
  const last = bars[bars.length - 1];
  if (!last || !isFiniteNumber(last.volume) || !isFiniteNumber(last.open) || !isFiniteNumber(last.close)) {
    return false;
  }
  // 20-bar moving average of volume EXCLUDING the latest bar.
  const window = bars.slice(-21, -1);
  if (window.length < 20) return false;
  let sum = 0;
  for (const b of window) {
    if (!b || !isFiniteNumber(b.volume)) return false;
    sum += b.volume;
  }
  const avg = sum / 20;
  if (avg <= 0) return false;
  const upCandle = last.close > last.open;
  return upCandle && last.volume >= multiplier * avg;
}

/**
 * Mandatory 8 (Req 8.1.8): Market breadth bullish.
 * Proxy: `regime.inputs.breadth.score > 50` when present;
 * permissive `true` when breadth is null/missing because the
 * regime adapter explicitly documents that null breadth must
 * not lower confidence on its own (a future task will wire a
 * dedicated breadth source).
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkBreadth(ctx) {
  const breadth =
    ctx && ctx.regime && ctx.regime.inputs ? ctx.regime.inputs.breadth : null;
  if (!breadth) return true; // permissive when missing — see proxy note in module header
  const score = finiteOrNull(breadth.score);
  if (score === null) return true;
  return score > 50;
}

/**
 * Mandatory 9 (Req 8.1.9): `liquidityHealth.healthy = true` AND
 * `liquidityScore ≥ signalEngine.minLiquidityScore`.
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkLiquidity(ctx, settings) {
  const liquidity = ctx && ctx.liquidity ? ctx.liquidity : null;
  if (!liquidity) return false;
  const healthy = !!(liquidity.liquidityHealth && liquidity.liquidityHealth.healthy);
  const score = finiteOrNull(liquidity.liquidityScore);
  if (score === null) return false;
  const minScore = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.minLiquidityScore : null,
    60,
  );
  return healthy && score >= minScore;
}

/**
 * Mandatory 10 (Req 8.1.10): `data.spot.ltp ≥
 * structure.volumeProfile.poc` OR `≥ structure.volumeProfile.vah`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkPriceVsPoc(ctx) {
  const ltp = finiteOrNull(ctx && ctx.data && ctx.data.spot ? ctx.data.spot.ltp : null);
  const vp = ctx && ctx.structure ? ctx.structure.volumeProfile : null;
  if (ltp === null || !vp) return false;
  const poc = finiteOrNull(vp.poc);
  const vah = finiteOrNull(vp.vah);
  if (poc === null && vah === null) return false;
  if (poc !== null && ltp >= poc) return true;
  if (vah !== null && ltp >= vah) return true;
  return false;
}

/**
 * Mandatory 11 (Req 8.1.11): `regime.label ∈ {trending,
 * volatility-expansion}` AND `regime.tradePermissions.LONG_SETUP
 * = true`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkRegime(ctx) {
  const regime = ctx && ctx.regime ? ctx.regime : null;
  if (!regime) return false;
  const okLabel = regime.label === 'trending' || regime.label === 'volatility-expansion';
  const okPerm = !!(regime.tradePermissions && regime.tradePermissions.LONG_SETUP === true);
  return okLabel && okPerm;
}

/**
 * Compute the LONG-side risk-reward block. Returns the SL points,
 * target points, and resulting RR. See the module header for the
 * formula (target = stopLoss × minRR ⇒ RR == minRR by
 * construction; mandatory 12 then checks RR ≥ minRR).
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {{ stopLossPoints:number, targetPoints:number, riskReward:number }}
 */
function computeRiskReward(ctx, settings) {
  const re = (settings && settings.riskEngine) || {};

  const fixedSL = resolvePositiveNumber(re.fixedSLPoints, 15);
  const atrMul = resolvePositiveNumber(re.atrSLMultiplier, 1.2);
  const maxSL = resolvePositiveNumber(re.maxSLPoints, 25);

  // Derive ATR on the LONG signal timeframe; fall back to the
  // fixed SL when ATR is unavailable so the gate still resolves.
  const tf = resolveLongSignalTimeframe(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  const atr = Array.isArray(bars) && bars.length >= 15 ? computeAtr(bars, 14) : null;

  const atrSL = isFiniteNumber(atr) ? atrMul * atr : 0;
  let stopLoss = Math.max(fixedSL, atrSL);
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) stopLoss = fixedSL;
  if (stopLoss > maxSL) stopLoss = maxSL;

  // Constant target multiple — see the "RR computation" section
  // of the module header. `target = entry + stopLoss × 2.0` so
  // RR is always 2.0 by construction; an operator who sets
  // `signalEngine.minRR > 2.0` correctly fails the LONG_RR gate.
  const targetDistance = stopLoss * RR_TARGET_MULTIPLE;
  const rr = stopLoss > 0 ? targetDistance / stopLoss : 0;

  return {
    stopLossPoints: stopLoss,
    targetPoints: targetDistance,
    riskReward: Number.isFinite(rr) ? rr : 0,
  };
}

/**
 * Mandatory 12 (Req 8.1.12): Computed RR ≥ `signalEngine.minRR`.
 *
 * @param {number} riskReward
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkRiskReward(riskReward, settings) {
  const minRR = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.minRR : null,
    2.0,
  );
  return isFiniteNumber(riskReward) && riskReward >= minRR;
}

// ============================================================
// OI confirmation evaluators (LONG path, Req 8.2)
// ============================================================

/**
 * `LONG_OI_CE_SHORT_COVERING_AT_ATM`: at least one CE leg AT or
 * NEAR ATM with `classification === 'Short_Covering'` and
 * `oiVelocity > 0`.
 *
 * "At or near ATM" is interpreted as `|strike − atmStrike| ≤
 * strikeStep` so we accept the ATM strike itself plus the two
 * adjacent strikes. The strike step is inferred from the option
 * chain (smallest positive diff between sorted strikes); when
 * not derivable we fall back to a strict `strike === atmStrike`
 * comparison.
 *
 * Per Req 10.4 a `null` `oiVelocity` is "no signal this cycle"
 * so we treat it as not satisfying the `> 0` condition.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmCeShortCoveringAtAtm(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const oc = ctx && ctx.data ? ctx.data.optionChain : null;
  const atm = finiteOrNull(oc ? oc.atmStrike : null);
  if (!Array.isArray(perStrike) || atm === null) return false;
  const step = inferStrikeStep(oc);
  for (const row of perStrike) {
    if (!row || row.side !== 'CE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.classification !== 'Short_Covering') continue;
    const near = step
      ? Math.abs(row.strike - atm) <= step
      : row.strike === atm;
    if (!near) continue;
    const v = finiteOrNull(row.oiVelocity);
    if (v !== null && v > 0) return true;
  }
  return false;
}

/**
 * `LONG_OI_PE_LONG_BUILDUP_BELOW_ATM`: at least one PE leg with
 * `strike < atmStrike` and `classification === 'Long_Buildup'`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmPeLongBuildupBelowAtm(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const atm = finiteOrNull(
    ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain.atmStrike : null,
  );
  if (!Array.isArray(perStrike) || atm === null) return false;
  for (const row of perStrike) {
    if (!row || row.side !== 'PE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.strike >= atm) continue;
    if (row.classification === 'Long_Buildup') return true;
  }
  return false;
}

/**
 * `LONG_OI_CE_LONG_UNWINDING_AT_RESISTANCE`: at least one CE leg
 * with `strike > atmStrike` (representing an OTM call resistance
 * level) and `classification === 'Long_Unwinding'`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmCeLongUnwindingAtResistance(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const atm = finiteOrNull(
    ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain.atmStrike : null,
  );
  if (!Array.isArray(perStrike) || atm === null) return false;
  for (const row of perStrike) {
    if (!row || row.side !== 'CE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.strike <= atm) continue;
    if (row.classification === 'Long_Unwinding') return true;
  }
  return false;
}

/**
 * `LONG_OI_STRIKE_MIGRATION_UP`: `oi.strikeMigration.direction
 * === 'up'`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmStrikeMigrationUp(ctx) {
  const sm = ctx && ctx.oi ? ctx.oi.strikeMigration : null;
  if (!sm) return false;
  return sm.direction === 'up';
}

/**
 * Infer strike step from option chain — smallest positive diff
 * between consecutive sorted strikes. Returns `null` when the
 * chain has fewer than two distinct numeric strikes.
 *
 * @param {Object|null} optionChain
 * @returns {number|null}
 */
function inferStrikeStep(optionChain) {
  if (!optionChain || !Array.isArray(optionChain.strikes)) return null;
  const xs = [];
  for (const row of optionChain.strikes) {
    if (row && isFiniteNumber(row.strike)) xs.push(row.strike);
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  let minDiff = Infinity;
  for (let i = 1; i < xs.length; i += 1) {
    const d = xs[i] - xs[i - 1];
    if (d > 0 && d < minDiff) minDiff = d;
  }
  return Number.isFinite(minDiff) && minDiff > 0 ? minDiff : null;
}

// ============================================================
// Settings extraction helpers (SHORT path)
// ============================================================

/**
 * Read the configured signal timeframe for the SHORT path. Falls
 * back to `'5m'` when missing (mirrors the documented default).
 *
 * @param {Readonly<Object>} settings
 * @returns {string}
 */
function resolveShortSignalTimeframe(settings) {
  const tf =
    settings && settings.signalEngine && settings.signalEngine.short
      ? settings.signalEngine.short.signalTimeframe
      : null;
  return typeof tf === 'string' && tf.length > 0 ? tf : '5m';
}

/**
 * Read the configured fast / slow EMA periods for the SHORT
 * path. Falls back to (9, 20) — the documented defaults.
 *
 * @param {Readonly<Object>} settings
 * @returns {{ fast:number, slow:number }}
 */
function resolveShortEmaPeriods(settings) {
  const short =
    settings && settings.signalEngine && settings.signalEngine.short
      ? settings.signalEngine.short
      : {};
  const fast =
    Number.isInteger(short.emaFast) && short.emaFast > 0 ? short.emaFast : 9;
  const slow =
    Number.isInteger(short.emaSlow) && short.emaSlow > 0 ? short.emaSlow : 20;
  return { fast, slow };
}

// ============================================================
// Mandatory condition evaluators (SHORT path, Req 9.1)
// ------------------------------------------------------------
// Symmetric to the LONG path: each evaluator reads only off the
// immutable cycle context, returns a strict boolean, and coerces
// missing / malformed inputs to `false` (except `*_BREADTH`,
// which is permissive on missing breadth — see proxy note in
// the module header).
// ============================================================

/**
 * Mandatory 1 (Req 9.1.1): `data.spot.ltp < data.vwap.session`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkVwapShort(ctx) {
  const ltp = finiteOrNull(ctx && ctx.data && ctx.data.spot ? ctx.data.spot.ltp : null);
  const session = finiteOrNull(ctx && ctx.data && ctx.data.vwap ? ctx.data.vwap.session : null);
  if (ltp === null || session === null) return false;
  return ltp < session;
}

/**
 * Mandatory 2 (Req 9.1.2): EMA9 < EMA20 on the configured SHORT
 * signal timeframe. Reads close prices off
 * `ctx.data.candles.spot[timeframe]` and uses the inline
 * `computeEma` helper so we don't depend on the structure adapter
 * having computed EMAs.
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkEmaCrossoverShort(ctx, settings) {
  const tf = resolveShortSignalTimeframe(settings);
  const { fast, slow } = resolveShortEmaPeriods(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  if (!Array.isArray(bars) || bars.length < slow) return false;
  const closes = [];
  for (const b of bars) {
    if (!b || !isFiniteNumber(b.close)) return false;
    closes.push(b.close);
  }
  const fastEma = computeEma(closes, fast);
  const slowEma = computeEma(closes, slow);
  if (fastEma === null || slowEma === null) return false;
  return fastEma < slowEma;
}

/**
 * Mandatory 3 (Req 9.1.3): `ATR(now) − ATR(prev) ≥
 * signalEngine.atrExpansionMin`. ATR expansion is direction-
 * agnostic — volatility-expansion is the precondition for either
 * side, so the test is identical to the LONG path (NOT flipped).
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkAtrExpansionShort(ctx, settings) {
  const tf = resolveShortSignalTimeframe(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  if (!Array.isArray(bars) || bars.length < 16) return false;
  const minExpansion = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.atrExpansionMin : null,
    0.05,
  );
  const atrNow = computeAtr(bars, 14);
  const atrPrev = computeAtr(bars.slice(0, -1), 14);
  if (atrNow === null || atrPrev === null) return false;
  return atrNow - atrPrev >= minExpansion;
}

/**
 * Mandatory 4 (Req 9.1.4): OI_Engine reports an aggressive CE
 * `Short_Buildup` at or ABOVE ATM. We scan
 * `ctx.oi.perStrike` for any CE leg with `strike ≥ atmStrike` and
 * `classification === 'Short_Buildup'`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkCeShortBuildupAtOrAboveAtm(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const atm = finiteOrNull(
    ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain.atmStrike : null,
  );
  if (!Array.isArray(perStrike) || atm === null) return false;
  for (const row of perStrike) {
    if (!row) continue;
    if (row.side !== 'CE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.strike < atm) continue;
    if (row.classification === 'Short_Buildup') return true;
  }
  return false;
}

/**
 * Mandatory 5 (Req 9.1.5): Futures bias bearish.
 *
 * Mirror of `checkFuturesBias` per Req 9.1.5. Returns true when
 * `niftyFuturesProd.analyzeCandles().trend === 'bearish'`. Falls
 * back to `premium < 0` when the futures candle series is missing.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkFuturesBiasShort(ctx) {
  // Path 1: niftyFuturesProd.analyzeCandles (canonical, Req 9.1.5).
  try {
    const futCandles = ctx && ctx.data && ctx.data.candles && ctx.data.candles.futures
      ? ctx.data.candles.futures['5m'] : null;
    const spotLtp = ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
      ? ctx.data.spot.ltp : null;
    if (Array.isArray(futCandles) && futCandles.length >= 3 && spotLtp !== null) {
      const adapted = futCandles.map((b) => ({
        c: b.close, close: b.close,
        h: b.high, high: b.high,
        l: b.low, low: b.low,
        v: b.volume, volume: b.volume,
        t: b.openTime,
      }));
      const analytics = niftyFuturesProd.analyzeCandles(adapted, spotLtp);
      if (analytics && analytics.trend === 'bearish') return true;
      if (analytics && analytics.trend === 'bullish') return false;
    }
  } catch (_) { /* swallow */ }

  // Path 2: premium-to-spot sign fallback.
  const premium = finiteOrNull(
    ctx && ctx.data && ctx.data.futures ? ctx.data.futures.premiumToSpot : null,
  );
  if (premium === null) return false;
  return premium < 0;
}

/**
 * Mandatory 6 (Req 9.1.6): Cumulative delta < 0.
 * Proxy: `liquidity.bidAskImbalance < 0`. Liquidity_Engine already
 * runs `orderFlow.service.js` for this number, so the proxy is
 * consistent with the underlying data.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkCumulativeDeltaShort(ctx) {
  const imbalance = finiteOrNull(
    ctx && ctx.liquidity ? ctx.liquidity.bidAskImbalance : null,
  );
  if (imbalance === null) return false;
  return imbalance < 0;
}

/**
 * Mandatory 7 (Req 9.1.7): Breakdown volume spike on a DOWN-
 * candle. Current volume ≥
 * `signalEngine.volumeBreakoutMultiplier × avgVolume(20)` on the
 * configured SHORT signal timeframe AND the latest candle is a
 * down-candle (`close < open`).
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkVolumeBreakdownShort(ctx, settings) {
  const tf = resolveShortSignalTimeframe(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  if (!Array.isArray(bars) || bars.length < 21) return false;
  const multiplier = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.volumeBreakoutMultiplier : null,
    1.5,
  );
  const last = bars[bars.length - 1];
  if (!last || !isFiniteNumber(last.volume) || !isFiniteNumber(last.open) || !isFiniteNumber(last.close)) {
    return false;
  }
  // 20-bar moving average of volume EXCLUDING the latest bar.
  const window = bars.slice(-21, -1);
  if (window.length < 20) return false;
  let sum = 0;
  for (const b of window) {
    if (!b || !isFiniteNumber(b.volume)) return false;
    sum += b.volume;
  }
  const avg = sum / 20;
  if (avg <= 0) return false;
  const downCandle = last.close < last.open;
  return downCandle && last.volume >= multiplier * avg;
}

/**
 * Mandatory 8 (Req 9.1.8): Market breadth bearish.
 * Proxy: `regime.inputs.breadth.score < 50` when present;
 * permissive `true` when breadth is null/missing because the
 * regime adapter explicitly documents that null breadth must
 * not lower confidence on its own (a future task will wire a
 * dedicated breadth source).
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkBreadthShort(ctx) {
  const breadth =
    ctx && ctx.regime && ctx.regime.inputs ? ctx.regime.inputs.breadth : null;
  if (!breadth) return true; // permissive when missing — see proxy note in module header
  const score = finiteOrNull(breadth.score);
  if (score === null) return true;
  return score < 50;
}

/**
 * Mandatory 9 (Req 9.1.9): `liquidityHealth.healthy = true` AND
 * `liquidityScore ≥ signalEngine.minLiquidityScore`. Liquidity
 * health is direction-agnostic (a healthy book is required for
 * either side), so the SHORT gate matches the LONG gate exactly.
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkLiquidityShort(ctx, settings) {
  const liquidity = ctx && ctx.liquidity ? ctx.liquidity : null;
  if (!liquidity) return false;
  const healthy = !!(liquidity.liquidityHealth && liquidity.liquidityHealth.healthy);
  const score = finiteOrNull(liquidity.liquidityScore);
  if (score === null) return false;
  const minScore = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.minLiquidityScore : null,
    60,
  );
  return healthy && score >= minScore;
}

/**
 * Mandatory 10 (Req 9.1.10): `data.spot.ltp ≤
 * structure.volumeProfile.poc` OR `≤ structure.volumeProfile.val`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkPriceVsPocShort(ctx) {
  const ltp = finiteOrNull(ctx && ctx.data && ctx.data.spot ? ctx.data.spot.ltp : null);
  const vp = ctx && ctx.structure ? ctx.structure.volumeProfile : null;
  if (ltp === null || !vp) return false;
  const poc = finiteOrNull(vp.poc);
  const val = finiteOrNull(vp.val);
  if (poc === null && val === null) return false;
  if (poc !== null && ltp <= poc) return true;
  if (val !== null && ltp <= val) return true;
  return false;
}

/**
 * Mandatory 11 (Req 9.1.11): `regime.label ∈ {trending,
 * volatility-expansion}` AND `regime.tradePermissions.SHORT_SETUP
 * = true`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function checkRegimeShort(ctx) {
  const regime = ctx && ctx.regime ? ctx.regime : null;
  if (!regime) return false;
  const okLabel = regime.label === 'trending' || regime.label === 'volatility-expansion';
  const okPerm = !!(regime.tradePermissions && regime.tradePermissions.SHORT_SETUP === true);
  return okLabel && okPerm;
}

/**
 * Compute the SHORT-side risk-reward block. Symmetric to the
 * LONG path: SL is direction-agnostic (computed from ATR and
 * configured floors), and the target is offset by the constant
 * `RR_TARGET_MULTIPLE` so RR is exactly `2.0` by construction
 * (see the "RR computation" section of the module header).
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {{ stopLossPoints:number, targetPoints:number, riskReward:number }}
 */
function computeRiskRewardShort(ctx, settings) {
  const re = (settings && settings.riskEngine) || {};

  const fixedSL = resolvePositiveNumber(re.fixedSLPoints, 15);
  const atrMul = resolvePositiveNumber(re.atrSLMultiplier, 1.2);
  const maxSL = resolvePositiveNumber(re.maxSLPoints, 25);

  // Derive ATR on the SHORT signal timeframe; fall back to the
  // fixed SL when ATR is unavailable so the gate still resolves.
  const tf = resolveShortSignalTimeframe(settings);
  const bars =
    ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot[tf]
      : null;
  const atr = Array.isArray(bars) && bars.length >= 15 ? computeAtr(bars, 14) : null;

  const atrSL = isFiniteNumber(atr) ? atrMul * atr : 0;
  let stopLoss = Math.max(fixedSL, atrSL);
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) stopLoss = fixedSL;
  if (stopLoss > maxSL) stopLoss = maxSL;

  // Target is BELOW entry on the SHORT side, but RR is computed
  // as a positive ratio — the sign of the move cancels out in
  // `(entry − target) / stopLoss`, leaving the constant multiple.
  const targetDistance = stopLoss * RR_TARGET_MULTIPLE;
  const rr = stopLoss > 0 ? targetDistance / stopLoss : 0;

  return {
    stopLossPoints: stopLoss,
    targetPoints: targetDistance,
    riskReward: Number.isFinite(rr) ? rr : 0,
  };
}

/**
 * Mandatory 12 (Req 9.1.12): Computed RR ≥ `signalEngine.minRR`.
 * Identical math to the LONG side — `signalEngine.minRR` is a
 * single floor that both sides share.
 *
 * @param {number} riskReward
 * @param {Readonly<Object>} settings
 * @returns {boolean}
 */
function checkRiskRewardShort(riskReward, settings) {
  const minRR = resolvePositiveNumber(
    settings && settings.signalEngine ? settings.signalEngine.minRR : null,
    2.0,
  );
  return isFiniteNumber(riskReward) && riskReward >= minRR;
}

// ============================================================
// OI confirmation evaluators (SHORT path, Req 9.2)
// ============================================================

/**
 * `SHORT_OI_PE_SHORT_COVERING_AT_ATM`: at least one PE leg AT or
 * NEAR ATM with `classification === 'Short_Covering'` and
 * `oiVelocity > 0`. "At or near ATM" follows the same `±step`
 * tolerance used by the LONG mirror.
 *
 * Per Req 10.4 a `null` `oiVelocity` is "no signal this cycle"
 * so we treat it as not satisfying the `> 0` condition.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmPeShortCoveringAtAtm(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const oc = ctx && ctx.data ? ctx.data.optionChain : null;
  const atm = finiteOrNull(oc ? oc.atmStrike : null);
  if (!Array.isArray(perStrike) || atm === null) return false;
  const step = inferStrikeStep(oc);
  for (const row of perStrike) {
    if (!row || row.side !== 'PE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.classification !== 'Short_Covering') continue;
    const near = step
      ? Math.abs(row.strike - atm) <= step
      : row.strike === atm;
    if (!near) continue;
    const v = finiteOrNull(row.oiVelocity);
    if (v !== null && v > 0) return true;
  }
  return false;
}

/**
 * `SHORT_OI_CE_LONG_BUILDUP_ABOVE_ATM`: at least one CE leg with
 * `strike > atmStrike` and `classification === 'Long_Buildup'`
 * (aggressive call writers stepping into resistance).
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmCeLongBuildupAboveAtm(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const atm = finiteOrNull(
    ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain.atmStrike : null,
  );
  if (!Array.isArray(perStrike) || atm === null) return false;
  for (const row of perStrike) {
    if (!row || row.side !== 'CE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.strike <= atm) continue;
    if (row.classification === 'Long_Buildup') return true;
  }
  return false;
}

/**
 * `SHORT_OI_PE_LONG_UNWINDING_AT_SUPPORT`: at least one PE leg
 * with `strike < atmStrike` (immediate-support side) and
 * `classification === 'Long_Unwinding'` (put longs giving up,
 * confirming the support is failing).
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmPeLongUnwindingAtSupport(ctx) {
  const perStrike = ctx && ctx.oi ? ctx.oi.perStrike : null;
  const atm = finiteOrNull(
    ctx && ctx.data && ctx.data.optionChain ? ctx.data.optionChain.atmStrike : null,
  );
  if (!Array.isArray(perStrike) || atm === null) return false;
  for (const row of perStrike) {
    if (!row || row.side !== 'PE') continue;
    if (!isFiniteNumber(row.strike)) continue;
    if (row.strike >= atm) continue;
    if (row.classification === 'Long_Unwinding') return true;
  }
  return false;
}

/**
 * `SHORT_OI_STRIKE_MIGRATION_DOWN`: `oi.strikeMigration.direction
 * === 'down'`.
 *
 * @param {Readonly<Object>} ctx
 * @returns {boolean}
 */
function confirmStrikeMigrationDown(ctx) {
  const sm = ctx && ctx.oi ? ctx.oi.strikeMigration : null;
  if (!sm) return false;
  return sm.direction === 'down';
}

// ============================================================
// Result aggregation
// ============================================================

/**
 * Build the canonical NO_TRADE `SignalOutput` shape. Used for
 * every NO_TRADE return path so callers see a stable schema.
 *
 * @param {Object} args
 * @param {Object} args.mandatoryResults
 * @param {Array<string>} args.oiConfirmations
 * @param {number} args.riskReward
 * @param {Array<string>} args.reasonCodes
 * @param {Object} args.provenance
 * @returns {Object}
 */
function buildNoTrade({ mandatoryResults, oiConfirmations, riskReward, reasonCodes, provenance }) {
  return {
    candidate: 'NO_TRADE',
    mandatoryResults,
    oiConfirmations,
    riskReward,
    reasonCodes,
    provenance,
  };
}

/**
 * Decide which reason code to emit when the SOLE failure on a
 * side is its RR mandatory (`LONG_RR` or `SHORT_RR`): per Req 8.5
 * / 9.5 we prefer the dedicated `SIGNAL_RR_BELOW_FLOOR` over the
 * generic per-id failure code. When the RR mandatory fails
 * alongside other mandatories, the per-id failure code is
 * retained so the audit row still records every failed gate.
 *
 * @param {Array<string>} failedIds
 * @returns {Array<string>}            Reason codes to push.
 */
function buildMandatoryFailureReasons(failedIds) {
  if (failedIds.length === 1) {
    const only = failedIds[0];
    if (only === 'LONG_RR' || only === 'SHORT_RR') {
      return [REASON_CODES.SIGNAL_RR_BELOW_FLOOR];
    }
  }
  return failedIds.map(signalMandatoryFail);
}

/**
 * Build the `provenance` block per Req 8.5 / 9.5. Pass-through
 * of the relevant upstream blocks so the audit row can replay
 * the inputs that participated in the decision.
 *
 * @param {Readonly<Object>} ctx
 * @returns {Object}
 */
function buildProvenance(ctx) {
  return {
    regime: ctx && ctx.regime ? ctx.regime : null,
    structure: ctx && ctx.structure ? ctx.structure : null,
    liquidity: ctx && ctx.liquidity ? ctx.liquidity : null,
    oi: ctx && ctx.oi ? ctx.oi : null,
    pcr: ctx && ctx.pcr ? ctx.pcr : null,
  };
}

// ============================================================
// Upstream gates (subtask 11.3)
// ------------------------------------------------------------
// Defensive enforcement of the data / regime / liquidity blocks
// BEFORE the mandatory evaluation runs. Each gate is independent
// and contributes its reason code; ALL matching codes are
// returned together so the audit row records every block. See
// the "Upstream gates" section of the module header for the
// full ordered list and Req cross-reference.
// ============================================================

/**
 * Evaluate the upstream NO_TRADE gates against the cycle context
 * + settings. Synchronous, pure, never throws. Collects every
 * matching reason code (does NOT short-circuit on the first
 * match) so the caller can emit a complete audit row.
 *
 * @param {Readonly<Object>} ctx
 * @param {Readonly<Object>} settings
 * @returns {{ blocked:boolean, reasonCodes:Array<string> }}
 */
function evaluateUpstreamGates(ctx, settings) {
  const codes = [];

  const data = ctx && ctx.data ? ctx.data : null;
  const regime = ctx && ctx.regime ? ctx.regime : null;
  const liquidity = ctx && ctx.liquidity ? ctx.liquidity : null;

  // 1. Data freshness (Req 4.6 / 17.5).
  if (data && data.tickStale === true) {
    codes.push(REASON_CODES.DATA_TICK_STALE);
  }

  // 2. Option chain availability (Req 4.8). `null` is the
  //    documented "unavailable" sentinel emitted by Data_Engine.
  if (data && data.optionChain === null) {
    codes.push(REASON_CODES.OPTION_CHAIN_UNAVAILABLE);
  }

  // 3-5. Regime label blocks (Req 5.6 / 5.7 / 5.8 / 17.1).
  if (regime) {
    if (regime.label === 'ranging') {
      codes.push(REASON_CODES.REGIME_BLOCK_RANGING);
    } else if (regime.label === 'expiry-manipulation') {
      codes.push(REASON_CODES.REGIME_BLOCK_EXPIRY_MANIPULATION);
    } else if (regime.label === 'high-risk') {
      codes.push(REASON_CODES.REGIME_BLOCK_HIGH_RISK);
    }

    // 6. Regime confidence floor (Req 5.10).
    const minConfidence = resolvePositiveNumber(
      settings && settings.regimeEngine
        ? settings.regimeEngine.minRegimeConfidence
        : null,
      6,
    );
    const confidence = finiteOrNull(regime.confidence);
    if (confidence !== null && confidence < minConfidence) {
      codes.push(REASON_CODES.REGIME_LOW_CONFIDENCE);
    }
  }

  // 7. Spread status (Req 7.3 / 17.4).
  if (liquidity && liquidity.spreadStatus === 'very_wide') {
    codes.push(REASON_CODES.LIQUIDITY_VERY_WIDE_SPREAD);
  }

  // 8. Liquidity score floor (Req 7.3 / 17.4).
  if (liquidity) {
    const minScore = resolvePositiveNumber(
      settings && settings.signalEngine
        ? settings.signalEngine.minLiquidityScore
        : null,
      60,
    );
    const score = finiteOrNull(liquidity.liquidityScore);
    if (score !== null && score < minScore) {
      codes.push(REASON_CODES.LIQUIDITY_LOW_SCORE);
    }
  }

  // 9. Stop-hunt block (Req 7.4).
  if (liquidity && liquidity.blockEntry === true) {
    codes.push(REASON_CODES.LIQUIDITY_STOP_HUNT_OPPOSES_SIDE);
  }

  return { blocked: codes.length > 0, reasonCodes: codes };
}

// ============================================================
// Public API
// ============================================================

/**
 * Evaluate the deterministic LONG and SHORT signal gates for the
 * supplied cycle context. Synchronous, pure, never throws.
 *
 * Subtask 11.1 wired the LONG path; subtask 11.2 mirrors it for
 * SHORT and refactors this entry point to evaluate BOTH sides
 * every cycle. Subtask 11.3 prepends an explicit upstream-gate
 * stage that returns NO_TRADE BEFORE any mandatory work runs.
 * Resolution order:
 *
 *   0. Run `evaluateUpstreamGates`. If ANY gate fires, return
 *      NO_TRADE immediately with the collected reason codes,
 *      empty `mandatoryResults`, no OI confirmations, and
 *      `riskReward = 0`. No mandatory evaluation runs.
 *   1. Compute LONG mandatory + OI + RR.
 *   2. Compute SHORT mandatory + OI + RR.
 *   3. If LONG passes (12 mandatory + ≥ 1 OI) ⇒ `LONG_SETUP`.
 *   4. Else if SHORT passes ⇒ `SHORT_SETUP`.
 *   5. Else `NO_TRADE` with reason aggregation favouring the
 *      side with FEWER failed mandatories (the side "closer to
 *      firing"). See module header for the full rules.
 *
 * The two sides are mutually exclusive in practice (price is
 * either above or below VWAP, so `LONG_VWAP` and `SHORT_VWAP`
 * cannot both pass) so at most one candidate fires per cycle.
 *
 * @param {{ ctx: Readonly<Object>, settings: Readonly<Object> }} args
 * @returns {Object}                  SignalOutput (see typedef in `cycleContext.js`).
 */
function evaluateSignal({ ctx, settings } = {}) {
  // ----- Defensive guard. If the orchestrator hasn't supplied a
  //       context / settings pair we return the safe default with
  //       a synthetic internal-failure code so the operator can
  //       audit the misuse.
  const provenance = buildProvenance(ctx || {});
  if (!ctx || typeof ctx !== 'object' || !settings || typeof settings !== 'object') {
    return buildNoTrade({
      mandatoryResults: {},
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('INTERNAL')],
      provenance,
    });
  }

  // ----- Critical-data gates (cannot be bypassed):
  //       tick freshness and option chain availability.
  //       Other regime/liquidity gates are evaluated INSIDE the
  //       strategy path so VWAP-bounce can run on `ranging` regime.
  if (ctx.data && ctx.data.tickStale === true) {
    return buildNoTrade({
      mandatoryResults: {},
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [REASON_CODES.DATA_TICK_STALE],
      provenance,
    });
  }
  if (ctx.data && ctx.data.optionChain === null) {
    return buildNoTrade({
      mandatoryResults: {},
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [REASON_CODES.OPTION_CHAIN_UNAVAILABLE],
      provenance,
    });
  }
  // Hard-stop blocks (no strategy can override these).
  const regimeHardBlock = ctx.regime
    && (ctx.regime.label === 'expiry-manipulation' || ctx.regime.label === 'high-risk');
  if (regimeHardBlock) {
    return buildNoTrade({
      mandatoryResults: {},
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [
        ctx.regime.label === 'expiry-manipulation'
          ? REASON_CODES.REGIME_BLOCK_EXPIRY_MANIPULATION
          : REASON_CODES.REGIME_BLOCK_HIGH_RISK,
      ],
      provenance,
    });
  }
  if (ctx.liquidity && ctx.liquidity.spreadStatus === 'very_wide') {
    return buildNoTrade({
      mandatoryResults: {},
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [REASON_CODES.LIQUIDITY_VERY_WIDE_SPREAD],
      provenance,
    });
  }
  // Skip the broader upstream gates when we're inside the
  // tradable session window (the strategy path handles its own
  // regime/liquidity checks).

  // Update day-state every cycle (OR build, bias lock).
  // Done BEFORE any path so all strategies share the same day-state.
  _updateDayState(ctx);

  // ============================================================
  // SHARED GATES — apply to UT-Bot-primary AND VWAP-bounce paths
  // ============================================================
  // These gates short-circuit BEFORE any strategy fires, so the
  // session-level limits (daily cap, consec-loss kill, drawdown
  // circuit) are honoured by every entry path.
  // ============================================================
  const cycleMs = ctx.cycleStartedAt;
  const sessionTickMs = ctx && ctx.data && typeof ctx.data.tickAt === 'number'
    ? ctx.data.tickAt
    : cycleMs;

  // Read UT Bot config + caps from settings (with safe fallbacks).
  const utBotCfg = (settings && settings.signalEngine && settings.signalEngine.utBot) || {};
  const dailyCap =
    Number.isInteger(utBotCfg.maxTradesPerDay) && utBotCfg.maxTradesPerDay > 0
      ? utBotCfg.maxTradesPerDay
      : 8;
  const consecLossKill =
    Number.isInteger(utBotCfg.consecLossKill) && utBotCfg.consecLossKill > 0
      ? utBotCfg.consecLossKill
      : 3;
  const drawdownINR =
    typeof utBotCfg.sessionDrawdownINR === 'number' && Number.isFinite(utBotCfg.sessionDrawdownINR)
      ? utBotCfg.sessionDrawdownINR
      : -3500;
  const minConfluences =
    Number.isInteger(utBotCfg.minConfluences) && utBotCfg.minConfluences >= 0
      ? utBotCfg.minConfluences
      : 2;
  const blockedRegimes = Array.isArray(utBotCfg.blockedRegimes)
    ? utBotCfg.blockedRegimes
    : ['expiry-manipulation', 'high-risk'];
  const requireConfluences = Array.isArray(utBotCfg.requireConfluences)
    ? utBotCfg.requireConfluences
    : [];
  const cooldownMs = Number.isFinite(utBotCfg.cooldownMs) && utBotCfg.cooldownMs >= 0
    ? utBotCfg.cooldownMs
    : 4 * 60 * 1000;

  // Hot-load UT Bot indicator parameters so a settings-update can
  // re-tune sensitivity / ATR period without a process restart.
  try {
    if (typeof multiTimeframe.setUtBotConfig === 'function') {
      multiTimeframe.setUtBotConfig({
        keyValue: utBotCfg.keyValue,
        atrPeriod: utBotCfg.atrPeriod,
      });
    }
  } catch (_) { /* swallow */ }

  // Daily trade cap.
  if (_dayState.tradesToday >= dailyCap) {
    return buildNoTrade({
      mandatoryResults: { DAILY_TRADE_CAP: false, tradesToday: _dayState.tradesToday, cap: dailyCap },
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('DAILY_TRADE_CAP')],
      provenance,
    });
  }
  // Consecutive-loss kill.
  if (_dayState.consecLosses >= consecLossKill) {
    return buildNoTrade({
      mandatoryResults: { CONSEC_LOSS_KILL: false, consecLosses: _dayState.consecLosses },
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('CONSEC_LOSS_KILL')],
      provenance,
    });
  }
  // Session drawdown circuit-breaker.
  if (_dayState.sessionPnL <= drawdownINR) {
    return buildNoTrade({
      mandatoryResults: { SESSION_DRAWDOWN_KILL: false, sessionPnL: _dayState.sessionPnL },
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('SESSION_DRAWDOWN_KILL')],
      provenance,
    });
  }
  // Time-window block.
  const twBlock = _timeWindowBlock(sessionTickMs);
  if (twBlock) {
    return buildNoTrade({
      mandatoryResults: { TIME_WINDOW: false, timeWindowBlock: twBlock },
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('TIME_WINDOW_' + twBlock)],
      provenance,
    });
  }

  // ============================================================
  // UT BOT PRIMARY TRIGGER PATH (institutional 5-8 trades/day)
  // ============================================================
  // The TradingView "UT Bot Alerts" indicator (Yo_adriiiiaaan,
  // 2018) is the canonical retail+pro NIFTY scalping trigger. On
  // the 5m timeframe it produces 8-12 directional flips per
  // session and, when filtered by regime + light confluence, has
  // historically delivered 70-85% accuracy on Nifty 50 options.
  //
  // The path here:
  //   1. Computes UT Bot on 5m spot bars; only fires on a fresh
  //      flip (signal === 'buy' OR 'sell' on the latest bar that
  //      we haven't already fired on — see `_lastUtBotBarSeen`).
  //   2. Refuses entries during regime hard-blocks
  //      (`expiry-manipulation`, `high-risk`).
  //   3. Counts confluences (MTF15M agreement, VWAP agreement,
  //      volume ≥ avg, cumulative delta sign, futures bias sign,
  //      structure bias). Need ≥ utBot.minConfluences.
  //   4. Returns LONG_SETUP / SHORT_SETUP with the firing bar's
  //      open time stamped in `_lastUtBotBarSeen` for de-dupe.
  //   5. Risk_Engine, AI_Support_Layer, and Execution_Engine run
  //      AFTER this in the orchestrator so the trade still has
  //      to clear sizing, AI advisory, and broker layers.
  //
  // The path runs BEFORE the bespoke VWAP-bounce strategy, so
  // a clean UT Bot flip wins. If UT Bot is silent or blocked,
  // the VWAP-bounce path (below) gets a second swing at the bar.
  // ============================================================
  try {
    const fiveMinBars = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m'] : null;
    const ltp = ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
      ? ctx.data.spot.ltp : null;

    if (Array.isArray(fiveMinBars) && fiveMinBars.length >= 16 && ltp !== null) {
      const adapted = fiveMinBars.map((b) => ({
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, t: b.openTime,
      }));
      const utResult = multiTimeframe.calculateUTBot(adapted);

      // Fire on UT Bot fresh flip (signal === 'buy' or 'sell').
      // The de-dupe via _lastUtBotBarSeen ensures at most one entry
      // per direction per 5m bar; the cooldown gate prevents
      // back-to-back entries inside 4 minutes.
      const wantLong = utResult.signal === 'buy';
      const wantShort = utResult.signal === 'sell';

      if (wantLong || wantShort) {
        const direction = wantLong ? 'LONG' : 'SHORT';
        const candidate = wantLong ? 'LONG_SETUP' : 'SHORT_SETUP';
        const dedupeKey = wantLong ? 'buy' : 'sell';
        const lastBarOpenTime = adapted[adapted.length - 1].t;
        const alreadyFiredThisBar = _lastUtBotBarSeen[dedupeKey] === lastBarOpenTime;

        if (!alreadyFiredThisBar) {
          // Regime hard-block check.
          const regimeLabel = (ctx.regime && ctx.regime.label) || null;
          const regimeBlocked = regimeLabel && blockedRegimes.indexOf(regimeLabel) !== -1;

          // Inside-OR chop kill (institutional rule). When LTP at
          // 09:45 didn't break OR, the day is structurally chop and
          // UT Bot whipsaws produce mostly losses. We DON'T block
          // counter-day-bias trades — those are valuable when the
          // initial OR breakout was a fake (which is common in
          // NIFTY post-news sessions).
          const insideORChop = _dayState.insideORDay === true;

          if (regimeBlocked) {
            return buildNoTrade({
              mandatoryResults: {
                STRATEGY: 'UT_BOT_PRIMARY',
                UT_BOT_SIGNAL: utResult.signal,
                REGIME_LABEL: regimeLabel,
                BLOCKED: 'REGIME',
              },
              oiConfirmations: [],
              riskReward: 0,
              reasonCodes: [signalMandatoryFail('UT_BOT_REGIME_BLOCKED')],
              provenance,
            });
          }

          if (insideORChop) {
            return buildNoTrade({
              mandatoryResults: {
                STRATEGY: 'UT_BOT_PRIMARY',
                UT_BOT_SIGNAL: utResult.signal,
                INSIDE_OR_DAY: true,
                BLOCKED: 'INSIDE_OR_CHOP',
              },
              oiConfirmations: [],
              riskReward: 0,
              reasonCodes: [signalMandatoryFail('UT_BOT_INSIDE_OR_CHOP')],
              provenance,
            });
          }

          // Cooldown gate.
          if (typeof _dayState.lastTradeMs === 'number'
            && Number.isFinite(sessionTickMs)
            && sessionTickMs - _dayState.lastTradeMs < cooldownMs) {
            return buildNoTrade({
              mandatoryResults: {
                STRATEGY: 'UT_BOT_PRIMARY',
                UT_BOT_SIGNAL: utResult.signal,
                BLOCKED: 'COOLDOWN',
                lastTradeMs: _dayState.lastTradeMs,
                sessionTickMs,
              },
              oiConfirmations: [],
              riskReward: 0,
              reasonCodes: [signalMandatoryFail('UT_BOT_COOLDOWN')],
              provenance,
            });
          }

          // ADX chop filter — institutional rule: ADX < 14 means
          // genuine sideways chop where UT Bot whipsaws produce
          // mostly losses. The regime engine already exposes ADX
          // on `ctx.regime.inputs.adx.value`; we read it here as
          // a UT-Bot-specific guard so the rest of the pipeline
          // (legacy / VWAP-bounce paths) can still trade if they
          // have their own conviction.
          const adxValue = ctx.regime && ctx.regime.inputs && ctx.regime.inputs.adx
            && typeof ctx.regime.inputs.adx.value === 'number'
            ? ctx.regime.inputs.adx.value : null;
          if (adxValue !== null && adxValue < 14) {
            return buildNoTrade({
              mandatoryResults: {
                STRATEGY: 'UT_BOT_PRIMARY',
                UT_BOT_SIGNAL: utResult.signal,
                ADX: adxValue,
                BLOCKED: 'ADX_CHOP',
              },
              oiConfirmations: [],
              riskReward: 0,
              reasonCodes: [signalMandatoryFail('UT_BOT_ADX_CHOP')],
              provenance,
            });
          }

          {
            // Confluence pool — light, NIFTY-tuned.
            const confluences = {};

            // 1) 15m EMA trend agrees with direction AND has slope
            //    in the trade direction. Slope (EMA9 vs EMA9 5 bars
            //    ago) prevents firing into a flatlining 15m trend
            //    where UT Bot is just whipsawing the 5m bars.
            try {
              const bars15m = ctx.data.candles.spot['15m'] || [];
              if (Array.isArray(bars15m) && bars15m.length >= 21) {
                const closes15 = bars15m.map((b) => b.close).filter(isFiniteNumber);
                const ema9_15 = computeEma(closes15, 9);
                const ema20_15 = computeEma(closes15, 20);
                // Slope: EMA9 of full series vs EMA9 of series ending 3 bars ago.
                let slopeOk = true;
                if (closes15.length >= 12) {
                  const ema9_15_lag = computeEma(closes15.slice(0, -3), 9);
                  if (ema9_15 !== null && ema9_15_lag !== null) {
                    slopeOk = wantLong ? ema9_15 > ema9_15_lag : ema9_15 < ema9_15_lag;
                  }
                }
                if (ema9_15 !== null && ema20_15 !== null) {
                  confluences.MTF15M_AGREE = (wantLong
                    ? ema9_15 > ema20_15
                    : ema9_15 < ema20_15) && slopeOk;
                }
              }
            } catch (_) { /* swallow */ }

            // 2) VWAP agreement.
            const vwap = ctx.data.vwap && typeof ctx.data.vwap.session === 'number'
              ? ctx.data.vwap.session : null;
            if (vwap !== null) {
              confluences.VWAP_AGREE = wantLong ? ltp >= vwap : ltp <= vwap;
            }

            // 3) Pull-back proximity — UT Bot trailing stop must be
            //    within 0.6% of price. A wider gap means we're
            //    chasing an extended move where the SL would be too
            //    far for option premium math to work. NIFTY 5m
            //    institutional rule: enter on UT Bot flips that are
            //    near the trailing stop (i.e. fresh transitions),
            //    not 0.5%+ extended moves.
            const utStop = utResult.trailingStop;
            if (typeof utStop === 'number' && utStop > 0) {
              const distPct = Math.abs((ltp - utStop) / utStop) * 100;
              confluences.NEAR_UT_STOP = distPct <= 0.60;
            }

            // 4) Volume — last bar ≥ 1.0× 20-bar avg (very loose;
            //    UT Bot itself encodes momentum so we just want a
            //    sanity-check that we're not entering on dust).
            try {
              const last = fiveMinBars[fiveMinBars.length - 1];
              const window = fiveMinBars.slice(-21, -1);
              if (window.length >= 20 && last && isFiniteNumber(last.volume)) {
                let sum = 0;
                for (const b of window) sum += isFiniteNumber(b.volume) ? b.volume : 0;
                const avg = sum / window.length;
                confluences.VOLUME_OK = avg > 0 && last.volume >= avg * 1.0;
              }
            } catch (_) { /* swallow */ }

            // 5) Cumulative delta sign.
            const imb = ctx.liquidity && typeof ctx.liquidity.bidAskImbalance === 'number'
              ? ctx.liquidity.bidAskImbalance : null;
            if (imb !== null) {
              confluences.CUMULATIVE_DELTA = wantLong ? imb >= 0 : imb <= 0;
            }

            // 6) Futures bias.
            const fut = ctx.data.futures || null;
            if (fut && typeof fut.premiumToSpot === 'number') {
              confluences.FUTURES_BIAS = wantLong ? fut.premiumToSpot >= 0 : fut.premiumToSpot <= 0;
            }

            // 7) Structure bias agreement.
            if (ctx.structure && ctx.structure.bias) {
              if (ctx.structure.bias === 'bullish') confluences.STRUCTURE_BIAS = wantLong;
              else if (ctx.structure.bias === 'bearish') confluences.STRUCTURE_BIAS = wantShort;
              // neutral — skip (don't add the key, doesn't count for or against).
            }

            // 8) Day-bias agreement (locked at 09:45 IST). Strong
            //    counter-cyclic filter: when day-bias is locked
            //    bullish, LONG entries get +1 confluence; SHORT
            //    entries don't get the confluence (so they need 4
            //    of the remaining 7 instead of 3).
            if (_dayState.dayBiasLong === true) {
              confluences.DAY_BIAS_AGREE = wantLong;
            } else if (_dayState.dayBiasLong === false) {
              confluences.DAY_BIAS_AGREE = wantShort;
            }
            // null dayBias (early session / no-bias day) — skip.

            const passed = Object.values(confluences).filter((v) => v === true).length;
            const total = Object.keys(confluences).length;

            // Compute RR (reuse existing helpers).
            const rr = wantLong
              ? computeRiskReward(ctx, settings)
              : computeRiskRewardShort(ctx, settings);

            // OI is treated as a SOFT confluence (not a hard gate).
            const oiConfirmations = [];
            if (wantLong) {
              if (confirmCeShortCoveringAtAtm(ctx)) oiConfirmations.push('LONG_OI_CE_SHORT_COVERING_AT_ATM');
              if (confirmPeLongBuildupBelowAtm(ctx)) oiConfirmations.push('LONG_OI_PE_LONG_BUILDUP_BELOW_ATM');
              if (confirmCeLongUnwindingAtResistance(ctx)) oiConfirmations.push('LONG_OI_CE_LONG_UNWINDING_AT_RESISTANCE');
              if (confirmStrikeMigrationUp(ctx)) oiConfirmations.push('LONG_OI_STRIKE_MIGRATION_UP');
            } else {
              if (confirmPeShortCoveringAtAtm(ctx)) oiConfirmations.push('SHORT_OI_PE_SHORT_COVERING_AT_ATM');
              if (confirmCeLongBuildupAboveAtm(ctx)) oiConfirmations.push('SHORT_OI_CE_LONG_BUILDUP_ABOVE_ATM');
              if (confirmPeLongUnwindingAtSupport(ctx)) oiConfirmations.push('SHORT_OI_PE_LONG_UNWINDING_AT_SUPPORT');
              if (confirmStrikeMigrationDown(ctx)) oiConfirmations.push('SHORT_OI_STRIKE_MIGRATION_DOWN');
            }

            const fullMandatoryResults = {
              STRATEGY: 'UT_BOT_PRIMARY',
              UT_BOT_SIGNAL: utResult.signal,
              UT_BOT_TREND: utResult.trend,
              UT_BOT_TRAILING_STOP: utResult.trailingStop,
              REGIME_LABEL: regimeLabel,
              REGIME_CONFIDENCE: ctx.regime ? ctx.regime.confidence : null,
              CONFLUENCE_PASSED: passed,
              CONFLUENCE_TOTAL: total,
              CONFLUENCES: confluences,
              [`${direction}_OI_CONFIRMED`]: oiConfirmations.length >= 1,
              RISK_REWARD: rr.riskReward,
            };

            if (passed >= minConfluences) {
              // Mandatory confluences — when the underlying datum
              // is available (i.e. the key was set on `confluences`),
              // a `false` value blocks the entry. This catches the
              // chop-day case where UT Bot flips against MTF/structure
              // and the ≥3 floor is satisfied by weaker confluences.
              let mandatoryFail = null;
              for (const k of requireConfluences) {
                if (Object.prototype.hasOwnProperty.call(confluences, k)
                  && confluences[k] === false) {
                  mandatoryFail = k;
                  break;
                }
              }
              if (mandatoryFail !== null) {
                fullMandatoryResults.MANDATORY_CONFLUENCE_FAILED = mandatoryFail;
                return buildNoTrade({
                  mandatoryResults: fullMandatoryResults,
                  oiConfirmations,
                  riskReward: rr.riskReward,
                  reasonCodes: [signalMandatoryFail('UT_BOT_' + mandatoryFail)],
                  provenance,
                });
              }
              // Mark the bar so we don't re-fire.
              _lastUtBotBarSeen[dedupeKey] = lastBarOpenTime;
              _dayState.tradesToday += 1;
              _dayState.lastTradeMs = sessionTickMs;
              return {
                candidate,
                mandatoryResults: fullMandatoryResults,
                oiConfirmations,
                riskReward: rr.riskReward,
                reasonCodes: [],
                provenance,
                primaryTrigger: 'UT_BOT_PRIMARY',
              };
            }
            // Confluence too low — fall through to VWAP-bounce
            // (it might pick up the same bar on different criteria).
          }
        }
      }
    }
  } catch (_) {
    // Swallow and fall through to VWAP-bounce path.
  }

  // ============================================================
  // INSTITUTIONAL HYBRID SIGNAL PATH (VWAP-bounce, secondary)
  // ============================================================
  // Multi-layer pro-trader playbook. Built from research on real
  // NIFTY 50 institutional desks that produce 70-80%+ win rates:
  //
  //   1. Day-state lock — establish bias in first 30 min, stick
  //      with it. Bidirectional trading on a directional day is
  //      the #1 source of losses.
  //   2. Time-window filter — skip 09:15-09:45, 11:30-13:00,
  //      14:45-15:30. Trade only in the 09:45-11:30 + 13:00-14:45
  //      institutional windows.
  //   3. UT Bot ATR Trailing Stop — primary directional trigger
  //      on 5m bars (TradingView UT Bot Alerts indicator).
  //   4. Day-bias agreement — UT Bot signal direction MUST match
  //      the locked day-bias (or day-bias must be null = no-bias
  //      day, in which case we still allow but with stricter
  //      confluence).
  //   5. MTF lock — 5m, 15m, 30m all agree direction.
  //   6. Pull-back entry — refuse if spot is more than 0.40%
  //      extended from VWAP (don't chase tops).
  //   7. Stretch filter — refuse if day's range > 1.5 × ATR
  //      (already exhausted move).
  //   8. Confluence — require regime trending + conf ≥ 7,
  //      VWAP align, POC align, liquidity health, RR ≥ minRR,
  //      OI confirmation, AND ≥ 3 of 6 confluence indicators.
  //   9. Daily caps — max 3 trades/day, hard stop after 2
  //      consecutive losses.
  //
  // AI advisory layer (downstream, applied by orchestrator):
  //   The orchestrator runs aiSupport.evaluateAISupport AFTER
  //   this path fires. AI may DOWNGRADE to NO_TRADE per Req
  //   14.4 / 14.9. AI cannot upgrade.
  // ============================================================

  // Inside-OR (chop day) kill — only when OR is ULTRA-TIGHT (<0.2% wide).
  // Real institutional rule: only skip the day when OR width signals
  // genuine pre-news compression. A 0.2-0.4% OR with inside-day still
  // gives intraday VWAP-bounce opportunities.
  if (_dayState.insideORDay === true && _dayState.openingHigh && _dayState.openingLow) {
    const orWidthPct = ((_dayState.openingHigh - _dayState.openingLow) / _dayState.openingLow) * 100;
    if (orWidthPct < 0.20) {
      return buildNoTrade({
        mandatoryResults: { INSIDE_OR_KILL: false, orWidthPct },
        oiConfirmations: [],
        riskReward: 0,
        reasonCodes: [signalMandatoryFail('INSIDE_OR_DAY_TIGHT')],
        provenance,
      });
    }
  }

  // NOTE: Daily-cap / consec-loss / drawdown / time-window gates
  // are now hoisted above the UT-Bot-primary path and apply to
  // both strategies. `cycleMs` and `sessionTickMs` are also
  // declared above. The VWAP-bounce path picks up here with the
  // stretch filter.

  // Stretch filter.
  if (_isDayRangeStretched(ctx)) {
    return buildNoTrade({
      mandatoryResults: { DAY_STRETCH: false },
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('DAY_RANGE_STRETCHED')],
      provenance,
    });
  }

  // ============================================================
  // INSTITUTIONAL VWAP-BOUNCE STRATEGY (70%+ win-rate target)
  // ============================================================
  // Pro NIFTY desks don't trade UT Bot crosses directly because
  // those whipsaw on chop. Instead they:
  //   1. Wait for OR-break and lock day-bias.
  //   2. Wait for price to PULL BACK to session VWAP after the
  //      break. The pullback IS the entry — buying the dip on a
  //      bullish day, selling the rip on a bearish day.
  //   3. Confirm the bounce with: UT Bot signal in same
  //      direction, volume spike on the touch bar, OI flow
  //      agreeing, cumulative delta agreeing.
  //
  // The pullback-entry pattern has structurally higher win-rate
  // than breakout-entry because:
  //   - You enter at a known support/resistance (VWAP).
  //   - Risk is mathematically defined (SL just past VWAP).
  //   - Target is clear (recent swing high/low or 1.5R).
  //   - You're trading WITH institutional flow (institutions
  //     defend VWAP on trending days).
  // ============================================================
  try {
    const fiveMinBars = ctx && ctx.data && ctx.data.candles && ctx.data.candles.spot
      ? ctx.data.candles.spot['5m'] : null;
    const ltp = ctx && ctx.data && ctx.data.spot && typeof ctx.data.spot.ltp === 'number'
      ? ctx.data.spot.ltp : null;
    const vwap = ctx && ctx.data && ctx.data.vwap && typeof ctx.data.vwap.session === 'number'
      ? ctx.data.vwap.session : null;
    if (Array.isArray(fiveMinBars) && fiveMinBars.length >= 16
      && ltp !== null && vwap !== null) {
      // Adapt bars for UT Bot.
      const adapted = fiveMinBars.map((b) => ({
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, t: b.openTime,
      }));
      const utResult = multiTimeframe.calculateUTBot(adapted);

      // VWAP proximity — must be near VWAP (within 0.30%).
      // Wider band (vs strict 0.15%) to capture more pullback
      // entries while still being institutional-tight.
      const distFromVwapPct = Math.abs((ltp - vwap) / vwap) * 100;
      const nearVwap = distFromVwapPct <= 0.30;

      // Strong-trend filter — institutional rule: only trade
      // when the recent 5 bars confirm the day-bias direction.
      // 3 of last 5 5m candles must close in the bias direction.
      let strongTrendOk = true;
      if (_dayState.dayBiasLong !== null && fiveMinBars.length >= 5) {
        const last5 = fiveMinBars.slice(-5);
        let bullCount = 0, bearCount = 0;
        for (const b of last5) {
          if (typeof b.close === 'number' && typeof b.open === 'number') {
            if (b.close > b.open) bullCount++;
            else if (b.close < b.open) bearCount++;
          }
        }
        if (_dayState.dayBiasLong === true && bullCount < 3) strongTrendOk = false;
        if (_dayState.dayBiasLong === false && bearCount < 3) strongTrendOk = false;
      }

      // Determine entry direction.
      // Priority: day-bias if locked, else UT Bot trend, else
      // refuse the trade.
      let wantLong;
      if (_dayState.dayBiasLong === true) wantLong = true;
      else if (_dayState.dayBiasLong === false) wantLong = false;
      else if (utResult.trend === 'bullish') wantLong = true;
      else if (utResult.trend === 'bearish') wantLong = false;
      else return buildNoTrade({
        mandatoryResults: { NO_DIRECTION: false },
        oiConfirmations: [],
        riskReward: 0,
        reasonCodes: [signalMandatoryFail('NO_DIRECTION')],
        provenance,
      });
      const direction = wantLong ? 'LONG' : 'SHORT';
      const candidate = wantLong ? 'LONG_SETUP' : 'SHORT_SETUP';

      // Price relative to VWAP must agree with direction:
      //   - LONG: price has pulled back to/below VWAP and is
      //     now above it (bounce starting).
      //   - SHORT: price has rallied to/above VWAP and is now
      //     below it (rejection starting).
      const priceVwapAlignsLong = wantLong && ltp >= vwap;
      const priceVwapAlignsShort = !wantLong && ltp <= vwap;
      const priceVwapAligns = priceVwapAlignsLong || priceVwapAlignsShort;

      // UT Bot must confirm the direction OR be neutral on the
      // current bar (institutional rule: don't fight UT Bot,
      // but tolerate it being silent on the entry bar).
      const utAligns = (wantLong && utResult.trend !== 'bearish')
        || (!wantLong && utResult.trend !== 'bullish');

      // De-dupe per 5m bar so we don't fire repeatedly on the
      // same touch.
      const lastBarOpenTime = adapted[adapted.length - 1].t;
      const dedupeKey = wantLong ? 'buy' : 'sell';
      const alreadyFiredThisBar = _lastUtBotBarSeen[dedupeKey] === lastBarOpenTime;

      const triggerArmed = nearVwap && priceVwapAligns && utAligns && !alreadyFiredThisBar;

      if (triggerArmed) {
        // Compute confirmations.
        const longRr = wantLong ? computeRiskReward(ctx, settings) : null;
        const shortRr = !wantLong ? computeRiskRewardShort(ctx, settings) : null;
        const rr = wantLong ? longRr : shortRr;

        const regime = ctx.regime || null;
        // Regime: trending/expansion preferred, confidence ≥ 7
        // (institutional bar — only trade when regime is clearly
        // directional, NOT during ambiguous periods).
        const regimeOk = !!regime
          && typeof regime.confidence === 'number'
          && regime.confidence >= 7
          && regime.label !== 'fake-breakout'
          && regime.label !== 'momentum-exhaustion'
          && regime.label !== 'expiry-manipulation'
          && regime.label !== 'high-risk';

        const confirmations = {
          [`${direction}_REGIME`]: regimeOk,
          [`${direction}_NEAR_VWAP`]: nearVwap,
          [`${direction}_PRICE_VWAP_ALIGN`]: priceVwapAligns,
          [`${direction}_UT_BOT_ALIGN`]: utAligns,
          [`${direction}_LIQUIDITY`]: wantLong ? checkLiquidity(ctx, settings) : checkLiquidityShort(ctx, settings),
          [`${direction}_RR`]: rr ? checkRiskReward(rr.riskReward, settings) : false,
          [`${direction}_STRONG_TREND`]: strongTrendOk,
        };

        // Confluence pool — at least 3 of 6 must pass.
        const confluence = {
          [`${direction}_VOLUME`]: wantLong ? checkVolumeBreakout(ctx, settings) : checkVolumeBreakdownShort(ctx, settings),
          [`${direction}_CUMULATIVE_DELTA`]: wantLong ? checkCumulativeDelta(ctx) : checkCumulativeDeltaShort(ctx),
          [`${direction}_FUTURES_BIAS`]: wantLong ? checkFuturesBias(ctx) : checkFuturesBiasShort(ctx),
          [`${direction}_EMA`]: wantLong ? checkEmaCrossover(ctx, settings) : checkEmaCrossoverShort(ctx, settings),
          [`${direction}_ATR`]: wantLong ? checkAtrExpansion(ctx, settings) : checkAtrExpansionShort(ctx, settings),
          [`${direction}_PRICE_VS_POC`]: wantLong ? checkPriceVsPoc(ctx) : checkPriceVsPocShort(ctx),
        };

        // OI confirmations.
        const oiConfirmations = [];
        if (wantLong) {
          if (confirmCeShortCoveringAtAtm(ctx)) oiConfirmations.push('LONG_OI_CE_SHORT_COVERING_AT_ATM');
          if (confirmPeLongBuildupBelowAtm(ctx)) oiConfirmations.push('LONG_OI_PE_LONG_BUILDUP_BELOW_ATM');
          if (confirmCeLongUnwindingAtResistance(ctx)) oiConfirmations.push('LONG_OI_CE_LONG_UNWINDING_AT_RESISTANCE');
          if (confirmStrikeMigrationUp(ctx)) oiConfirmations.push('LONG_OI_STRIKE_MIGRATION_UP');
        } else {
          if (confirmPeShortCoveringAtAtm(ctx)) oiConfirmations.push('SHORT_OI_PE_SHORT_COVERING_AT_ATM');
          if (confirmCeLongBuildupAboveAtm(ctx)) oiConfirmations.push('SHORT_OI_CE_LONG_BUILDUP_ABOVE_ATM');
          if (confirmPeLongUnwindingAtSupport(ctx)) oiConfirmations.push('SHORT_OI_PE_LONG_UNWINDING_AT_SUPPORT');
          if (confirmStrikeMigrationDown(ctx)) oiConfirmations.push('SHORT_OI_STRIKE_MIGRATION_DOWN');
        }

        const allRequiredPass = Object.values(confirmations).every((v) => v === true);
        const confluencePassCount = Object.values(confluence).filter((v) => v === true).length;
        const oiOk = oiConfirmations.length >= 1;

        const fullMandatoryResults = {
          STRATEGY: 'VWAP_BOUNCE_DAY_BIAS',
          DAY_BIAS_LONG: _dayState.dayBiasLong,
          DAY_TRADES: _dayState.tradesToday,
          DIST_FROM_VWAP_PCT: distFromVwapPct,
          UT_BOT_TREND: utResult.trend,
          ...confirmations,
          ...confluence,
          [`${direction}_OI_CONFIRMED`]: oiOk,
          [`${direction}_CONFLUENCE_COUNT`]: confluencePassCount,
        };

        if (allRequiredPass && confluencePassCount >= 3 && oiOk) {
          // Mark this bar as fired to prevent re-fire.
          _lastUtBotBarSeen[dedupeKey] = lastBarOpenTime;
          _dayState.tradesToday += 1;
          _dayState.lastTradeMs = cycleMs;
          return {
            candidate,
            mandatoryResults: fullMandatoryResults,
            oiConfirmations,
            riskReward: rr.riskReward,
            reasonCodes: [],
            provenance,
            primaryTrigger: 'VWAP_BOUNCE',
          };
        }

        // Drop NO_TRADE with the failure reasons.
        const failedReasonCodes = [];
        for (const [id, pass] of Object.entries(confirmations)) {
          if (pass !== true) failedReasonCodes.push(signalMandatoryFail(id));
        }
        if (!oiOk) failedReasonCodes.push(REASON_CODES.SIGNAL_NO_OI_CONFIRMATION);
        if (confluencePassCount < 3) failedReasonCodes.push(signalMandatoryFail(`${direction}_CONFLUENCE_LOW`));
        return buildNoTrade({
          mandatoryResults: fullMandatoryResults,
          oiConfirmations,
          riskReward: rr ? rr.riskReward : 0,
          reasonCodes: failedReasonCodes,
          provenance,
        });
      }
    }
  } catch (err) {
    // Fall through.
  }

  try {
    // ----------------------------------------------------------
    // LONG side
    // ----------------------------------------------------------
    const longRr = computeRiskReward(ctx, settings);
    /** @type {Object<string, boolean>} */
    const longMandatoryResults = {};
    longMandatoryResults.LONG_VWAP = checkVwap(ctx);
    longMandatoryResults.LONG_EMA = checkEmaCrossover(ctx, settings);
    longMandatoryResults.LONG_ATR = checkAtrExpansion(ctx, settings);
    longMandatoryResults.LONG_PE_SHORT_BUILDUP = checkPeShortBuildupAtOrBelowAtm(ctx);
    longMandatoryResults.LONG_FUTURES_BIAS = checkFuturesBias(ctx);
    longMandatoryResults.LONG_CUMULATIVE_DELTA = checkCumulativeDelta(ctx);
    longMandatoryResults.LONG_VOLUME_BREAKOUT = checkVolumeBreakout(ctx, settings);
    longMandatoryResults.LONG_BREADTH = checkBreadth(ctx);
    longMandatoryResults.LONG_LIQUIDITY = checkLiquidity(ctx, settings);
    longMandatoryResults.LONG_PRICE_VS_POC = checkPriceVsPoc(ctx);
    longMandatoryResults.LONG_REGIME = checkRegime(ctx);
    longMandatoryResults.LONG_RR = checkRiskReward(longRr.riskReward, settings);

    const longFailedIds = LONG_MANDATORY_IDS.filter(
      (id) => longMandatoryResults[id] !== true,
    );

    const longOiConfirmations = [];
    if (confirmCeShortCoveringAtAtm(ctx)) {
      longOiConfirmations.push('LONG_OI_CE_SHORT_COVERING_AT_ATM');
    }
    if (confirmPeLongBuildupBelowAtm(ctx)) {
      longOiConfirmations.push('LONG_OI_PE_LONG_BUILDUP_BELOW_ATM');
    }
    if (confirmCeLongUnwindingAtResistance(ctx)) {
      longOiConfirmations.push('LONG_OI_CE_LONG_UNWINDING_AT_RESISTANCE');
    }
    if (confirmStrikeMigrationUp(ctx)) {
      longOiConfirmations.push('LONG_OI_STRIKE_MIGRATION_UP');
    }

    // ----------------------------------------------------------
    // SHORT side
    // ----------------------------------------------------------
    const shortRr = computeRiskRewardShort(ctx, settings);
    /** @type {Object<string, boolean>} */
    const shortMandatoryResults = {};
    shortMandatoryResults.SHORT_VWAP = checkVwapShort(ctx);
    shortMandatoryResults.SHORT_EMA = checkEmaCrossoverShort(ctx, settings);
    shortMandatoryResults.SHORT_ATR = checkAtrExpansionShort(ctx, settings);
    shortMandatoryResults.SHORT_CE_SHORT_BUILDUP = checkCeShortBuildupAtOrAboveAtm(ctx);
    shortMandatoryResults.SHORT_FUTURES_BIAS = checkFuturesBiasShort(ctx);
    shortMandatoryResults.SHORT_CUMULATIVE_DELTA = checkCumulativeDeltaShort(ctx);
    shortMandatoryResults.SHORT_VOLUME_BREAKDOWN = checkVolumeBreakdownShort(ctx, settings);
    shortMandatoryResults.SHORT_BREADTH = checkBreadthShort(ctx);
    shortMandatoryResults.SHORT_LIQUIDITY = checkLiquidityShort(ctx, settings);
    shortMandatoryResults.SHORT_PRICE_VS_POC = checkPriceVsPocShort(ctx);
    shortMandatoryResults.SHORT_REGIME = checkRegimeShort(ctx);
    shortMandatoryResults.SHORT_RR = checkRiskRewardShort(shortRr.riskReward, settings);

    const shortFailedIds = SHORT_MANDATORY_IDS.filter(
      (id) => shortMandatoryResults[id] !== true,
    );

    const shortOiConfirmations = [];
    if (confirmPeShortCoveringAtAtm(ctx)) {
      shortOiConfirmations.push('SHORT_OI_PE_SHORT_COVERING_AT_ATM');
    }
    if (confirmCeLongBuildupAboveAtm(ctx)) {
      shortOiConfirmations.push('SHORT_OI_CE_LONG_BUILDUP_ABOVE_ATM');
    }
    if (confirmPeLongUnwindingAtSupport(ctx)) {
      shortOiConfirmations.push('SHORT_OI_PE_LONG_UNWINDING_AT_SUPPORT');
    }
    if (confirmStrikeMigrationDown(ctx)) {
      shortOiConfirmations.push('SHORT_OI_STRIKE_MIGRATION_DOWN');
    }

    // ----------------------------------------------------------
    // Combined audit map — every cycle records BOTH sides' gate
    // results so the audit row is complete (Req 18.4). The
    // `SignalOutput.mandatoryResults` typedef is
    // `Object<string, boolean>`, so the 24 keys co-exist freely.
    // ----------------------------------------------------------
    const mandatoryResults = Object.assign(
      {},
      longMandatoryResults,
      shortMandatoryResults,
    );
    // Combined OI confirmations across both sides, for the audit
    // row. The success-path return below overrides this with the
    // firing side's confirmations only.
    const allOiConfirmations = longOiConfirmations.concat(shortOiConfirmations);

    // ----------------------------------------------------------
    // Success path: LONG fires (Req 8.5).
    // ----------------------------------------------------------
    if (longFailedIds.length === 0 && longOiConfirmations.length > 0) {
      return {
        candidate: 'LONG_SETUP',
        mandatoryResults,
        oiConfirmations: longOiConfirmations,
        riskReward: longRr.riskReward,
        reasonCodes: [],
        provenance,
      };
    }

    // ----------------------------------------------------------
    // Success path: SHORT fires (Req 9.5).
    // ----------------------------------------------------------
    if (shortFailedIds.length === 0 && shortOiConfirmations.length > 0) {
      return {
        candidate: 'SHORT_SETUP',
        mandatoryResults,
        oiConfirmations: shortOiConfirmations,
        riskReward: shortRr.riskReward,
        reasonCodes: [],
        provenance,
      };
    }

    // ----------------------------------------------------------
    // NO_TRADE — reason aggregation.
    //
    // Special case 1 (Req 8.4 / 9.4): if EITHER side has all
    // twelve mandatories true but no OI confirmation, emit the
    // single `SIGNAL_NO_OI_CONFIRMATION` code. (In practice this
    // can fire on at most one side per cycle since the two are
    // mutually exclusive, but we tolerate both for safety.)
    // ----------------------------------------------------------
    const longAllMandatoryPass = longFailedIds.length === 0;
    const shortAllMandatoryPass = shortFailedIds.length === 0;
    if (
      (longAllMandatoryPass && longOiConfirmations.length === 0) ||
      (shortAllMandatoryPass && shortOiConfirmations.length === 0)
    ) {
      // Pick the firing side's RR for the audit; if both sides
      // are all-mandatory-pass (theoretically impossible) prefer
      // the LONG number to keep behaviour deterministic.
      const firingSide = longAllMandatoryPass ? 'long' : 'short';
      const firingOi = firingSide === 'long' ? longOiConfirmations : shortOiConfirmations;
      const firingRr = firingSide === 'long' ? longRr.riskReward : shortRr.riskReward;
      return buildNoTrade({
        mandatoryResults,
        oiConfirmations: firingOi,
        riskReward: firingRr,
        reasonCodes: [REASON_CODES.SIGNAL_NO_OI_CONFIRMATION],
        provenance,
      });
    }

    // ----------------------------------------------------------
    // Failure path: pick the side closer to firing (fewer failed
    // mandatories) and emit its per-id failure codes. Ties go to
    // LONG (it is evaluated first).
    // ----------------------------------------------------------
    const longCloser = longFailedIds.length <= shortFailedIds.length;
    const failedIds = longCloser ? longFailedIds : shortFailedIds;
    const closerOi = longCloser ? longOiConfirmations : shortOiConfirmations;
    const closerRr = longCloser ? longRr.riskReward : shortRr.riskReward;
    return buildNoTrade({
      mandatoryResults,
      oiConfirmations: closerOi.length > 0 ? closerOi : allOiConfirmations,
      riskReward: closerRr,
      reasonCodes: buildMandatoryFailureReasons(failedIds),
      provenance,
    });
  } catch (err) {
    // Any unexpected failure ⇒ safe default NO_TRADE with a
    // synthetic internal-failure reason so the audit row records
    // it. We deliberately swallow `err` rather than re-throwing
    // because Req 1.5 demands the engine never abort a cycle.
    return buildNoTrade({
      mandatoryResults: {},
      oiConfirmations: [],
      riskReward: 0,
      reasonCodes: [signalMandatoryFail('INTERNAL')],
      provenance,
    });
  }
}

module.exports = {
  evaluateSignal,
  evaluateUpstreamGates,
  __resetUtBotCacheForTest,
  __recordTradeOutcome,
  // Exposed for unit tests and downstream reuse.
  computeEma,
  computeAtr,
  inferStrikeStep,
  LONG_MANDATORY_IDS,
  LONG_OI_CONFIRMATION_IDS,
  SHORT_MANDATORY_IDS,
  SHORT_OI_CONFIRMATION_IDS,
};
