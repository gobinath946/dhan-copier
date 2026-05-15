/**
 * Sector Rotation Analysis
 * Used by: Fund managers, Institutional traders, Sector specialists
 * 
 * Analyzes BankNIFTY leadership, top stock contribution, sector-wise strength,
 * and rotation patterns (IT/Banking/Auto/FMCG/Defensive)
 * 
 * CRITICAL FOR UNDERSTANDING MARKET DRIVERS
 */
const logger = require('../../utils/logger');
const dhanBypass = require('../dhanProd.service');

const BANKNIFTY_SECURITY_ID = 25;

// Top NIFTY contributors by weight
const TOP_NIFTY_CONTRIBUTORS = [
  { name: 'Reliance', securityId: 2885, weight: 10.5, sector: 'Energy' },
  { name: 'HDFC Bank', securityId: 1333, weight: 9.8, sector: 'Banking' },
  { name: 'ICICI Bank', securityId: 4963, weight: 7.2, sector: 'Banking' },
  { name: 'Infosys', securityId: 1594, weight: 6.5, sector: 'IT' },
  { name: 'TCS', securityId: 3456, weight: 5.8, sector: 'IT' }
];

/**
 * Analyze sector rotation
 * @param {string} authKey - Dhan Bypass auth key
 * @param {number} niftySpotPrice - Current NIFTY spot price
 * @param {number|Object} niftyChangePctOrPrev - NIFTY change % (number) OR legacy previous-state object
 */
async function analyzeSectorRotation(authKey, niftySpotPrice, niftyChangePctOrPrev) {
  try {
    // Defensive: the engine previously passed the previous-state object here
    // by mistake. Accept either shape and coerce to a number.
    let niftyChangePct = 0;
    if (typeof niftyChangePctOrPrev === 'number' && Number.isFinite(niftyChangePctOrPrev)) {
      niftyChangePct = niftyChangePctOrPrev;
    } else if (niftyChangePctOrPrev && typeof niftyChangePctOrPrev === 'object') {
      const candidate = niftyChangePctOrPrev.nifty_change_pct
        ?? niftyChangePctOrPrev.niftyChangePct
        ?? niftyChangePctOrPrev.changePct;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        niftyChangePct = candidate;
      }
    }

    // 1. Analyze BankNIFTY Leadership
    const bankNiftyLeadership = await analyzeBankNiftyLeadership(authKey, niftyChangePct);
    
    // 2. Analyze Top 5 Stock Contribution
    const topStockContribution = await analyzeTopStockContribution(authKey, niftyChangePct);
    
    // 3. Analyze Sector-wise Strength
    const sectorStrength = analyzeSectorWiseStrength(topStockContribution);
    
    // 4. Detect Rotation Pattern
    const rotationPattern = detectRotationPattern(bankNiftyLeadership, sectorStrength);
    
    // 5. Calculate Sector Rotation Score
    const rotationScore = calculateRotationScore(
      bankNiftyLeadership,
      topStockContribution,
      sectorStrength,
      rotationPattern
    );
    
    return {
      banknifty_leadership: bankNiftyLeadership,
      top_stock_contribution: topStockContribution,
      sector_strength: sectorStrength,
      rotation_pattern: rotationPattern,
      rotation_score: rotationScore,
      rotation_quality: determineRotationQuality(rotationScore),
      trading_implication: getTradingImplication(bankNiftyLeadership, rotationPattern)
    };
  } catch (error) {
    logger.error({ error: error.message }, '[sectorRotation] Analysis failed');
    return null;
  }
}

/**
 * Analyze BankNIFTY Leadership (nullsafe against bad inputs)
 */
async function analyzeBankNiftyLeadership(authKey, niftyChangePct) {
  try {
    // Coerce input to a safe number
    const niftyChg = Number.isFinite(Number(niftyChangePct)) ? Number(niftyChangePct) : 0;

    const now = Math.floor(Date.now() / 1000);
    const fiveMinAgo = now - (5 * 60);
    
    const res = await dhanBypass.getDhanBypassData(authKey, {
      securityId: BANKNIFTY_SECURITY_ID,
      exchange: 'IDX',
      segment: 'I',
      instrument: 'IDX',
      startTime: fiveMinAgo,
      endTime: now,
      interval: '1',
    });
    
    if (!res.ok || !res.data.candles || res.data.candles.length === 0) {
      return {
        is_leading: false,
        leadership_type: 'none',
        banknifty_change_pct: 0,
        nifty_change_pct: Number(niftyChg.toFixed(2)),
        relative_strength: 0,
        correlation: 0,
        strength: 'weak'
      };
    }
    
    const candles = res.data.candles;
    const lastCandle = candles[candles.length - 1];
    const firstCandle = candles[0];

    const firstOpen = Number(firstCandle?.open);
    const lastClose = Number(lastCandle?.close);
    if (!Number.isFinite(firstOpen) || !Number.isFinite(lastClose) || firstOpen === 0) {
      return {
        is_leading: false,
        leadership_type: 'none',
        banknifty_change_pct: 0,
        nifty_change_pct: Number(niftyChg.toFixed(2)),
        relative_strength: 0,
        correlation: 0,
        strength: 'weak'
      };
    }

    const bankNiftyChangePct = ((lastClose - firstOpen) / firstOpen) * 100;

    // Relative strength vs NIFTY
    const relativeStrength = bankNiftyChangePct - niftyChg;

    // Is BankNIFTY leading?
    const isLeading = Math.abs(bankNiftyChangePct) > Math.abs(niftyChg) * 1.1;

    // Leadership type
    let leadershipType = 'none';
    if (isLeading && bankNiftyChangePct > 0) {
      leadershipType = 'bullish_leader';
    } else if (isLeading && bankNiftyChangePct < 0) {
      leadershipType = 'bearish_leader';
    } else if (Math.abs(bankNiftyChangePct) < Math.abs(niftyChg) * 0.9) {
      leadershipType = 'lagging';
    } else {
      leadershipType = 'in_sync';
    }

    // Correlation (same direction?)
    const sameDirection = (bankNiftyChangePct > 0 && niftyChg > 0) ||
                          (bankNiftyChangePct < 0 && niftyChg < 0);
    const correlation = sameDirection ? 0.9 : -0.5;

    return {
      is_leading: isLeading,
      leadership_type: leadershipType,
      banknifty_change_pct: Number(bankNiftyChangePct.toFixed(2)),
      nifty_change_pct: Number(niftyChg.toFixed(2)),
      relative_strength: Number(relativeStrength.toFixed(2)),
      correlation: Number(correlation.toFixed(2)),
      strength: isLeading ? 'strong' : 'weak'
    };
  } catch (error) {
    logger.error({ error: error.message }, '[sectorRotation] BankNIFTY leadership analysis failed');
    return {
      is_leading: false,
      leadership_type: 'none',
      banknifty_change_pct: 0,
      nifty_change_pct: 0,
      relative_strength: 0,
      correlation: 0,
      strength: 'weak'
    };
  }
}

/**
 * Analyze Top 5 Stock Contribution
 * 
 * OPTIMIZATION: This function makes 5+ API calls per cycle, causing rate limits.
 * Options:
 * 1. Disable completely (return mock data)
 * 2. Cache for longer (5 minutes instead of real-time)
 * 3. Use WebSocket feed if available
 * 
 * Current: DISABLED to prevent rate limits
 */
async function analyzeTopStockContribution(authKey, niftyChangePct) {
  try {
    // TEMPORARY FIX: Return mock data to prevent rate limits
    // TODO: Implement WebSocket-based stock tracking or extend live-feed to stocks
    logger.debug('[sectorRotation] Stock contribution analysis DISABLED (rate limit optimization)');
    
    return {
      stocks: [],
      total_contribution: 0,
      top_contributor: null,
      positive_contributors: 0,
      negative_contributors: 0,
      contribution_quality: 'weak',
      note: 'Stock analysis disabled to prevent API rate limits',
    };
    
    /* ORIGINAL CODE - COMMENTED OUT TO PREVENT RATE LIMITS
    const now = Math.floor(Date.now() / 1000);
    const fiveMinAgo = now - (5 * 60);
    
    // Fetch data for top 5 stocks in parallel
    const promises = TOP_NIFTY_CONTRIBUTORS.map(async (stock) => {
      try {
        const res = await dhanBypass.getDhanBypassData(authKey, {
          securityId: stock.securityId,
          exchange: 'NSE',
          segment: 'E',
          instrument: 'EQUITY',
          startTime: fiveMinAgo,
          endTime: now,
          interval: '1',
        });
        
        if (!res.ok || !res.data.candles || res.data.candles.length === 0) {
          return null;
        }
        
        const candles = res.data.candles;
        const lastCandle = candles[candles.length - 1];
        const firstCandle = candles[0];
        
        const changePct = ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100;
        
        // Contribution to NIFTY = weight * change%
        const contribution = (stock.weight / 100) * changePct;
        
        return {
          name: stock.name,
          sector: stock.sector,
          weight: stock.weight,
          change_pct: Number(changePct.toFixed(2)),
          contribution: Number(contribution.toFixed(2)),
          ltp: lastCandle.close,
          is_positive: changePct > 0
        };
      } catch (error) {
        logger.error({ error: error.message, stock: stock.name }, '[sectorRotation] Stock fetch failed');
        return null;
      }
    });
    
    const results = await Promise.all(promises);
    const stocks = results.filter(r => r !== null);
    
    // Calculate total contribution
    const totalContribution = stocks.reduce((sum, s) => sum + s.contribution, 0);
    
    // Sort by contribution
    stocks.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    
    // Top contributor
    const topContributor = stocks[0] || null;
    
    // Positive vs negative contributors
    const positiveContributors = stocks.filter(s => s.is_positive);
    const negativeContributors = stocks.filter(s => !s.is_positive);
    
    return {
      stocks,
      total_contribution: Number(totalContribution.toFixed(2)),
      top_contributor: topContributor,
      positive_contributors: positiveContributors.length,
      negative_contributors: negativeContributors.length,
      contribution_quality: Math.abs(totalContribution) > 0.5 ? 'strong' : 'weak'
    };
    */
  } catch (error) {
    logger.error({ error: error.message }, '[sectorRotation] Top stock contribution analysis failed');
    return {
      stocks: [],
      total_contribution: 0,
      top_contributor: null,
      positive_contributors: 0,
      negative_contributors: 0,
      contribution_quality: 'weak'
    };
  }
}

/**
 * Analyze Sector-wise Strength
 */
function analyzeSectorWiseStrength(topStockContribution) {
  if (!topStockContribution.stocks || topStockContribution.stocks.length === 0) {
    return {
      sectors: [],
      strongest_sector: null,
      weakest_sector: null
    };
  }
  
  // Group by sector
  const sectorMap = {};
  topStockContribution.stocks.forEach(stock => {
    if (!sectorMap[stock.sector]) {
      sectorMap[stock.sector] = {
        sector: stock.sector,
        stocks: [],
        total_contribution: 0,
        avg_change: 0
      };
    }
    sectorMap[stock.sector].stocks.push(stock);
    sectorMap[stock.sector].total_contribution += stock.contribution;
  });
  
  // Calculate sector averages
  const sectors = Object.values(sectorMap).map(sector => {
    const avgChange = sector.stocks.reduce((sum, s) => sum + s.change_pct, 0) / sector.stocks.length;
    return {
      sector: sector.sector,
      stock_count: sector.stocks.length,
      total_contribution: Number(sector.total_contribution.toFixed(2)),
      avg_change: Number(avgChange.toFixed(2)),
      strength: avgChange > 0.5 ? 'strong' : avgChange > 0 ? 'moderate' : avgChange > -0.5 ? 'weak' : 'very_weak'
    };
  });
  
  // Sort by contribution
  sectors.sort((a, b) => b.total_contribution - a.total_contribution);
  
  const strongestSector = sectors[0] || null;
  const weakestSector = sectors[sectors.length - 1] || null;
  
  return {
    sectors,
    strongest_sector: strongestSector,
    weakest_sector: weakestSector
  };
}

/**
 * Detect Rotation Pattern
 */
function detectRotationPattern(bankNiftyLeadership, sectorStrength) {
  let pattern = 'none';
  let description = 'No clear rotation pattern';
  
  // Banking leadership
  if (bankNiftyLeadership.is_leading && bankNiftyLeadership.leadership_type === 'bullish_leader') {
    pattern = 'banking_leadership';
    description = 'Banking sector leading market higher - risk-on sentiment';
  } else if (bankNiftyLeadership.is_leading && bankNiftyLeadership.leadership_type === 'bearish_leader') {
    pattern = 'banking_weakness';
    description = 'Banking sector leading market lower - risk-off sentiment';
  }
  
  // IT leadership
  if (sectorStrength.strongest_sector && sectorStrength.strongest_sector.sector === 'IT') {
    if (sectorStrength.strongest_sector.avg_change > 1) {
      pattern = 'it_leadership';
      description = 'IT sector showing strength - defensive rotation or export optimism';
    }
  }
  
  // Energy leadership (Reliance)
  if (sectorStrength.strongest_sector && sectorStrength.strongest_sector.sector === 'Energy') {
    pattern = 'energy_leadership';
    description = 'Energy sector (Reliance) driving market - crude oil impact';
  }
  
  // FMCG strength = defensive rotation
  if (sectorStrength.strongest_sector && sectorStrength.strongest_sector.sector === 'FMCG') {
    pattern = 'defensive_rotation';
    description = 'FMCG strength indicates defensive rotation - risk-off';
  }
  
  // Broad weakness
  if (sectorStrength.sectors.every(s => s.avg_change < 0)) {
    pattern = 'broad_weakness';
    description = 'All sectors weak - broad market selloff';
  }
  
  // Broad strength
  if (sectorStrength.sectors.every(s => s.avg_change > 0)) {
    pattern = 'broad_strength';
    description = 'All sectors strong - broad market rally';
  }
  
  return {
    pattern,
    description,
    confidence: pattern !== 'none' ? 'high' : 'low'
  };
}

/**
 * Calculate Rotation Score (0-100)
 */
function calculateRotationScore(bankNiftyLeadership, topStockContribution, sectorStrength, rotationPattern) {
  let score = 50; // Start neutral
  
  // 1. BankNIFTY Leadership (30 points)
  if (bankNiftyLeadership.is_leading) {
    score += 30;
  } else if (bankNiftyLeadership.leadership_type === 'lagging') {
    score -= 15;
  }
  
  // 2. Top Stock Contribution (25 points)
  if (topStockContribution.contribution_quality === 'strong') {
    score += 25;
  } else if (topStockContribution.contribution_quality === 'weak') {
    score -= 10;
  }
  
  // 3. Sector Strength (25 points)
  if (sectorStrength.strongest_sector && sectorStrength.strongest_sector.avg_change > 1) {
    score += 25;
  } else if (sectorStrength.weakest_sector && sectorStrength.weakest_sector.avg_change < -1) {
    score -= 25;
  }
  
  // 4. Rotation Pattern (20 points)
  if (rotationPattern.pattern === 'broad_strength') {
    score += 20;
  } else if (rotationPattern.pattern === 'broad_weakness') {
    score -= 20;
  } else if (rotationPattern.pattern === 'banking_leadership') {
    score += 15;
  } else if (rotationPattern.pattern === 'defensive_rotation') {
    score -= 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determine rotation quality
 */
function determineRotationQuality(rotationScore) {
  if (rotationScore >= 80) return 'excellent';
  if (rotationScore >= 65) return 'good';
  if (rotationScore >= 50) return 'fair';
  if (rotationScore >= 35) return 'poor';
  return 'critical';
}

/**
 * Get trading implications
 */
function getTradingImplication(bankNiftyLeadership, rotationPattern) {
  if (rotationPattern.pattern === 'banking_leadership') {
    return 'Banking leading higher - strong risk-on sentiment, favor longs';
  }
  
  if (rotationPattern.pattern === 'banking_weakness') {
    return 'Banking leading lower - risk-off sentiment, favor shorts or avoid';
  }
  
  if (rotationPattern.pattern === 'it_leadership') {
    return 'IT sector strength - defensive rotation or export optimism';
  }
  
  if (rotationPattern.pattern === 'defensive_rotation') {
    return 'Defensive rotation (FMCG) - risk-off, reduce exposure';
  }
  
  if (rotationPattern.pattern === 'broad_strength') {
    return 'Broad market strength - all sectors participating, high conviction longs';
  }
  
  if (rotationPattern.pattern === 'broad_weakness') {
    return 'Broad market weakness - all sectors declining, avoid longs';
  }
  
  return 'Mixed sector rotation - trade with caution';
}

/**
 * Calculate sector rotation score for master algorithm (0-100)
 */
function calculateSectorRotationScoreForMaster(rotationData, direction) {
  if (!rotationData) return 50; // Neutral
  
  let score = rotationData.rotation_score; // Start with base score
  
  // 1. BankNIFTY leadership alignment (25 points)
  if (direction === 'bullish') {
    if (rotationData.banknifty_leadership.leadership_type === 'bullish_leader') {
      score += 25;
    } else if (rotationData.banknifty_leadership.leadership_type === 'bearish_leader') {
      score -= 20;
    }
  } else if (direction === 'bearish') {
    if (rotationData.banknifty_leadership.leadership_type === 'bearish_leader') {
      score += 25;
    } else if (rotationData.banknifty_leadership.leadership_type === 'bullish_leader') {
      score -= 20;
    }
  }
  
  // 2. Rotation pattern alignment (15 points)
  if (direction === 'bullish') {
    if (rotationData.rotation_pattern.pattern === 'broad_strength' || 
        rotationData.rotation_pattern.pattern === 'banking_leadership') {
      score += 15;
    } else if (rotationData.rotation_pattern.pattern === 'defensive_rotation' ||
               rotationData.rotation_pattern.pattern === 'broad_weakness') {
      score -= 15;
    }
  } else if (direction === 'bearish') {
    if (rotationData.rotation_pattern.pattern === 'broad_weakness' ||
        rotationData.rotation_pattern.pattern === 'banking_weakness') {
      score += 15;
    } else if (rotationData.rotation_pattern.pattern === 'broad_strength') {
      score -= 15;
    }
  }
  
  // 3. Top stock contribution (10 points)
  if (rotationData.top_stock_contribution.contribution_quality === 'strong') {
    score += 10;
  }
  
  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  analyzeSectorRotation,
  calculateSectorRotationScoreForMaster
};
