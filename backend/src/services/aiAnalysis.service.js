/**
 * AI Analysis Service - Maximum ChatGPT Integration
 * 
 * Strategy: "Whatever possibility to use ChatGPT API calls, make it do more and pick the best"
 * 
 * Features:
 * 1. Real-time market analysis every 30 seconds
 * 2. Multiple parallel AI calls for strike selection
 * 3. Pattern recognition every 5 minutes
 * 4. Trade monitoring with AI
 * 5. Exit decision AI analysis
 * 6. Ensemble AI decision (pick best from multiple responses)
 */
const axios = require('axios');
const logger = require('../utils/logger');
const aiIOLogger = require('../utils/aiIOLogger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Per-call purpose slot (set just before each call by callers). This keeps
// the old call signatures untouched while letting us capture structured logs.
let _nextCallPurpose = 'unspecified';
function setNextCallPurpose(purpose) { _nextCallPurpose = purpose || 'unspecified'; }

/**
 * STRATEGY 1: Real-Time Market Analysis (Every 30 seconds)
 * Send comprehensive market data to ChatGPT for analysis
 */
async function analyzeMarketRealTime(marketData, algorithmOutputs, aiModel = 'gpt-4o-mini') {
  try {
    const prompt = `You are a professional NIFTY 50 scalper with 20 years of experience.

CURRENT MARKET DATA:
${JSON.stringify(marketData, null, 2)}

ALGORITHM OUTPUTS:
${JSON.stringify(algorithmOutputs, null, 2)}

ANALYZE AND PROVIDE:
1. Current market sentiment (bullish/bearish/neutral)
2. Probability of upward move in next 15-20 seconds (0-100%)
3. Probability of downward move in next 15-20 seconds (0-100%)
4. Best strike to trade (from opening ±2 strikes)
5. Optimal option type (CE/PE)
6. Expected move in points
7. Key risks to watch
8. Confidence level (0-10)
9. Should enter trade? (YES/NO/WAIT)
10. Reasoning (max 200 chars)

Return ONLY valid JSON:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "upward_probability": number (0-100),
  "downward_probability": number (0-100),
  "best_strike": number,
  "option_type": "CE" | "PE",
  "expected_move": number,
  "key_risks": "string",
  "confidence": number (0-10),
  "should_enter": "YES" | "NO" | "WAIT",
  "reasoning": "string"
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({ 
      sentiment: response.sentiment,
      confidence: response.confidence,
      shouldEnter: response.should_enter
    }, '[aiAnalysis] Real-time market analysis completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Real-time analysis failed');
    return null;
  }
}

/**
 * STRATEGY 2: Multiple Parallel AI Calls for Strike Selection
 * Call ChatGPT 3 times in parallel and pick the best response
 */
async function selectOptimalStrikeEnsemble(marketData, validStrikes, tradeDecision, aiModel = 'gpt-4o-mini') {
  try {
    // OPTIMIZED: Single AI call (was 3 parallel calls)
    // Professional trader already selected strike, just validate
    // Savings: 4-8 seconds per entry
    logger.info('[aiAnalysis] Running optimized strike selection (1 AI call)');
    
    const prompt = `You are an expert NIFTY options trader. Validate the strike selection.

VALID STRIKES (Opening ±2 only):
${JSON.stringify(validStrikes, null, 2)}

CURRENT MARKET:
Spot: ${marketData.spot_data?.ltp}
ATM Strike: ${marketData.atm_strike}
Opening Strike: ${marketData.opening_strike}
PCR: ${marketData.options_chain?.pcr_total}
Max Pain: ${marketData.options_chain?.max_pain_strike}
Build-up: ${marketData.futures_data?.build_up_type}

**CRITICAL: MARKET DIRECTION**
Professional Trader Direction: ${tradeDecision.dominant_direction}
Trade Decision: ${tradeDecision.trade_decision}
Recommended Option Type: ${tradeDecision.option_type}

**YOU MUST RESPECT THE MARKET DIRECTION:**
- If direction is BEARISH → Select PE (Put) only
- If direction is BULLISH → Select CE (Call) only
- If direction is NEUTRAL → Select based on momentum

SELECT THE BEST STRIKE considering:
1. **MARKET DIRECTION (MOST IMPORTANT)** - Must match professional trader's direction
2. Liquidity (OI and Volume)
3. Premium value (not too cheap, not too expensive)
4. Delta (how much it moves with spot)
5. Probability of profit in 15-20 seconds
6. Risk-reward ratio

**EXPIRY DAY RULES:**
- If today is expiry day, be extra cautious
- Avoid far OTM strikes (they decay fast)
- Prefer ATM or slightly ITM strikes

Return ONLY valid JSON:
{
  "selected_strike": number,
  "option_type": "CE" | "PE",
  "confidence": number (0-10),
  "reasoning": "why this strike (max 150 chars)",
  "expected_premium_move": number,
  "probability_of_profit": number (0-100)
}`;

    // OPTIMIZED: Single call instead of 3
    const response = await callOpenAI(prompt, aiModel);
    
    if (!response) {
      logger.error('[aiAnalysis] Strike selection AI call failed');
      return null;
    }
    
    logger.info({
      selectedStrike: response.selected_strike,
      confidence: response.confidence,
      probability: response.probability_of_profit
    }, '[aiAnalysis] Optimized strike selection completed (1 AI call)');
    
    return {
      best_response: response,
      all_responses: [response],
      ensemble_confidence: response.confidence
    };
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Ensemble strike selection failed');
    return null;
  }
}

/**
 * STRATEGY 3: Pattern Recognition (Every 5 minutes)
 * Deep analysis of chart patterns and historical similarities
 */
async function recognizePatterns(historicalData, currentMarket, aiModel = 'gpt-4o-mini') {
  try {
    const prompt = `You are a pattern recognition expert specializing in NIFTY 50 scalping.

HISTORICAL DATA (Last 1 hour):
${JSON.stringify(historicalData, null, 2)}

CURRENT MARKET:
${JSON.stringify(currentMarket, null, 2)}

IDENTIFY:
1. Chart patterns forming (head & shoulders, double top/bottom, triangles, flags, etc.)
2. Candlestick patterns (engulfing, doji, hammer, shooting star, etc.)
3. Historical similar setups and their outcomes
4. Success rate of current pattern (based on historical data)
5. Expected outcome and timeframe
6. Key levels to watch (support/resistance)
7. Pattern reliability score (0-10)

Return ONLY valid JSON:
{
  "chart_patterns": ["pattern1", "pattern2"],
  "candlestick_patterns": ["pattern1", "pattern2"],
  "historical_similarity": "description",
  "success_rate": number (0-100),
  "expected_outcome": "bullish" | "bearish" | "neutral",
  "expected_timeframe": "seconds",
  "key_levels": {"support": [numbers], "resistance": [numbers]},
  "reliability_score": number (0-10),
  "trading_recommendation": "string"
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      patterns: response.chart_patterns,
      successRate: response.success_rate,
      reliability: response.reliability_score
    }, '[aiAnalysis] Pattern recognition completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Pattern recognition failed');
    return null;
  }
}

/**
 * STRATEGY 4: Trade Entry Decision (Multiple AI Calls)
 * Call ChatGPT 5 times and require 4/5 agreement
 */
async function shouldEnterTradeEnsemble(marketData, algorithmOutputs, aiModel = 'gpt-4o-mini') {
  try {
    logger.info('[aiAnalysis] Running ensemble entry decision (5 parallel AI calls)');
    
    const prompt = `You are a professional scalper. Should we enter this trade?

MARKET DATA:
${JSON.stringify(marketData, null, 2)}

ALGORITHM SCORES:
${JSON.stringify(algorithmOutputs, null, 2)}

DECISION CRITERIA:
1. Master score ≥ 75
2. Confidence ≥ 8
3. Agreement ≥ 7/10 algorithms
4. Strike within opening ±2
5. Clear directional bias
6. Risk-reward ≥ 2:1
7. No major risks

Return ONLY valid JSON:
{
  "decision": "ENTER" | "WAIT" | "AVOID",
  "confidence": number (0-10),
  "reasoning": "string (max 200 chars)",
  "expected_profit_probability": number (0-100)
}`;

    // OPTIMIZED: Call ChatGPT 3 times in parallel (was 5)
    // Savings: 4-8 seconds per entry
    const responses = await Promise.all([
      callOpenAI(prompt, aiModel),
      callOpenAI(prompt, aiModel),
      callOpenAI(prompt, aiModel)
    ]);
    
    const validResponses = responses.filter(r => r !== null);
    
    if (validResponses.length < 2) {
      logger.error('[aiAnalysis] Insufficient ensemble responses');
      return { decision: 'WAIT', confidence: 0, reasoning: 'AI ensemble failed' };
    }
    
    // Count votes
    const enterVotes = validResponses.filter(r => r.decision === 'ENTER').length;
    const waitVotes = validResponses.filter(r => r.decision === 'WAIT').length;
    const avoidVotes = validResponses.filter(r => r.decision === 'AVOID').length;
    
    // OPTIMIZED: Require 2/3 agreement for ENTER (was 4/5)
    let finalDecision = 'WAIT';
    if (enterVotes >= 2) finalDecision = 'ENTER';
    else if (avoidVotes >= 2) finalDecision = 'AVOID';
    
    // Average confidence
    const avgConfidence = validResponses.reduce((sum, r) => sum + (r.confidence || 0), 0) / validResponses.length;
    
    logger.info({
      enterVotes,
      waitVotes,
      avoidVotes,
      finalDecision,
      avgConfidence
    }, '[aiAnalysis] Ensemble entry decision completed');
    
    return {
      decision: finalDecision,
      confidence: Math.round(avgConfidence * 10) / 10,
      votes: { enter: enterVotes, wait: waitVotes, avoid: avoidVotes },
      all_responses: validResponses,
      reasoning: `${enterVotes}/5 AI models voted ENTER`
    };
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Ensemble entry decision failed');
    return { decision: 'WAIT', confidence: 0, reasoning: 'Error in AI ensemble' };
  }
}

/**
 * STRATEGY 5: Trade Monitoring (Individual AI Controller)
 * Monitor each open trade with dedicated AI analysis
 */
async function monitorTradeWithAI(trade, currentMarket, aiModel = 'gpt-4o-mini') {
  try {
    const holdDuration = Math.floor((Date.now() - new Date(trade.createdAt).getTime()) / 1000);
    const currentPnL = (trade.currentPrice - trade.entryPrice) * trade.quantity;
    const pnlPct = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    
    const prompt = `You are monitoring an open scalping trade. Should we exit?

TRADE DETAILS:
Signal: ${trade.signal}
Strike: ${trade.strike}
Entry Price: ${trade.entryPrice}
Current Price: ${trade.currentPrice}
Stop Loss: ${trade.sl}
Target: ${trade.target}
Hold Duration: ${holdDuration} seconds
Current P&L: ₹${currentPnL.toFixed(2)} (${pnlPct.toFixed(2)}%)
Entry Reason: ${trade.entryReason}

CURRENT MARKET:
${JSON.stringify(currentMarket, null, 2)}

EXIT CRITERIA:
1. Target hit → EXIT
2. Stop loss hit → EXIT
3. Hold time > 20 seconds → CONSIDER EXIT
4. Market reversal → EXIT
5. Momentum fading → EXIT
6. Better opportunity elsewhere → EXIT

Return ONLY valid JSON:
{
  "action": "EXIT" | "HOLD" | "TRAIL_SL",
  "confidence": number (0-10),
  "reasoning": "string (max 200 chars)",
  "new_sl": number (if TRAIL_SL),
  "urgency": "high" | "medium" | "low",
  "expected_outcome": "profit" | "loss" | "breakeven"
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      tradeId: trade._id,
      action: response.action,
      confidence: response.confidence,
      urgency: response.urgency
    }, '[aiAnalysis] Trade monitoring completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message, tradeId: trade._id }, '[aiAnalysis] Trade monitoring failed');
    return null;
  }
}

/**
 * STRATEGY 6: Exit Decision (Multiple AI Calls)
 * Call ChatGPT 3 times and pick most conservative response
 */
async function shouldExitTradeEnsemble(trade, currentMarket, aiModel = 'gpt-4o-mini') {
  try {
    logger.info({ tradeId: trade._id }, '[aiAnalysis] Running ensemble exit decision (3 parallel AI calls)');
    
    const prompt = `Should we exit this trade NOW?

TRADE: ${trade.signal} @ ${trade.strike}
Entry: ₹${trade.entryPrice} | Current: ₹${trade.currentPrice}
SL: ₹${trade.sl} | Target: ₹${trade.target}
Hold: ${Math.floor((Date.now() - new Date(trade.createdAt).getTime()) / 1000)}s

MARKET: ${JSON.stringify(currentMarket, null, 2)}

Return ONLY valid JSON:
{
  "exit_now": true | false,
  "confidence": number (0-10),
  "reasoning": "string"
}`;

    // Call ChatGPT 3 times in parallel
    const [response1, response2, response3] = await Promise.all([
      callOpenAI(prompt, aiModel),
      callOpenAI(prompt, aiModel),
      callOpenAI(prompt, aiModel)
    ]);
    
    const responses = [response1, response2, response3].filter(r => r !== null);
    
    if (responses.length === 0) {
      return { exit_now: false, confidence: 0, reasoning: 'AI ensemble failed' };
    }
    
    // Count exit votes
    const exitVotes = responses.filter(r => r.exit_now === true).length;
    
    // Exit if 2/3 or more vote to exit (conservative approach)
    const shouldExit = exitVotes >= 2;
    
    logger.info({
      tradeId: trade._id,
      exitVotes,
      totalVotes: responses.length,
      decision: shouldExit ? 'EXIT' : 'HOLD'
    }, '[aiAnalysis] Ensemble exit decision completed');
    
    return {
      exit_now: shouldExit,
      confidence: responses.reduce((sum, r) => sum + (r.confidence || 0), 0) / responses.length,
      votes: { exit: exitVotes, hold: responses.length - exitVotes },
      all_responses: responses,
      reasoning: `${exitVotes}/${responses.length} AI models voted EXIT`
    };
  } catch (error) {
    logger.error({ error: error.message, tradeId: trade._id }, '[aiAnalysis] Ensemble exit decision failed');
    return { exit_now: false, confidence: 0, reasoning: 'Error in AI ensemble' };
  }
}

/**
 * STRATEGY 7: Comprehensive Analysis (Send ALL data to AI)
 * Maximum data dump to ChatGPT for deep analysis
 */
async function comprehensiveAnalysis(allData, aiModel = 'gpt-4o-mini') {
  try {
    const prompt = `You are the world's best NIFTY 50 scalper. Analyze EVERYTHING.

COMPLETE DATA DUMP:
${JSON.stringify(allData, null, 2)}

PROVIDE COMPREHENSIVE ANALYSIS:
1. Overall market sentiment and direction
2. Best trading opportunity right now
3. Optimal strike and option type
4. Entry price target
5. Stop loss level
6. Take profit level
7. Expected hold duration
8. Probability of success
9. Key risks and how to mitigate
10. Alternative scenarios
11. Confidence level (0-10)
12. Final recommendation (ENTER/WAIT/AVOID)

Return ONLY valid JSON with all fields above.`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      recommendation: response.final_recommendation,
      confidence: response.confidence,
      probability: response.probability_of_success
    }, '[aiAnalysis] Comprehensive analysis completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Comprehensive analysis failed');
    return null;
  }
}

/**
 * STRATEGY 8: NIFTY Futures AI Analysis (NEW!)
 * Send futures data to AI for confirmation - NO STATIC CONDITIONS
 */
async function analyzeFuturesWithAI(futuresData, spotData, direction, aiModel = 'gpt-4o-mini') {
  try {
    logger.info('[aiAnalysis] Sending futures data to AI for confirmation');
    
    const prompt = `You are a futures market expert. Analyze NIFTY Futures data and confirm trade direction.

NIFTY FUTURES DATA:
${JSON.stringify(futuresData, null, 2)}

SPOT DATA:
Current Spot Price: ${spotData.spotPrice}
Spot Direction: ${direction}

FUTURES ANALYSIS:
Futures Price: ${futuresData.lastPrice}
Premium/Discount: ${futuresData.lastPrice - spotData.spotPrice} points
Last 10 Candles: ${JSON.stringify(futuresData.candles?.slice(-10), null, 2)}

ANALYZE:
1. Is futures price at premium or discount to spot?
2. What does premium/discount indicate about market sentiment?
3. Are futures leading spot or lagging?
4. What is the trend in futures (last 10 candles)?
5. Is there volume spike in futures?
6. Is OI increasing or decreasing?
7. Does futures data CONFIRM the spot direction (${direction})?
8. What is your confidence in this confirmation (0-10)?
9. Should we take the trade based on futures analysis?
10. Any divergence or warning signs?

Return ONLY valid JSON:
{
  "futures_direction": "bullish" | "bearish" | "neutral",
  "confirms_spot": true | false,
  "premium_discount": number,
  "sentiment_indication": "string (max 150 chars)",
  "trend_analysis": "string (max 150 chars)",
  "volume_analysis": "string (max 100 chars)",
  "oi_analysis": "string (max 100 chars)",
  "confidence": number (0-10),
  "should_take_trade": true | false,
  "reasoning": "string (max 200 chars)",
  "warning_signs": ["string"] or []
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      futuresDirection: response.futures_direction,
      confirmsSpot: response.confirms_spot,
      confidence: response.confidence,
      shouldTakeTrade: response.should_take_trade
    }, '[aiAnalysis] Futures AI analysis completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Futures AI analysis failed');
    return null;
  }
}

/**
 * STRATEGY 9: Minimum Points AI Decision (NEW!)
 * Let AI decide if points are sufficient - NO STATIC THRESHOLDS
 */
async function analyzePointsPotentialWithAI(entryPrice, targetPrice, quantity, brokerageData, marketContext, aiModel = 'gpt-4o-mini') {
  try {
    logger.info('[aiAnalysis] Sending points analysis to AI');
    
    const potentialPoints = targetPrice - entryPrice;
    const breakEvenPoints = brokerageData.costPerPoint || 0;
    const netPoints = potentialPoints - breakEvenPoints;
    
    const prompt = `You are a risk management expert. Should we take this trade based on profit potential?

TRADE DETAILS:
Entry Price: ₹${entryPrice}
Target Price: ₹${targetPrice}
Quantity: ${quantity}
Potential Points: ${potentialPoints}
Breakeven Points (Brokerage): ${breakEvenPoints}
Net Points (After Brokerage): ${netPoints}

BROKERAGE BREAKDOWN:
${JSON.stringify(brokerageData, null, 2)}

MARKET CONTEXT:
${JSON.stringify(marketContext, null, 2)}

ANALYZE:
1. Is ${netPoints} points sufficient for a scalping trade?
2. What is the risk-reward ratio?
3. Considering brokerage impact (${brokerageData.chargesPercentage}%), is this trade worth it?
4. What is the probability of capturing ${netPoints} points in 15-20 seconds?
5. Are there better opportunities with higher points potential?
6. What is your confidence in this trade's profitability (0-10)?
7. Should we take this trade?

Return ONLY valid JSON:
{
  "points_sufficient": true | false,
  "risk_reward_ratio": number,
  "brokerage_impact_acceptable": true | false,
  "probability_of_success": number (0-100),
  "better_opportunities_exist": true | false,
  "confidence": number (0-10),
  "should_take_trade": true | false,
  "reasoning": "string (max 200 chars)",
  "minimum_points_recommendation": number
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      pointsSufficient: response.points_sufficient,
      confidence: response.confidence,
      shouldTakeTrade: response.should_take_trade
    }, '[aiAnalysis] Points potential AI analysis completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Points AI analysis failed');
    return null;
  }
}

/**
 * STRATEGY 10: Master Algorithm AI Validation (NEW!)
 * Send all 10 algorithm outputs to AI for final validation
 */
async function validateMasterScoreWithAI(masterDecision, algorithmOutputs, marketData, aiModel = 'gpt-4o-mini') {
  try {
    logger.info('[aiAnalysis] Sending master algorithm output to AI for validation');
    
    const prompt = `You are validating algorithmic trading signals. Review and confirm.

MASTER ALGORITHM DECISION:
${JSON.stringify(masterDecision, null, 2)}

ALL 10 ALGORITHM OUTPUTS:
${JSON.stringify(algorithmOutputs, null, 2)}

CURRENT MARKET DATA:
${JSON.stringify(marketData, null, 2)}

VALIDATE:
1. Is the master score (${masterDecision.master_score}/100) reliable?
2. Are the ${masterDecision.agreement_count}/10 agreeing algorithms the right ones?
3. Do you see any conflicting signals that algorithms missed?
4. Is the confidence level (${masterDecision.confidence}/10) justified?
5. Are there any hidden risks the algorithms didn't catch?
6. Do you agree with the entry recommendation?
7. What is YOUR confidence in this trade (0-10)?
8. Should we proceed with this trade?

Return ONLY valid JSON:
{
  "master_score_reliable": true | false,
  "agreement_sufficient": true | false,
  "conflicting_signals_detected": true | false,
  "confidence_justified": true | false,
  "hidden_risks": ["string"] or [],
  "ai_agrees_with_entry": true | false,
  "ai_confidence": number (0-10),
  "should_proceed": true | false,
  "reasoning": "string (max 200 chars)",
  "ai_recommendation": "ENTER" | "WAIT" | "AVOID"
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      aiAgreesWithEntry: response.ai_agrees_with_entry,
      aiConfidence: response.ai_confidence,
      shouldProceed: response.should_proceed,
      aiRecommendation: response.ai_recommendation
    }, '[aiAnalysis] Master score AI validation completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] Master score AI validation failed');
    return null;
  }
}

/**
 * STRATEGY 11: COMPREHENSIVE Trade Action Decision with ALL 16 Algorithms
 * Sends COMPLETE algorithm data to AI for intelligent decisions
 * FEATURES:
 * - Dynamic target extension (targetPoints is MIN, AI can extend)
 * - Immediate exit when price falls below reached target
 * - Lot management (ADD_QUANTITY) based on AI analysis
 * - All 16 algorithms' data sent to AI
 */
async function decideTradeActionWithAI(trade, marketData, algorithmOutputs, masterScore, sessionSettings, aiModel = 'gpt-4o-mini') {
  try {
    logger.info({ tradeId: trade._id }, '[aiAnalysis] COMPREHENSIVE AI trade action decision with ALL 16 algorithms');
    
    const holdDuration = Math.floor((Date.now() - new Date(trade.createdAt).getTime()) / 1000);
    const currentPnL = (trade.currentPrice - trade.entryPrice) * trade.quantity;
    const pnlPct = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    const pnlPoints = trade.currentPrice - trade.entryPrice;
    
    // Settings
    const targetPoints = Number(sessionSettings?.targetPoints) || 15;
    const slPoints = Number(sessionSettings?.slPoints) || 10;
    const maxLots = Number(sessionSettings?.maxLots) || 2;
    const lotSize = Number(sessionSettings?.lotSize) || 65;
    const currentLots = Math.round(trade.quantity / lotSize);
    
    // Track if we've reached target (for immediate exit if price falls back)
    const hasReachedTarget = pnlPoints >= targetPoints;
    
    // Build comprehensive data package with ALL 16 algorithms
    const comprehensiveData = {
      trade: {
        signal: trade.signal,
        strike: trade.strike,
        entry_price: trade.entryPrice,
        current_price: trade.currentPrice,
        sl: trade.sl,
        target: trade.target,
        quantity: trade.quantity,
        current_lots: currentLots,
        max_lots: maxLots,
        hold_duration_seconds: holdDuration,
        pnl_rupees: currentPnL.toFixed(2),
        pnl_percent: pnlPct.toFixed(2),
        pnl_points: pnlPoints.toFixed(2),
        entry_reason: trade.entryReason
      },
      
      settings: {
        target_points_min: targetPoints,
        sl_points: slPoints,
        max_lots: maxLots,
        lot_size: lotSize,
        can_add_lots: currentLots < maxLots
      },
      
      status: {
        has_reached_target: hasReachedTarget,
        points_above_target: hasReachedTarget ? (pnlPoints - targetPoints).toFixed(2) : 0,
        time_in_trade: holdDuration
      },
      
      market: {
        spot_price: marketData?.spot_data?.ltp,
        vix: marketData?.spot_data?.vix,
        pcr: marketData?.options_chain?.pcr_total,
        max_pain: marketData?.options_chain?.max_pain_strike
      },
      
      master_algorithm: {
        score: masterScore,
        direction: trade.signal === 'BUY_CE' ? 'bullish' : 'bearish'
      },
      
      // ALL 16 ALGORITHMS
      algorithms: {
        gamma_exposure: algorithmOutputs?.gammaExposure || null,
        order_flow: algorithmOutputs?.orderFlow || null,
        multi_timeframe: algorithmOutputs?.multiTimeframe || null,
        liquidity: algorithmOutputs?.liquidityAnalysis || null,
        smart_money: algorithmOutputs?.smartMoneyConcepts || null,
        market_internals: algorithmOutputs?.marketInternals || null,
        sector_rotation: algorithmOutputs?.sectorRotation || null,
        global_markets: algorithmOutputs?.globalMarkets || null,
        behavioral: algorithmOutputs?.behavioralAnalysis || null,
        dema: algorithmOutputs?.demaIndicator || null,
        vwap: algorithmOutputs?.vwapAnalysis || null,
        volume_oi: algorithmOutputs?.volumeOIAnalysis || null,
        regime: algorithmOutputs?.marketRegime || null,
        build_up: algorithmOutputs?.buildUpType || null,
        pcr_analysis: algorithmOutputs?.pcrAnalysis || null,
        max_pain_analysis: algorithmOutputs?.maxPainAnalysis || null
      }
    };
    
    const prompt = `You are an ELITE trade manager with access to ALL 16 world-class algorithms. Make the BEST decision for this open trade.

📊 COMPLETE TRADE & MARKET DATA:
${JSON.stringify(comprehensiveData, null, 2)}

🎯 YOUR TASK:
Analyze ALL data and decide the BEST action for this trade.

⚠️ CRITICAL RULES:

1. **DYNAMIC TARGET EXTENSION:**
   - Target Points (${targetPoints}) is the MINIMUM target
   - If market momentum is strong, you CAN extend the target
   - If algorithms show continued strength, HOLD for more profit
   - But if momentum weakens, EXIT at current profit

2. **IMMEDIATE EXIT RULE:**
   - If trade HAS reached target (${hasReachedTarget ? 'YES' : 'NO'}) and price falls back below target
   - EXIT IMMEDIATELY - don't wait for AI
   - This is a HARD RULE - lock in profits

3. **LOT MANAGEMENT:**
   - Current lots: ${currentLots}, Max lots: ${maxLots}
   - Can add more: ${currentLots < maxLots ? 'YES' : 'NO'}
   - Only ADD_QUANTITY if:
     a) Trade is profitable (P&L > 0)
     b) All algorithms support the direction
     c) Master score > 70
     d) Momentum is increasing

4. **TRAILING SL:**
   - If in profit, consider trailing SL to lock gains
   - Move SL to breakeven + 2 points when profit > 5 points
   - Move SL to entry + 50% of profit when profit > 10 points

5. **EXIT CONDITIONS:**
   - Master score < 40 = EXIT (market reversal)
   - Algorithms showing divergence = EXIT
   - Time > 300 seconds with no momentum = EXIT
   - P&L < -${slPoints} points = EXIT (SL hit)

🔍 ANALYZE ALL 16 ALGORITHMS:
- Are they aligned with the trade direction?
- Is momentum increasing or decreasing?
- Any divergence or warning signs?
- Is liquidity sufficient for exit?
- What does smart money indicate?

Return ONLY valid JSON:
{
  "action": "EXIT" | "HOLD" | "TRAIL_SL" | "ADD_QUANTITY",
  "reasoning": "string (max 300 chars - explain WHY based on algorithms)",
  "new_sl": number (if TRAIL_SL, otherwise null),
  "new_target": number (if extending target, otherwise null),
  "add_quantity": number (if ADD_QUANTITY, otherwise null),
  "urgency": "high" | "medium" | "low",
  "confidence": number (0-10),
  "expected_outcome": "string (max 150 chars)",
  "algorithm_summary": "string (max 200 chars - key algorithm insights)",
  "risks": ["string"] or [],
  "exit_type": "target" | "extended_target" | "stop_loss" | "time" | "reversal" | "trailing_sl" | "ai_decision" | null,
  "should_extend_target": true | false,
  "extended_target_points": number (if extending, otherwise null)
}`;

    const response = await callOpenAI(prompt, aiModel);
    
    logger.info({
      tradeId: trade._id,
      action: response.action,
      confidence: response.confidence,
      urgency: response.urgency,
      shouldExtendTarget: response.should_extend_target,
      algorithmSummary: response.algorithm_summary
    }, '[aiAnalysis] COMPREHENSIVE trade action AI decision completed');
    
    return response;
  } catch (error) {
    logger.error({ error: error.message, tradeId: trade._id }, '[aiAnalysis] Comprehensive trade action AI decision failed');
    return null;
  }
}

/**
 * Helper: Call OpenAI API (now with full request/response logging).
 * The caller can set _nextCallPurpose via setNextCallPurpose(...) so we tag
 * every log entry with a meaningful purpose (e.g. "strike_selection").
 */
async function callOpenAI(prompt, model = 'gpt-4o-mini') {
  const purpose = _nextCallPurpose;
  _nextCallPurpose = 'unspecified'; // consume

  const systemPrompt = 'You are a professional NIFTY 50 options scalper with 20 years of experience. Always return valid JSON.';
  const started = Date.now();
  try {
    const { data } = await axios.post(
      OPENAI_URL,
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3, // Lower temperature for more consistent responses
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const latencyMs = Date.now() - started;
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: prompt,
        responseText: null,
        parsedResponse: null,
        usage: data?.usage || null,
        latencyMs,
        error: 'Empty AI response',
      });
      throw new Error('Empty AI response');
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: prompt,
        responseText: text,
        parsedResponse: null,
        usage: data?.usage || null,
        latencyMs,
        error: `JSON parse failed: ${parseErr.message}`,
      });
      throw parseErr;
    }

    aiIOLogger.logAICall({
      purpose,
      model,
      systemPrompt,
      userPrompt: prompt,
      responseText: text,
      parsedResponse: parsed,
      usage: data?.usage || null,
      latencyMs,
    });

    return parsed;
  } catch (error) {
    const latencyMs = Date.now() - started;
    aiIOLogger.logAICall({
      purpose,
      model,
      systemPrompt,
      userPrompt: prompt,
      responseText: null,
      parsedResponse: null,
      usage: null,
      latencyMs,
      error: error.message,
    });
    logger.error({
      purpose,
      error: error.message,
      response: error.response?.data,
    }, '[aiAnalysis] OpenAI API call failed');
    return null;
  }
}

/**
 * Helper: Calculate ensemble confidence
 */
function calculateEnsembleConfidence(responses) {
  if (responses.length === 0) return 0;
  
  // Check agreement on strike selection
  const strikes = responses.map(r => r.selected_strike);
  const mostCommonStrike = strikes.sort((a, b) =>
    strikes.filter(s => s === a).length - strikes.filter(s => s === b).length
  ).pop();
  
  const agreement = strikes.filter(s => s === mostCommonStrike).length / strikes.length;
  
  // Average confidence
  const avgConfidence = responses.reduce((sum, r) => sum + (r.confidence || 0), 0) / responses.length;
  
  // Ensemble confidence = agreement * average confidence
  return Math.round(agreement * avgConfidence * 10) / 10;
}

module.exports = {
  analyzeMarketRealTime,
  selectOptimalStrikeEnsemble,
  recognizePatterns,
  shouldEnterTradeEnsemble,
  monitorTradeWithAI,
  shouldExitTradeEnsemble,
  comprehensiveAnalysis,
  // NEW AI FUNCTIONS - AI DECIDES EVERYTHING
  analyzeFuturesWithAI,
  analyzePointsPotentialWithAI,
  validateMasterScoreWithAI,
  decideTradeActionWithAI,
  // Function declarations below are hoisted so direct reference works here.
  validateInstitutionalFlowsWithAI,
  setNextCallPurpose,
};


/**
 * STRATEGY 7: FII/DII Institutional Flow Validation
 * Send FII/DII data to ChatGPT for institutional flow analysis
 *
 * HARDENED: every path into flowData is nullsafe so a schema change on
 * Sensibull's side can't crash the engine mid-cycle.
 */
async function validateInstitutionalFlowsWithAI(fiiDiiData, tradeDirection, aiModel = 'gpt-4o-mini') {
  try {
    if (!fiiDiiData || !fiiDiiData.institutional_flow_raw) {
      return null;
    }

    const flowData = fiiDiiData.institutional_flow_raw || {};
    const pickNum = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const pickStr = (v, d = 'unknown') => (typeof v === 'string' && v ? v : d);

    const fiiCash = flowData?.cash?.fii || {};
    const diiCash = flowData?.cash?.dii || {};
    const fiiFut = flowData?.future?.fii || {};
    const diiFut = flowData?.future?.dii || {};
    const fiiFutQty = fiiFut['quantity-wise'] || fiiFut.quantity_wise || {};
    const diiFutQty = diiFut['quantity-wise'] || diiFut.quantity_wise || {};
    const fiiOpt = flowData?.option?.fii || {};
    const diiOpt = flowData?.option?.dii || {};
    const fiiOptCall = fiiOpt.call || {};
    const fiiOptPut = fiiOpt.put || {};

    const niftyChg = pickNum(flowData.nifty_change_percent);
    const bankChg = pickNum(flowData.banknifty_change_percent);

    const prompt = `You are an institutional flow analyst with expertise in FII/DII positioning.

INSTITUTIONAL FLOW DATA (TODAY):
Date: ${pickStr(flowData.date, 'n/a')}
NIFTY: ${pickNum(flowData.nifty)} (${niftyChg > 0 ? '+' : ''}${niftyChg.toFixed(2)}%)
BankNIFTY: ${pickNum(flowData.banknifty)} (${bankChg > 0 ? '+' : ''}${bankChg.toFixed(2)}%)

CASH MARKET:
- FII: ${pickStr(fiiCash.net_action)} ₹${pickNum(fiiCash.buy_sell_difference).toFixed(2)} crores (${pickStr(fiiCash.net_view)})
- DII: ${pickStr(diiCash.net_action)} ₹${pickNum(diiCash.buy_sell_difference).toFixed(2)} crores (${pickStr(diiCash.net_view)})

FUTURES MARKET:
- FII: ${pickStr(fiiFutQty.net_action)} ${pickNum(fiiFutQty.net_oi)} contracts (${pickStr(fiiFutQty.net_view)})
  - NIFTY: ${pickNum(fiiFutQty.nifty_net_oi)} (${pickStr(fiiFutQty.nifty_net_view)})
  - BankNIFTY: ${pickNum(fiiFutQty.banknifty_net_oi)} (${pickStr(fiiFutQty.banknifty_net_view)})
- DII: ${pickStr(diiFutQty.net_action)} ${pickNum(diiFutQty.net_oi)} contracts (${pickStr(diiFutQty.net_view)})

OPTIONS MARKET:
- FII Overall: ${pickStr(fiiOpt.overall_net_oi_change_action)} ${pickNum(fiiOpt.overall_net_oi_change)} (${pickStr(fiiOpt.overall_net_oi_change_view)})
  - Call: ${pickStr(fiiOptCall.net_oi_change_action)} ${pickNum(fiiOptCall.net_oi_change)}
  - Put: ${pickStr(fiiOptPut.net_oi_change_action)} ${pickNum(fiiOptPut.net_oi_change)}
- DII Overall: ${pickStr(diiOpt.overall_net_oi_change_action)} ${pickNum(diiOpt.overall_net_oi_change)} (${pickStr(diiOpt.overall_net_oi_change_view)})

PROPOSED TRADE DIRECTION: ${String(tradeDirection || 'unknown').toUpperCase()}

ANALYZE AND PROVIDE:
1. Do FII/DII flows support this trade direction?
2. What is the institutional consensus? (strong_bullish/bullish/neutral/bearish/strong_bearish)
3. Is there divergence between FII and DII? (e.g., FII selling but DII buying)
4. What does the options positioning tell us? (hedging/directional/neutral)
5. Flow strength? (strong/moderate/weak)
6. Should we proceed with this trade given institutional flows?
7. Any red flags or warnings?
8. Confidence in institutional flow analysis (0-10)

Return ONLY valid JSON:
{
  "flows_support_trade": true | false,
  "institutional_consensus": "strong_bullish" | "bullish" | "neutral" | "bearish" | "strong_bearish",
  "fii_dii_divergence": true | false,
  "divergence_type": "fii_selling_dii_buying" | "fii_buying_dii_selling" | "none",
  "options_positioning": "hedging" | "directional_bullish" | "directional_bearish" | "neutral",
  "flow_strength": "strong" | "moderate" | "weak",
  "should_proceed": true | false,
  "red_flags": ["string"],
  "warnings": ["string"],
  "confidence": number (0-10),
  "reasoning": "string (max 300 chars)",
  "key_insight": "string (max 200 chars)"
}`;

    setNextCallPurpose('institutional_flow_validation');
    const response = await callOpenAI(prompt, aiModel);
    if (!response) return null;

    logger.info({
      flowsSupport: response.flows_support_trade,
      consensus: response.institutional_consensus,
      shouldProceed: response.should_proceed,
      confidence: response.confidence
    }, '[aiAnalysis] FII/DII flow validation completed');

    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[aiAnalysis] FII/DII validation failed');
    return null;
  }
}
