const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/scalping.controller');

const router = express.Router();

router.use(requireAuth);

router.get('/market-status', ctrl.marketStatus);
router.get('/settings', ctrl.getSettings);
router.post('/settings', ctrl.updateSettings);
router.post('/start', ctrl.start);
router.post('/stop', ctrl.stop);
router.get('/status', ctrl.status);
router.get('/replay-dates', ctrl.replayDates);
router.get('/trades', ctrl.listTrades);
router.get('/sessions', ctrl.listSessions);
router.post('/trades/:id/exit', ctrl.exitTrade);
router.get('/logs', ctrl.getLogs);
router.get('/logs/stats', ctrl.getLogsStats);
router.get('/events', ctrl.getEvents);

// Backtest endpoints (Hybrid_Engine in simulation mode)
router.get('/backtest/dates', ctrl.backtestList);
router.post('/backtest/start', ctrl.backtestStart);
router.post('/backtest/stop', ctrl.backtestStop);
router.get('/backtest/status', ctrl.backtestStatus);

module.exports = router;
