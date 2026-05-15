/**
 * Dhan WebSocket Feed Service
 * Reverse engineered from bundle2.1.64.js
 * 
 * This service connects to Dhan's native WebSocket feed and decodes binary messages
 */

const WebSocket = require('ws');
const logger = require('../utils/logger');

class DhanWebSocketFeedService {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.subscriptions = new Map(); // securityId -> callbacks
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.heartbeatInterval = null;
    this.messageHandlers = new Map();
  }

  /**
   * Connect to Dhan WebSocket
   * URL pattern from bundle: wss://price-feed-tv.dhan.co/?src=T&id={timestamp}
   */
  connect() {
    return new Promise((resolve, reject) => {
      try {
        const timestamp = Date.now();
        const wsUrl = `wss://price-feed-tv.dhan.co/?src=T&id=${timestamp}`;
        
        logger.info({ url: wsUrl }, 'Connecting to Dhan native WebSocket');
        
        this.ws = new WebSocket(wsUrl, {
          headers: {
            'Origin': 'https://tv.dhan.co',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        });
        
        // IMPORTANT: Set binary type to arraybuffer (from bundle)
        this.ws.binaryType = 'arraybuffer';
        
        this.ws.on('open', () => {
          logger.info('Connected to Dhan native WebSocket');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startHeartbeat();
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
          this.stopHeartbeat();
          this.attemptReconnect();
        });
        
      } catch (error) {
        logger.error({ error: error.message }, 'Failed to connect to Dhan WebSocket');
        reject(error);
      }
    });
  }

  /**
   * Handle incoming binary messages
   * Based on bundle analysis, messages are in binary format
   */
  handleMessage(data) {
    try {
      if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        // Log raw message for analysis
        logger.debug({ 
          length: buffer.length,
          hex: buffer.toString('hex').substring(0, 40) + '...',
          fullHex: buffer.length <= 50 ? buffer.toString('hex') : undefined,
          first10Bytes: Array.from(buffer.slice(0, Math.min(10, buffer.length))),
          allBytes: buffer.length <= 50 ? Array.from(buffer) : undefined
        }, 'Received binary message from Dhan');
        
        // Decode the message
        const decoded = this.decodeBinaryMessage(buffer);
        
        if (decoded) {
          logger.info({ decoded }, 'Decoded Dhan message');
          this.distributeMessage(decoded);
        }
      } else {
        // Text message (JSON)
        const message = JSON.parse(data.toString());
        logger.info({ message }, 'Received text message from Dhan');
        
        // Handle subscription acknowledgment
        if (message.type === 'subscribed' || message.status === 'subscribed') {
          logger.info({ message }, 'Subscription acknowledged by server');
        }
      }
    } catch (error) {
      logger.error({ error: error.message, data: data.toString() }, 'Error handling Dhan message');
    }
  }

  /**
   * Decode binary message
   * 
   * Based on bundle analysis, the binary format appears to be:
   * - First byte: Message type
   * - Remaining bytes: Payload (varies by type)
   * 
   * Common message types observed:
   * - 0x20 (32): Heartbeat/ping
   * - 0x01: Tick data
   * - 0x02: Depth data
   * - 0x03: Trade data
   */
  decodeBinaryMessage(buffer) {
    if (buffer.length === 0) return null;
    
    const messageType = buffer[0];
    
    // Heartbeat message (single byte 0x20)
    if (messageType === 0x20 && buffer.length === 1) {
      return { type: 'heartbeat' };
    }
    
    // Tick data message
    if (messageType === 0x01) {
      return this.decodeTickData(buffer);
    }
    
    // Depth data message
    if (messageType === 0x02) {
      return this.decodeDepthData(buffer);
    }
    
    // Trade data message
    if (messageType === 0x03) {
      return this.decodeTradeData(buffer);
    }
    
    // Unknown message type - log for analysis
    logger.warn({ 
      messageType: messageType.toString(16),
      length: buffer.length,
      hex: buffer.toString('hex')
    }, 'Unknown message type');
    
    return null;
  }

  /**
   * Decode tick data (price updates)
   * 
   * Estimated format based on typical market data:
   * Byte 0: Message type (0x01)
   * Bytes 1-4: Security ID (uint32)
   * Bytes 5-8: Last traded price (float32)
   * Bytes 9-12: Volume (uint32)
   * Bytes 13-16: Open (float32)
   * Bytes 17-20: High (float32)
   * Bytes 21-24: Low (float32)
   * Bytes 25-28: Close (float32)
   * Bytes 29-32: Timestamp (uint32)
   */
  decodeTickData(buffer) {
    try {
      if (buffer.length < 33) {
        logger.warn({ length: buffer.length }, 'Tick data buffer too short');
        return null;
      }
      
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      
      const securityId = view.getUint32(1, true); // little-endian
      const ltp = view.getFloat32(5, true);
      const volume = view.getUint32(9, true);
      const open = view.getFloat32(13, true);
      const high = view.getFloat32(17, true);
      const low = view.getFloat32(21, true);
      const close = view.getFloat32(25, true);
      const timestamp = view.getUint32(29, true);
      
      return {
        type: 'tick',
        securityId,
        ltp,
        volume,
        open,
        high,
        low,
        close,
        timestamp,
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Error decoding tick data');
      return null;
    }
  }

  /**
   * Decode depth data (order book)
   */
  decodeDepthData(buffer) {
    // TODO: Implement based on actual message format
    logger.debug('Depth data received (not yet implemented)');
    return { type: 'depth' };
  }

  /**
   * Decode trade data
   */
  decodeTradeData(buffer) {
    // TODO: Implement based on actual message format
    logger.debug('Trade data received (not yet implemented)');
    return { type: 'trade' };
  }

  /**
   * Subscribe to security updates
   * 
   * Based on bundle analysis, subscription message formats to try:
   * Format 1: {"action": "subscribe", "symbols": [id1, id2]}
   * Format 2: {"type": "subscribe", "securityIds": [id1, id2]}
   * Format 3: {"subscribe": [id1, id2]}
   * Format 4: Binary subscription message
   */
  subscribe(securityIds, callback) {
    if (!Array.isArray(securityIds)) {
      securityIds = [securityIds];
    }
    
    // Convert to numbers
    securityIds = securityIds.map(id => parseInt(id, 10));
    
    // Store callbacks
    securityIds.forEach(securityId => {
      if (!this.subscriptions.has(securityId)) {
        this.subscriptions.set(securityId, []);
      }
      this.subscriptions.get(securityId).push(callback);
    });
    
    // Send subscription message
    if (this.isConnected) {
      // Try multiple formats to find the correct one
      
      // Format 1: Standard action-based
      const message1 = {
        action: 'subscribe',
        symbols: securityIds,
      };
      
      // Format 2: Type-based
      const message2 = {
        type: 'subscribe',
        securityIds: securityIds,
      };
      
      // Format 3: Simple array
      const message3 = {
        subscribe: securityIds,
      };
      
      // Format 4: TradingView style
      const message4 = {
        type: 'subscribe',
        channel: 'ticker',
        symbols: securityIds,
      };
      
      logger.info({ securityIds, formats: 4 }, 'Subscribing to securities (trying multiple formats)');
      
      // Send all formats - server will ignore invalid ones
      try {
        this.ws.send(JSON.stringify(message1));
        logger.debug({ message: message1 }, 'Sent subscription format 1');
      } catch (e) {
        logger.error({ error: e.message }, 'Failed to send format 1');
      }
      
      setTimeout(() => {
        try {
          this.ws.send(JSON.stringify(message2));
          logger.debug({ message: message2 }, 'Sent subscription format 2');
        } catch (e) {
          logger.error({ error: e.message }, 'Failed to send format 2');
        }
      }, 100);
      
      setTimeout(() => {
        try {
          this.ws.send(JSON.stringify(message3));
          logger.debug({ message: message3 }, 'Sent subscription format 3');
        } catch (e) {
          logger.error({ error: e.message }, 'Failed to send format 3');
        }
      }, 200);
      
      setTimeout(() => {
        try {
          this.ws.send(JSON.stringify(message4));
          logger.debug({ message: message4 }, 'Sent subscription format 4');
        } catch (e) {
          logger.error({ error: e.message }, 'Failed to send format 4');
        }
      }, 300);
    } else {
      logger.warn('Cannot subscribe - WebSocket not connected');
    }
  }

  /**
   * Unsubscribe from security updates
   */
  unsubscribe(securityIds, callback) {
    if (!Array.isArray(securityIds)) {
      securityIds = [securityIds];
    }
    
    securityIds.forEach(securityId => {
      if (callback) {
        // Remove specific callback
        const callbacks = this.subscriptions.get(securityId);
        if (callbacks) {
          const index = callbacks.indexOf(callback);
          if (index > -1) {
            callbacks.splice(index, 1);
          }
          if (callbacks.length === 0) {
            this.subscriptions.delete(securityId);
          }
        }
      } else {
        // Remove all callbacks for this security
        this.subscriptions.delete(securityId);
      }
    });
    
    if (this.isConnected) {
      const message = {
        action: 'unsubscribe',
        symbols: securityIds,
      };
      
      logger.info({ securityIds }, 'Unsubscribing from securities');
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Distribute decoded message to subscribers
   */
  distributeMessage(message) {
    if (message.type === 'heartbeat') {
      // Respond to heartbeat
      if (this.isConnected) {
        this.ws.send(Buffer.from([0x20]));
      }
      return;
    }
    
    if (message.type === 'tick' && message.securityId) {
      const callbacks = this.subscriptions.get(message.securityId);
      if (callbacks) {
        callbacks.forEach(callback => {
          try {
            callback(message);
          } catch (error) {
            logger.error({ error: error.message }, 'Error in subscription callback');
          }
        });
      }
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        // Send heartbeat (0x20)
        this.ws.send(Buffer.from([0x20]));
        logger.debug('Sent heartbeat to Dhan');
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Attempt to reconnect
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
      this.connect().catch(error => {
        logger.error({ error: error.message }, 'Reconnect failed');
      });
    }, delay);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    this.subscriptions.clear();
    
    logger.info('Disconnected from Dhan WebSocket');
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      isConnected: this.isConnected,
      subscriptions: this.subscriptions.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// Singleton instance
const dhanWebSocketFeedService = new DhanWebSocketFeedService();

module.exports = dhanWebSocketFeedService;
