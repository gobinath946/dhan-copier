const mongoose = require('mongoose');

const AccountSchema = new mongoose.Schema(
  {
    accountName: { type: String, required: true, trim: true, maxlength: 100 },
    clientId: { type: String, required: true, trim: true, maxlength: 100 },
    accessTokenEncrypted: { type: String, required: true },
    accessTokenLast4: { type: String, required: true },
    mode: { type: String, enum: ['sandbox', 'production'], required: true, index: true },
    riskMultiplier: { type: Number, default: 1, min: 0.01, max: 100 },
    capitalPercentage: { type: Number, default: 100, min: 0, max: 100 },
    capitalAmount: { type: Number, default: 0, min: 0 },
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

AccountSchema.index({ enabled: 1, mode: 1 });

// Never leak the encrypted token in JSON responses
AccountSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.accessTokenEncrypted;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Account', AccountSchema);
