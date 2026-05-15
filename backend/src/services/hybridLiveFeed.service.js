/**
 * Hybrid Live Feed Service
 * 
 * Uses WebSocket for index data (NIFTY, BANK NIFTY, etc.)
 * Falls back to polling for options contracts
 */

const dhanWebSocketFeedService = require('./dhanWebSocketFeed.service');
const dhanLiveFeedPollingService = require('./dhanLiveFeedPolling.service');
const logger = require('../utils/logger');

class HybridLiveFeedService {
  constructor() {
    this.websocketConnected = false;
    this.initializationAttempted = false;
    this.websocketSecurities = new Set([13, 25, 51]); // NIFTY, BANK NIFTY, SENSEX
    this.subscriptions = new Map(); // Track all subscriptions
  }

  /**
   * Initialize the service
   */
  async initialize() {
    // Only try to connect WebSocket once
    if (this.initializationAttempted) {
      return;
    }
    
    this.initializationAttempted = true;
    
    try {
      // Try to connect WebSocket
      await dhanWebSocketFeedService.connect();
      this.websocketConnected = true;
      logger.info('Hybrid service: WebSocket connected');
    } catch (error) {
      logger.warn({ error: error.message }, 'Hybrid service: WebSocket failed, using polling only');
      this.websocketConnected = false;
    }
  }

  /**
   * Determine if security should use WebSocket or polling
   */
  shouldUseWebSocket(securityId) {
    const id = parseInt(securityId, 10);
    
    // Use WebSocket for known index securities
    if (this.websocketSecurities.has(id)) {
      return this.websocketConnected;
    }
    
    // Use WebSocket for securities < 100 (likely indices)
    if (id < 100) {
      return this.websocketConnected;
    }
    
    // Use polling for everything else (options, futures, stocks)
    return false;
  }

  /**
   * Subscribe to live feed
   * Automatically routes to WebSocket or polling based on security type
   */
  subscribe(securityIds, exchangeSegment, interval, callback, authKey, exchange, segment, instrument) {
    if (!Array.isArray(securityIds)) {
      securityIds = [securityIds];
    }

    const websocketIds = [];
    const pollingIds = [];

    // Route securities to appropriate service
    securityIds.forEach(id => {
      if (this.shouldUseWebSocket(id)) {
        websocketIds.push(id);
      } else {
        pollingIds.push(id);
      }
    });

    logger.info({ 
      websocketIds, 
      pollingIds,
      total: securityIds.length,
      websocketConnected: this.websocketConnected
    }, '🔀 Hybrid service: Routing subscriptions');

    // Subscribe via WebSocket
    if (websocketIds.length > 0 && this.websocketConnected) {
      try {
        dhanWebSocketFeedService.subscribe(websocketIds, (tick) => {
          // Transform WebSocket tick to match polling format
          const transformedData = {
            securityId: tick.securityId,
            candle: {
              time: tick.timestamp * 1000,
              open: tick.open,
              high: tick.high,
              low: tick.low,
              close: tick.ltp,
              volume: tick.volume,
            },
          };
          callback(transformedData);
        });
        
        logger.info({ websocketIds }, '⚡ Subscribed via WebSocket (real-time)');
      } catch (error) {
        logger.error({ error: error.message }, 'WebSocket subscription failed, falling back to polling');
        // Fallback to polling
        pollingIds.push(...websocketIds);
      }
    } else if (websocketIds.length > 0 && !this.websocketConnected) {
      logger.warn({ websocketIds }, '⚠️  WebSocket not connected, routing to polling');
      pollingIds.push(...websocketIds);
    }

    // Subscribe via polling
    if (pollingIds.length > 0) {
      dhanLiveFeedPollingService.subscribe(
        pollingIds,
        exchangeSegment,
        interval,
        callback,
        authKey,
        exchange,
        segment,
        instrument
      );
      
      logger.info({ pollingIds }, '🔄 Subscribed via polling (2s interval)');
    }

    // Track subscription
    const key = `${securityIds.join(',')}_${exchangeSegment}_${interval}`;
    this.subscriptions.set(key, {
      securityIds,
      websocketIds,
      pollingIds,
      callback,
      exchangeSegment,
      interval,
      authKey,
      exchange,
      segment,
      instrument,
    });
  }

  /**
   * Unsubscribe from live feed
   */
  unsubscribe(securityIds, exchangeSegment, callback) {
    if (!Array.isArray(securityIds)) {
      securityIds = [securityIds];
    }

    const websocketIds = [];
    const pollingIds = [];

    securityIds.forEach(id => {
      if (this.shouldUseWebSocket(id)) {
        websocketIds.push(id);
      } else {
        pollingIds.push(id);
      }
    });

    // Unsubscribe from WebSocket
    if (websocketIds.length > 0 && this.websocketConnected) {
      dhanWebSocketFeedService.unsubscribe(websocketIds, callback);
      logger.info({ websocketIds }, 'Unsubscribed from WebSocket');
    }

    // Unsubscribe from polling
    if (pollingIds.length > 0) {
      dhanLiveFeedPollingService.unsubscribe(pollingIds, exchangeSegment, callback);
      logger.info({ pollingIds }, 'Unsubscribed from polling');
    }

    // Remove from tracking
    const key = `${securityIds.join(',')}_${exchangeSegment}`;
    this.subscriptions.delete(key);
  }

  /**
   * Get service status
   */
  getStatus() {
    const status = {
      websocketConnected: this.websocketConnected,
      websocketStatus: this.websocketConnected ? dhanWebSocketFeedService.getStatus() : null,
      subscriptions: this.subscriptions.size,
      websocketSecurities: Array.from(this.websocketSecurities),
    };
    
    // Count polling subscriptions
    let pollingCount = 0;
    this.subscriptions.forEach(sub => {
      pollingCount += sub.pollingIds ? sub.pollingIds.length : 0;
    });
    status.pollingSubscriptions = pollingCount;
    
    return status;
  }

  /**
   * Disconnect all services
   */
  disconnect() {
    if (this.websocketConnected) {
      dhanWebSocketFeedService.disconnect();
    }
    // Polling service doesn't need explicit disconnect
    this.subscriptions.clear();
    logger.info('Hybrid service: Disconnected');
  }
}

// Singleton instance
const hybridLiveFeedService = new HybridLiveFeedService();

module.exports = hybridLiveFeedService;
