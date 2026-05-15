const mongoose = require('mongoose');

const TradePLRecordSchema = new mongoose.Schema(
  {
    tradeExecutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TradeExecutionLog',
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    accountName: { type: String, required: true, trim: true },
    
    // Trade details
    symbol: { type: String, required: true, trim: true },
    lots: { type: Number, required: true, min: 1 },
    lotSize: { type: Number, required: true, min: 1 },
    
    // Entry details
    entryTime: { type: Date, required: true },
    entryPremium: { type: Number, required: true, min: 0 },
    entryValue: { type: Number, required: true, min: 0 },
    
    // Exit details
    exitTime: { type: Date, required: true },
    exitPremium: { type: Number, required: true, min: 0 },
    exitValue: { type: Number, required: true, min: 0 },
    
    // P&L calculation
    pl: { type: Number, required: true },
    plPercentage: { type: Number, required: true },
  },
  { timestamps: true }
);

// Indexes for efficient querying
TradePLRecordSchema.index({ tradeExecutionId: 1 });
TradePLRecordSchema.index({ accountId: 1, createdAt: -1 });
TradePLRecordSchema.index({ pl: -1 });
TradePLRecordSchema.index({ createdAt: -1 });

// Pre-save hook to validate P&L calculations
TradePLRecordSchema.pre('save', function (next) {
  // Validate P&L calculation
  const expectedPL = this.exitValue - this.entryValue;
  if (Math.abs(this.pl - expectedPL) > 0.01) {
    return next(new Error('P&L calculation mismatch'));
  }
  
  // Validate P&L percentage calculation
  if (this.entryValue > 0) {
    const expectedPLPercentage = (this.pl / this.entryValue) * 100;
    if (Math.abs(this.plPercentage - expectedPLPercentage) > 0.01) {
      return next(new Error('P&L percentage calculation mismatch'));
    }
  }
  
  next();
});

module.exports = mongoose.model('TradePLRecord', TradePLRecordSchema);
