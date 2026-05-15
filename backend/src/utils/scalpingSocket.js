/**
 * Scalping Socket Emitter
 * Helper functions to emit real-time updates to connected clients
 */
const logger = require('./logger');

let io = null;

/**
 * Initialize socket.io instance
 * Called from server.js after io is created
 */
function initializeSocket(socketIo) {
  io = socketIo;
  logger.info('[scalpingSocket] Socket.io initialized for scalping updates');
}

/**
 * Emit session status update
 * @param {Object} session - Session object
 * @param {boolean} running - Is engine running
 * @param {number} openTrades - Number of open trades
 */
function emitSessionUpdate(session, running, openTrades) {
  if (!io) return;
  
  try {
    const update = {
      session,
      running,
      openTrades,
      timestamp: Date.now(),
    };
    
    // Emit to all clients subscribed to this session
    io.to(`scalping_${session._id}`).emit('scalpingSessionUpdate', update);
    
    // Also emit to general scalping room
    io.to('scalping_all').emit('scalpingSessionUpdate', update);
    
    logger.debug({ sessionId: session._id, running, openTrades }, '[scalpingSocket] Session update emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting session update');
  }
}

/**
 * Emit trade created event
 * @param {Object} trade - Trade object
 * @param {string} sessionId - Session ID
 */
function emitTradeCreated(trade, sessionId) {
  if (!io) return;
  
  try {
    const update = {
      type: 'trade_created',
      trade,
      sessionId,
      timestamp: Date.now(),
    };
    
    io.to(`scalping_${sessionId}`).emit('scalpingTradeUpdate', update);
    io.to('scalping_all').emit('scalpingTradeUpdate', update);
    
    logger.debug({ tradeId: trade._id, sessionId }, '[scalpingSocket] Trade created emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting trade created');
  }
}

/**
 * Emit trade updated event (price, SL, quantity changes)
 * @param {Object} trade - Updated trade object
 * @param {string} sessionId - Session ID
 * @param {string} updateType - Type of update (price, sl, quantity, etc.)
 */
function emitTradeUpdated(trade, sessionId, updateType = 'price') {
  if (!io) return;
  
  try {
    const update = {
      type: 'trade_updated',
      updateType,
      trade,
      sessionId,
      timestamp: Date.now(),
    };
    
    io.to(`scalping_${sessionId}`).emit('scalpingTradeUpdate', update);
    io.to('scalping_all').emit('scalpingTradeUpdate', update);
    
    logger.debug({ tradeId: trade._id, sessionId, updateType }, '[scalpingSocket] Trade updated emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting trade updated');
  }
}

/**
 * Emit trade closed event
 * @param {Object} trade - Closed trade object
 * @param {string} sessionId - Session ID
 */
function emitTradeClosed(trade, sessionId) {
  if (!io) return;
  
  try {
    const update = {
      type: 'trade_closed',
      trade,
      sessionId,
      timestamp: Date.now(),
    };
    
    io.to(`scalping_${sessionId}`).emit('scalpingTradeUpdate', update);
    io.to('scalping_all').emit('scalpingTradeUpdate', update);
    
    logger.debug({ tradeId: trade._id, sessionId, result: trade.result }, '[scalpingSocket] Trade closed emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting trade closed');
  }
}

/**
 * Emit engine started event
 * @param {Object} session - Session object
 */
function emitEngineStarted(session) {
  if (!io) return;
  
  try {
    const update = {
      type: 'engine_started',
      session,
      timestamp: Date.now(),
    };
    
    io.to(`scalping_${session._id}`).emit('scalpingEngineEvent', update);
    io.to('scalping_all').emit('scalpingEngineEvent', update);
    
    logger.info({ sessionId: session._id }, '[scalpingSocket] Engine started emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting engine started');
  }
}

/**
 * Emit engine stopped event
 * @param {Object} session - Session object
 * @param {string} reason - Stop reason
 */
function emitEngineStopped(session, reason) {
  if (!io) return;
  
  try {
    const update = {
      type: 'engine_stopped',
      session,
      reason,
      timestamp: Date.now(),
    };
    
    io.to(`scalping_${session._id}`).emit('scalpingEngineEvent', update);
    io.to('scalping_all').emit('scalpingEngineEvent', update);
    
    logger.info({ sessionId: session._id, reason }, '[scalpingSocket] Engine stopped emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting engine stopped');
  }
}

/**
 * Emit cycle completed event
 * @param {string} sessionId - Session ID
 * @param {number} cycleCount - Current cycle count
 * @param {string} cycleType - 'prediction' or 'monitor'
 */
function emitCycleCompleted(sessionId, cycleCount, cycleType) {
  if (!io) return;
  
  try {
    const update = {
      type: 'cycle_completed',
      sessionId,
      cycleCount,
      cycleType,
      timestamp: Date.now(),
    };
    
    io.to(`scalping_${sessionId}`).emit('scalpingEngineEvent', update);
    io.to('scalping_all').emit('scalpingEngineEvent', update);
    
    logger.debug({ sessionId, cycleCount, cycleType }, '[scalpingSocket] Cycle completed emitted');
  } catch (error) {
    logger.error({ error: error.message }, '[scalpingSocket] Error emitting cycle completed');
  }
}

module.exports = {
  initializeSocket,
  emitSessionUpdate,
  emitTradeCreated,
  emitTradeUpdated,
  emitTradeClosed,
  emitEngineStarted,
  emitEngineStopped,
  emitCycleCompleted,
};
