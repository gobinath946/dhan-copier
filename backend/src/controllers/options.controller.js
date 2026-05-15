const dhanOptions = require('../services/dhanOptions.service');
const dhanBypass = require('../services/dhanBypass.service');
const dhanProd = require('../services/dhanProd.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');

exports.getExpiryList = asyncHandler(async (req, res) => {
  const { dataSource, authKey } = req.query;
  
  // Use Dhan Bypass if requested and auth key is provided
  if (dataSource === 'dhan-bypass') {
    if (!authKey) {
      throw new HttpError(400, 'Auth key is required for Dhan Bypass');
    }
    
    const result = await dhanBypass.getExpiryListBypass(authKey, {
      segment: 2, // NIFTY
      securityId: 72259, // NIFTY 50
    });
    
    if (!result.ok) {
      throw new HttpError(500, result.error);
    }
    
    return res.json(result.data);
  }
  
  // Use production Dhan API
  const result = await dhanProd.getExpiryListProd(null, {
    securityId: 13, // NIFTY 50 security ID for production API
  });
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  // Return in the same format as bypass for frontend compatibility
  res.json(result.data);
});

exports.getOptionChain = asyncHandler(async (req, res) => {
  const { spotPrice, expiry, dataSource, authKey } = req.query;
  
  if (!spotPrice) {
    throw new HttpError(400, 'Spot price is required');
  }
  
  // Use Dhan Bypass if requested and auth key is provided
  if (dataSource === 'dhan-bypass') {
    if (!authKey) {
      throw new HttpError(400, 'Auth key is required for Dhan Bypass');
    }
    
    const result = await dhanBypass.getOptionChainBypass(authKey, {
      segment: 2, // NIFTY
      expiry: expiry ? parseInt(expiry) : null,
      securityId: 72259, // NIFTY 50
    });
    
    if (!result.ok) {
      throw new HttpError(500, result.error);
    }
    
    return res.json(result.data);
  }
  
  // Use production Dhan API
  const result = await dhanProd.getOptionChainProd(null, {
    securityId: 13, // NIFTY 50 security ID for production API
    expiry: expiry ? parseInt(expiry) : null,
  });
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json(result.data);
});

exports.getOptionQuote = asyncHandler(async (req, res) => {
  const { securityId, exchangeSegment } = req.query;
  
  if (!securityId) {
    throw new HttpError(400, 'Security ID is required');
  }
  
  const result = await dhanOptions.getOptionQuote(securityId, exchangeSegment);
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json(result.data);
});

exports.getOptionLTPs = asyncHandler(async (req, res) => {
  const { securityIds, exchangeSegment } = req.body;
  
  if (!securityIds || !Array.isArray(securityIds)) {
    throw new HttpError(400, 'Security IDs array is required');
  }
  
  const result = await dhanOptions.getOptionLTPs(securityIds, exchangeSegment);
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json(result.data);
});
