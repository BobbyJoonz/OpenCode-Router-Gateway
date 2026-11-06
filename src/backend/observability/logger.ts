import pino from 'pino';

/**
 * Structured logger.
 *
 * Everything goes to stdout as JSON so it can be shipped by journald / Docker /
 * a log agent without parsing. Secrets are redacted centrally: no module is
 * allowed to log an Authorization header or an API key.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'opencode-router-gateway',
    version: process.env.npm_package_version || '2.0.0',
    pid: process.pid
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'authorization',
      '*.authorization',
      '*.apiKey',
      '*.api_key',
      '*.password',
      '*.secret',
      '*.token',
      'body.api_key'
    ],
    censor: '***'
  },
  formatters: {
    level(label) {
      return { level: label };
    }
  }
});

export type Logger = typeof logger;
