/**
 * Lot Allocation Service
 * 
 * Calculates optimal lot distribution across accounts based on capital constraints.
 * Implements the capital-based proportional allocation algorithm.
 */

const logger = require('../utils/logger');

/**
 * Allocate lots across accounts based on usable capital
 * @param {Array} accounts - Selected accounts with capital info
 * @param {number} totalLots - Total lots requested by user
 * @param {number} premium - Current option premium
 * @param {number} lotSize - Standard lot size for Nifty 50 (typically 50)
 * @returns {{ ok: boolean, data?: Map<string, number>, error?: string }}
 */
function allocateLots(accounts, totalLots, premium, lotSize) {
  try {
    // Validation
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return { ok: false, error: 'No accounts provided' };
    }
    if (totalLots <= 0) {
      return { ok: false, error: 'Total lots must be positive' };
    }
    if (premium <= 0) {
      return { ok: false, error: 'Premium must be positive' };
    }
    if (lotSize <= 0) {
      return { ok: false, error: 'Lot size must be positive' };
    }

    // Calculate cost per lot
    const costPerLot = lotSize * premium;

    // Calculate usable capital and max lots for each account
    const accountsWithCapital = accounts.map(account => {
      const usableCapital = account.capitalAmount * (account.capitalPercentage / 100);
      const maxLots = Math.floor(usableCapital / costPerLot);
      return {
        accountId: account._id.toString(),
        accountName: account.accountName,
        usableCapital,
        maxLots,
      };
    });

    // Filter accounts with sufficient capital (at least 1 lot)
    const eligibleAccounts = accountsWithCapital.filter(acc => acc.maxLots >= 1);

    if (eligibleAccounts.length === 0) {
      return { 
        ok: false, 
        error: 'Insufficient capital across all selected accounts',
        details: {
          costPerLot,
          accountsChecked: accounts.length,
        }
      };
    }

    // Calculate total usable capital across eligible accounts
    const totalUsableCapital = eligibleAccounts.reduce(
      (sum, acc) => sum + acc.usableCapital, 
      0
    );

    // Allocate lots proportionally with fractional tracking
    const allocations = eligibleAccounts.map(acc => {
      const proportionalLots = (acc.usableCapital / totalUsableCapital) * totalLots;
      return {
        accountId: acc.accountId,
        accountName: acc.accountName,
        proportionalLots,
        allocatedLots: Math.floor(proportionalLots),
        fractionalPart: proportionalLots - Math.floor(proportionalLots),
      };
    });

    // Calculate initial sum
    let allocatedSum = allocations.reduce((sum, a) => sum + a.allocatedLots, 0);

    // Distribute remainder to accounts with highest fractional parts
    const remainder = totalLots - allocatedSum;
    if (remainder > 0) {
      // Sort by fractional part descending
      const sortedByFraction = [...allocations].sort(
        (a, b) => b.fractionalPart - a.fractionalPart
      );
      
      // Add 1 lot to top accounts until remainder is distributed
      for (let i = 0; i < remainder && i < sortedByFraction.length; i++) {
        const account = sortedByFraction[i];
        const original = allocations.find(a => a.accountId === account.accountId);
        original.allocatedLots += 1;
      }
    } else if (remainder < 0) {
      // If we somehow over-allocated, remove from accounts with lowest fractional parts
      const sortedByFraction = [...allocations].sort(
        (a, b) => a.fractionalPart - b.fractionalPart
      );
      
      for (let i = 0; i < Math.abs(remainder) && i < sortedByFraction.length; i++) {
        const account = sortedByFraction[i];
        const original = allocations.find(a => a.accountId === account.accountId);
        if (original.allocatedLots > 1) {
          original.allocatedLots -= 1;
        }
      }
    }

    // Ensure each eligible account gets at least 1 lot
    allocations.forEach(allocation => {
      if (allocation.allocatedLots < 1) {
        allocation.allocatedLots = 1;
      }
    });

    // Recalculate sum after ensuring minimums
    allocatedSum = allocations.reduce((sum, a) => sum + a.allocatedLots, 0);

    // Final adjustment if sum doesn't match (within ±1 tolerance)
    const difference = totalLots - allocatedSum;
    if (Math.abs(difference) > 1) {
      logger.warn({
        totalLots,
        allocatedSum,
        difference,
        allocations: allocations.map(a => ({
          accountId: a.accountId,
          lots: a.allocatedLots
        }))
      }, 'Lot allocation sum mismatch exceeds tolerance');
    }

    // If we need to adjust, do so on the account with highest/lowest fractional part
    if (difference > 0) {
      const maxFraction = allocations.reduce((max, a) => 
        a.fractionalPart > max.fractionalPart ? a : max
      );
      maxFraction.allocatedLots += difference;
    } else if (difference < 0) {
      const minFraction = allocations.reduce((min, a) => 
        a.allocatedLots > 1 && a.fractionalPart < min.fractionalPart ? a : min
      );
      if (minFraction.allocatedLots > 1) {
        minFraction.allocatedLots += difference; // difference is negative
      }
    }

    // Create result map
    const allocationMap = new Map();
    allocations.forEach(allocation => {
      allocationMap.set(allocation.accountId, allocation.allocatedLots);
    });

    // Add zero allocations for ineligible accounts
    accountsWithCapital.forEach(acc => {
      if (acc.maxLots < 1 && !allocationMap.has(acc.accountId)) {
        allocationMap.set(acc.accountId, 0);
      }
    });

    logger.info({
      totalLots,
      eligibleAccounts: eligibleAccounts.length,
      totalAccounts: accounts.length,
      costPerLot,
      allocations: Array.from(allocationMap.entries()).map(([id, lots]) => ({
        accountId: id,
        lots
      }))
    }, 'Lot allocation completed');

    return { 
      ok: true, 
      data: allocationMap,
      summary: {
        totalLots,
        eligibleAccounts: eligibleAccounts.length,
        totalAccounts: accounts.length,
        costPerLot,
      }
    };

  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Lot allocation error');
    return { 
      ok: false, 
      error: error.message || 'Lot allocation failed' 
    };
  }
}

module.exports = {
  allocateLots,
};
