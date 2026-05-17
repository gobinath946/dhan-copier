/**
 * Institutional AI Service

 * ========================

 * Institution-grade OpenAI payload builder + caller for NIFTY options scalping.

 *
 * HybridEngine: removed per Req 3.11 — direct order-placement authority
 * disabled. This module is ADVISORY ONLY. AI advisories must flow into the
 * Hybrid_Engine pipeline exclusively through `hybridEngine/aiSupport.adapter.js`,
 * which is the only authorised consumer. The `getEntryDecision` and
 * `getMonitorDecision` exports below are preserved for backwards compatibility
 * with legacy callers (e.g. `scalpingEngine.service.js`); they return decision
 * structures only and MUST NOT be wired to any direct order-placement path
 * (`orderOrchestration.executeMultiAccountOrder`, `dhanProd.placeOrder`,
 * `copyTrade.placeOrder`). The `_assertNoDirectExecution` helper at the foot of
 * this module documents and enforces the boundary at runtime.
 *
 * ENTRY DECISION

 *   - Sends ±4 strikes from CURRENT market price (live context beats opening anchor)

 *   - Full CE + PE data per strike: LTP, OI, change-in-OI, IV, greeks, volume

 *   - All 17 algorithm outputs

 *   - Market internals, global markets, sentiment, FII/DII

 *   - targetPoints from settings = MINIMUM target — AI must confirm it can reach it

 *   - Returns: { shouldEnter, signal, strike, optionType, confidence, minTargetAchievable,

 *               expectedPoints, reasoning, risks }

 *

 * MONITOR DECISION

 *   - Same strike-chain data + current holding details

 *   - Phase-aware: before min-target vs after min-target

 *   - Returns: { action, confidence, reasoning, newSl, addQuantity, exitType }

 *

 * RULES (hard-coded, never overridden by AI):

 *   1. Entry only if AI confirms minTarget is achievable

 *   2. After min-target reached: if price falls back below → immediate EXIT (no AI needed)

 *   3. ADD_QUANTITY only after min-target captured AND AI confident AND currentLots < maxLots

 *   4. Multiple concurrent entries allowed up to maxConcurrentTrades (different strikes)

 */



const axios = require('axios');

const logger = require('../utils/logger');
const historicalContext = require('./historicalContext.service');



const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// Load OpenAI API key from environment variable

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;



// ─────────────────────────────────────────────────────────────────────────────

// STRIKE CHAIN BUILDER  (±4 from current market price)

// ─────────────────────────────────────────────────────────────────────────────



/**

 * Build a rich ±4 strike chain around the current spot price.

 * Each row contains CE + PE: ltp, oi, oiChange, iv, delta, gamma, volume.

 *

 * @param {Object} optionChain  - raw option chain from dhanBypass

 * @param {number} spotPrice    - current NIFTY spot LTP

 * @param {number} [range=4]    - how many strikes each side (default 4)

 * @returns {Array}             - sorted strike rows, ATM in the middle

 */

function buildStrikeChain(optionChain, spotPrice, range = 4) {

  if (!optionChain || !optionChain.strikes || !spotPrice) return [];



  // ATM = nearest 50-multiple to spot

  const atmStrike = Math.round(spotPrice / 50) * 50;



  const chain = [];

  for (let i = -range; i <= range; i++) {

    const strike = atmStrike + i * 50;

    const row = optionChain.strikes.find(s => s.strike === strike);

    if (!row) continue;



    const ceOiChange = row.call.oiChange || row.call.oi_change || 0;

    const peOiChange = row.put.oiChange  || row.put.oi_change  || 0;



    chain.push({

      strike,

      distance_from_atm: i,                    // negative = below ATM (PE side)

      is_atm: i === 0,

      is_itm_ce: strike < spotPrice,

      is_itm_pe: strike > spotPrice,

      call: {

        ltp:        row.call.ltp        || 0,

        oi:         row.call.oi         || 0,

        oi_change:  ceOiChange,

        oi_change_pct: row.call.oi ? ((ceOiChange / row.call.oi) * 100).toFixed(2) : '0',

        iv:         row.call.iv         || 0,

        volume:     row.call.volume     || 0,

        delta:      row.call.greeks?.delta  || null,

        gamma:      row.call.greeks?.gamma  || null,

        theta:      row.call.greeks?.theta  || null,

        vega:       row.call.greeks?.vega   || null,

        symbol:     row.call.displaySymbol  || '',

        buildup:    classifyStrikeBuildup(row.call.ltp, row.call.oi, ceOiChange),

      },

      put: {

        ltp:        row.put.ltp         || 0,

        oi:         row.put.oi          || 0,

        oi_change:  peOiChange,

        oi_change_pct: row.put.oi ? ((peOiChange / row.put.oi) * 100).toFixed(2) : '0',

        iv:         row.put.iv          || 0,

        volume:     row.put.volume      || 0,

        delta:      row.put.greeks?.delta   || null,

        gamma:      row.put.greeks?.gamma   || null,

        theta:      row.put.greeks?.theta   || null,

        vega:       row.put.greeks?.vega    || null,

        symbol:     row.put.displaySymbol   || '',

        buildup:    classifyStrikeBuildup(row.put.ltp, row.put.oi, peOiChange),

      },

    });

  }



  return chain;

}



/**

 * Classify buildup type for a single option leg.

 * price_up + oi_up   = long_buildup  (bullish for CE, bearish for PE)

 * price_up + oi_down = short_covering

 * price_down + oi_up = short_buildup

 * price_down + oi_down = long_unwinding

 */

function classifyStrikeBuildup(ltp, oi, oiChange) {

  if (!ltp || !oi) return 'unknown';

  const oiUp = oiChange > 0;

  // We don't have prev ltp here, so use oiChange direction as proxy

  if (oiUp)  return oiChange > oi * 0.02 ? 'strong_buildup' : 'buildup';

  if (!oiUp) return Math.abs(oiChange) > oi * 0.02 ? 'strong_unwinding' : 'unwinding';

  return 'neutral';

}



/**

 * Summarise the full chain into key OI signals for the AI prompt.

 */

function summariseChain(chain) {

  if (!chain.length) return {};



  const totalCeOI  = chain.reduce((s, r) => s + r.call.oi, 0);

  const totalPeOI  = chain.reduce((s, r) => s + r.put.oi,  0);

  const totalCeOIChange = chain.reduce((s, r) => s + r.call.oi_change, 0);

  const totalPeOIChange = chain.reduce((s, r) => s + r.put.oi_change,  0);



  // Highest OI strikes (max pain proxies)

  const maxCeOI = chain.reduce((b, r) => r.call.oi > b.oi ? { strike: r.strike, oi: r.call.oi } : b, { strike: 0, oi: 0 });

  const maxPeOI = chain.reduce((b, r) => r.put.oi  > b.oi ? { strike: r.strike, oi: r.put.oi  } : b, { strike: 0, oi: 0 });



  // Strikes with biggest OI addition (fresh positions)

  const biggestCeAdd = chain.reduce((b, r) => r.call.oi_change > b.change ? { strike: r.strike, change: r.call.oi_change } : b, { strike: 0, change: 0 });

  const biggestPeAdd = chain.reduce((b, r) => r.put.oi_change  > b.change ? { strike: r.strike, change: r.put.oi_change  } : b, { strike: 0, change: 0 });



  const pcr = totalCeOI ? (totalPeOI / totalCeOI).toFixed(3) : '0';



  return {

    pcr_chain:           pcr,

    total_ce_oi:         totalCeOI,

    total_pe_oi:         totalPeOI,

    ce_oi_change_net:    totalCeOIChange,

    pe_oi_change_net:    totalPeOIChange,

    max_ce_oi_strike:    maxCeOI,

    max_pe_oi_strike:    maxPeOI,

    biggest_ce_addition: biggestCeAdd,

    biggest_pe_addition: biggestPeAdd,

    interpretation: totalPeOIChange > 0 && totalCeOIChange < 0

      ? 'PE_BUILDUP_CE_UNWINDING → bearish pressure'

      : totalCeOIChange > 0 && totalPeOIChange < 0

      ? 'CE_BUILDUP_PE_UNWINDING → bullish pressure'

      : 'MIXED',

  };

}





// ─────────────────────────────────────────────────────────────────────────────

// ENTRY DECISION

// ─────────────────────────────────────────────────────────────────────────────



const ENTRY_SYSTEM_PROMPT = `You are the head of a NIFTY options desk at a top-tier Indian institution.
You have 25 years of experience. You trade with discipline, precision, and conviction.

YOUR MANDATE:
- Analyse the complete market intelligence payload INCLUDING HISTORICAL CONTEXT.
- Decide whether to enter a SCALP or SWING trade.
- The "min_target_points" is the MINIMUM for scalp. Swing targets are 3-8x that.
- Multiple concurrent trades at DIFFERENT strikes are allowed.

⚠️ CRITICAL — NO TRADE IN RANGING/CHOPPY MARKETS:
  - If 30m = neutral/unknown AND 15m = neutral/unknown → NO_TRADE (wait for clarity)
  - If price is oscillating within a 50-point range for >30 minutes → NO_TRADE
  - If last 3 candles show no clear direction (up-down-up or down-up-down) → NO_TRADE
  - ONLY enter when you have HIGH CONVICTION from multiple timeframes

CRITICAL — DIRECTION FIRST, STRIKE SECOND:
  Step 1: Determine direction from 30m + 15m + VWAP + price action + HISTORICAL LEVELS
  Step 2: Pick the best strike for that direction

  DIRECTION RULES (STRICT):
  - 30m bearish + 15m bearish + price below VWAP → BUY_PE (bearish)
  - 30m bullish + 15m bullish + price above VWAP → BUY_CE (bullish)
  - 30m neutral + 15m bearish + price below VWAP → BUY_PE (lean bearish) — ONLY if 5m also bearish
  - 30m neutral + 15m bullish + price above VWAP → BUY_CE (lean bullish) — ONLY if 5m also bullish
  - 30m neutral + 15m neutral → NO_TRADE (wait for clarity)
  - Global strongly_bullish does NOT override local bearish price action
  - Global strongly_bearish does NOT override local bullish price action
  
  HISTORICAL CONTEXT RULES (NEW):
  - If price is below yesterday's low → strong bearish bias (prefer PE)
  - If price is above yesterday's high → strong bullish bias (prefer CE)
  - If price is within yesterday's range → use intraday levels only
  - Opening range (first 15 min): if price breaks above → bullish, below → bearish

STRIKE SELECTION (after direction is determined):
  1. ATM (distance_from_atm = 0) — default for most scalps
  2. Support strike for PE: if price is near a support level, use that strike for PE
     (support = where price has bounced before, high PE OI)
  3. Resistance strike for CE: if price is near resistance, use that strike for CE
     (resistance = where price has rejected before, high CE OI)
  4. ITM for high conviction: if 30m + 15m + 5m all agree, use 1 ITM strike
  5. NEVER use the same strike if the last 2 trades at that strike were losses

  HOW TO FIND SUPPORT/RESISTANCE FROM OI:
  - Highest PE OI strike = strong support (market makers defend it)
  - Highest CE OI strike = strong resistance (market makers defend it)
  - Max pain strike = where market gravitates by expiry
  - If spot is between two high-OI strikes, use the one in the direction of trade

TRADE TYPE:
  SCALP: expected_points < 15. Hold 30-90 seconds. ATM or 1 ITM.
         ONLY in clear short-term momentum (5m + 1m aligned).
         
  SWING: expected_points >= 40 AND AI MUST CONFIRM these points are ACHIEVABLE.
         Hold 5-15 minutes. ATM or 1 ITM.
         STRICT REQUIREMENTS:
         - 30m + 15m + 5m ALL must align in same direction
         - Strong trend (not just "bearish" but "STRONG bearish momentum")
         - Price must have room to move (not near support for PE, not near resistance for CE)
         - Historical levels must support the move
         - If ANY doubt → SCALP instead of SWING
         
  ⚠️ CRITICAL: If you cannot GUARANTEE the expected_points will be reached, 
      reduce expected_points to a SCALP level (5-10pts) or return NO_TRADE.

WHEN TO RETURN NO_TRADE:
  1. Premium is 0 or unavailable
  2. Direction is genuinely unclear (all timeframes neutral, no VWAP signal)
  3. Confidence < 6 after all data
  4. Both CE and PE show zero OI (no liquidity)
  5. SWING trade requested but expected_points NOT achievable with high confidence
  6. Market is ranging (30m=neutral AND 15m=neutral)
  7. Price action contradicts the signal (e.g., BUY_CE but price falling hard)

IMPORTANT — FII/DII DATA:
  - fii_dii.available = false is NORMAL — do not block entry because of absent FII/DII data

Return ONLY valid JSON:
{
  "should_enter": true | false,
  "signal": "BUY_CE" | "BUY_PE" | "NO_TRADE",
  "strike": number,
  "option_type": "ATM" | "ITM" | "OTM",
  "strike_selection_reason": "ATM_default" | "support_level" | "resistance_level" | "high_oi_buildup" | "ITM_high_conviction",
  "trade_type": "SCALP" | "SWING",
  "hold_duration_seconds": number,
  "confidence": 0-10,
  "min_target_achievable": true | false,
  "expected_points": number,
  "breakout_probability": 0-100,
  "direction": "bullish" | "bearish" | "neutral",
  "key_level_to_break": number,
  "reasoning": "max 300 chars — cite MTF trend, VWAP, OI data, specific levels",
  "risks": "max 150 chars",
  "suggested_sl_points": number,
  "suggested_target_points": number,
  "mtf_alignment": "strongly_bullish" | "bullish" | "neutral" | "bearish" | "strongly_bearish",
  "additional_strikes": [
    { "strike": number, "signal": "BUY_CE"|"BUY_PE", "option_type": "ATM"|"ITM"|"OTM", "confidence": 0-10, "reasoning": "max 100 chars" }
  ]
}`;



/**

 * Build the full entry payload and call OpenAI.

 *

 * @param {Object} p

 * @param {Object} p.marketData        - aggregator payload (spot, vwap, ema, etc.)

 * @param {Object} p.optionChain       - raw option chain from dhanBypass

 * @param {Object} p.algorithmOutputs  - all 17 algorithm outputs

 * @param {Object} p.masterDecision    - masterAlgorithm result

 * @param {Object} p.tradeDecision     - professionalTrader result

 * @param {Object} p.sessionSettings   - session settings (targetPoints, slPoints, lotSize, etc.)

 * @param {Object} p.openTrades        - currently open trades (for context)

 * @param {string} p.direction         - 'bullish' | 'bearish'

 * @param {string} p.aiModel

 * @returns {Object} AI decision

 */

async function getEntryDecision({

  marketData,

  optionChain,

  algorithmOutputs,

  masterDecision,

  tradeDecision,

  sessionSettings,

  openTrades = [],

  direction,

  aiModel = 'gpt-4o-mini',

}) {

  try {

    const spotPrice  = marketData?.spot_data?.ltp || 0;

    const atmStrike  = Math.round(spotPrice / 50) * 50;

    const minTarget  = Number(sessionSettings?.targetPoints) || 5;

    const slPoints   = Number(sessionSettings?.slPoints)     || minTarget * 2;

    const maxLots    = Number(sessionSettings?.maxLots)      || 3;

    const minLots    = Number(sessionSettings?.minLots)      || 1;

    const maxConc    = Number(sessionSettings?.maxConcurrentTrades) || 1;



    // Build ±4 strike chain

    const strikeChain = buildStrikeChain(optionChain, spotPrice, 4);

    const chainSummary = strikeChain.length ? summariseChain(strikeChain) : {};



    // Compact algorithm summary (avoid token bloat)

    const algoSummary = {

      master_score:       masterDecision?.master_score,

      master_signal:      masterDecision?.master_signal,

      confidence:         masterDecision?.confidence,

      agreement_count:    masterDecision?.agreement_count,

      entry_recommended:  masterDecision?.entry_recommended,

      individual_scores:  masterDecision?.individual_scores,

      gamma_exposure: algorithmOutputs?.gammaExposure ? {

        net_gex:          algorithmOutputs.gammaExposure.net_gex,

        flip_level:       algorithmOutputs.gammaExposure.flip_level,

        expected_move:    algorithmOutputs.gammaExposure.expected_move,

        dealer_position:  algorithmOutputs.gammaExposure.dealer_position,

      } : null,

      order_flow: algorithmOutputs?.orderFlow ? {

        imbalance:        algorithmOutputs.orderFlow.imbalance,

        buy_pressure:     algorithmOutputs.orderFlow.buy_pressure,

        sell_pressure:    algorithmOutputs.orderFlow.sell_pressure,

        signal:           algorithmOutputs.orderFlow.signal,

      } : null,

      multi_timeframe: algorithmOutputs?.multiTimeframe ? {

        alignment_score:  algorithmOutputs.multiTimeframe.alignment_score,

        higher_tf_bias:   algorithmOutputs.multiTimeframe.higher_tf_bias,

        fractal_pattern:  algorithmOutputs.multiTimeframe.fractal_pattern,

        all_aligned:      algorithmOutputs.multiTimeframe.all_timeframes_aligned,

        timeframes:       algorithmOutputs.multiTimeframe.timeframes,

      } : null,

      liquidity: algorithmOutputs?.liquidityAnalysis ? {

        health:           algorithmOutputs.liquidityAnalysis.liquidity_health,

        score:            algorithmOutputs.liquidityAnalysis.liquidity_score,

        sweep_risk:       algorithmOutputs.liquidityAnalysis.liquidity_sweeps?.sweep_risk,

      } : null,

      smart_money: algorithmOutputs?.smartMoneyConcepts ? {

        bias:             algorithmOutputs.smartMoneyConcepts.smc_bias,

        score:            algorithmOutputs.smartMoneyConcepts.smc_score,

        structure:        algorithmOutputs.smartMoneyConcepts.market_structure?.structure,

        order_blocks:     algorithmOutputs.smartMoneyConcepts.order_blocks,

        fvg:              algorithmOutputs.smartMoneyConcepts.fair_value_gaps,

      } : null,

      market_internals: algorithmOutputs?.marketInternals ? {

        score:            algorithmOutputs.marketInternals.market_internals_score,

        advance_decline:  algorithmOutputs.marketInternals.advance_decline,

        breadth:          algorithmOutputs.marketInternals.market_breadth,

      } : null,

      sector_rotation: algorithmOutputs?.sectorRotation ? {

        score:            algorithmOutputs.sectorRotation.sector_rotation_score,

        leading_sectors:  algorithmOutputs.sectorRotation.leading_sectors,

        lagging_sectors:  algorithmOutputs.sectorRotation.lagging_sectors,

      } : null,

      global_markets: algorithmOutputs?.globalMarkets ? {

        score:            algorithmOutputs.globalMarkets.global_score,

        risk_sentiment:   algorithmOutputs.globalMarkets.risk_sentiment?.sentiment,

        global_bias:      algorithmOutputs.globalMarkets.global_bias,

        us_futures:       algorithmOutputs.globalMarkets.us_futures?.direction,

        crude_change_pct: algorithmOutputs.globalMarkets.crude_oil?.changePct,

        dxy_change_pct:   algorithmOutputs.globalMarkets.dxy?.changePct,

      } : null,

      behavioral: algorithmOutputs?.behavioral ? {

        score:            algorithmOutputs.behavioral.behavioral_score,

        bias:             algorithmOutputs.behavioral.behavioral_bias,

        retail_panic:     algorithmOutputs.behavioral.retail_panic?.detected,

        fomo:             algorithmOutputs.behavioral.fomo?.detected,

        short_squeeze:    algorithmOutputs.behavioral.short_squeeze?.detected,

        trap_moves:       algorithmOutputs.behavioral.trap_moves?.detected,

      } : null,

      dema: algorithmOutputs?.dema ? {

        score:            algorithmOutputs.dema.dema_score,

        signal:           algorithmOutputs.dema.dema_signal,

        momentum:         algorithmOutputs.dema.momentum,

      } : null,

    };

    // ── LOAD HISTORICAL CONTEXT (NEW) ────────────────────────────────────
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const histContext = await historicalContext.getHistoricalContext(currentDate);
    logger.info({ available: histContext.available }, '[institutionalAI] Historical context loaded');

    const payload = {

      // ── CONTEXT ──────────────────────────────────────────────────────────

      timestamp:          new Date().toISOString(),

      instrument:         'NIFTY50 OPTIONS',

      task:               'ENTRY_DECISION',



      // ── RISK PARAMETERS (from settings) ──────────────────────────────────

      risk_parameters: {

        min_target_points:  minTarget,   // MINIMUM — AI must confirm achievability

        sl_points:          slPoints,

        min_lots:           minLots,

        max_lots:           maxLots,

        max_concurrent_trades: maxConc,

        current_open_trades:   openTrades.length,

        open_trade_strikes:    openTrades.map(t => ({ strike: t.strike, signal: t.signal })),

      },



      // ── SPOT & MARKET STRUCTURE ───────────────────────────────────────────

      spot: {

        ltp:              spotPrice,

        open:             marketData?.spot_data?.open,

        high:             marketData?.spot_data?.high,

        low:              marketData?.spot_data?.low,

        prev_close:       marketData?.spot_data?.previous_close,

        returns_1m_pct:   marketData?.spot_data?.returns_1m,

        day_range:        marketData?.spot_data?.day_range,

        atm_strike:       atmStrike,
        atm_strike_is_default_choice: true,
        note_on_strike_selection: 'DEFAULT to ATM strike unless support/resistance strike has confidence>=8 AND OI buildup>1.5x ATM',

      },

      vwap: {

        value:            marketData?.vwap_analysis?.vwap,

        price_vs_vwap:    marketData?.vwap_analysis?.price_vs_vwap,

        distance_pts:     marketData?.vwap_analysis?.distance_from_vwap,

      },

      ema: {

        ema_9:            marketData?.moving_averages?.ema_9,

        ema_20:           marketData?.moving_averages?.ema_20,

        ema_50:           marketData?.moving_averages?.ema_50,

        alignment:        marketData?.moving_averages?.ema_alignment,

      },

      volume: {

        current:          marketData?.volume_orderflow?.volume,

        avg_20:           marketData?.volume_orderflow?.avg_volume_20,

        spike:            marketData?.volume_orderflow?.volume_spike,

      },

      market_structure: {

        trend:            marketData?.market_structure?.trend_structure,

        regime:           marketData?.market_structure?.market_regime,

        build_up_type:    marketData?.futures_data?.build_up_type,

      },

      expiry: {

        date:             marketData?.expiry_context?.expiry,

        days_to_expiry:   marketData?.expiry_context?.days_to_expiry,

        type:             marketData?.expiry_context?.expiry_type,

      },



      // ── FULL ±4 STRIKE CHAIN (9 strikes) ─────────────────────────────────

      // This is the most important section — analyse ALL rows

      strike_chain_pm4: strikeChain,

      chain_summary:    chainSummary,



      // ── OVERALL OI ANALYSIS ───────────────────────────────────────────────

      oi_analysis:      marketData?.oi_analysis  || null,

      oi_change:        marketData?.oi_change     || null,



      // ── ATM OPTIONS SNAPSHOT ─────────────────────────────────────────────

      atm_options:      marketData?.options_chain || null,



      // ── ALL 17 ALGORITHMS ────────────────────────────────────────────────

      algorithms:       algoSummary,



      // ── PROFESSIONAL TRADER ANALYSIS ─────────────────────────────────────

      professional_trader: {

        market_character:   tradeDecision?.market_character,

        dominant_direction: tradeDecision?.dominant_direction,

        trade_decision:     tradeDecision?.trade_decision,

        selected_strike:    tradeDecision?.selected_strike,

        option_type:        tradeDecision?.option_type,

        confidence:         tradeDecision?.confidence,

        entry_rationale:    tradeDecision?.entry_rationale,

        risk_reward:        tradeDecision?.risk_reward_ratio,

        key_risks:          tradeDecision?.key_risks,

      },



      // ── DIRECTION RESOLVED BY ENGINE ─────────────────────────────────────

      engine_direction: direction,

      // ── FII/DII INSTITUTIONAL FLOWS (context only, no separate AI call) ──
      // If absent, it means Sensibull has no data — normal during market hours
      // Do NOT block entries just because FII/DII data is absent
      fii_dii: (sessionSettings && sessionSettings.fiiDiiSummary) ? sessionSettings.fiiDiiSummary : {
        available: false,
        note: 'FII/DII data absent — normal during market hours, do not block entry',
      },

      // ── HISTORICAL CONTEXT (NEW) ─────────────────────────────────────────
      // Previous days' highs/lows, swing levels, support/resistance
      historical_context: histContext.available ? histContext : null,
      
      // ── FUTURES DATA (NEW) ───────────────────────────────────────────────
      // Futures premium/discount, basis, trend
      futures_data: marketData?.futures_data || null,

    };



                // Use actual ATM from aggregator (computed from real spot price)
    const actualAtm = (marketData && marketData.actual_atm_strike) ? marketData.actual_atm_strike : atmStrike;
    const actualSpot = (marketData && marketData.actual_spot_price) ? marketData.actual_spot_price : spotPrice;

    // Multi-timeframe summary from aggregator
    const aggMtf = marketData && marketData.multi_timeframe ? marketData.multi_timeframe : null;
    const aggMtfSummary = aggMtf ? (
      '30m: ' + (aggMtf.timeframes && aggMtf.timeframes['30m'] ? aggMtf.timeframes['30m'].trend + ' str=' + aggMtf.timeframes['30m'].strength + ' regime=' + aggMtf.timeframes['30m'].regime : 'N/A') +
      ' | 15m: ' + (aggMtf.timeframes && aggMtf.timeframes['15m'] ? aggMtf.timeframes['15m'].trend + ' str=' + aggMtf.timeframes['15m'].strength : 'N/A') +
      ' | 5m: ' + (aggMtf.timeframes && aggMtf.timeframes['5m'] ? aggMtf.timeframes['5m'].trend + ' str=' + aggMtf.timeframes['5m'].strength : 'N/A') +
      ' | 1m: ' + (aggMtf.timeframes && aggMtf.timeframes['1m'] ? aggMtf.timeframes['1m'].trend + ' str=' + aggMtf.timeframes['1m'].strength : 'N/A') +
      ' | alignment=' + aggMtf.alignment +
      ' | higher_tf_bias=' + aggMtf.higher_tf_bias +
      ' | all_aligned=' + aggMtf.all_aligned
    ) : 'No aggregator MTF data';

    // Determine local direction from price action
    const vwapPos = (marketData && marketData.vwap_analysis) ? marketData.vwap_analysis.price_vs_vwap : 'unknown';
    const mtf15m  = aggMtf && aggMtf.timeframes && aggMtf.timeframes['15m'] ? aggMtf.timeframes['15m'].trend : 'neutral';
    const mtf30m  = aggMtf && aggMtf.timeframes && aggMtf.timeframes['30m'] ? aggMtf.timeframes['30m'].trend : 'neutral';
    const mtf5m   = aggMtf && aggMtf.timeframes && aggMtf.timeframes['5m']  ? aggMtf.timeframes['5m'].trend  : 'neutral';

    const localDirection = (mtf15m === 'bearish' || mtf30m === 'bearish') && vwapPos === 'below' ? 'bearish'
      : (mtf15m === 'bullish' || mtf30m === 'bullish') && vwapPos === 'above' ? 'bullish'
      : 'neutral';

    // OI-based support/resistance
    const chainSummaryData = chainSummary || {};
    const maxPeOiStrike = chainSummaryData.max_pe_oi_strike ? chainSummaryData.max_pe_oi_strike.strike : null;
    const maxCeOiStrike = chainSummaryData.max_ce_oi_strike ? chainSummaryData.max_ce_oi_strike.strike : null;

    // Recent loss history from open trades context
    const recentLossStrikes = openTrades
      .filter(function(t) { return t.result === 'LOSS'; })
      .map(function(t) { return t.strike; });

    // Historical context summary
    const histSummary = histContext.available ? `
HISTORICAL CONTEXT (CRITICAL FOR DECISION):
Yesterday: High=${histContext.yesterday?.high || 'N/A'}, Low=${histContext.yesterday?.low || 'N/A'}, Close=${histContext.yesterday?.close || 'N/A'}
Current vs Yesterday: ${actualSpot > (histContext.yesterday?.high || 0) ? 'ABOVE yesterday high (bullish)' : actualSpot < (histContext.yesterday?.low || 999999) ? 'BELOW yesterday low (bearish)' : 'Within yesterday range'}
Opening Range: High=${histContext.opening_range?.high || 'N/A'}, Low=${histContext.opening_range?.low || 'N/A'}
Key Resistance Levels: ${histContext.key_resistance_levels?.map(l => l.level).join(', ') || 'N/A'}
Key Support Levels: ${histContext.key_support_levels?.map(l => l.level).join(', ') || 'N/A'}
Weekly High: ${histContext.weekly_high || 'N/A'}, Weekly Low: ${histContext.weekly_low || 'N/A'}
Futures Premium Trend: ${histContext.futures_premium_trend || 'N/A'}
` : 'Historical context not available';

    const userPrompt = `You are making an ENTRY DECISION for NIFTY options.

ACTUAL SPOT: ${actualSpot} | ACTUAL ATM STRIKE: ${actualAtm}
MIN TARGET: ${minTarget} pts | ENGINE DIRECTION: ${direction}

${histSummary}

LOCAL PRICE ACTION (most important — use this for direction):
VWAP position: ${vwapPos} (above=bullish, below=bearish)
${aggMtfSummary}

LOCAL DIRECTION (derived from price action): ${localDirection}
⚠️ USE LOCAL DIRECTION (${localDirection}) for signal, NOT global bias alone.
If local is bearish → BUY_PE. If local is bullish → BUY_CE. If neutral → NO_TRADE (wait for clarity).

⚠️ RANGING MARKET CHECK:
- If 30m=neutral AND 15m=neutral → NO_TRADE
- If price oscillating within 50pts for >30min → NO_TRADE
- Only enter with HIGH CONVICTION from multiple timeframes

OI-BASED LEVELS:
- Highest PE OI strike (support): ${maxPeOiStrike || 'N/A'} — use for BUY_PE entry
- Highest CE OI strike (resistance): ${maxCeOiStrike || 'N/A'} — use for BUY_CE entry
- ATM strike: ${actualAtm}

STRIKE SELECTION:
- If BUY_PE: prefer ${maxPeOiStrike || actualAtm} (highest PE OI = support level)
- If BUY_CE: prefer ${maxCeOiStrike || actualAtm} (highest CE OI = resistance level)
- If no clear OI level: use ATM ${actualAtm}
- AVOID these strikes (recent losses): ${recentLossStrikes.length > 0 ? recentLossStrikes.join(', ') : 'none'}

COMPLETE PAYLOAD:
${JSON.stringify(payload, null, 2)}`;



        logger.info({
      spotPrice, atmStrike, direction, minTarget,
      strikeChainLength: strikeChain.length,
      masterScore: masterDecision && masterDecision.master_score,
      historicalAvailable: histContext.available,
    }, '[institutionalAI] Sending ENTRY decision to OpenAI (3 parallel calls)');

    // ── 3 PARALLEL AI CALLS — majority vote for high-conviction entries ──────
    const [r1, r2, r3] = await Promise.all([
      callOpenAI(ENTRY_SYSTEM_PROMPT, userPrompt, aiModel),
      callOpenAI(ENTRY_SYSTEM_PROMPT, userPrompt, aiModel),
      callOpenAI(ENTRY_SYSTEM_PROMPT, userPrompt, aiModel),
    ]);

    const responses = [r1, r2, r3].filter(function(r) { return r !== null; });

    if (responses.length === 0) {
      logger.warn('[institutionalAI] All 3 entry AI calls returned null — NO_TRADE');
      return { should_enter: false, signal: 'NO_TRADE', confidence: 0, min_target_achievable: false, expected_points: 0, reasoning: 'All AI calls failed' };
    }

    // Count votes
    const enterVotes = responses.filter(function(r) { return r.should_enter && r.min_target_achievable; });

    logger.info({
      total: responses.length,
      enterVotes: enterVotes.length,
      signals: responses.map(function(r) { return r.signal; }),
      confidences: responses.map(function(r) { return r.confidence; }),
    }, '[institutionalAI] ENTRY parallel votes received');

    // Need majority (2/3) to enter
    if (enterVotes.length < 2) {
      const bestReason = (responses.find(function(r) { return !r.should_enter; }) || {}).reasoning || 'Majority voted NO_TRADE';
      logger.warn({ enterVotes: enterVotes.length }, '[institutionalAI] Majority voted NO_TRADE — skipping');
      return {
        should_enter: false,
        signal: 'NO_TRADE',
        confidence: 0,
        min_target_achievable: false,
        expected_points: 0,
        reasoning: bestReason,
      };
    }

    // Pick highest confidence among enter votes
    const best = enterVotes.reduce(function(a, b) { return (b.confidence || 0) > (a.confidence || 0) ? b : a; });
    const avgConf = Math.round(enterVotes.reduce(function(s, r) { return s + (r.confidence || 0); }, 0) / enterVotes.length * 10) / 10;
    best.confidence = avgConf;
    best.vote_summary = enterVotes.length + '/3 voted ENTER';
    best.expected_points = Math.max.apply(null, enterVotes.map(function(r) { return r.expected_points || 0; }));

    logger.info({
      shouldEnter: best.should_enter, signal: best.signal, strike: best.strike,
      tradeType: best.trade_type, confidence: best.confidence,
      expectedPoints: best.expected_points, votes: best.vote_summary,
    }, '[institutionalAI] ENTRY decision — majority vote result');

    return best;

  } catch (err) {

    logger.error({ err: err.message }, '[institutionalAI] getEntryDecision failed');

    return { should_enter: false, signal: 'NO_TRADE', confidence: 0, min_target_achievable: false, expected_points: 0, reasoning: err.message };

  }

}





// ─────────────────────────────────────────────────────────────────────────────

// MONITOR DECISION

// ─────────────────────────────────────────────────────────────────────────────



const MONITOR_SYSTEM_PROMPT = `You are managing an OPEN NIFTY options trade at an institutional desk.
Your ONLY job is to decide: EXIT, HOLD, TRAIL_SL, or ADD_QUANTITY.
You are the SOLE decision maker for exits. Be decisive.

TRADE TYPE AWARENESS (critical):
  SCALP trade (hold_duration < 120s target):
    - Tight management: cut losses fast, take profits fast
    - Loss cut: -3pts after 60s, or -5pts at any time
    - Profit: exit at target or trail SL

  SWING trade (hold_duration > 300s target):
    - Patient management: hold through minor pullbacks
    - Loss cut: only if -8pts OR clear trend reversal on 15m
    - Profit: trail SL, let it run, add lots on pullbacks
    - Do NOT exit a swing trade just because 1m momentum fades
    - A swing trade needs 15m reversal to exit, not 1m noise

SCALP LOSS CUTTING RULES:
  - pnl_points < -3 AND hold_seconds > 60 → EXIT
  - pnl_points < -5 at any time → EXIT
  - Momentum reversing on 1m → EXIT

SWING LOSS CUTTING RULES:
  - pnl_points < -8 → EXIT (wider SL for swing)
  - 15m trend reversed against trade direction → EXIT
  - Hold time > max_hold_time → EXIT
  - Do NOT exit on 1m noise or minor pullbacks

PROFIT TAKING:
  SCALP: Exit at target or when momentum fades
  SWING: Trail SL, add lots on pullbacks (if phase 2), let profits run to 30-80pts

PHASE RULES:
  PHASE 1 — Before min_target reached:
    - SCALP: HOLD if within -3pts, EXIT if -3pts after 60s
    - SWING: HOLD if within -8pts, EXIT only on 15m reversal
    - DO NOT add quantity

  PHASE 2 — After min_target reached:
    - TRAIL_SL to lock profits
    - ADD_QUANTITY if: master_score > 65 AND momentum increasing AND currentLots < maxLots
    - SWING: keep trailing, don't exit early

ADD_QUANTITY (all must be true):
  - Phase 2 only
  - master_score > 65
  - momentum = "increasing" or "stable"
  - currentLots < maxLots
  - For SWING: 15m still in trade direction

Return ONLY valid JSON:
{
  "action": "EXIT" | "HOLD" | "TRAIL_SL" | "ADD_QUANTITY",
  "confidence": 0-10,
  "reasoning": "max 200 chars — cite trade_type, MTF trend, specific P&L",
  "new_sl": number | null,
  "add_quantity": number | null,
  "exit_type": "stop_loss" | "reversal" | "momentum_fade" | "time" | "trailing_sl" | "profit_lock" | "ai_decision" | null,
  "urgency": "high" | "medium" | "low",
  "phase": 1 | 2,
  "momentum_direction": "increasing" | "stable" | "fading" | "reversing"
}`;



/**

 * Get monitor decision for an open trade.

 *

 * @param {Object} p

 * @param {Object} p.trade             - open trade document

 * @param {Object} p.marketData        - current aggregator payload

 * @param {Object} p.optionChain       - current option chain

 * @param {Object} p.algorithmOutputs  - current algorithm outputs

 * @param {Object} p.masterScore       - current master score (number)

 * @param {Object} p.sessionSettings   - session settings

 * @param {string} p.aiModel

 * @returns {Object} monitor decision

 */

async function getMonitorDecision({

  trade,

  marketData,

  optionChain,

  algorithmOutputs,

  masterScore,

  sessionSettings,

  aiModel = 'gpt-4o-mini',

}) {

  try {

    const spotPrice    = marketData?.spot_data?.ltp || 0;

    const minTarget    = Number(sessionSettings?.targetPoints) || 5;

    const slPoints     = Number(sessionSettings?.slPoints)     || minTarget * 2;

    const maxLots      = Number(sessionSettings?.maxLots)      || 3;

    const lotSize      = Number(sessionSettings?.lotSize)      || 65;

    const currentLots  = Math.round(trade.quantity / lotSize);



    const holdSecs     = Math.floor((Date.now() - new Date(trade.createdAt).getTime()) / 1000);

    const pnlPoints    = trade.currentPrice - trade.entryPrice;

    const pnlRupees    = pnlPoints * trade.quantity;

    const phase        = pnlPoints >= minTarget ? 2 : 1;

    const hasReachedTarget = trade.hasReachedTarget || pnlPoints >= minTarget;



    // Build ±4 strike chain around current spot

    const strikeChain  = buildStrikeChain(optionChain, spotPrice, 4);

    const chainSummary = strikeChain.length ? summariseChain(strikeChain) : {};



    const payload = {

      timestamp:   new Date().toISOString(),

      task:        'MONITOR_DECISION',



      // ── TRADE STATE ───────────────────────────────────────────────────────

      trade: {

        id:                 trade._id?.toString?.()?.slice(-6) || 'unknown',

        signal:             trade.signal,

        strike:             trade.strike,

        entry_price:        trade.entryPrice,

        current_price:      trade.currentPrice,

        sl:                 trade.sl,

        target:             trade.target,

        quantity:           trade.quantity,

        current_lots:       currentLots,

        max_lots:           maxLots,

        hold_seconds:       holdSecs,

        pnl_points:         +pnlPoints.toFixed(2),

        pnl_rupees:         +pnlRupees.toFixed(2),

        entry_reason:       trade.entryReason,

      },



      // ── PHASE & SETTINGS ─────────────────────────────────────────────────

      phase_info: {
        current_phase:        phase,
        min_target_points:    minTarget,
        sl_points:            slPoints,
        has_reached_target:   hasReachedTarget,
        points_above_target:  hasReachedTarget ? +(pnlPoints - minTarget).toFixed(2) : 0,
        can_add_lots:         currentLots < maxLots && phase === 2,
        lots_remaining:       maxLots - currentLots,
        hold_seconds:         holdSecs,
        min_hold_before_exit: 45,
        is_past_min_hold:     holdSecs >= 45,

      },



      // ── CURRENT MARKET ────────────────────────────────────────────────────

      spot: {

        ltp:              spotPrice,

        vwap:             marketData?.vwap_analysis?.vwap,

        price_vs_vwap:    marketData?.vwap_analysis?.price_vs_vwap,

        ema_alignment:    marketData?.moving_averages?.ema_alignment,

        volume_spike:     marketData?.volume_orderflow?.volume_spike,

        build_up:         marketData?.futures_data?.build_up_type,

        regime:           marketData?.market_structure?.market_regime,

      },



      // ── ±4 STRIKE CHAIN ───────────────────────────────────────────────────

      strike_chain_pm4: strikeChain,

      chain_summary:    chainSummary,



      // ── ALGORITHM SNAPSHOT ───────────────────────────────────────────────

      algorithms: {

        master_score:       masterScore,

        gamma_flip:         algorithmOutputs?.gammaExposure?.flip_level || null,

        order_flow_signal:  algorithmOutputs?.orderFlow?.signal || null,

        mtf_bias:           algorithmOutputs?.multiTimeframe?.higher_tf_bias || null,

        mtf_aligned:        algorithmOutputs?.multiTimeframe?.all_timeframes_aligned || false,

        smc_bias:           algorithmOutputs?.smartMoneyConcepts?.smc_bias || null,

        behavioral_bias:    algorithmOutputs?.behavioral?.behavioral_bias || null,

        dema_signal:        algorithmOutputs?.dema?.dema_signal || null,

        liquidity_health:   algorithmOutputs?.liquidityAnalysis?.liquidity_health || null,

      },

    };



        // tradeType and minHoldBeforeExit — computed locally since effectiveMinHold is in tradeMonitor scope
    const tradeType = (sessionSettings && sessionSettings.tradeType) || (trade && trade.tradeType) || 'SCALP';
    const minHoldBeforeExit = tradeType === 'SWING' ? 120 : 20;

    // MTF from aggregator payload
    const monAggMtf = marketData && marketData.multi_timeframe ? marketData.multi_timeframe : null;
    const monMtfSummary = monAggMtf ? (
      '30m: ' + (monAggMtf.timeframes && monAggMtf.timeframes['30m'] ? monAggMtf.timeframes['30m'].trend + ' str=' + monAggMtf.timeframes['30m'].strength : 'N/A') +
      ' | 15m: ' + (monAggMtf.timeframes && monAggMtf.timeframes['15m'] ? monAggMtf.timeframes['15m'].trend + ' str=' + monAggMtf.timeframes['15m'].strength : 'N/A') +
      ' | 5m: ' + (monAggMtf.timeframes && monAggMtf.timeframes['5m'] ? monAggMtf.timeframes['5m'].trend : 'N/A') +
      ' | 1m: ' + (monAggMtf.timeframes && monAggMtf.timeframes['1m'] ? monAggMtf.timeframes['1m'].trend : 'N/A') +
      ' | bias=' + monAggMtf.higher_tf_bias
    ) : 'No MTF data';

    const userPrompt = `You are monitoring an OPEN ${trade.signal} ${tradeType} trade at strike ${trade.strike}.

TRADE TYPE: ${tradeType} (${tradeType === 'SWING' ? 'patient — hold through minor pullbacks, exit on 15m reversal or -8pts' : 'fast — cut at -3pts after 60s or -5pts anytime'})
PHASE: ${phase} | P&L: ${pnlPoints.toFixed(2)} pts | Hold: ${holdSecs}s | Min target: ${minTarget} pts
${holdSecs < minHoldBeforeExit ? 'MIN HOLD NOT REACHED (' + holdSecs + 's < ' + minHoldBeforeExit + 's). Return HOLD unless hard SL hit.' : ''}

MULTI-TIMEFRAME (current market):
${monMtfSummary}

${tradeType === 'SWING' ? 'SWING: Only exit on 15m reversal or -8pts. Hold through 1m noise. Trail SL in phase 2. Add lots if momentum increasing.' : 'SCALP: Exit at -3pts after 60s or -5pts anytime. Take profits at target.'}

COMPLETE PAYLOAD:
${JSON.stringify(payload, null, 2)}`;



    logger.info({

      tradeId:    trade._id,

      phase,

      pnlPoints:  pnlPoints.toFixed(2),

      minTarget,

      currentLots,

      maxLots,

    }, '[institutionalAI] Sending MONITOR decision to OpenAI');



    const response = await callOpenAI(MONITOR_SYSTEM_PROMPT, userPrompt, aiModel);



    if (!response) {

      logger.warn({ tradeId: trade._id }, '[institutionalAI] Monitor AI call returned null — defaulting HOLD');

      return { action: 'HOLD', confidence: 5, reasoning: 'AI call failed', urgency: 'low', phase };

    }



    // Enforce phase rules — AI cannot add quantity in phase 1

    if (response.action === 'ADD_QUANTITY' && phase === 1) {

      logger.warn({ tradeId: trade._id, phase }, '[institutionalAI] AI tried ADD_QUANTITY in phase 1 — overriding to HOLD');

      response.action = 'HOLD';

      response.reasoning = `[Phase 1 override] ${response.reasoning}`;

    }



    logger.info({

      tradeId:   trade._id,

      action:    response.action,

      confidence: response.confidence,

      urgency:   response.urgency,

      phase:     response.phase,

      momentum:  response.momentum_direction,

    }, '[institutionalAI] MONITOR decision received');



    return response;

  } catch (err) {

    logger.error({ err: err.message, tradeId: trade._id }, '[institutionalAI] getMonitorDecision failed');

    return { action: 'HOLD', confidence: 5, reasoning: err.message, urgency: 'low' };

  }

}





// ─────────────────────────────────────────────────────────────────────────────

// SHARED OPENAI CALLER

// ─────────────────────────────────────────────────────────────────────────────



async function callOpenAI(systemPrompt, userPrompt, model = 'gpt-4o-mini') {

  try {

    const { data } = await axios.post(

      OPENAI_URL,

      {

        model,

        messages: [

          { role: 'system', content: systemPrompt },

          { role: 'user',   content: userPrompt   },

        ],

        response_format: { type: 'json_object' },

        temperature: 0.2,

      },

      {

        headers: {

          Authorization:  `Bearer ${OPENAI_API_KEY}`,

          'Content-Type': 'application/json',

        },

        timeout: 35000,

      }

    );



    const text = data?.choices?.[0]?.message?.content;

    if (!text) throw new Error('Empty OpenAI response');

    return JSON.parse(text);

  } catch (err) {

    logger.error({ err: err.message, status: err.response?.status }, '[institutionalAI] OpenAI call failed');

    return null;

  }

}



// ─────────────────────────────────────────────────────────────────────────────

// EXPORTS

// ─────────────────────────────────────────────────────────────────────────────

// HybridEngine: removed per Req 3.11 — AI direct order placement disabled.
// `placeOrderFromAdvisory` is exported as an inert stub so any legacy caller
// that imports it (or that we haven't yet migrated) hits a structured rejection
// instead of touching `orderOrchestration` / `dhanProd` / `copyTrade`. AI
// advisories must flow only through `hybridEngine/aiSupport.adapter.js`.
function placeOrderFromAdvisory(/* intent */) {
  console.error(
    '[HybridEngine: removed per Req 3.11] institutionalAI direct order placement '
    + 'disabled; AI advisories must flow via aiSupport.adapter.js'
  );
  return {
    placed: false,
    reason: 'AI_DIRECT_EXECUTION_DISABLED',
    source: 'institutionalAI',
  };
}

// HybridEngine: removed per Req 3.11 — alias kept for any existing callsites
// that referenced the historical name. Returns the same structured rejection.
function executeAdvisory(/* intent */) {
  return placeOrderFromAdvisory();
}

module.exports = {

  buildStrikeChain,

  summariseChain,

  getEntryDecision,

  getMonitorDecision,

  // HybridEngine: removed per Req 3.11 — order placement intentionally inert.
  placeOrderFromAdvisory,
  executeAdvisory,

};

