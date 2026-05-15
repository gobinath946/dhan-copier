require('dotenv').config();

const required = [
  'MONGODB_URI',
  'JWT_SECRET',
  'APP_PASSWORD',
  'ENCRYPTION_KEY',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(`[env] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[env] Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('[env] ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  console.error('[env] Generate one with:');
  console.error('       node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

module.exports = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  appPassword: process.env.APP_PASSWORD,
  encryptionKey: process.env.ENCRYPTION_KEY,
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173,http://192.168.0.104:5173',
  dhanSandboxBaseUrl: process.env.DHAN_SANDBOX_BASE_URL || 'https://sandbox.dhan.co',
  dhanProdBaseUrl: process.env.DHAN_PROD_BASE_URL || 'https://api.dhan.co',
  dhanAccessToken: process.env.DHAN_ACCESS_TOKEN || '',
  dhanClientId: process.env.DHAN_CLIENT_ID || '',
  dhanMode: process.env.DHAN_MODE || 'sandbox',
};
