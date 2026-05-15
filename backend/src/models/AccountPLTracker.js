const mongoose = require('mongoose');

const MonthlyPLSchema = new mongoose.Schema(
  {
    month: { type: String, required: true }, // Format: "YYYY-MM"
    pl: { type: Number, required: true, default: 0 },
    trades: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false }
);

const AccountPLTrackerSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      unique: true,
      index: true,
    },
    accountName: { type: String, required: true, trim: true },
    
    // Cumulative metrics
    totalPL: { type: Number, required: true, default: 0 },
    totalTrades: { type: Number, required: true, default: 0, min: 0 },
    profitableTrades: { type: Number, required: true, default: 0, min: 0 },
    losingTrades: { type: Number, required: true, default: 0, min: 0 },
    winRate: { type: Number, required: true, default: 0, min: 0, max: 100 },
    
    // Monthly breakdown
    monthlyPL: { type: [MonthlyPLSchema], default: [] },
    
    // Metadata
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Index for ranking accounts by performance
AccountPLTrackerSchema.index({ totalPL: -1 });

// Validation: profitableTrades + losingTrades should equal totalTrades
AccountPLTrackerSchema.pre('save', function (next) {
  if (this.profitableTrades + this.losingTrades !== this.totalTrades) {
    // Allow for edge case where totalTrades might include pending trades
    // but enforce that profitable + losing doesn't exceed total
    if (this.profitableTrades + this.losingTrades > this.totalTrades) {
      return next(new Error('Sum of profitable and losing trades cannot exceed total trades'));
    }
  }
  
  // Recalculate win rate
  if (this.totalTrades > 0) {
    this.winRate = (this.profitableTrades / this.totalTrades) * 100;
  } else {
    this.winRate = 0;
  }
  
  this.lastUpdated = new Date();
  next();
});

module.exports = mongoose.model('AccountPLTracker', AccountPLTrackerSchema);
