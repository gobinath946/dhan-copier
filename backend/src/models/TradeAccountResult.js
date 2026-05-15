const mongoose = require('mongoose');

const TradeAccountResultSchema = new mongoose.Schema(
  {
    tradeExecutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TradeExecution',
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    accountName: String, // denormalized for fast log display
    scaledQuantity: { type: Number, required: true },
    dhanOrderId: { type: String, default: null },
    status: {
      type: String,
      enum: ['success', 'failed', 'pending', 'retrying'],
      required: true,
      index: true,
    },
    attemptCount: { type: Number, default: 1 },
    errorMessage: { type: String, default: null },
    executedQuantity: { type: Number, default: 0 },
    responsePayload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

TradeAccountResultSchema.index({ accountId: 1, createdAt: -1 });
TradeAccountResultSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('TradeAccountResult', TradeAccountResultSchema);
