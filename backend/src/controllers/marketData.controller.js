const marketDataService = require('../services/marketData.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');

exports.getNiftyData = asyncHandler(async (req, res) => {
  const { interval = '5m', range = '5d', endTime, dataSource = 'dhan' } = req.query;
  
  const endTimeNum = endTime ? parseInt(endTime, 10) : null;
  
  const result = await marketDataService.getNiftyData(interval, range, endTimeNum, dataSource);
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json(result.data);
});

exports.getBankNiftyData = asyncHandler(async (req, res) => {
  const { interval = '5m', range = '5d', endTime, dataSource = 'dhan' } = req.query;
  
  const endTimeNum = endTime ? parseInt(endTime, 10) : null;
  
  const result = await marketDataService.getBankNiftyData(interval, range, endTimeNum, dataSource);
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json(result.data);
});

exports.getHistoricalData = asyncHandler(async (req, res) => {
  const { symbol, interval = '5m', range = '5d', endTime, dataSource = 'auto' } = req.query;
  
  if (!symbol) {
    throw new HttpError(400, 'Symbol is required');
  }
  
  const endTimeNum = endTime ? parseInt(endTime, 10) : null;
  
  const result = await marketDataService.getHistoricalData(symbol, interval, range, endTimeNum, dataSource);
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json(result.data);
});

exports.testDhanApi = asyncHandler(async (req, res) => {
  const { interval = '5m', range = '5d' } = req.query;
  
  const result = await marketDataService.getNiftyData(interval, range);
  
  if (!result.ok) {
    throw new HttpError(500, result.error);
  }
  
  res.json({
    success: true,
    message: 'Dhan API integration working',
    dataSource: 'Dhan API',
    candleCount: result.data.candles.length,
    data: result.data,
  });
});
