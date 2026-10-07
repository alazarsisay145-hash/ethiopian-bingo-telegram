import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@bingo/shared';
import { z } from 'zod';
import { buildApp } from './app.js';
import { testEnv } from './test-support.js';
import { mapError, validate } from './interfaces/http/errors.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { signedInitData, testBotToken } from './test-support.js';

describe('HTTP application', () => {
  it('does not record credentials or URL query secrets in captured HTTP logs', async () => {
    const messages: string[] = [];
    const logger = createLogger(
      { ...testEnv, LOG_LEVEL: 'info' },
      {
        write: (message) => {
          messages.push(message);
        },
      },
    );
    const app = await buildApp({ env: testEnv, logger });
    try {
      const initData = signedInitData();
      await app.inject({
        url: '/unsupported?initData=private-query-secret',
        headers: { authorization: `tma ${initData}`, 'x-telegram-init-data': initData },
      });
      const serialized = messages.join('');
      expect(serialized).toContain('incoming request');
      for (const secret of [initData, testBotToken, 'private-query-secret']) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });
  it('builds without listening and reports healthy process but unconfigured dependencies', async () => {
    const app = await buildApp({ env: testEnv });
    try {
      expect(app.server.listening).toBe(false);
      const health = await app.inject('/healthz');
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      const ready = await app.inject('/readyz');
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({
        status: 'not_ready',
        dependencies: { database: 'not_configured', redis: 'not_configured' },
      });
    } finally {
      await app.close();
    }
  });
  it('reports configured but unreachable services unavailable', async () => {
    const app = await buildApp({
      env: {
        ...testEnv,
        DATABASE_URL: 'postgresql://127.0.0.1:1/bingo',
        REDIS_URL: 'redis://127.0.0.1:1',
      },
    });
    try {
      const result = await app.inject('/readyz');
      expect(result.statusCode).toBe(503);
      expect(result.json().dependencies).toEqual({ database: 'unavailable', redis: 'unavailable' });
    } finally {
      await app.close();
    }
  });
  it('only reports ready when both configured dependency probes succeed', async () => {
    const app = await buildApp({
      env: {
        ...testEnv,
        DATABASE_URL: 'postgresql://localhost/bingo',
        REDIS_URL: 'redis://localhost',
      },
      probes: { database: { check: async () => true }, redis: { check: async () => true } },
    });
    try {
      const result = await app.inject('/readyz');
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({
        status: 'ready',
        dependencies: { database: 'available', redis: 'available' },
      });
    } finally {
      await app.close();
    }
  });
  it('handles failing probes without leaking errors or reporting readiness', async () => {
    const app = await buildApp({
      env: {
        ...testEnv,
        DATABASE_URL: 'postgresql://localhost/bingo',
        REDIS_URL: 'redis://localhost',
      },
      probes: {
        database: {
          check: async () => {
            throw new Error('secret');
          },
        },
        redis: { check: async () => false },
      },
    });
    try {
      const result = await app.inject('/readyz');
      expect(result.statusCode).toBe(503);
      expect(result.json().dependencies).toEqual({ database: 'unavailable', redis: 'unavailable' });
    } finally {
      await app.close();
    }
  });
  it('normalizes missing routes and generates server-controlled unique request IDs', async () => {
    const app = await buildApp({ env: testEnv });
    try {
      const first = await app.inject({ url: '/not-found', headers: { 'x-request-id': 'spoofed' } });
      const second = await app.inject('/not-found');
      expect(first.statusCode).toBe(404);
      expect(first.json().error.code).toBe(ErrorCode.NOT_FOUND);
      expect(first.json().error.requestId).not.toBe('spoofed');
      expect(first.headers['x-request-id']).toBe(first.json().error.requestId);
      expect(first.json().error.requestId).not.toBe(second.json().error.requestId);
    } finally {
      await app.close();
    }
  });
  it('maps application, validation, and unknown errors through HTTP error handler', async () => {
    // Route creation uses a separate Fastify instance because buildApp intentionally returns a ready app.
    const { default: Fastify } = await import('fastify');
    const app = Fastify();
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id);
      void reply.code(mapped.status).send(mapped.body);
    });
    app.get('/app', () => {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Forbidden');
    });
    app.get('/zod', () => validate(z.string(), 1));
    app.get('/unknown', () => {
      throw new Error('private secret');
    });
    try {
      expect((await app.inject('/app')).statusCode).toBe(403);
      expect((await app.inject('/zod')).statusCode).toBe(400);
      const failure = await app.inject('/unknown');
      expect(failure.statusCode).toBe(500);
      expect(failure.body).not.toContain('private secret');
    } finally {
      await app.close();
    }
  });
  it('limits HTTP request rates with normalized errors', async () => {
    const app = await buildApp({ env: testEnv });
    try {
      for (let index = 0; index < 100; index++) await app.inject('/unsupported');
      const result = await app.inject('/unsupported');
      expect(result.statusCode).toBe(429);
      expect(result.json().error.code).toBe(ErrorCode.RATE_LIMITED);
    } finally {
      await app.close();
    }
  });
  it('only reflects explicitly configured CORS origins', async () => {
    const app = await buildApp({ env: { ...testEnv, CORS_ORIGINS: ['https://example.com'] } });
    try {
      const accepted = await app.inject({
        url: '/healthz',
        headers: { origin: 'https://example.com' },
      });
      expect(accepted.headers['access-control-allow-origin']).toBe('https://example.com');
      const rejected = await app.inject({
        url: '/healthz',
        headers: { origin: 'https://untrusted.example' },
      });
      expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
