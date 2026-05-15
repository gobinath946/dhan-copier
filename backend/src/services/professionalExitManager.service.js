/**
 * Professional Exit Manager - 20 Years Experience
 * 
 * Exit is more important than entry!
 * 
 * Exit Conditions (Priority Order):
 * 1. Stop-loss hit (cut loss immediately)
 * 2. Target hit (take profit)
 * 3. Market character change (exit immediately)
 * 4. Time-based (scalping timeout)
 * 5. Reversal pattern (exit before loss)
 * 6. Support/Resistance breach (structure broken)
 */
const axios = require('axios');
const logger = require('../utils/logger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const PROFESSIONAL_EXIT_PROMPT = `You are a 20-year veteran trader managing an OPEN position.

EXIT PHILOSOPHY:
"Exit is more important than entry. Protect capital first, profits second."

EXIT PRIORITY (Check in this order):
1. STOP-LOSS HIT → Exit immediately, no questions
2. TARGET HIT → Take profit, don't be greedy
3. MARKET CHARACTER CHANGED → Exit immediately (trending → ranging, etc.)
4. TIME LIMIT REACHED → Scalping timeout, exit
5. REVERSAL PATTERN → Exit before it becomes a loss
6. SUPPORT/RESISTANCE BREACH → Structure broken, exit

PROFESSIONAL RULES:
- Never hope for recovery - cut losses fast
- Take profits when available - don't wait for "more"
- Respect time limits - scalping is quick in/out
- Market character change = immediate exit
- Support/resistance breach = structure broken, exit
- Volume drying up = exit signal

TRAILING STOP-LOSS:
- Only after 15%+ profit
- Lock in minimum 10% profit
- Trail by 5-point increments
- Never move SL against you

Return ONLY valid JSON:
{
  "exit_decision": "EXIT_NOW" | "HOLD" | "TRAIL_SL",
  "exit_reason": "specific reason (max 150 chars)",
  "exit_price": number (if EXIT_NOW),
  "new_sl": number (if TRAIL_SL),
  "confidence": 0-10,
  "urgency": "immediate" | "high" | "medium" | "low",
  "expected_outcome": "profit" | "loss" | "breakeven",
  "risk_alert": "any immediate risks (max 100 chars)",
  "hold_rationale": "why holding if HOLD (max 150 chars)"
}`;

/**
 * Professional exit analysis
 */
async function analyzeExit(trade, currentMarketData, marketSession, aiModel = 'gpt-4o-mini') {
  const apiKey = process.env.OPENAI_API_KEY;
  
  try {
    // Calculate trade metrics
    const timeInTrade = Date.now() - trade.createdAt.getTime();
    const timeInTradeSeconds = Math.floor(timeInTrade / 1000);
    const currentPnL = (trade.currentPrice - trade.entryPrice) * trade.quantity;
    const pnlPct = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    
    // Check hard exit conditions first (no AI needed)
    
    // 1. Stop-loss hit
    if (trade.sl && trade.currentPrice <= trade.sl) {
      return {
        exit_decision: 'EXIT_NOW',
        exit_reason: 'Stop-loss hit - protecting capital',
        exit_price: trade.currentPrice,
        confidence: 10,
        urgency: 'immediate',
        expected_outcome: 'loss',
        risk_alert: 'SL triggered',
        hold_rationale: null,
      };
    }
    
    // 2. Target hit
    if (trade.target && trade.currentPrice >= trade.target) {
      return {
        exit_decision: 'EXIT_NOW',
        exit_reason: 'Target achieved - taking profit',
        exit_price: trade.currentPrice,
        confidence: 10,
        urgency: 'immediate',
        expected_outcome: 'profit',
        risk_alert: 'None',
        hold_rationale: null,
      };
    }
    
    // 3. Time limit exceeded
    const maxHoldTime = trade.expectedHoldDuration ? 
      parseHoldDuration(trade.expectedHoldDuration) : 180;
    
    if (timeInTradeSeconds > maxHoldTime) {
      return {
        exit_decision: 'EXIT_NOW',
        exit_reason: `Scalping timeout (${timeInTradeSeconds}s > ${maxHoldTime}s)`,
        exit_price: trade.currentPrice,
        confidence: 9,
        urgency: 'high',
        expected_outcome: pnlPct > 0 ? 'profit' : pnlPct < 0 ? 'loss' : 'breakeven',
        risk_alert: 'Time-based exit',
        hold_rationale: null,
      };
    }
    
    // 4. Market character changed
    if (trade.marketRegime && marketSession.marketCharacter && 
        trade.marketRegime !== marketSession.marketCharacter) {
      return {
        exit_decision: 'EXIT_NOW',
        exit_reason: `Market character changed: ${trade.marketRegime} → ${marketSession.marketCharacter}`,
        exit_price: trade.currentPrice,
        confidence: 9,
        urgency: 'high',
        expected_outcome: pnlPct > 0 ? 'profit' : pnlPct < 0 ? 'loss' : 'breakeven',
        risk_alert: 'Market structure changed',
        hold_rationale: null,
      };
    }
    
    // 5. Check support/resistance breach
    const currentPrice = currentMarketData.spot_data?.ltp;
    const isCE = trade.signal === 'BUY_CE';
    
    if (isCE && marketSession.keyLevels?.resistance?.length > 0) {
      const nearestResistance = marketSession.keyLevels.resistance.find(r => r > currentPrice);
      if (nearestResistance && currentPrice > nearestResistance) {
        // Broke resistance - could be good or bad
        // Let AI decide
      }
    }
    
    if (!isCE && marketSession.keyLevels?.support?.length > 0) {
      const nearestSupport = marketSession.keyLevels.support.find(s => s < currentPrice);
      if (nearestSupport && currentPrice < nearestSupport) {
        // Broke support - could be good or bad
        // Let AI decide
      }
    }
    
    // If no hard exit conditions, use AI for nuanced analysis
    if (!apiKey) {
      logger.warn('[professionalExitManager] No OpenAI API key, using rule-based exit');
      return ruleBasedExit(trade, currentMarketData, timeInTradeSeconds, pnlPct);
    }
    
    const exitPayload = {
      trade_info: {
        trade_id: trade._id.toString(),
        signal: trade.signal,
        strike: trade.strike,
        entry_price: trade.entryPrice,
        current_price: trade.currentPrice,
        stop_loss: trade.sl,
        target: trade.target,
        time_in_trade_seconds: timeInTradeSeconds,
        max_hold_time_seconds: maxHoldTime,
        current_pnl: Number(currentPnL.toFixed(2)),
        pnl_pct: Number(pnlPct.toFixed(2)),
        entry_reason: trade.entryReason,
        market_regime_at_entry: trade.marketRegime,
      },
      current_market: {
        spot_price: currentPrice,
        market_character: marketSession.marketCharacter,
        dominant_direction: marketSession.dominantDirection,
        vwap_position: currentMarketData.vwap_analysis?.price_vs_vwap,
        ema_alignment: currentMarketData.moving_averages?.ema_alignment,
        volume_spike: currentMarketData.volume_orderflow?.volume_spike,
        build_up_type: currentMarketData.futures_data?.build_up_type,
        key_levels: marketSession.keyLevels,
      },
      exit_criteria: {
        sl_distance_pct: trade.sl ? (((trade.currentPrice - trade.sl) / trade.currentPrice) * 100).toFixed(2) : null,
        target_distance_pct: trade.target ? (((trade.target - trade.currentPrice) / trade.currentPrice) * 100).toFixed(2) : null,
        time_remaining_seconds: maxHoldTime - timeInTradeSeconds,
      },
    };
    
    const userPrompt = `Analyze this OPEN trade and decide: EXIT_NOW, HOLD, or TRAIL_SL

TRADE INFORMATION:
${JSON.stringify(exitPayload.trade_info, null, 2)}

CURRENT MARKET CONDITIONS:
${JSON.stringify(exitPayload.current_market, null, 2)}

EXIT CRITERIA:
${JSON.stringify(exitPayload.exit_criteria, null, 2)}

CRITICAL QUESTIONS:
1. Is the trade still valid based on current market?
2. Has market character changed since entry?
3. Is there a reversal forming?
4. Should we take profit now or wait?
5. Should we trail the stop-loss?
6. Any immediate risks?

Remember: Exit is more important than entry. Protect capital first.`;

    console.log('\n' + '='.repeat(80));
    console.log(`📊 EXIT ANALYSIS - Trade ${trade._id.toString().slice(-6)}`);
    console.log('='.repeat(80));
    console.log('Signal:', trade.signal, '@ Strike:', trade.strike);
    console.log('Entry:', trade.entryPrice, '| Current:', trade.currentPrice);
    console.log('P&L:', currentPnL.toFixed(2), `(${pnlPct.toFixed(2)}%)`);
    console.log('Time:', timeInTradeSeconds, '/', maxHoldTime, 'seconds');
    console.log('SL:', trade.sl, '| Target:', trade.target);
    console.log('Market:', marketSession.marketCharacter, '|', marketSession.dominantDirection);
    console.log('='.repeat(80) + '\n');
    
    const { data } = await axios.post(
      OPENAI_URL,
      {
        model: aiModel,
        messages: [
          { role: 'system', content: PROFESSIONAL_EXIT_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1, // Very low temperature for exit decisions
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty AI response');
    const decision = JSON.parse(text);
    
    console.log('\n' + '='.repeat(80));
    console.log(`🎯 EXIT DECISION - Trade ${trade._id.toString().slice(-6)}`);
    console.log('='.repeat(80));
    console.log('Decision:', decision.exit_decision);
    console.log('Reason:', decision.exit_reason);
    console.log('Urgency:', decision.urgency);
    console.log('Expected:', decision.expected_outcome);
    console.log('Confidence:', decision.confidence);
    if (decision.new_sl) console.log('New SL:', decision.new_sl);
    if (decision.hold_rationale) console.log('Hold Rationale:', decision.hold_rationale);
    console.log('='.repeat(80) + '\n');
    
    return decision;
  } catch (error) {
    logger.error({ 
      error: error.message,
      tradeId: trade._id 
    }, '[professionalExitManager] Exit analysis failed');
    
    // Fallback to rule-based
    const timeInTradeSeconds = Math.floor((Date.now() - trade.createdAt.getTime()) / 1000);
    const pnlPct = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    return ruleBasedExit(trade, currentMarketData, timeInTradeSeconds, pnlPct);
  }
}

/**
 * Rule-based exit fallback
 */
function ruleBasedExit(trade, currentMarketData, timeInTradeSeconds, pnlPct) {
  // Simple rules
  if (pnlPct < -3) {
    return {
      exit_decision: 'EXIT_NOW',
      exit_reason: 'Loss exceeding 3%',
      exit_price: trade.currentPrice,
      confidence: 8,
      urgency: 'high',
      expected_outcome: 'loss',
      risk_alert: 'Cut loss',
      hold_rationale: null,
    };
  }
  
  if (pnlPct > 15) {
    return {
      exit_decision: 'TRAIL_SL',
      exit_reason: 'Profit > 15%, trailing SL',
      new_sl: trade.entryPrice * 1.10, // Lock 10% profit
      confidence: 8,
      urgency: 'medium',
      expected_outcome: 'profit',
      risk_alert: 'None',
      hold_rationale: 'Trailing to lock profit',
    };
  }
  
  if (timeInTradeSeconds > 120 && pnlPct > 5) {
    return {
      exit_decision: 'EXIT_NOW',
      exit_reason: 'Time-based exit with profit',
      exit_price: trade.currentPrice,
      confidence: 7,
      urgency: 'medium',
      expected_outcome: 'profit',
      risk_alert: 'None',
      hold_rationale: null,
    };
  }
  
  return {
    exit_decision: 'HOLD',
    exit_reason: 'Trade within parameters',
    confidence: 6,
    urgency: 'low',
    expected_outcome: pnlPct > 0 ? 'profit' : 'breakeven',
    risk_alert: 'Monitor closely',
    hold_rationale: 'No exit conditions met yet',
  };
}

/**
 * Parse hold duration string to seconds
 */
function parseHoldDuration(duration) {
  if (duration.includes('15-30sec')) return 30;
  if (duration.includes('30-60sec')) return 60;
  if (duration.includes('1-2min')) return 120;
  if (duration.includes('2-5min')) return 300;
  return 180; // Default 3 minutes
}

module.exports = {
  analyzeExit,
};
