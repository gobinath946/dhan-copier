/**
 * Debug script for Dhan WebSocket Feed
 * Tests with multiple security IDs and formats
 */

const dhanWebSocketFeedService = require('./services/dhanWebSocketFeed.service');
const logger = require('./utils/logger');

async function testWebSocketDebug() {
  try {
    logger.info('=== Starting WebSocket Debug Test ===');
    
    // Connect to Dhan WebSocket
    await dhanWebSocketFeedService.connect();
    logger.info('✓ Connected successfully');
    
    // Test with multiple known security IDs
    const testSecurities = [
      { id: 13, name: 'NIFTY 50' },
      { id: 25, name: 'BANK NIFTY' },
      { id: 51, name: 'SENSEX' },
      { id: 72263, name: 'Option Contract 1' },
      { id: 72264, name: 'Option Contract 2' },
    ];
    
    logger.info({ securities: testSecurities }, 'Testing with multiple securities');
    
    // Subscribe to all
    const allIds = testSecurities.map(s => s.id);
    
    let tickCount = 0;
    let receivedSecurities = new Set();
    
    dhanWebSocketFeedService.subscribe(allIds, (tick) => {
      tickCount++;
      receivedSecurities.add(tick.securityId);
      
      const security = testSecurities.find(s => s.id === tick.securityId);
      const name = security ? security.name : 'Unknown';
      
      logger.info({ tick, name }, '✓ Received tick data');
      
      console.log('\n=== LIVE TICK DATA ===');
      console.log(`Security: ${name} (ID: ${tick.securityId})`);
      console.log(`LTP: ${tick.ltp}`);
      console.log(`Volume: ${tick.volume}`);
      console.log(`Open: ${tick.open}`);
      console.log(`High: ${tick.high}`);
      console.log(`Low: ${tick.low}`);
      console.log(`Close: ${tick.close}`);
      console.log(`Timestamp: ${new Date(tick.timestamp * 1000).toISOString()}`);
      console.log('=====================\n');
    });
    
    // Monitor for 60 seconds
    logger.info('Listening for 60 seconds...');
    
    let checkInterval = setInterval(() => {
      logger.info({ 
        tickCount, 
        receivedSecurities: Array.from(receivedSecurities),
        expectedSecurities: allIds 
      }, 'Status check');
      
      if (tickCount === 0) {
        logger.warn('⚠️  No ticks received yet - possible issues:');
        logger.warn('  1. Market might be closed');
        logger.warn('  2. Security IDs might be invalid');
        logger.warn('  3. Subscription format might be wrong');
        logger.warn('  4. WebSocket feed might not support these securities');
      }
    }, 10000); // Every 10 seconds
    
    setTimeout(() => {
      clearInterval(checkInterval);
      
      logger.info('=== Test Summary ===');
      logger.info({ 
        totalTicks: tickCount,
        securitiesReceived: Array.from(receivedSecurities),
        securitiesExpected: allIds,
        successRate: `${receivedSecurities.size}/${allIds.length}`
      }, 'Test complete');
      
      if (tickCount === 0) {
        logger.error('❌ No ticks received - WebSocket feed not working');
        logger.error('Possible reasons:');
        logger.error('  1. Market is closed');
        logger.error('  2. Security IDs are invalid for this feed');
        logger.error('  3. Subscription message format is incorrect');
        logger.error('  4. This WebSocket only supports index data (not options)');
        logger.error('');
        logger.error('Recommendation: Use polling service for options data');
      } else {
        logger.info(`✓ Success! Received ${tickCount} ticks from ${receivedSecurities.size} securities`);
      }
      
      dhanWebSocketFeedService.disconnect();
      process.exit(tickCount > 0 ? 0 : 1);
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

testWebSocketDebug();
