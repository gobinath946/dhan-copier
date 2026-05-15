/**
 * Test script for Dhan WebSocket Feed
 * Run with: node src/test-websocket.js
 */

const dhanWebSocketFeedService = require('./services/dhanWebSocketFeed.service');
const logger = require('./utils/logger');

async function testWebSocket() {
  try {
    logger.info('Starting WebSocket test...');
    
    // Connect to Dhan WebSocket
    await dhanWebSocketFeedService.connect();
    logger.info('✓ Connected successfully');
    
    // Subscribe to a test security (NIFTY 50 index)
    // You'll need to replace this with actual security ID
    const testSecurityId = 13; // Example: NIFTY 50
    
    logger.info({ securityId: testSecurityId }, 'Subscribing to test security');
    
    dhanWebSocketFeedService.subscribe(testSecurityId, (tick) => {
      logger.info({ tick }, '✓ Received tick data');
      
      // Log in readable format
      console.log('\n=== LIVE TICK DATA ===');
      console.log(`Security ID: ${tick.securityId}`);
      console.log(`LTP: ${tick.ltp}`);
      console.log(`Volume: ${tick.volume}`);
      console.log(`Open: ${tick.open}`);
      console.log(`High: ${tick.high}`);
      console.log(`Low: ${tick.low}`);
      console.log(`Close: ${tick.close}`);
      console.log(`Timestamp: ${new Date(tick.timestamp * 1000).toISOString()}`);
      console.log('=====================\n');
    });
    
    // Keep running for 60 seconds
    logger.info('Listening for 60 seconds...');
    
    setTimeout(() => {
      logger.info('Test complete, disconnecting...');
      dhanWebSocketFeedService.disconnect();
      process.exit(0);
    }, 60000);
    
  } catch (error) {
    logger.error({ error: error.message }, '✗ Test failed');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  dhanWebSocketFeedService.disconnect();
  process.exit(0);
});

testWebSocket();
