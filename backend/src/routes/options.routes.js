const express = require('express');
const optionsController = require('../controllers/options.controller');

const router = express.Router();

// Get expiry list
router.get('/expiries', optionsController.getExpiryList);

// Get option chain
router.get('/chain', optionsController.getOptionChain);

// Get option quote
router.get('/quote', optionsController.getOptionQuote);

// Get multiple option LTPs
router.post('/ltps', optionsController.getOptionLTPs);

module.exports = router;
