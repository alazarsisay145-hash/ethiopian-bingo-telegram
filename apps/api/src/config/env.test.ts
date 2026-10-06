import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const required = {
  BOT_TOKEN: 'test-only-token',
  JWT_SECRET: 'test-only-signing-secret-at-least-32',
};

describe('environment configuration', () => {
  it('parses defaults without inventing dependencies', () => {
    const env = parseEnv(required);
    expect(env.PORT).toBe(3001);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([]);
  });
  it('parses ports, exact origins, and safe admin IDs', () => {
    expect(parseEnv({
      ...required, PORT: '4000', CORS_ORIGINS: 'https://example.com, http://localhost:5173',
      ADMIN_TELEGRAM_IDS: '123,456', DATABASE_URL: 'postgresql://localhost/bingo',
      REDIS_URL: 'redis://localhost:6379',
    })).toMatchObject({ PORT: 4000, ADMIN_TELEGRAM_IDS: [123, 456] });
  });
  it.each([
    {}, { ...required, JWT_SECRET: 'short' }, { ...required, BOT_TOKEN: ' ' },
    { ...required, PORT: '0' }, { ...required, PORT: '1.5' },
    { ...required, PORT: '65536' }, { ...required, NODE_ENV: 'invalid' },
    { ...required, LOG_LEVEL: 'invalid' }, { ...required, DATABASE_URL: 'invalid' },
    { ...required, CORS_ORIGINS: '*' }, { ...required, CORS_ORIGINS: 'https://example.com/path' },
    { ...required, ADMIN_TELEGRAM_IDS: '9007199254740992' }, { ...required, ADMIN_TELEGRAM_IDS: '1e3' },
  ])('rejects invalid configuration %#', (input) => {
    expect(() => parseEnv(input)).toThrow();
  });
  it('treats blank optional URLs as not configured', () => {
    expect(parseEnv({ ...required, DATABASE_URL: '', REDIS_URL: '' }).DATABASE_URL).toBeUndefined();
  });
});
