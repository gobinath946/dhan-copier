const dhanBypass = require('../services/dhanBypass.service');
const asyncHandler = require('../utils/asyncHandler');
const HttpError = require('../utils/HttpError');

exports.getBypassData = asyncHandler(async (req, res) => {
  const { authKey } = req.headers;
  const { 
    securityId, 
    exchange, 
    segment, 
    instrument, 
    interval, 
    range = '5d',
    endTime 
  } = req.query;

  if (!authKey) {
    throw new HttpError(401, 'Auth key is required');
  }

  // Calculate time range
  const { startTime, endTime: calculatedEndTime } = dhanBypass.calculateBypassTimeRange(
    range,
    endTime ? parseInt(endTime) : null
  );

  const result = await dhanBypass.getDhanBypassData(authKey, {
    securityId,
    exchange,
    segment,
    instrument,
    startTime,
    endTime: calculatedEndTime,
    interval,
  });

  if (!result.ok) {
    throw new HttpError(500, result.error);
  }

  res.json(result.data);
});
