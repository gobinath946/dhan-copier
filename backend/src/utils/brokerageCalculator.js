/**
 * Brokerage Calculator for Dhan — NIFTY 50 Options
 *
 * Dhan charges a flat ₹40 per round-trip trade (buy + sell) for NIFTY options.
 * This is the actual amount deducted regardless of premium or quantity.
 *
 * All functions return a consistent shape so callers don't need to change.
 */

const FLAT_BROKERAGE = 40; // ₹40 per round-trip trade (Dhan NIFTY options)

/**
 * Calculate brokerage for a NIFTY options round-trip trade.
 * Always returns ₹40 total charges.
 *
 * @param {number} entryPrice  - Entry premium (used for grossPnL / breakeven)
 * @param {number} exitPrice   - Exit premium
 * @param {number} quantity    - Total quantity (e.g. 130 for 2 lots)
 * @param {string} tradeType   - 'BUY_CE' or 'BUY_PE' (kept for API compatibility)
 * @returns {Object} Charges breakdown
 */
function calculateBrokerage(entryPrice, exitPrice, quantity, tradeType = 'BUY_CE') {
  const totalCharges = FLAT_BROKERAGE;

  const grossPnL = (exitPrice - entryPrice) * quantity;
  const netPnL   = grossPnL - totalCharges;

  // Breakeven: how many points needed to cover ₹40 brokerage
  const breakEvenPoints = quantity > 0 ? totalCharges / quantity : 0;

  return {
    // Flat brokerage breakdown (all other charges rolled into the ₹40 flat)
    brokerage:       FLAT_BROKERAGE,
    stt:             0,
    exchangeCharges: 0,
    gst:             0,
    sebiCharges:     0,
    stampDuty:       0,
    totalCharges:    FLAT_BROKERAGE,

    // P&L
    grossPnL:            Number(grossPnL.toFixed(2)),
    netPnL:              Number(netPnL.toFixed(2)),
    chargesPercentage:   grossPnL !== 0
      ? Number(((totalCharges / Math.abs(grossPnL)) * 100).toFixed(2))
      : 0,

    // Breakeven
    breakEvenBuy:  Number((entryPrice + breakEvenPoints).toFixed(2)),
    breakEvenSell: Number((entryPrice - breakEvenPoints).toFixed(2)),

    // Per-point cost (how many points needed to cover brokerage)
    costPerPoint: Number(breakEvenPoints.toFixed(4)),
  };
}

/**
 * Minimum points required to break even after ₹40 brokerage.
 * @param {number} entryPrice - Entry premium (unused, kept for API compat)
 * @param {number} quantity   - Total quantity
 * @returns {number} Points required
 */
function calculateMinPointsForBreakeven(entryPrice, quantity) {
  if (!quantity || quantity <= 0) return 0;
  return Number((FLAT_BROKERAGE / quantity).toFixed(4));
}

/**
 * Check if a trade meets the minimum points requirement after brokerage.
 * @param {number} entryPrice       - Entry premium
 * @param {number} targetPrice      - Target premium
 * @param {number} quantity         - Total quantity
 * @param {number} minPointsRequired - Minimum net points setting
 * @returns {Object} Check result
 */
function checkMinPointsRequirement(entryPrice, targetPrice, quantity, minPointsRequired) {
  const potentialPoints = targetPrice - entryPrice;
  const breakEvenPoints = calculateMinPointsForBreakeven(entryPrice, quantity);
  const netPoints       = potentialPoints - breakEvenPoints;
  const meetsRequirement = netPoints >= minPointsRequired;

  return {
    potentialPoints:  Number(potentialPoints.toFixed(2)),
    breakEvenPoints,
    netPoints:        Number(netPoints.toFixed(2)),
    minPointsRequired,
    meetsRequirement,
    message: meetsRequirement
      ? `✅ Trade meets requirement: ${netPoints.toFixed(2)} pts (min: ${minPointsRequired})`
      : `❌ Trade rejected: ${netPoints.toFixed(2)} pts (min: ${minPointsRequired})`,
  };
}

module.exports = {
  calculateBrokerage,
  calculateMinPointsForBreakeven,
  checkMinPointsRequirement,
  FLAT_BROKERAGE,
};
