/**
 * API Rate Limiter Service
 * =========================
 * Prevents Dhan API rate limit errors (429) by:
 * 1. Throttling API calls (max N calls per minute)
 * 2. Queuing requests when limit is reached
 * 3. Caching responses to avoid duplicate calls
 * 4. Providing circuit breaker when rate limits are hit
 * 
 * Dhan API Limits (estimated):
 * - ~100 calls per minute per user
 * - Burst limit: ~20 calls per 10 seconds
 */

const logger = require('../utils/logger');

class APIRateLimiter {
  constructor() {
    // Configuration
    this.maxCallsPerMinute = 60;        // Conservative limit
    this.maxBurstCalls = 15;            // Max calls in 10 seconds
    this.burstWindowMs = 10000;         // 10 seconds
    this.cacheExpiryMs = 5000;          // Cache responses for 5 seconds
    
    // State
    this.callTimestamps = [];           // Array of timestamps
    this.burstCallTimestamps = [];      // Burst window tracking
    this.cache = new Map();             // Response cache
    this.queue = [];                    // Queued requests
    this.isProcessingQueue = false;
    this.circuitBreakerOpen = false;    // True when rate limited
    this.circuitBreakerUntil = 0;       // Timestamp when to retry
    
    // Stats
    this.stats = {
      totalCalls: 0,
      cachedResponses: 0,
      queuedCalls: 0,
      rateLimitErrors: 0,
      circuitBreakerTrips: 0,
    };
    
    // Cleanup old timestamps every minute
    setInterval(() => this._cleanup(), 60000);
  }
  
  /**
   * Execute an API call with rate limiting
   * @param {string} key - Unique key for caching (e.g., "candles:13:1:1778822880")
   * @param {Function} apiCall - Async function that makes the API call
   * @param {object} options - { skipCache: boolean, priority: 'high'|'normal' }
   * @returns {Promise<any>} API response
   */
  async execute(key, apiCall, options = {}) {
    const { skipCache = false, priority = 'normal' } = options;
    
    // Check circuit breaker
    if (this.circuitBreakerOpen) {
      const now = Date.now();
      if (now < this.circuitBreakerUntil) {
        const waitMs = this.circuitBreakerUntil - now;
        logger.warn({
          waitMs,
          key,
        }, '[rateLimiter] Circuit breaker open - rejecting call');
        
        throw new Error(`Rate limit circuit breaker open. Retry in ${Math.ceil(waitMs / 1000)}s`);
      } else {
        // Circuit breaker expired, reset
        this.circuitBreakerOpen = false;
        logger.info('[rateLimiter] Circuit breaker closed - resuming calls');
      }
    }
    
    // Check cache first
    if (!skipCache && this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (Date.now() < cached.expiresAt) {
        this.stats.cachedResponses++;
        logger.debug({ key }, '[rateLimiter] Serving from cache');
        return cached.data;
      } else {
        this.cache.delete(key);
      }
    }
    
    // Check if we can make the call now
    if (this._canMakeCall()) {
      return await this._executeCall(key, apiCall);
    }
    
    // Queue the call
    logger.debug({ key, priority }, '[rateLimiter] Queueing call - rate limit reached');
    this.stats.queuedCalls++;
    
    return new Promise((resolve, reject) => {
      const queueItem = {
        key,
        apiCall,
        resolve,
        reject,
        priority,
        queuedAt: Date.now(),
      };
      
      if (priority === 'high') {
        this.queue.unshift(queueItem);
      } else {
        this.queue.push(queueItem);
      }
      
      this._processQueue();
    });
  }
  
  /**
   * Check if we can make an API call now
   */
  _canMakeCall() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const burstWindowStart = now - this.burstWindowMs;
    
    // Remove old timestamps
    this.callTimestamps = this.callTimestamps.filter(t => t > oneMinuteAgo);
    this.burstCallTimestamps = this.burstCallTimestamps.filter(t => t > burstWindowStart);
    
    // Check limits
    const minuteCallCount = this.callTimestamps.length;
    const burstCallCount = this.burstCallTimestamps.length;
    
    return minuteCallCount < this.maxCallsPerMinute && burstCallCount < this.maxBurstCalls;
  }
  
  /**
   * Execute the API call
   */
  async _executeCall(key, apiCall) {
    const now = Date.now();
    this.callTimestamps.push(now);
    this.burstCallTimestamps.push(now);
    this.stats.totalCalls++;
    
    try {
      const result = await apiCall();
      
      // Cache successful responses
      this.cache.set(key, {
        data: result,
        expiresAt: now + this.cacheExpiryMs,
      });
      
      return result;
    } catch (error) {
      // Check if it's a rate limit error
      if (error.response?.status === 429 || error.message?.includes('429')) {
        this.stats.rateLimitErrors++;
        this._openCircuitBreaker();
        throw new Error('Rate limit exceeded - circuit breaker opened');
      }
      
      throw error;
    }
  }
  
  /**
   * Process queued requests
   */
  async _processQueue() {
    if (this.isProcessingQueue || this.queue.length === 0) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    while (this.queue.length > 0 && this._canMakeCall()) {
      const item = this.queue.shift();
      
      try {
        const result = await this._executeCall(item.key, item.apiCall);
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }
      
      // Small delay between queued calls
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.isProcessingQueue = false;
    
    // If there are still items in queue, schedule next processing
    if (this.queue.length > 0) {
      setTimeout(() => this._processQueue(), 1000);
    }
  }
  
  /**
   * Open circuit breaker when rate limited
   */
  _openCircuitBreaker() {
    this.circuitBreakerOpen = true;
    this.circuitBreakerUntil = Date.now() + 30000; // 30 seconds
    this.stats.circuitBreakerTrips++;
    
    logger.error({
      until: new Date(this.circuitBreakerUntil).toISOString(),
      queueLength: this.queue.length,
    }, '[rateLimiter] Circuit breaker OPENED - rate limit exceeded');
    
    // Clear queue to prevent backlog
    const queuedCount = this.queue.length;
    this.queue.forEach(item => {
      item.reject(new Error('Circuit breaker opened - call cancelled'));
    });
    this.queue = [];
    
    if (queuedCount > 0) {
      logger.warn({ cancelledCalls: queuedCount }, '[rateLimiter] Cleared queue due to circuit breaker');
    }
  }
  
  /**
   * Cleanup old data
   */
  _cleanup() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Clean timestamps
    this.callTimestamps = this.callTimestamps.filter(t => t > oneMinuteAgo);
    
    // Clean cache
    for (const [key, value] of this.cache.entries()) {
      if (now >= value.expiresAt) {
        this.cache.delete(key);
      }
    }
    
    logger.debug({
      callsLastMinute: this.callTimestamps.length,
      cacheSize: this.cache.size,
      queueLength: this.queue.length,
    }, '[rateLimiter] Cleanup completed');
  }
  
  /**
   * Get current stats
   */
  getStats() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const callsLastMinute = this.callTimestamps.filter(t => t > oneMinuteAgo).length;
    
    return {
      ...this.stats,
      callsLastMinute,
      cacheSize: this.cache.size,
      queueLength: this.queue.length,
      circuitBreakerOpen: this.circuitBreakerOpen,
      circuitBreakerUntil: this.circuitBreakerOpen 
        ? new Date(this.circuitBreakerUntil).toISOString() 
        : null,
    };
  }
  
  /**
   * Reset stats
   */
  resetStats() {
    this.stats = {
      totalCalls: 0,
      cachedResponses: 0,
      queuedCalls: 0,
      rateLimitErrors: 0,
      circuitBreakerTrips: 0,
    };
  }
  
  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('[rateLimiter] Cache cleared');
  }
}

// Singleton instance
const instance = new APIRateLimiter();

module.exports = {
  instance,
  APIRateLimiter,
};
