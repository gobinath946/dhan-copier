const express = require('express');
const c = require('../controllers/feedRecorder.controller');

const router = express.Router();

router.get('/status', c.getStatus);
router.get('/days', c.listDays);
router.get('/spot', c.getSpot);
router.get('/option-chain', c.getOptionChain);
router.get('/metadata', c.getMetadata);

module.exports = router;
