/**
 * Confirmation Engine Service
 * ============================
 * Multi-layer confirmation system for trade entries.
 * Requires 8+ independent confirmations before allowing any trade.
 * 
 * CONFIRMATION LAYERS:
 * 1. Higher Timeframe Trend Alignment (15m, 30m)
 * 2. VWAP Confirmation (price position relative to VWAP)
 * 3. OI Confirmation (Open Interest direction)
 * 4. Volume Expansion (above average volume)
 * 5. Futures Strength Confirmation (futures leading spot)
 * 6. Liquidity Sweep Validation (post-sweep momentum)
 * 7. Delta Momentum Confirmation (option flow)
 * 8. Option Chain Imbalance (PCR analysis)
 * 9. Market Sentiment Agreement (AI sentiment)
 * 10. Sector Strength Confirmation (sector rotation)
 * 11. Candle Structure Confirmation (price action)
 * 12. Breakout Retest Confirmation (structure validation)
 * 
 * SCORING:
 * - Each confirmation adds 1-2 points
 * - Minimum 8 confirmations required
 * - Minimum score of 10 required
 * - Critical confirmations (HTF, VWAP, Futures) are weighted higher
 */

const logger = require('../utils/logger');

/**
 * Calculate comprehensive confirmation score for trade entry
 * @param {Object} payload - Market data payload
 * @param {Object} algorithmOutputs - All algorithm outputs
 * @param {Object} masterDecision - Master algorithm decision
 * @param {Object} tradeDecision - Professional trader decision
 * @param {Object} futuresData - Futures market data
 * @returns {Object} - { score, confirmations, count, passed, details }
 */
function calculateConfirmationScore(payload, algorithmOutputs, masterDecision, tradeDecision, futuresData) {
  const confirmations = [];
  let score = 0;
  const details = {};

  const direction = tradeDecision?.dominant_direction || 'neutral';
  const isBullish = direction === 'bullish';
  const spotPrice = payload?.spot_data?.ltp || 0;

  logger.info({
    direction,
    spotPrice,
    hasAlgorithms: !!algorithmOutputs,
    hasMaster: !!masterDecision,
    hasFutures: !!futuresData
  }, '[confirmationEngine] Starting confirmation analysis');

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 1 & 2: HIGHER TIMEFRAME TREND ALIGNMENT (Critical - 2 points)
  // ═══════════════════════════════════════════════════════════════════════
  const tf15m = payload?.multi_timeframe?.['15m']?.trend;
  const tf30m = payload?.multi_timeframe?.['30m']?.trend;
  
  let htfScore = 0;
  if (tf15m === direction) {
    confirmations.push('HTF_15M_ALIGNED');
    htfScore += 1;
  }
  if (tf30m === direction) {
    confirmations.push('HTF_30M_ALIGNED');
    htfScore += 1;
  }
  
  if (htfScore === 2) {
    score += 2; // Both timeframes aligned - strong confirmation
    details.htf_alignment = 'STRONG';
  } else if (htfScore === 1) {
    score += 1; // One timeframe aligned - moderate
    details.htf_alignment = 'MODERATE';
  } else {
    details.htf_alignment = 'WEAK';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 3: VWAP CONFIRMATION (Critical - 1 point)
  // ═══════════════════════════════════════════════════════════════════════
  const vwap = payload?.vwap || payload?.spot_data?.vwap;
  if (vwap && spotPrice) {
    const aboveVWAP = spotPrice > vwap;
    if ((isBullish && aboveVWAP) || (!isBullish && !aboveVWAP)) {
      confirmations.push('VWAP_CONFIRMED');
      score += 1;
      details.vwap_position = isBullish ? 'ABOVE' : 'BELOW';
    } else {
      details.vwap_position = isBullish ? 'BELOW (AGAINST)' : 'ABOVE (AGAINST)';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 4: OI CONFIRMATION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  const oiAnalysis = payload?.oi_analysis;
  if (oiAnalysis) {
    const oiDirection = oiAnalysis.direction || oiAnalysis.bias;
    if (oiDirection === direction) {
      confirmations.push('OI_CONFIRMED');
      score += 1;
      details.oi_direction = oiDirection;
    } else {
      details.oi_direction = `${oiDirection} (AGAINST)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 5: VOLUME EXPANSION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  const volumeSpike = payload?.volume_spike || 
                      payload?.volume_orderflow?.volume_spike ||
                      algorithmOutputs?.orderFlow?.volume_spike;
  
  if (volumeSpike) {
    confirmations.push('VOLUME_EXPANSION');
    score += 1;
    details.volume_status = 'EXPANDING';
  } else {
    details.volume_status = 'NORMAL';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 6: FUTURES STRENGTH CONFIRMATION (Critical - 2 points)
  // ═══════════════════════════════════════════════════════════════════════
  if (futuresData) {
    const futuresDirection = futuresData.direction;
    const futuresMomentum = futuresData.momentum;
    const futuresTrend = futuresData.trend;
    const change1m = futuresData.change_1m || 0;
    
    let futuresScore = 0;
    
    // Direction alignment
    if (futuresDirection === direction) {
      futuresScore += 1;
    }
    
    // Momentum confirmation
    if ((isBullish && futuresMomentum === 'bullish') || 
        (!isBullish && futuresMomentum === 'bearish')) {
      futuresScore += 1;
    }
    
    // Trend confirmation
    if ((isBullish && futuresTrend === 'uptrend') || 
        (!isBullish && futuresTrend === 'downtrend')) {
      futuresScore += 1;
    }
    
    // 1-minute change confirmation
    if ((isBullish && change1m > 0) || (!isBullish && change1m < 0)) {
      futuresScore += 1;
    }
    
    if (futuresScore >= 3) {
      confirmations.push('FUTURES_STRONG_ALIGNED');
      score += 2;
      details.futures_alignment = 'STRONG';
    } else if (futuresScore >= 2) {
      confirmations.push('FUTURES_ALIGNED');
      score += 1;
      details.futures_alignment = 'MODERATE';
    } else {
      details.futures_alignment = 'WEAK';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 7: LIQUIDITY SWEEP VALIDATION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  if (algorithmOutputs?.liquidityAnalysis) {
    const liquidityScore = algorithmOutputs.liquidityAnalysis.liquidity_score || 0;
    if (liquidityScore > 60) {
      confirmations.push('LIQUIDITY_VALIDATED');
      score += 1;
      details.liquidity_score = liquidityScore;
    } else {
      details.liquidity_score = `${liquidityScore} (LOW)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 8: DELTA MOMENTUM CONFIRMATION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  if (algorithmOutputs?.orderFlow) {
    const deltaMomentum = algorithmOutputs.orderFlow.delta_momentum;
    if (deltaMomentum === direction) {
      confirmations.push('DELTA_MOMENTUM');
      score += 1;
      details.delta_momentum = deltaMomentum;
    } else {
      details.delta_momentum = `${deltaMomentum} (AGAINST)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 9: OPTION CHAIN IMBALANCE (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  const pcrOI = payload?.options_chain?.pcr_oi || payload?.pcr_oi;
  if (pcrOI) {
    // PCR > 1.2 = more puts = bullish
    // PCR < 0.8 = more calls = bearish
    if ((isBullish && pcrOI > 1.2) || (!isBullish && pcrOI < 0.8)) {
      confirmations.push('OPTION_IMBALANCE');
      score += 1;
      details.pcr_oi = `${pcrOI.toFixed(2)} (FAVORABLE)`;
    } else {
      details.pcr_oi = `${pcrOI.toFixed(2)} (NEUTRAL)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 10: MARKET SENTIMENT AGREEMENT (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  const sentiment = payload?.market_sentiment;
  if (sentiment) {
    const sentimentBias = sentiment.market_bias;
    if (sentimentBias === direction) {
      confirmations.push('SENTIMENT_ALIGNED');
      score += 1;
      details.sentiment = sentimentBias;
    } else {
      details.sentiment = `${sentimentBias} (AGAINST)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 11: SECTOR STRENGTH CONFIRMATION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  if (algorithmOutputs?.sectorRotation) {
    const sectorScore = algorithmOutputs.sectorRotation.sector_rotation_score || 0;
    if (sectorScore > 60) {
      confirmations.push('SECTOR_STRENGTH');
      score += 1;
      details.sector_score = sectorScore;
    } else {
      details.sector_score = `${sectorScore} (WEAK)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 12: CANDLE STRUCTURE CONFIRMATION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  const candles1m = payload?.candles_1m;
  if (candles1m && candles1m.length > 0) {
    const lastCandle = candles1m[candles1m.length - 1];
    const isBullishCandle = lastCandle.c > lastCandle.o;
    
    if ((isBullish && isBullishCandle) || (!isBullish && !isBullishCandle)) {
      confirmations.push('CANDLE_STRUCTURE');
      score += 1;
      details.candle_structure = isBullish ? 'BULLISH' : 'BEARISH';
    } else {
      details.candle_structure = isBullish ? 'BEARISH (AGAINST)' : 'BULLISH (AGAINST)';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 13: BREAKOUT RETEST CONFIRMATION (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  if (payload?.breakout_retest_confirmed) {
    confirmations.push('BREAKOUT_RETEST');
    score += 1;
    details.breakout_retest = 'CONFIRMED';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIRMATION 14: MASTER ALGORITHM AGREEMENT (1 point)
  // ═══════════════════════════════════════════════════════════════════════
  if (masterDecision) {
    const masterScore = masterDecision.master_score || 0;
    const masterConfidence = masterDecision.confidence || 0;
    const agreementCount = masterDecision.agreement_count || 0;
    
    if (masterScore >= 70 && masterConfidence >= 7 && agreementCount >= 10) {
      confirmations.push('MASTER_ALGORITHM_STRONG');
      score += 1;
      details.master_agreement = `Score: ${masterScore}, Conf: ${masterConfidence}, Agree: ${agreementCount}`;
    } else {
      details.master_agreement = `Score: ${masterScore} (WEAK)`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINAL EVALUATION
  // ═══════════════════════════════════════════════════════════════════════
  const count = confirmations.length;
  const minConfirmations = 8;
  const minScore = 10;
  
  const passed = count >= minConfirmations && score >= minScore;

  logger.info({
    confirmations: count,
    score,
    required: { confirmations: minConfirmations, score: minScore },
    passed,
    direction
  }, '[confirmationEngine] Confirmation analysis complete');

  return {
    score,
    confirmations,
    count,
    passed,
    details,
    summary: {
      total_confirmations: count,
      required_confirmations: minConfirmations,
      total_score: score,
      required_score: minScore,
      passed,
      missing: Math.max(0, minConfirmations - count),
      direction
    }
  };
}

/**
 * Validate if confirmations meet minimum requirements
 * @param {Object} confirmationResult - Result from calculateConfirmationScore
 * @param {Object} settings - Session settings
 * @returns {Object} - { allowed, reason, details }
 */
function validateConfirmations(confirmationResult, settings) {
  const minConfirmations = settings.minConfirmations || 8;
  const minScore = settings.minConfirmationScore || 10;

  if (!confirmationResult.passed) {
    return {
      allowed: false,
      reason: `Insufficient confirmations: ${confirmationResult.count}/${minConfirmations} (score: ${confirmationResult.score}/${minScore})`,
      details: {
        missing_confirmations: minConfirmations - confirmationResult.count,
        missing_score: minScore - confirmationResult.score,
        confirmations: confirmationResult.confirmations,
        details: confirmationResult.details
      }
    };
  }

  // Check critical confirmations
  const hasCriticalHTF = confirmationResult.confirmations.some(c => 
    c.includes('HTF_15M_ALIGNED') || c.includes('HTF_30M_ALIGNED')
  );
  
  const hasCriticalVWAP = confirmationResult.confirmations.includes('VWAP_CONFIRMED');
  
  const hasCriticalFutures = confirmationResult.confirmations.some(c => 
    c.includes('FUTURES')
  );

  if (settings.requireHTFAlignment && !hasCriticalHTF) {
    return {
      allowed: false,
      reason: 'Higher timeframe alignment required but not confirmed',
      details: confirmationResult.details
    };
  }

  if (settings.requireVWAPConfirmation && !hasCriticalVWAP) {
    return {
      allowed: false,
      reason: 'VWAP confirmation required but not confirmed',
      details: confirmationResult.details
    };
  }

  if (settings.requireFuturesConfirmation && !hasCriticalFutures) {
    return {
      allowed: false,
      reason: 'Futures confirmation required but not confirmed',
      details: confirmationResult.details
    };
  }

  return {
    allowed: true,
    reason: `All confirmations passed: ${confirmationResult.count}/${minConfirmations} (score: ${confirmationResult.score}/${minScore})`,
    details: confirmationResult.details
  };
}

/**
 * Get human-readable confirmation report
 * @param {Object} confirmationResult - Result from calculateConfirmationScore
 * @returns {string} - Formatted report
 */
function getConfirmationReport(confirmationResult) {
  const lines = [
    `\n═══════════════════════════════════════════════════════════════`,
    `CONFIRMATION ANALYSIS REPORT`,
    `═══════════════════════════════════════════════════════════════`,
    `Direction: ${confirmationResult.summary.direction.toUpperCase()}`,
    `Total Confirmations: ${confirmationResult.count}/${confirmationResult.summary.required_confirmations}`,
    `Total Score: ${confirmationResult.score}/${confirmationResult.summary.required_score}`,
    `Status: ${confirmationResult.passed ? '✅ PASSED' : '❌ FAILED'}`,
    ``,
    `Confirmed Layers:`,
    ...confirmationResult.confirmations.map(c => `  ✓ ${c}`),
    ``,
    `Details:`,
    ...Object.entries(confirmationResult.details).map(([key, value]) => 
      `  ${key}: ${value}`
    ),
    `═══════════════════════════════════════════════════════════════\n`
  ];

  return lines.join('\n');
}

module.exports = {
  calculateConfirmationScore,
  validateConfirmations,
  getConfirmationReport
};
