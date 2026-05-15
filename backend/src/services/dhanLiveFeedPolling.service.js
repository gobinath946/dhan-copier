/**
 * Dhan Live Feed Polling Service
 * Alternative approach: Poll Dhan Bypass API for latest data
 * This is more reliable for options data
 */
const logger = require('../utils/logger');
const dhanBypassService = require('./dhanBypass.service');

class DhanLiveFeedPollingService {
  constructor() {
    this.subscribers = new Map(); // Map of securityId -> { callbacks, config }
    this.pollingIntervals = new Map(); // Map of securityId -> interval ID
    this.pollingRate = 2000; // Poll every 2 seconds for more responsive updates
    this.lastCandleCache = new Map(); // Cache last candle to detect changes
  }

  /**
   * Start polling for a security
   */
  startPolling(securityId, exchangeSegment, interval = '1m', authKey, exchange, segment, instrument) {
    const key = `${securityId}_${exchangeSegment}`;
    
    if (this.pollingIntervals.has(key)) {
      logger.info({ securityId, exchangeSegment }, 'Already polling for this security');
      return true;
    }

    logger.info({ securityId, exchangeSegment, interval }, 'Starting live feed polling');

    // Initial fetch
    this.fetchLatestData(securityId, exchangeSegment, interval, authKey, exchange, segment, instrument);

    // Set up polling interval
    const intervalId = setInterval(() => {
      this.fetchLatestData(securityId, exchangeSegment, interval, authKey, exchange, segment, instrument);
    }, this.pollingRate);

    this.pollingIntervals.set(key, intervalId);
    return true;
  }

  /**
   * Stop polling for a security
   */
  stopPolling(securityId, exchangeSegment) {
    const key = `${securityId}_${exchangeSegment}`;
    
    if (this.pollingIntervals.has(key)) {
      clearInterval(this.pollingIntervals.get(key));
      this.pollingIntervals.delete(key);
      logger.info({ securityId, exchangeSegment }, 'Stopped live feed polling');
      return true;
    }
    
    return false;
  }

  /**
   * Fetch latest data from Dhan Bypass API
   */
  async fetchLatestData(securityId, exchangeSegment, interval, authKey, exchange, segment, instrument) {
    try {
      if (!authKey) {
        logger.warn({ securityId }, 'No auth key for live feed polling');
        return;
      }

      // Calculate time range - get last 2 candles to detect updates
      const now = Date.now();
      const endTime = Math.floor(now / 1000);
      
      // Calculate start time based on interval to get last 2-3 candles
      const intervalSeconds = {
        '1m': 60,
        '5m': 300,
        '15m': 900,
        '30m': 1800,
        '1h': 3600,
        '1d': 86400,
      };
      
      const secondsPerCandle = intervalSeconds[interval] || 300;
      const startTime = endTime - (secondsPerCandle * 3); // Get last 3 candles

      // Map interval to Dhan Bypass format
      const intervalMap = {
        '1m': '1',
        '5m': '5',
        '15m': '15',
        '30m': '30',
        '1h': '60',
        '1d': '1D',
      };
      
      const bypassInterval = intervalMap[interval] || '5';

      // Fetch from Dhan Bypass
      const result = await dhanBypassService.getDhanBypassData(authKey, {
        securityId: securityId,
        exchange: exchange || 'NSE',
        segment: segment || 'D',
        instrument: instrument || 'OPTIDX',
        startTime: startTime,
        endTime: endTime,
        interval: bypassInterval,
      });

      if (result.ok && result.data.candles.length > 0) {
        const latestCandle = result.data.candles[result.data.candles.length - 1];
        const key = `${securityId}_${exchangeSegment}`;
        
        // Check if this candle is different from the last one we sent
        const lastCandle = this.lastCandleCache.get(key);
        const candleChanged = !lastCandle || 
          lastCandle.time !== latestCandle.time ||
          lastCandle.close !== latestCandle.close ||
          lastCandle.high !== latestCandle.high ||
          lastCandle.low !== latestCandle.low ||
          lastCandle.volume !== latestCandle.volume;
        
        if (candleChanged) {
          logger.info({ 
            securityId, 
            candle: latestCandle,
            candleCount: result.data.candles.length,
            isNew: !lastCandle || lastCandle.time !== latestCandle.time,
            isUpdate: lastCandle && lastCandle.time === latestCandle.time
          }, 'Live feed candle update');

          // Cache this candle
          this.lastCandleCache.set(key, latestCandle);

          // Notify subscribers with the latest candle
          if (this.subscribers.has(key)) {
            const { callbacks } = this.subscribers.get(key);
            callbacks.forEach(callback => {
              try {
                callback({
                  type: 'candleUpdate',
                  securityId,
                  exchangeSegment,
                  candle: latestCandle,
                  timestamp: Date.now(),
                });
              } catch (err) {
                logger.error({ error: err.message }, 'Error in subscriber callback');
              }
            });
          }
        }
      }
    } catch (error) {
      logger.error({ 
        error: error.message, 
        securityId, 
        exchangeSegment 
      }, 'Failed to fetch latest data from Dhan Bypass');
    }
  }

  /**
   * Subscribe to live updates for a security
   */
  subscribe(securityIds, exchangeSegment, interval, callback, authKey, exchange, segment, instrument) {
    securityIds.forEach(securityId => {
      const key = `${securityId}_${exchangeSegment}`;
      
      if (!this.subscribers.has(key)) {
        this.subscribers.set(key, {
          callbacks: new Set(),
          config: { exchangeSegment, interval, authKey, exchange, segment, instrument },
        });
      }
      
      this.subscribers.get(key).callbacks.add(callback);
      
      // Start polling if not already started
      this.startPolling(securityId, exchangeSegment, interval, authKey, exchange, segment, instrument);
    });
  }

  /**
   * Unsubscribe from live updates
   */
  unsubscribe(securityIds, exchangeSegment, callback) {
    securityIds.forEach(securityId => {
      const key = `${securityId}_${exchangeSegment}`;
      
      if (this.subscribers.has(key)) {
        this.subscribers.get(key).callbacks.delete(callback);
        
        // If no more subscribers, stop polling
        if (this.subscribers.get(key).callbacks.size === 0) {
          this.subscribers.delete(key);
          this.stopPolling(securityId, exchangeSegment);
        }
      }
    });
  }

  /**
   * Clean up all polling
   */
  cleanup() {
    this.pollingIntervals.forEach((intervalId) => {
      clearInterval(intervalId);
    });
    this.pollingIntervals.clear();
    this.subscribers.clear();
    this.lastCandleCache.clear();
    logger.info('Cleaned up all live feed polling');
  }
}

// Singleton instance
const dhanLiveFeedPollingService = new DhanLiveFeedPollingService();

module.exports = dhanLiveFeedPollingService;
