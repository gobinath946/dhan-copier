/**
 * Market Regime Detector Service
 * ===============================
 * Classifies market conditions to prevent trading in unfavorable regimes.
 * 
 * REGIMES:
 * - TRENDING: High volatility + strong trend → Allow momentum trades
 * - EXPANSION: Volatility spike + breakout → Allow breakout trades
 * - RANGING: Low volatility + weak trend → BLOCK ALL TRADES
 * - QUIET: Very low activity → BLOCK ALL TRADES
 * - COMPRESSION: Building energy → WAIT FOR BREAKOUT
 * - MANIPULATION: Liquidity sweep detected → BLOCK TRADES
 * 
 * CRITICAL: This is the FIRST filter - runs before any other logic
 */

const logger = require('../utils/logger');

/**
 * Classify current market regime based on multiple factors
 * @param {Object} marketData - Current market snapshot
 * @returns {Object} - { regime, allowEntry, strategy, confidence, reasoning }
 */
function classifyMarketRegime(marketData) {
  const {
    volatility = 0,
    trendStrength = 0,
    marketCharacter = 'unknown',
    volumeProfile = {},
    priceAction = {},
    liquiditySweep = false,
    spotData = {},
    multiTimeframe = {}
  } = marketData;

  // Extract additional metrics
  const volume = volumeProfile.current || 0;
  const avgVolume = volumeProfile.average || 1;
  const volumeRatio = volume / avgVolume;
  
  const priceRange = priceAction.range || 0;
  const avgRange = priceAction.avgRange || 1;
  const rangeRatio = priceRange / avgRange;

  // Multi-timeframe trend alignment
  const tf1m = multiTimeframe['1m']?.trend || 'neutral';
  const tf5m = multiTimeframe['5m']?.trend || 'neutral';
  const tf15m = multiTimeframe['15m']?.trend || 'neutral';
  const tf30m = multiTimeframe['30m']?.trend || 'neutral';

  const trendsAligned = (
    (tf5m === tf15m && tf15m === tf30m) ||
    (tf1m === tf5m && tf5m === tf15m)
  );

  logger.info({
    volatility,
    trendStrength,
    marketCharacter,
    volumeRatio: volumeRatio.toFixed(2),
    rangeRatio: rangeRatio.toFixed(2),
    trendsAligned,
    tf1m, tf5m, tf15m, tf30m
  }, '[regimeDetector] Analyzing market conditions');

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 1: MANIPULATION / LIQUIDITY SWEEP
  // ═══════════════════════════════════════════════════════════════════════
  if (liquiditySweep) {
    return {
      regime: 'MANIPULATION',
      allowEntry: false,
      strategy: 'WAIT_FOR_CLARITY',
      confidence: 9,
      reasoning: 'Liquidity sweep detected - institutional manipulation in progress',
      filters: {
        volatility: false,
        trend: false,
        volume: false,
        alignment: false
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 2: QUIET MARKET (MOST COMMON LOSING CONDITION)
  // ═══════════════════════════════════════════════════════════════════════
  if (marketCharacter === 'quiet' || volatility < 0.2) {
    return {
      regime: 'QUIET',
      allowEntry: false,
      strategy: 'WAIT',
      confidence: 10,
      reasoning: `Market too quiet (volatility: ${(volatility * 100).toFixed(1)}%) - no tradeable moves`,
      filters: {
        volatility: false,
        trend: trendStrength > 0.1,
        volume: volumeRatio > 0.8,
        alignment: trendsAligned
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 3: RANGING MARKET (SECOND MOST COMMON LOSING CONDITION)
  // ═══════════════════════════════════════════════════════════════════════
  if (marketCharacter === 'ranging' || 
      (volatility < 0.3 && trendStrength < 0.15 && !trendsAligned)) {
    return {
      regime: 'RANGING',
      allowEntry: false,
      strategy: 'WAIT_FOR_BREAKOUT',
      confidence: 9,
      reasoning: `Ranging market (vol: ${(volatility * 100).toFixed(1)}%, trend: ${(trendStrength * 100).toFixed(1)}%) - breakout strategies fail`,
      filters: {
        volatility: false,
        trend: false,
        volume: volumeRatio > 1.2,
        alignment: false
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 4: COMPRESSION (Building Energy)
  // ═══════════════════════════════════════════════════════════════════════
  if (volatility < 0.4 && trendStrength < 0.2 && rangeRatio < 0.7) {
    return {
      regime: 'COMPRESSION',
      allowEntry: false,
      strategy: 'WAIT_FOR_EXPANSION',
      confidence: 7,
      reasoning: `Market compressing (range: ${(rangeRatio * 100).toFixed(0)}% of avg) - wait for expansion`,
      filters: {
        volatility: false,
        trend: false,
        volume: volumeRatio > 0.8,
        alignment: trendsAligned
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 5: NEUTRAL (Unclear Direction)
  // ═══════════════════════════════════════════════════════════════════════
  if (marketCharacter === 'neutral' || 
      (trendStrength < 0.2 && !trendsAligned)) {
    return {
      regime: 'NEUTRAL',
      allowEntry: false,
      strategy: 'WAIT_FOR_DIRECTION',
      confidence: 8,
      reasoning: `Neutral market (trend: ${(trendStrength * 100).toFixed(1)}%, alignment: ${trendsAligned}) - no clear direction`,
      filters: {
        volatility: volatility > 0.3,
        trend: false,
        volume: volumeRatio > 1.0,
        alignment: false
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 6: EXPANSION (Volatility Spike + Breakout)
  // ═══════════════════════════════════════════════════════════════════════
  if (volatility > 0.8 && trendStrength > 0.2 && volumeRatio > 1.5) {
    return {
      regime: 'EXPANSION',
      allowEntry: true,
      strategy: 'BREAKOUT',
      confidence: 8,
      reasoning: `Expansion phase (vol: ${(volatility * 100).toFixed(1)}%, trend: ${(trendStrength * 100).toFixed(1)}%, volume: ${volumeRatio.toFixed(1)}x) - breakout opportunity`,
      filters: {
        volatility: true,
        trend: true,
        volume: true,
        alignment: trendsAligned
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 7: TRENDING (High Volatility + Strong Trend)
  // ═══════════════════════════════════════════════════════════════════════
  if (volatility > 0.5 && trendStrength > 0.3 && trendsAligned) {
    return {
      regime: 'TRENDING',
      allowEntry: true,
      strategy: 'MOMENTUM',
      confidence: 9,
      reasoning: `Strong trending market (vol: ${(volatility * 100).toFixed(1)}%, trend: ${(trendStrength * 100).toFixed(1)}%, aligned: ${trendsAligned}) - momentum opportunity`,
      filters: {
        volatility: true,
        trend: true,
        volume: volumeRatio > 0.8,
        alignment: true
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGIME 8: WEAK TRENDING (Moderate Conditions)
  // ═══════════════════════════════════════════════════════════════════════
  if (volatility > 0.4 && trendStrength > 0.25 && volumeRatio > 1.0) {
    return {
      regime: 'WEAK_TRENDING',
      allowEntry: true,
      strategy: 'SELECTIVE_MOMENTUM',
      confidence: 6,
      reasoning: `Weak trend (vol: ${(volatility * 100).toFixed(1)}%, trend: ${(trendStrength * 100).toFixed(1)}%) - selective entries only`,
      filters: {
        volatility: true,
        trend: true,
        volume: true,
        alignment: trendsAligned
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEFAULT: UNCERTAIN (Block by default)
  // ═══════════════════════════════════════════════════════════════════════
  return {
    regime: 'UNCERTAIN',
    allowEntry: false,
    strategy: 'WAIT',
    confidence: 5,
    reasoning: `Uncertain conditions (vol: ${(volatility * 100).toFixed(1)}%, trend: ${(trendStrength * 100).toFixed(1)}%) - waiting for clarity`,
    filters: {
      volatility: volatility > 0.3,
      trend: trendStrength > 0.15,
      volume: volumeRatio > 0.8,
      alignment: trendsAligned
    }
  };
}

/**
 * Extract market data from aggregator payload
 * @param {Object} payload - Aggregator payload
 * @param {Object} professionalTraderDecision - Professional trader analysis
 * @returns {Object} - Formatted market data for regime detection
 */
function extractMarketData(payload, professionalTraderDecision) {
  const spotData = payload?.spot_data || {};
  const multiTimeframe = payload?.multi_timeframe || {};
  const volumeProfile = payload?.volume_orderflow || {};
  
  // Calculate volatility from spot data or use professional trader's assessment
  const volatility = spotData.volatility || 
                     professionalTraderDecision?.volatility || 
                     0;

  // Calculate trend strength from multi-timeframe alignment
  const trendStrength = professionalTraderDecision?.trend_strength || 
                        calculateTrendStrength(multiTimeframe) || 
                        0;

  // Market character from professional trader
  const marketCharacter = professionalTraderDecision?.market_character || 'unknown';

  // Price action metrics
  const priceAction = {
    range: spotData.high - spotData.low || 0,
    avgRange: spotData.avgRange || (spotData.high - spotData.low) || 1,
    current: spotData.ltp || 0
  };

  // Liquidity sweep detection
  const liquiditySweep = payload?.liquidity_sweep?.detected || false;

  return {
    volatility,
    trendStrength,
    marketCharacter,
    volumeProfile,
    priceAction,
    liquiditySweep,
    spotData,
    multiTimeframe
  };
}

/**
 * Calculate trend strength from multi-timeframe data
 * @param {Object} multiTimeframe - Multi-timeframe trend data
 * @returns {number} - Trend strength (0-1)
 */
function calculateTrendStrength(multiTimeframe) {
  if (!multiTimeframe || Object.keys(multiTimeframe).length === 0) {
    return 0;
  }

  const timeframes = ['1m', '5m', '15m', '30m'];
  const trends = timeframes
    .map(tf => multiTimeframe[tf]?.trend)
    .filter(t => t && t !== 'neutral');

  if (trends.length === 0) return 0;

  // Count bullish vs bearish
  const bullish = trends.filter(t => t === 'bullish').length;
  const bearish = trends.filter(t => t === 'bearish').length;

  // Alignment strength
  const alignment = Math.max(bullish, bearish) / trends.length;

  return alignment;
}

/**
 * Validate if current regime allows entry with given settings
 * @param {Object} regime - Regime classification result
 * @param {Object} settings - Session settings
 * @returns {Object} - { allowed, reason }
 */
function validateRegimeForEntry(regime, settings) {
  // Check if regime allows entry
  if (!regime.allowEntry) {
    return {
      allowed: false,
      reason: `Market regime ${regime.regime} does not allow entries: ${regime.reasoning}`
    };
  }

  // Check confidence threshold
  const minRegimeConfidence = settings.minRegimeConfidence || 6;
  if (regime.confidence < minRegimeConfidence) {
    return {
      allowed: false,
      reason: `Regime confidence ${regime.confidence} below threshold ${minRegimeConfidence}`
    };
  }

  // Check if settings block certain regimes
  if (settings.blockQuietMarket && regime.regime === 'QUIET') {
    return {
      allowed: false,
      reason: 'Quiet market blocked by settings'
    };
  }

  if (settings.blockRangingMarket && regime.regime === 'RANGING') {
    return {
      allowed: false,
      reason: 'Ranging market blocked by settings'
    };
  }

  // All checks passed
  return {
    allowed: true,
    reason: `Regime ${regime.regime} allows ${regime.strategy} strategy`
  };
}

module.exports = {
  classifyMarketRegime,
  extractMarketData,
  validateRegimeForEntry,
  calculateTrendStrength
};
