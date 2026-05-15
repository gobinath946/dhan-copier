/**
 * Price Feed Service
 * 
 * Provides real-time price updates for active positions.
 * Integrates with existing hybridLiveFeed service for market data.
 * Implements in-memory caching with TTL for price optimization.
 */

const hybridLiveFeedService = require('./hybridLiveFeed.service');
const dhanService = require('./dhan.service');
const logger = require('../utils/logger');

class PriceFeedService {
  constructor() {
    this.priceCache = new Map(); // securityId -> { price, timestamp }
    this.subscriptions = new Map(); // securityId -> { callbacks: Set, exchangeSegment }
    this.cacheTTL = 1000; // 1 second TTL
    this.initialized = false;
  }

  /**
   * Initialize the service
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      await hybridLiveFeedService.initialize();
      this.initialized = true;
      logger.info('Price feed service initialized');
    } catch (error) {
      logger.warn({ error: error.message }, 'Price feed service initialization failed, will use direct API calls');
      this.initialized = false;
    }
  }

  /**
   * Subscribe to price updates for a security
   * @param {string} securityId - Dhan security identifier
   * @param {string} exchangeSegment - Exchange segment (e.g., NSE_FNO)
   * @param {Function} callback - Callback function to receive price updates
   */
  subscribe(securityId, exchangeSegment, callback) {
    try {
      if (!this.initialized) {
        logger.warn('Price feed service not initialized, attempting to initialize');
        this.initialize().catch(err => {
          logger.error({ error: err.message }, 'Failed to initialize price feed service');
        });
      }

      // Track subscription
      if (!this.subscriptions.has(securityId)) {
        this.subscriptions.set(securityId, {
          callbacks: new Set(),
          exchangeSegment,
        });
      }

      const subscription = this.subscriptions.get(securityId);
      subscription.callbacks.add(callback);

      // Subscribe to hybrid live feed
      if (this.initialized) {
        hybridLiveFeedService.subscribe(
          [securityId],
          exchangeSegment,
          1000, // 1 second interval
          (data) => {
            // Update cache
            const price = data.candle?.close || data.ltp || null;
            if (price) {
              this.priceCache.set(securityId, {
                price,
                timestamp: Date.now(),
              });

              // Notify all callbacks for this security
              const sub = this.subscriptions.get(securityId);
              if (sub) {
                sub.callbacks.forEach(cb => {
                  try {
                    cb(price);
                  } catch (error) {
                    logger.error({ error: error.message }, 'Price callback error');
                  }
                });
              }
            }
          },
          null, // authKey - not needed for public data
          null, // exchange
          null, // segment
          null  // instrument
        );

        logger.info({ securityId, exchangeSegment }, 'Subscribed to price feed');
      }

    } catch (error) {
      logger.error({ 
        error: error.message, 
        securityId, 
        exchangeSegment 
      }, 'Price feed subscription error');
    }
  }

  /**
   * Unsubscribe from price updates
   * @param {string} securityId - Dhan security identifier
   * @param {Function} callback - Callback function to remove
   */
  unsubscribe(securityId, callback) {
    try {
      const subscription = this.subscriptions.get(securityId);
      if (!subscription) {
        return;
      }

      if (callback) {
        subscription.callbacks.delete(callback);
      }

      // If no more callbacks, unsubscribe from hybrid feed
      if (subscription.callbacks.size === 0) {
        if (this.initialized) {
          hybridLiveFeedService.unsubscribe(
            [securityId],
            subscription.exchangeSegment,
            null
          );
        }
        this.subscriptions.delete(securityId);
        this.priceCache.delete(securityId);
        
        logger.info({ securityId }, 'Unsubscribed from price feed');
      }

    } catch (error) {
      logger.error({ 
        error: error.message, 
        securityId 
      }, 'Price feed unsubscribe error');
    }
  }

  /**
   * Get current price for a security
   * @param {string} securityId - Dhan security identifier
   * @param {string} exchangeSegment - Exchange segment (e.g., NSE_FNO)
   * @param {Object} account - Account object with clientId and accessToken (optional)
   * @returns {Promise<number | null>} Current LTP (Last Traded Price)
   */
  async getCurrentPrice(securityId, exchangeSegment, account = null) {
    try {
      // Check cache first
      const cached = this.priceCache.get(securityId);
      if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
        logger.debug({ securityId, price: cached.price }, 'Price from cache');
        return cached.price;
      }

      // If no account provided, cannot fetch from API
      if (!account) {
        logger.warn({ securityId }, 'No cached price and no account provided for API call');
        return null;
      }

      // Fetch from Dhan API
      const result = await dhanService.getLtp(account, {
        exchangeSegment,
        securityId,
      });

      if (result.ok && result.data) {
        // Extract LTP from response
        // Dhan API returns: { data: { [exchangeSegment]: [{ security_id, LTP, ... }] } }
        const segmentData = result.data[exchangeSegment];
        if (segmentData && segmentData.length > 0) {
          const securityData = segmentData.find(
            s => s.security_id === parseInt(securityId, 10)
          );
          if (securityData && securityData.LTP) {
            const price = securityData.LTP;
            
            // Update cache
            this.priceCache.set(securityId, {
              price,
              timestamp: Date.now(),
            });

            logger.debug({ securityId, price }, 'Price from API');
            return price;
          }
        }
      }

      logger.warn({ 
        securityId, 
        exchangeSegment,
        result: result.error 
      }, 'Failed to fetch current price');
      
      return null;

    } catch (error) {
      logger.error({ 
        error: error.message, 
        securityId 
      }, 'Get current price error');
      
      return null;
    }
  }

  /**
   * Get current prices for multiple securities
   * @param {Array<{securityId: string, exchangeSegment: string}>} securities - Array of securities
   * @param {Object} account - Account object with clientId and accessToken
   * @returns {Promise<Map<string, number>>} Map of securityId to current price
   */
  async getBatchPrices(securities, account) {
    try {
      const priceMap = new Map();
      const uncachedSecurities = [];

      // Check cache for each security
      securities.forEach(({ securityId, exchangeSegment }) => {
        const cached = this.priceCache.get(securityId);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
          priceMap.set(securityId, cached.price);
        } else {
          uncachedSecurities.push({ securityId, exchangeSegment });
        }
      });

      // If all prices are cached, return immediately
      if (uncachedSecurities.length === 0) {
        logger.debug({ count: securities.length }, 'All prices from cache');
        return priceMap;
      }

      // Group uncached securities by exchange segment
      const bySegment = new Map();
      uncachedSecurities.forEach(({ securityId, exchangeSegment }) => {
        if (!bySegment.has(exchangeSegment)) {
          bySegment.set(exchangeSegment, []);
        }
        bySegment.get(exchangeSegment).push(securityId);
      });

      // Fetch prices for each segment
      const fetchPromises = Array.from(bySegment.entries()).map(
        async ([exchangeSegment, securityIds]) => {
          try {
            // Build payload for Dhan API
            const payload = {
              [exchangeSegment]: securityIds.map(id => parseInt(id, 10)),
            };

            // Use quote endpoint for batch requests
            const result = await dhanService.getQuote(account, {
              exchangeSegment,
              securityId: securityIds[0], // Not used in batch, but required by interface
            });

            if (result.ok && result.data) {
              const segmentData = result.data[exchangeSegment];
              if (segmentData && Array.isArray(segmentData)) {
                segmentData.forEach(securityData => {
                  const securityId = securityData.security_id?.toString();
                  const price = securityData.LTP;
                  
                  if (securityId && price) {
                    priceMap.set(securityId, price);
                    
                    // Update cache
                    this.priceCache.set(securityId, {
                      price,
                      timestamp: Date.now(),
                    });
                  }
                });
              }
            }
          } catch (error) {
            logger.error({ 
              error: error.message, 
              exchangeSegment 
            }, 'Batch price fetch error for segment');
          }
        }
      );

      await Promise.allSettled(fetchPromises);

      logger.debug({ 
        total: securities.length,
        cached: securities.length - uncachedSecurities.length,
        fetched: priceMap.size - (securities.length - uncachedSecurities.length)
      }, 'Batch prices retrieved');

      return priceMap;

    } catch (error) {
      logger.error({ 
        error: error.message, 
        count: securities.length 
      }, 'Batch prices error');
      
      return new Map();
    }
  }

  /**
   * Clear price cache
   */
  clearCache() {
    this.priceCache.clear();
    logger.info('Price cache cleared');
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      subscriptions: this.subscriptions.size,
      cachedPrices: this.priceCache.size,
      cacheTTL: this.cacheTTL,
    };
  }
}

// Singleton instance
const priceFeedService = new PriceFeedService();

module.exports = priceFeedService;
