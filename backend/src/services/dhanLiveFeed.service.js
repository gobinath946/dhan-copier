/**
 * Dhan Live Feed WebSocket Service
 * Connects to Dhan's official WebSocket API for real-time market data
 */
const WebSocket = require('ws');
const logger = require('../utils/logger');
const env = require('../config/env');

const DHAN_ACCESS_TOKEN = env.dhanAccessToken;
// Use the TradingView feed endpoint as shown in your screenshots
const DHAN_WS_URL = 'wss://price-feed-tv.dhan.co';

class DhanLiveFeedService {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.subscribers = new Map(); // Map of securityId -> Set of callback functions
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.pendingSubscriptions = []; // Store subscriptions to retry after reconnect
  }

  /**
   * Connect to Dhan WebSocket feed
   */
  connect() {
    if (this.ws && this.isConnected) {
      logger.info('Already connected to Dhan live feed');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      try {
        logger.info({ url: DHAN_WS_URL }, 'Connecting to Dhan live feed');

        // Build WebSocket URL with query parameters (as shown in your screenshot)
        const wsUrl = `${DHAN_WS_URL}/?src=T&id=${Date.now()}`;

        this.ws = new WebSocket(wsUrl, {
          headers: {
            'Origin': 'https://tv.dhan.co',
            'User-Agent': 'Mozilla/5.0',
          },
        });

        this.ws.on('open', () => {
          logger.info('Connected to Dhan live feed');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          
          // Resubscribe to pending subscriptions
          if (this.pendingSubscriptions.length > 0) {
            logger.info({ count: this.pendingSubscriptions.length }, 'Resubscribing to instruments');
            this.pendingSubscriptions.forEach(sub => {
              this.subscribe(sub.securityIds, sub.exchangeSegment);
            });
          }
          
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error) => {
          logger.error({ error: error.message }, 'Dhan WebSocket error');
          reject(error);
        });

        this.ws.on('close', () => {
          logger.warn('Dhan WebSocket closed');
          this.isConnected = false;
          this.attemptReconnect();
        });
      } catch (error) {
        logger.error({ error: error.message }, 'Failed to connect to Dhan live feed');
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleMessage(data) {
    try {
      // Check if data is binary (protobuf/custom encoding)
      if (Buffer.isBuffer(data)) {
        // Dhan uses binary protocol - decode based on their format
        // For now, log the hex representation for debugging
        logger.debug({ 
          length: data.length,
          hex: data.toString('hex').substring(0, 100) + '...'
        }, 'Received binary message from Dhan');
        
        // TODO: Implement proper binary decoder based on Dhan's protocol
        // The binary format likely contains:
        // - Security ID
        // - LTP (Last Traded Price)
        // - Volume
        // - Timestamp
        // - Other tick data
        
        // For now, we'll parse what we can and distribute to subscribers
        this.parseBinaryMessage(data);
        return;
      }

      // Handle JSON messages (if any)
      const message = JSON.parse(data.toString());
      logger.debug({ message }, 'Received JSON message from Dhan');

      // Distribute to subscribers based on security ID
      if (message.securityId && this.subscribers.has(message.securityId)) {
        const callbacks = this.subscribers.get(message.securityId);
        callbacks.forEach(callback => {
          try {
            callback(message);
          } catch (err) {
            logger.error({ error: err.message }, 'Error in subscriber callback');
          }
        });
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Parse binary message from Dhan WebSocket
   * This is a basic implementation - you'll need to adjust based on actual protocol
   */
  parseBinaryMessage(data) {
    try {
      // Log more details about the binary data for debugging
      if (data.length > 1) {
        logger.debug({ 
          length: data.length,
          hex: data.toString('hex'),
          bytes: Array.from(data).slice(0, 20)
        }, 'Parsing binary message');
      }
      
      // For heartbeat messages (single byte), just acknowledge
      if (data.length === 1) {
        return;
      }
      
      // Basic parsing - this needs to be adjusted based on Dhan's actual binary format
      // Typical tick data structure might include:
      // - Message type (1-2 bytes)
      // - Security ID (4 bytes)
      // - LTP (4-8 bytes)
      // - Volume (4-8 bytes)
      // - Timestamp (4-8 bytes)
      
      // For now, we'll create a mock tick update to demonstrate the flow
      // You'll need to reverse engineer the actual binary format
      
      const tickData = {
        type: 'tick',
        timestamp: Date.now(),
        ltp: null, // Parse from binary
        volume: null, // Parse from binary
        rawData: data.toString('hex'),
      };
      
      // Notify all subscribers that we received data
      this.subscribers.forEach((callbacks, securityId) => {
        callbacks.forEach(callback => {
          try {
            callback({
              ...tickData,
              securityId,
            });
          } catch (err) {
            logger.error({ error: err.message }, 'Error in subscriber callback');
          }
        });
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to parse binary message');
    }
  }

  /**
   * Subscribe to live feed for specific instruments
   */
  subscribe(securityIds, exchangeSegment = 'IDX_I') {
    if (!this.isConnected) {
      logger.warn('Cannot subscribe - not connected to Dhan live feed');
      // Store for later retry
      this.pendingSubscriptions.push({ securityIds, exchangeSegment });
      return false;
    }

    try {
      // Based on typical WebSocket feed protocols, send subscription message
      // This format may need adjustment based on Dhan's actual protocol
      const subscribeMessage = JSON.stringify({
        action: 'subscribe',
        instruments: securityIds.map(id => ({
          exchange: exchangeSegment,
          securityId: id.toString(),
        })),
      });

      logger.info({ securityIds, exchangeSegment }, 'Subscribing to Dhan live feed');
      this.ws.send(subscribeMessage);
      
      // Store subscription
      this.pendingSubscriptions.push({ securityIds, exchangeSegment });
      
      return true;
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to subscribe to instruments');
      return false;
    }
  }

  /**
   * Unsubscribe from live feed
   */
  unsubscribe(securityIds, exchangeSegment = 'IDX_I') {
    if (!this.isConnected) {
      return false;
    }

    try {
      const unsubscribeMessage = JSON.stringify({
        action: 'unsubscribe',
        instruments: securityIds.map(id => ({
          exchange: exchangeSegment,
          securityId: id.toString(),
        })),
      });

      logger.info({ securityIds, exchangeSegment }, 'Unsubscribing from Dhan live feed');
      this.ws.send(unsubscribeMessage);
      
      // Remove from pending subscriptions
      this.pendingSubscriptions = this.pendingSubscriptions.filter(
        sub => !sub.securityIds.some(id => securityIds.includes(id))
      );
      
      return true;
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to unsubscribe from instruments');
      return false;
    }
  }

  /**
   * Register a callback for specific security ID
   */
  addSubscriber(securityId, callback) {
    if (!this.subscribers.has(securityId)) {
      this.subscribers.set(securityId, new Set());
    }
    this.subscribers.get(securityId).add(callback);
  }

  /**
   * Remove a callback for specific security ID
   */
  removeSubscriber(securityId, callback) {
    if (this.subscribers.has(securityId)) {
      this.subscribers.get(securityId).delete(callback);
      if (this.subscribers.get(securityId).size === 0) {
        this.subscribers.delete(securityId);
      }
    }
  }

  /**
   * Attempt to reconnect to WebSocket
   */
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    logger.info({ attempt: this.reconnectAttempts, delay }, 'Attempting to reconnect');

    setTimeout(() => {
      this.connect().catch(err => {
        logger.error({ error: err.message }, 'Reconnect failed');
      });
    }, delay);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      this.subscribers.clear();
      this.pendingSubscriptions = [];
      logger.info('Disconnected from Dhan live feed');
    }
  }
}

// Singleton instance
const dhanLiveFeedService = new DhanLiveFeedService();

module.exports = dhanLiveFeedService;
