const express = require('express');
const marketDataController = require('../controllers/marketData.controller');

const router = express.Router();

// Get NIFTY 50 data
router.get('/nifty', marketDataController.getNiftyData);

// Get Bank NIFTY data
router.get('/bank-nifty', marketDataController.getBankNiftyData);

// Get historical data for any symbol
router.get('/historical', marketDataController.getHistoricalData);

// Test Dhan API integration
router.get('/test-dhan', marketDataController.testDhanApi);

module.exports = router;
