const Account = require('../models/Account');
const dhanService = require('../services/dhan.service');
const { encrypt, decrypt, last4 } = require('../services/crypto.service');
const HttpError = require('../utils/HttpError');
const asyncHandler = require('../utils/asyncHandler');

exports.list = asyncHandler(async (_req, res) => {
  const accounts = await Account.find().sort({ createdAt: -1 });
  res.json({ accounts });
});

exports.create = asyncHandler(async (req, res) => {
  const { accountName, clientId, accessToken, mode, riskMultiplier, capitalPercentage, enabled } = req.body;
  
  // Fetch capital amount from Dhan API
  let capitalAmount = 0;
  try {
    const fundResult = await dhanService.getFundLimit({
      clientId,
      accessToken,
      mode,
    });
    if (fundResult.ok && fundResult.data) {
      // Dhan API returns availabelBalance or similar field
      capitalAmount = fundResult.data.availabelBalance || fundResult.data.sodLimit || 0;
    }
  } catch (err) {
    // Log but don't fail account creation if fund fetch fails
    console.warn('Failed to fetch capital amount:', err.message);
  }

  const doc = await Account.create({
    accountName,
    clientId,
    accessTokenEncrypted: encrypt(accessToken),
    accessTokenLast4: last4(accessToken),
    mode,
    riskMultiplier: riskMultiplier ?? 1,
    capitalPercentage: capitalPercentage ?? 100,
    capitalAmount,
    enabled: enabled ?? true,
  });
  res.status(201).json({ account: doc });
});

exports.update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { accountName, clientId, accessToken, mode, riskMultiplier, capitalPercentage, enabled } = req.body;
  const update = {};
  if (accountName !== undefined) update.accountName = accountName;
  if (clientId !== undefined) update.clientId = clientId;
  if (mode !== undefined) update.mode = mode;
  if (riskMultiplier !== undefined) update.riskMultiplier = riskMultiplier;
  if (capitalPercentage !== undefined) update.capitalPercentage = capitalPercentage;
  if (enabled !== undefined) update.enabled = enabled;
  
  // If access token is being updated, fetch new capital amount
  if (accessToken) {
    update.accessTokenEncrypted = encrypt(accessToken);
    update.accessTokenLast4 = last4(accessToken);
    
    // Fetch updated capital amount
    const doc = await Account.findById(id);
    if (doc) {
      try {
        const fundResult = await dhanService.getFundLimit({
          clientId: clientId || doc.clientId,
          accessToken,
          mode: mode || doc.mode,
        });
        if (fundResult.ok && fundResult.data) {
          update.capitalAmount = fundResult.data.availabelBalance || fundResult.data.sodLimit || 0;
        }
      } catch (err) {
        console.warn('Failed to fetch capital amount:', err.message);
      }
    }
  }
  
  const doc = await Account.findByIdAndUpdate(id, update, { new: true });
  if (!doc) throw new HttpError(404, 'Account not found');
  res.json({ account: doc });
});

exports.remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await Account.findByIdAndDelete(id);
  if (!doc) throw new HttpError(404, 'Account not found');
  res.json({ ok: true });
});

exports.test = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const doc = await Account.findById(id);
  if (!doc) throw new HttpError(404, 'Account not found');
  const accessToken = decrypt(doc.accessTokenEncrypted);
  const result = await dhanService.getPositions({
    clientId: doc.clientId,
    accessToken,
    mode: doc.mode,
  });
  res.json({
    ok: result.ok,
    status: result.status,
    error: result.ok ? null : result.error,
    sample: result.ok ? Array.isArray(result.data) ? result.data.slice(0, 1) : result.data : null,
  });
});

exports.updateAllCapital = asyncHandler(async (_req, res) => {
  const accounts = await Account.find();
  const results = [];
  
  for (const account of accounts) {
    try {
      const accessToken = decrypt(account.accessTokenEncrypted);
      const fundResult = await dhanService.getFundLimit({
        clientId: account.clientId,
        accessToken,
        mode: account.mode,
      });
      
      if (fundResult.ok && fundResult.data) {
        const capitalAmount = fundResult.data.availabelBalance || fundResult.data.sodLimit || 0;
        await Account.findByIdAndUpdate(account._id, { capitalAmount });
        results.push({
          accountId: account._id,
          accountName: account.accountName,
          success: true,
          capitalAmount,
        });
      } else {
        results.push({
          accountId: account._id,
          accountName: account.accountName,
          success: false,
          error: fundResult.error,
        });
      }
    } catch (err) {
      results.push({
        accountId: account._id,
        accountName: account.accountName,
        success: false,
        error: err.message,
      });
    }
  }
  
  res.json({ results });
});
