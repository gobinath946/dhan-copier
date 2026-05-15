/**
 * Test Dhan API directly to see what data it returns
 */
require('dotenv').config();
const axios = require('axios');

async function testAPI() {
  const payload = {
    securityId: "13",
    exchangeSegment: "IDX_I",
    instrument: "INDEX",
    interval: "1",
    oi: false,
    fromDate: "2026-05-13 09:15:00",
    toDate: "2026-05-13 09:20:00", // Just first 5 minutes
  };

  console.log('Testing Dhan API with payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('\n');

  try {
    const response = await axios.post(
      'https://api.dhan.co/v2/charts/intraday',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'access-token': process.env.DHAN_ACCESS_TOKEN,
          'client-id': process.env.DHAN_CLIENT_ID,
        },
        timeout: 30000,
      }
    );

    console.log('API Response:');
    console.log(JSON.stringify(response.data, null, 2));
    
    // Show first candle details
    if (response.data.timestamp && response.data.timestamp.length > 0) {
      console.log('\n=== FIRST CANDLE ===');
      console.log(`Timestamp: ${response.data.timestamp[0]}`);
      console.log(`Open: ${response.data.open[0]}`);
      console.log(`High: ${response.data.high[0]}`);
      console.log(`Low: ${response.data.low[0]}`);
      console.log(`Close: ${response.data.close[0]}`);
      console.log(`Volume: ${response.data.volume[0]}`);
      
      // Convert timestamp
      const date = new Date(response.data.timestamp[0] * 1000);
      console.log(`\nIST Time: ${date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testAPI();
