const mongoose = require('mongoose');

const TradeExecutionSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, trim: true },
    securityId: { type: String, trim: true }, // Dhan securityId if known
    exchangeSegment: { type: String, trim: true }, // e.g. NSE_EQ
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    quantity: { type: Number, required: true, min: 1 },
    orderType: {
      type: String,
      enum: ['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_MARKET'],
      required: true,
    },
    productType: {
      type: String,
      enum: ['INTRADAY', 'CNC', 'MARGIN', 'MTF', 'CO', 'BO'],
      required: true,
    },
    price: { type: Number, default: 0 },
    triggerPrice: { type: Number, default: 0 },
    stopLoss: { type: Number, default: 0 },
    target: { type: Number, default: 0 },
    triggeredMode: { type: String, enum: ['sandbox', 'production'], required: true, index: true },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

TradeExecutionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TradeExecution', TradeExecutionSchema);
