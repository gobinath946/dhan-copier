/**
 * Test script to verify JSON logging is working
 * Run with: node test-logging.js
 */

// Import the logger first to set up console intercepts
const jsonEventLogger = require('./src/utils/jsonEventLogger');
const logger = require('./src/utils/logger');

console.log('='.repeat(80));
console.log('Testing JSON Event Logger');
console.log('='.repeat(80));

// Set a test session ID
const testSessionId = 'test-' + Date.now();
jsonEventLogger.setSessionId(testSessionId);

console.log('\n1. Testing console.log capture...');
console.log('This is a test console.log message');

console.log('\n2. Testing console.info capture...');
console.info('This is a test console.info message');

console.log('\n3. Testing console.warn capture...');
console.warn('This is a test console.warn message');

console.log('\n4. Testing console.error capture...');
console.error('This is a test console.error message');

console.log('\n5. Testing Pino logger...');
logger.info({ testData: 'value1' }, 'This is a Pino info log');
logger.warn({ testData: 'value2' }, 'This is a Pino warn log');
logger.error({ testData: 'value3' }, 'This is a Pino error log');

console.log('\n6. Testing direct event logging...');
jsonEventLogger.logEvent({
  type: 'test_event',
  level: 'info',
  msg: 'Direct event log test',
  data: { foo: 'bar', baz: 123 },
});

console.log('\n7. Flushing logs...');
setTimeout(async () => {
  await jsonEventLogger.flushQueue();
  
  console.log('\n8. Reading back logs...');
  const events = await jsonEventLogger.readEvents(testSessionId);
  
  console.log(`\nFound ${events.length} events in log file:`);
  events.forEach((event, i) => {
    console.log(`\nEvent ${i + 1}:`);
    console.log(`  Type: ${event.type}`);
    console.log(`  Level: ${event.level}`);
    console.log(`  Message: ${event.msg}`);
    if (event.data) {
      console.log(`  Data: ${JSON.stringify(event.data)}`);
    }
  });
  
  console.log('\n' + '='.repeat(80));
  console.log('Test Complete!');
  console.log('Check backend/logs/ directory for log files');
  console.log('='.repeat(80));
  
  process.exit(0);
}, 2000);
