const express = require('express');
const c = require('../controllers/liveFeedProd.controller');

const router = express.Router();

router.get('/status', c.getStatus);
router.get('/snapshot', c.getSnapshot);
router.get('/snapshot-file', c.getSnapshotFile);
router.get('/tick', c.getTick);
router.post('/subscribe', c.subscribe);
router.post('/unsubscribe', c.unsubscribe);

module.exports = router;
