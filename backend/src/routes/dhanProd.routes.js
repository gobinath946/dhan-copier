/**
 * Dhan Production API routes
 * Mounted under /api/dhan-prod
 */
const express = require('express');
const c = require('../controllers/dhanProd.controller');

const router = express.Router();

router.get('/historical', c.getHistorical);
router.get('/expiry', c.getExpiryList);
router.get('/option-chain', c.getOptionChain);
router.get('/oi-analysis', c.getOIAnalysis);
router.get('/oi-change', c.getOIChange);

router.post('/ltp', c.getLTP);
router.post('/ohlc', c.getOHLC);
router.post('/quote', c.getQuote);

module.exports = router;
