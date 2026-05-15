const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

async function connectDB() {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 8000,
    });
    logger.info({ uri: maskUri(env.mongoUri) }, 'MongoDB connected');
  } catch (err) {
    logger.error({ err: err.message }, 'MongoDB connection failed');
    throw err;
  }

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('error', (err) => {
    logger.error({ err: err.message }, 'MongoDB error');
  });
}

function maskUri(uri) {
  return uri.replace(/(mongodb(?:\+srv)?:\/\/)([^:]+):([^@]+)@/, '$1$2:***@');
}

module.exports = { connectDB };
