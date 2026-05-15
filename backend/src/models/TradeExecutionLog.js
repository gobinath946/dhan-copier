const mongoose = require('mongoose');

const TradeExecutionLogSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, trim: true },
    securityId: { type: String, required: true, trim: true },
    exchangeSegment: { type: String, required: true, trim: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    totalLots: { type: Number, required: true, min: 1 },
    lotSize: { type: Number, required: true, min: 1 },
    orderType: {
      type: String,
      enum: ['MARKET', 'LIMIT'],
      required: true,
    },
    productType: {
      type: String,
      enum: ['INTRADAY', 'CNC'],
      required: true,
    },
    
    // Entry details
    entryTime: { type: Date, required: true },
    entryPremium: { type: Number, required: true, min: 0 },
    entryValue: { type: Number, required: true, min: 0 },
    
    // Exit details (null until exited)
    exitTime: { type: Date, default: null },
    exitPremium: { type: Number, default: null, min: 0 },
    exitValue: { type: Number, default: null, min: 0 },
    
    // Status
    status: {
      type: String,
      enum: ['active', 'exited', 'partial'],
      required: true,
      default: 'active',
      index: true,
    },
    triggeredMode: {
      type: String,
      enum: ['sandbox', 'production'],
      required: true,
      index: true,
    },
    
    // Metadata
    note: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

// Indexes for efficient querying
TradeExecutionLogSchema.index({ status: 1, createdAt: -1 });
TradeExecutionLogSchema.index({ triggeredMode: 1, createdAt: -1 });
TradeExecutionLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TradeExecutionLog', TradeExecutionLogSchema);
