/**
 * Engine Event Log Model
 * Stores all scalping engine events for analysis and debugging
 */
const mongoose = require('mongoose');

const EngineEventLogSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ScalpingSession',
      required: true,
      index: true,
    },
    // NOTE: eventType is an open string by design. The scalping engine emits
    // many distinct event types (professional_analysis, master_algorithm,
    // liquidity_check, smc_check, ai_ensemble_entry, sentiment_validation, ...).
    // Enforcing an enum here caused validation failures and silently dropped
    // logs. We keep it as a free-form String with an index for fast queries.
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    level: {
      type: String,
      enum: ['info', 'warn', 'error'],
      default: 'info',
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // For linking to specific trades
    tradeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ScalpingTrade',
    },
    // AI decision snapshot
    aiDecision: {
      action: String,
      confidence: Number,
      rationale: String,
      regime: String,
    },
    // Market data snapshot
    marketSnapshot: {
      atmStrike: Number,
      spotPrice: Number,
      vwapState: String,
      buildUpType: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient querying
EngineEventLogSchema.index({ sessionId: 1, createdAt: -1 });
EngineEventLogSchema.index({ eventType: 1, createdAt: -1 });
EngineEventLogSchema.index({ level: 1, createdAt: -1 });

// Auto-delete logs older than 30 days
EngineEventLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('EngineEventLog', EngineEventLogSchema);
