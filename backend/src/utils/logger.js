const pino = require('pino');
const jsonEventLogger = require('./jsonEventLogger');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
    },
  }),
  // Never log access tokens or passwords
  redact: {
    paths: [
      'password',
      'accessToken',
      'access_token',
      'accessTokenEncrypted',
      'authorization',
      '*.password',
      '*.accessToken',
      '*.accessTokenEncrypted',
      'req.headers.authorization',
      'headers["access-token"]',
      'headers.access-token',
    ],
    censor: '[REDACTED]',
  },
  // Hook to capture all logs to JSON
  hooks: {
    logMethod(inputArgs, method) {
      // Capture to JSON file
      try {
        if (inputArgs.length >= 2) {
          const [obj, msg] = inputArgs;
          jsonEventLogger.logEvent({
            type: 'log',
            level: this.levelVal,
            msg,
            data: obj,
          });
        } else if (inputArgs.length === 1) {
          const [msg] = inputArgs;
          jsonEventLogger.logEvent({
            type: 'log',
            level: this.levelVal,
            msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
          });
        }
      } catch (err) {
        // Don't break logging if JSON logger fails
        console.error('[Logger Hook Error]', err.message);
      }
      return method.apply(this, inputArgs);
    },
  },
});

module.exports = logger;
