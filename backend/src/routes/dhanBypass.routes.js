const express = require('express');
const dhanBypassController = require('../controllers/dhanBypass.controller');

const router = express.Router();

// Get data from Dhan Bypass API
router.get('/data', dhanBypassController.getBypassData);

module.exports = router;
