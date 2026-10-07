import pino, { type DestinationStream, type Logger } from 'pino';
import type { Env } from '../../config/env.js';

export function createLogger(env: Env, destination?: DestinationStream): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie',
        'req.headers["x-telegram-init-data"]', 'req.body', 'req.query',
        'res.headers["set-cookie"]', 'botToken', 'BOT_TOKEN', 'TELEGRAM_BOT_TOKEN',
        'jwtSecret', 'JWT_SECRET', 'initData', '*.initData',
        '*.botToken', '*.BOT_TOKEN', '*.TELEGRAM_BOT_TOKEN', '*.jwtSecret', '*.JWT_SECRET',
        'SEED_ENCRYPTION_KEY', '*.SEED_ENCRYPTION_KEY',
        'databaseUrl', 'DATABASE_URL', 'redisUrl', 'REDIS_URL',
        '*.databaseUrl', '*.DATABASE_URL', '*.redisUrl', '*.REDIS_URL',
        'err', 'error', '*.err', '*.error', 'env',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req: (request: { method: string; url: string; hostname?: string; remoteAddress?: string }) => ({
        method: request.method,
        url: request.url.split('?')[0],
        hostname: request.hostname,
        remoteAddress: request.remoteAddress,
      }),
    },
    ...(env.NODE_ENV === 'development' ? {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    } : {}),
  }, destination);
}
