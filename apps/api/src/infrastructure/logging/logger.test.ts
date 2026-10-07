import { describe, expect, it } from 'vitest';
import { testEnv } from '../../test-support.js';
import { createLogger } from './logger.js';

describe('production logging', () => {
  it('writes structured JSON while redacting credentials and request queries', () => {
    const output: string[] = [];
    const logger = createLogger({ ...testEnv, NODE_ENV: 'production', LOG_LEVEL: 'info' }, {
      write: (value) => { output.push(value); },
    });
    logger.info({
      req: {
        method: 'GET', url: '/healthz?initData=private-telegram-data',
        headers: { authorization: 'private-bearer', cookie: 'private-cookie' },
      },
      BOT_TOKEN: 'private-bot-token',
      TELEGRAM_BOT_TOKEN: 'private-canonical-token',
      SEED_ENCRYPTION_KEY: 'private-seed-key',
      JWT_SECRET: 'private-jwt-secret',
      DATABASE_URL: 'private-database-url',
      REDIS_URL: 'private-redis-url',
      initData: 'private-telegram-data',
      err: new Error('private-error-message'),
      error: { message: 'private-error-object', stack: 'private-stack' },
      config: {
        botToken: 'private-nested-token', JWT_SECRET: 'private-nested-secret',
        TELEGRAM_BOT_TOKEN: 'private-nested-canonical', SEED_ENCRYPTION_KEY: 'private-nested-seed',
      },
      env: { CUSTOM_SECRET: 'private-environment-value' },
    }, 'Request logged');
    const entry = output.join('');
    expect(entry).not.toContain('private');
    expect(JSON.parse(entry)).toMatchObject({
      req: { method: 'GET', url: '/healthz' },
      BOT_TOKEN: '[REDACTED]', JWT_SECRET: '[REDACTED]',
      TELEGRAM_BOT_TOKEN: '[REDACTED]', SEED_ENCRYPTION_KEY: '[REDACTED]',
      DATABASE_URL: '[REDACTED]', REDIS_URL: '[REDACTED]', initData: '[REDACTED]',
      err: '[REDACTED]', error: '[REDACTED]', env: '[REDACTED]',
      config: { botToken: '[REDACTED]', JWT_SECRET: '[REDACTED]' },
    });
  });
});
