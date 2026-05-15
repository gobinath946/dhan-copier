/**
 * Gamma Exposure (GEX) Algorithm
 * Based on SpotGamma methodology used by professional options traders
 * 
 * Tracks dealer gamma exposure to predict volatility and price movement
 */
const logger = require('../../utils/logger');

/**
 * Calculate Gamma Exposure for all strikes
 * @param {Array} optionChain - Option chain data
 * @param {number} spotPrice - Current spot price
 */
function calculateGammaExposure(optionChain, spotPrice) {
  try {
    const gammaByStrike = {};
    let totalCallGamma = 0;
    let totalPutGamma = 0;
    
    optionChain.strikes.forEach(strike => {
      const strikePrice = strike.strike;
      
      // Call Gamma (dealers are short calls, so negative gamma)
      const callOI = strike.call.oi || 0;
      const callGamma = strike.call.greeks?.gamma || estimateGamma(spotPrice, strikePrice, 'CE');
      const callGEX = callOI * callGamma * 100 * spotPrice * spotPrice * 0.01; // Convert to dollars
      
      // Put Gamma (dealers are long puts, so positive gamma)
      const putOI = strike.put.oi || 0;
      const putGamma = strike.put.greeks?.gamma || estimateGamma(spotPrice, strikePrice, 'PE');
      const putGEX = putOI * putGamma * 100 * spotPrice * spotPrice * 0.01;
      
      // Net Gamma = Put Gamma - Call Gamma (dealer perspective)
      const netGamma = putGEX - callGEX;
      
      gammaByStrike[strikePrice] = {
        call_gamma: -callGEX, // Negative because dealers are short
        put_gamma: putGEX,    // Positive because dealers are long
        net_gamma: netGamma,
        total_oi: callOI + putOI
      };
      
      totalCallGamma += callGEX;
      totalPutGamma += putGEX;
    });
    
    const netGammaExposure = totalPutGamma - totalCallGamma;
    
    // Find Gamma Flip Point (where net gamma = 0)
    const gammaFlipPoint = findGammaFlipPoint(gammaByStrike, spotPrice);
    
    // Determine regime
    const regime = determineGammaRegime(netGammaExposure, spotPrice, gammaFlipPoint);
    
    // Find high gamma strikes (pin risk)
    const pinRiskStrikes = findPinRiskStrikes(gammaByStrike);
    
    // Calculate expected move
    const expectedMove = calculateExpectedMove(gammaByStrike, spotPrice, regime);
    
    return {
      total_gamma_exposure: Math.round(netGammaExposure),
      total_call_gamma: Math.round(totalCallGamma),
      total_put_gamma: Math.round(totalPutGamma),
      gamma_by_strike: gammaByStrike,
      net_gamma: netGammaExposure > 0 ? 'positive' : 'negative',
      gamma_flip_point: gammaFlipPoint,
      current_regime: regime,
      pin_risk_strikes: pinRiskStrikes,
      expected_move: expectedMove,
      volatility_forecast: regime === 'suppression' ? 'low' : 'high',
      trading_implication: getTradingImplication(regime, spotPrice, gammaFlipPoint)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[gammaExposure] Calculation failed');
    return null;
  }
}

/**
 * Estimate gamma when not provided by API
 */
function estimateGamma(spotPrice, strikePrice, optionType) {
  const moneyness = strikePrice / spotPrice;
  const timeToExpiry = 2 / 365; // Assume 2 days for weekly options
  const volatility = 0.18; // Assume 18% IV
  
  // Simplified gamma estimation (peaks at ATM)
  const d1 = (Math.log(spotPrice / strikePrice) + (0.05 + 0.5 * volatility * volatility) * timeToExpiry) / 
             (volatility * Math.sqrt(timeToExpiry));
  
  const gamma = Math.exp(-d1 * d1 / 2) / (spotPrice * volatility * Math.sqrt(2 * Math.PI * timeToExpiry));
  
  return gamma;
}

/**
 * Find the strike where gamma flips from positive to negative
 */
function findGammaFlipPoint(gammaByStrike, spotPrice) {
  const strikes = Object.keys(gammaByStrike).map(Number).sort((a, b) => a - b);
  
  for (let i = 0; i < strikes.length - 1; i++) {
    const currentGamma = gammaByStrike[strikes[i]].net_gamma;
    const nextGamma = gammaByStrike[strikes[i + 1]].net_gamma;
    
    if (currentGamma * nextGamma < 0) {
      // Gamma flips between these strikes
      return (strikes[i] + strikes[i + 1]) / 2;
    }
  }
  
  // If no flip found, return closest to spot
  return spotPrice;
}

/**
 * Determine gamma regime
 */
function determineGammaRegime(netGamma, spotPrice, flipPoint) {
  if (netGamma > 0) {
    // Positive gamma = dealers hedge by buying dips, selling rips
    // Result: Volatility SUPPRESSION
    return 'suppression';
  } else {
    // Negative gamma = dealers hedge by selling dips, buying rips
    // Result: Volatility EXPANSION
    return 'expansion';
  }
}

/**
 * Find strikes with highest gamma (pin risk)
 */
function findPinRiskStrikes(gammaByStrike) {
  const strikes = Object.entries(gammaByStrike)
    .map(([strike, data]) => ({
      strike: Number(strike),
      absGamma: Math.abs(data.net_gamma)
    }))
    .sort((a, b) => b.absGamma - a.absGamma)
    .slice(0, 3)
    .map(s => s.strike);
  
  return strikes;
}

/**
 * Calculate expected move based on gamma
 */
function calculateExpectedMove(gammaByStrike, spotPrice, regime) {
  // In suppression regime, expect smaller moves
  // In expansion regime, expect larger moves
  
  const totalGamma = Object.values(gammaByStrike)
    .reduce((sum, data) => sum + Math.abs(data.net_gamma), 0);
  
  const avgGamma = totalGamma / Object.keys(gammaByStrike).length;
  
  // Higher gamma = more pinning = smaller expected move
  const baseMove = spotPrice * 0.005; // 0.5% base
  const gammaFactor = regime === 'suppression' ? 0.5 : 1.5;
  
  return Math.round(baseMove * gammaFactor);
}

/**
 * Get trading implications
 */
function getTradingImplication(regime, spotPrice, flipPoint) {
  if (regime === 'suppression') {
    if (spotPrice > flipPoint) {
      return 'Above flip point in suppression: Expect mean reversion down, fade rallies';
    } else {
      return 'Below flip point in suppression: Expect mean reversion up, fade dips';
    }
  } else {
    if (spotPrice > flipPoint) {
      return 'Above flip point in expansion: Expect momentum continuation up, trend following';
    } else {
      return 'Below flip point in expansion: Expect momentum continuation down, trend following';
    }
  }
}

/**
 * Calculate gamma score for master algorithm (0-100)
 */
function calculateGammaScore(gexData, direction, spotPrice) {
  if (!gexData) return 50; // Neutral if no data
  
  let score = 50; // Start neutral
  
  // 1. Regime alignment (30 points)
  if (direction === 'bullish') {
    if (gexData.current_regime === 'expansion' && spotPrice > gexData.gamma_flip_point) {
      score += 30; // Perfect for bullish momentum
    } else if (gexData.current_regime === 'suppression' && spotPrice < gexData.gamma_flip_point) {
      score += 15; // Good for bullish mean reversion
    }
  } else if (direction === 'bearish') {
    if (gexData.current_regime === 'expansion' && spotPrice < gexData.gamma_flip_point) {
      score += 30; // Perfect for bearish momentum
    } else if (gexData.current_regime === 'suppression' && spotPrice > gexData.gamma_flip_point) {
      score += 15; // Good for bearish mean reversion
    }
  }
  
  // 2. Distance from flip point (20 points)
  const distanceFromFlip = Math.abs(spotPrice - gexData.gamma_flip_point);
  const distancePct = (distanceFromFlip / spotPrice) * 100;
  
  if (distancePct > 0.5) {
    score += 20; // Far from flip = clearer regime
  } else if (distancePct > 0.2) {
    score += 10; // Moderate distance
  }
  
  // 3. Pin risk avoidance (20 points)
  const nearPinRisk = gexData.pin_risk_strikes.some(strike => 
    Math.abs(strike - spotPrice) < 50
  );
  
  if (!nearPinRisk) {
    score += 20; // Not near pin risk
  } else {
    score -= 10; // Near pin risk = avoid
  }
  
  // 4. Expected move alignment (30 points)
  if (gexData.expected_move > 20) {
    score += 30; // Large expected move = good for scalping
  } else if (gexData.expected_move > 10) {
    score += 15; // Moderate move
  }
  
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  calculateGammaExposure,
  calculateGammaScore
};
