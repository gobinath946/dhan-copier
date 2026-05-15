/**
 * Sentiment Analyzer Service
 * Uses ChatGPT to analyze current market sentiment and news impact
 * 
 * NO EXTERNAL NEWS APIs NEEDED - ChatGPT analyzes current events directly
 * 
 * Features:
 * - Real-time market sentiment analysis
 * - News impact assessment (crude oil, rupee, FII, RBI, geopolitical)
 * - Sector-specific impact detection
 * - Risk level assessment
 * - Breaking news detection
 * - Trading recommendations based on news
 */

const axios = require('axios');
const logger = require('../utils/logger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Cache for sentiment to avoid repeated API calls
let sentimentCache = {
  data: null,
  timestamp: 0,
  ttl: 60000, // 1 minute cache
};

/**
 * Analyze current market sentiment using ChatGPT
 * ChatGPT will analyze current events, news, and market conditions
 * 
 * @param {string} currentTime - Current timestamp for context
 * @param {string} aiModel - OpenAI model to use
 * @returns {Object} Sentiment analysis result
 */
async function analyzeCurrentMarketSentiment(currentTime = new Date().toISOString(), aiModel = 'gpt-4o-mini') {
  try {
    // Check cache
    const now = Date.now();
    if (sentimentCache.data && (now - sentimentCache.timestamp) < sentimentCache.ttl) {
      logger.debug('[sentimentAnalyzer] Using cached sentiment');
      return sentimentCache.data;
    }

    logger.info('[sentimentAnalyzer] Asking ChatGPT to analyze current market sentiment');

    const prompt = `You are a professional market sentiment analyst for NIFTY 50 trading in India.

CURRENT TIME: ${currentTime}
CURRENT DATE: ${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

ANALYZE CURRENT MARKET SENTIMENT for NIFTY 50 based on:

1. **Recent News & Events** (if you're aware of any):
   - Crude oil prices movement
   - INR/USD exchange rate
   - FII/DII activity
   - RBI policy or statements
   - Banking sector news (especially SBI, HDFC, ICICI)
   - Geopolitical tensions (Middle East, Iran, etc.)
   - Global markets (US, Europe, Asia)
   - Government policy changes
   - Major earnings announcements

2. **Market Factors**:
   - Is crude oil spiking? (Bearish for India)
   - Is rupee weakening? (Bearish - FII selling)
   - Are there geopolitical tensions? (Risk-off, bearish)
   - Is banking sector weak? (Bearish - high NIFTY weightage)
   - Are global markets strong? (Bullish)
   - Is there positive earnings news? (Bullish)

PROVIDE COMPREHENSIVE ANALYSIS:

1. **Overall Market Bias**: bullish / bearish / neutral / risk-off
2. **Sentiment Score**: -100 (very bearish) to +100 (very bullish)
3. **Confidence**: 0-10 (how confident are you in this assessment)
4. **Impact Strength**: 0-10 (how much will current events affect NIFTY 50 today)
5. **Affected Sectors**: Which sectors are most impacted (banking, auto, IT, pharma, energy, metals, FMCG, etc.)
6. **Key Themes**: Main themes affecting market (crude oil, rupee, FII, RBI, geopolitical, earnings, global, etc.)
7. **Risk Level**: low / medium / high / critical
8. **Trading Recommendation**: BULLISH / BEARISH / NEUTRAL / AVOID / CAUTIOUS
9. **Reasoning**: Why this sentiment (max 300 chars)
10. **Warning Signs**: Any red flags or risks to watch (array of strings)
11. **Bullish Factors**: What's supporting the market
12. **Bearish Factors**: What's pressuring the market
13. **Breaking News**: Is there any breaking/urgent news? (true/false)
14. **Immediate Action**: Should algo pause/reduce size? (CONTINUE / REDUCE_SIZE / PAUSE / CLOSE_POSITIONS)

IMPORTANT CONTEXT FOR INDIA:
- Crude oil spike = Bearish (India imports 85% of oil)
- Rupee weakness = Bearish (FII selling, inflation concerns)
- FII selling = Bearish pressure on markets
- Banking weakness = Bearish (banking has ~35% NIFTY weightage)
- RBI hawkish = Bearish short-term (rate hikes)
- Geopolitical tensions = Risk-off, bearish
- Strong global markets = Bullish (FII inflows)
- Positive earnings = Bullish
- Government reforms = Bullish long-term

Return ONLY valid JSON:
{
  "market_bias": "bullish" | "bearish" | "neutral" | "risk-off",
  "sentiment_score": number (-100 to +100),
  "confidence": number (0-10),
  "impact_strength": number (0-10),
  "affected_sectors": ["sector1", "sector2"],
  "key_themes": ["theme1", "theme2"],
  "risk_level": "low" | "medium" | "high" | "critical",
  "trading_recommendation": "BULLISH" | "BEARISH" | "NEUTRAL" | "AVOID" | "CAUTIOUS",
  "reasoning": "string (max 300 chars)",
  "warning_signs": ["string"] or [],
  "bullish_factors": ["string"],
  "bearish_factors": ["string"],
  "breaking_news": true | false,
  "immediate_action": "CONTINUE" | "REDUCE_SIZE" | "PAUSE" | "CLOSE_POSITIONS",
  "crude_oil_status": "stable" | "rising" | "falling" | "spiking" | "crashing",
  "rupee_status": "stable" | "strengthening" | "weakening" | "volatile",
  "global_market_status": "positive" | "negative" | "mixed" | "volatile"
}`;

    const response = await callOpenAI(prompt, aiModel);

    // Update cache
    sentimentCache = {
      data: response,
      timestamp: now,
      ttl: 60000,
    };

    logger.info({
      marketBias: response.market_bias,
      sentimentScore: response.sentiment_score,
      confidence: response.confidence,
      impactStrength: response.impact_strength,
      riskLevel: response.risk_level,
      breakingNews: response.breaking_news,
      immediateAction: response.immediate_action
    }, '[sentimentAnalyzer] Current market sentiment analysis completed');

    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[sentimentAnalyzer] Sentiment analysis failed');
    return {
      market_bias: 'neutral',
      sentiment_score: 0,
      confidence: 0,
      impact_strength: 0,
      affected_sectors: [],
      key_themes: [],
      risk_level: 'medium',
      trading_recommendation: 'NEUTRAL',
      reasoning: 'Sentiment analysis failed - proceeding with caution',
      warning_signs: ['AI analysis unavailable'],
      bullish_factors: [],
      bearish_factors: [],
      breaking_news: false,
      immediate_action: 'CONTINUE',
      crude_oil_status: 'stable',
      rupee_status: 'stable',
      global_market_status: 'mixed'
    };
  }
}

/**
 * Analyze sentiment impact on specific trade setup
 * @param {Object} tradeSetup - Trade setup details
 * @param {Object} marketSentiment - Current market sentiment
 * @param {string} aiModel - OpenAI model
 * @returns {Object} Trade-specific sentiment analysis
 */
async function analyzeSentimentForTrade(tradeSetup, marketSentiment, aiModel = 'gpt-4o-mini') {
  try {
    logger.info('[sentimentAnalyzer] Analyzing sentiment impact on trade setup');

    const prompt = `You are validating a trade setup against current market sentiment.

TRADE SETUP:
Direction: ${tradeSetup.direction}
Strike: ${tradeSetup.strike}
Option Type: ${tradeSetup.optionType}
Technical Score: ${tradeSetup.technicalScore}
Master Score: ${tradeSetup.masterScore}
Confidence: ${tradeSetup.confidence}

CURRENT MARKET SENTIMENT:
${JSON.stringify(marketSentiment, null, 2)}

VALIDATE:
1. Does current sentiment support this trade direction?
2. Are there conflicting signals between technicals and sentiment?
3. What is the risk of taking this trade given current news?
4. Should we proceed, wait, or avoid?
5. Any adjustments needed (reduce size, widen SL, etc.)?

Return ONLY valid JSON:
{
  "sentiment_supports_trade": true | false,
  "conflict_detected": true | false,
  "risk_assessment": "low" | "medium" | "high" | "critical",
  "should_proceed": true | false,
  "recommended_action": "PROCEED" | "PROCEED_CAUTIOUS" | "WAIT" | "AVOID",
  "adjustments_needed": ["reduce_size", "widen_sl", "lower_target"] or [],
  "confidence_adjustment": number (-30 to +30),
  "reasoning": "string (max 250 chars)"
}`;

    const response = await callOpenAI(prompt, aiModel);

    logger.info({
      sentimentSupports: response.sentiment_supports_trade,
      shouldProceed: response.should_proceed,
      recommendedAction: response.recommended_action,
      confidenceAdjustment: response.confidence_adjustment
    }, '[sentimentAnalyzer] Trade sentiment validation completed');

    return response;
  } catch (error) {
    logger.error({ error: error.message }, '[sentimentAnalyzer] Trade sentiment analysis failed');
    return {
      sentiment_supports_trade: true,
      conflict_detected: false,
      risk_assessment: 'medium',
      should_proceed: true,
      recommended_action: 'PROCEED',
      adjustments_needed: [],
      confidence_adjustment: 0,
      reasoning: 'Analysis failed - proceeding with original setup'
    };
  }
}

/**
 * Calculate news-adjusted confidence score
 * @param {number} technicalScore - Technical analysis score (0-100)
 * @param {Object} marketSentiment - Market sentiment analysis
 * @param {string} tradeDirection - Trade direction (bullish/bearish)
 * @returns {Object} Adjusted score and recommendation
 */
function calculateNewsAdjustedScore(technicalScore, marketSentiment, tradeDirection) {
  try {
    logger.info('[sentimentAnalyzer] Calculating news-adjusted confidence score');

    // Base technical score
    let adjustedScore = technicalScore;

    // Check if sentiment supports trade direction
    const sentimentSupports = 
      (tradeDirection === 'bullish' && marketSentiment.market_bias === 'bullish') ||
      (tradeDirection === 'bearish' && marketSentiment.market_bias === 'bearish');

    // Sentiment adjustment
    if (sentimentSupports) {
      // Sentiment supports - boost score
      const boost = (marketSentiment.sentiment_score / 100) * 20; // Max +20 points
      adjustedScore += Math.abs(boost);
    } else if (marketSentiment.market_bias === 'risk-off' || marketSentiment.risk_level === 'critical') {
      // Risk-off or critical - major penalty
      adjustedScore -= 40;
    } else {
      // Sentiment conflicts - penalty
      const penalty = (Math.abs(marketSentiment.sentiment_score) / 100) * 15; // Max -15 points
      adjustedScore -= penalty;
    }

    // Impact strength multiplier
    const impactMultiplier = marketSentiment.impact_strength / 10;
    const impactAdjustment = sentimentSupports ? 
      (marketSentiment.sentiment_score / 100) * 10 * impactMultiplier :
      -(Math.abs(marketSentiment.sentiment_score) / 100) * 10 * impactMultiplier;
    
    adjustedScore += impactAdjustment;

    // Risk level penalty
    const riskPenalty = {
      low: 0,
      medium: -5,
      high: -15,
      critical: -30
    };
    adjustedScore += riskPenalty[marketSentiment.risk_level] || 0;

    // Breaking news penalty
    if (marketSentiment.breaking_news) {
      adjustedScore -= 20;
    }

    // Clamp between 0-100
    adjustedScore = Math.max(0, Math.min(100, adjustedScore));

    // Determine recommendation
    let recommendation = 'NEUTRAL';
    if (marketSentiment.immediate_action === 'PAUSE' || marketSentiment.immediate_action === 'CLOSE_POSITIONS') {
      recommendation = 'AVOID';
    } else if (adjustedScore >= 75 && sentimentSupports) {
      recommendation = 'STRONG_ENTER';
    } else if (adjustedScore >= 60 && sentimentSupports) {
      recommendation = 'ENTER';
    } else if (adjustedScore <= 25 || marketSentiment.risk_level === 'critical') {
      recommendation = 'AVOID';
    } else if (adjustedScore <= 40 && !sentimentSupports) {
      recommendation = 'WAIT';
    } else if (marketSentiment.immediate_action === 'REDUCE_SIZE') {
      recommendation = 'ENTER_REDUCED';
    }

    const result = {
      technical_score: technicalScore,
      sentiment_score: marketSentiment.sentiment_score,
      adjusted_score: Math.round(adjustedScore),
      adjustment: Math.round(adjustedScore - technicalScore),
      recommendation,
      sentiment_supports: sentimentSupports,
      confidence: marketSentiment.confidence,
      risk_level: marketSentiment.risk_level,
      immediate_action: marketSentiment.immediate_action,
      reasoning: `Technical: ${technicalScore}, Sentiment: ${marketSentiment.sentiment_score}, Risk: ${marketSentiment.risk_level}, Supports: ${sentimentSupports}`
    };

    logger.info({
      technicalScore,
      adjustedScore: result.adjusted_score,
      adjustment: result.adjustment,
      recommendation,
      sentimentSupports
    }, '[sentimentAnalyzer] News-adjusted score calculated');

    return result;
  } catch (error) {
    logger.error({ error: error.message }, '[sentimentAnalyzer] Score adjustment failed');
    return {
      technical_score: technicalScore,
      sentiment_score: 0,
      adjusted_score: technicalScore,
      adjustment: 0,
      recommendation: 'NEUTRAL',
      sentiment_supports: true,
      confidence: 0,
      risk_level: 'medium',
      immediate_action: 'CONTINUE',
      reasoning: 'Adjustment failed'
    };
  }
}

/**
 * Clear sentiment cache (force refresh)
 */
function clearCache() {
  sentimentCache = {
    data: null,
    timestamp: 0,
    ttl: 60000,
  };
  logger.info('[sentimentAnalyzer] Sentiment cache cleared');
}

/**
 * Helper: Call OpenAI API
 */
async function callOpenAI(prompt, model = 'gpt-4o-mini') {
  try {
    const { data } = await axios.post(
      OPENAI_URL,
      {
        model,
        messages: [
          { 
            role: 'system', 
            content: 'You are a professional market sentiment analyst specializing in NIFTY 50 trading in India. Always return valid JSON.' 
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty AI response');
    
    return JSON.parse(text);
  } catch (error) {
    logger.error({ 
      error: error.message, 
      response: error.response?.data 
    }, '[sentimentAnalyzer] OpenAI API call failed');
    throw error;
  }
}

module.exports = {
  analyzeCurrentMarketSentiment,
  analyzeSentimentForTrade,
  calculateNewsAdjustedScore,
  clearCache
};
