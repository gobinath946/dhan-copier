const express = require('express');
const c = require('../controllers/historicalBackfill.controller');

const router = express.Router();

router.post('/', c.runBackfill);
router.post('/yesterday', c.backfillYesterday);
router.post('/range', c.backfillRange);
router.post('/week', c.backfillWeek);

module.exports = router;
