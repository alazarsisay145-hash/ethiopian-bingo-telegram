import { AppError, ErrorCode } from '@bingo/shared';
import { describe, expect, it, vi } from 'vitest';
import { GAME_STATUS_TRANSITIONS } from '../domain/entities.js';
import { testEnv } from '../test-support.js';
import { createInfrastructure } from './bootstrap.js';
import { isUuid, requireUuid } from './db/errors.js';
import { PostgresProbe } from './db/probe.js';
import type { Db } from './db/prisma.js';
import { RedisGameOwnershipLease } from './redis/gameOwnershipLease.js';
import { RedisProbe } from './redis/probe.js';
import type { RedisClient } from './redis/client.js';
import { createLogger } from './logging/logger.js';

const fakeDb = (query: () => Promise<unknown>): Db =>
  ({ $queryRaw: query }) as unknown as Db;

describe('PostgresProbe', () => {
  it('is available when SELECT 1 succeeds', async () => {
    expect(await new PostgresProbe(fakeDb(async () => [{ ok: 1 }])).check()).toBe(true);
  });
  it('is unavailable on errors and on timeout', async () => {
    expect(await new PostgresProbe(fakeDb(async () => { throw new Error('boom'); })).check()).toBe(false);
    const hang = fakeDb(() => new Promise(() => undefined));
    expect(await new PostgresProbe(hang, 20).check()).toBe(false);
  });
});

describe('RedisProbe', () => {
  it('requires PONG', async () => {
    const redis = (ping: () => Promise<string>): RedisClient => ({ ping }) as unknown as RedisClient;
    expect(await new RedisProbe(redis(async () => 'PONG')).check()).toBe(true);
    expect(await new RedisProbe(redis(async () => 'nope')).check()).toBe(false);
    expect(await new RedisProbe(redis(async () => { throw new Error('down'); })).check()).toBe(false);
  });
});

describe('createInfrastructure', () => {
  const logger = createLogger(testEnv);
  it('creates nothing when nothing is configured', async () => {
    const infra = createInfrastructure(testEnv, logger);
    expect(infra.probes).toEqual({});
    await infra.close();
  });
  it('keeps injected probes instead of creating real clients', async () => {
    const probe = { check: async () => true };
    const infra = createInfrastructure(
      { ...testEnv, DATABASE_URL: 'postgresql://localhost/x', REDIS_URL: 'redis://localhost' },
      logger, { database: probe, redis: probe },
    );
    expect(infra.probes).toEqual({ database: probe, redis: probe });
    await infra.close();
  });
});

describe('RedisGameOwnershipLease argument handling', () => {
  const evalMock = vi.fn();
  const lease = new RedisGameOwnershipLease({ eval: evalMock } as unknown as RedisClient);
  it('maps script results to leases and rejects invalid ttl', async () => {
    evalMock.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    expect(await lease.acquire('g', 'i', 1000)).toEqual({ gameId: 'g', instanceId: 'i', fencingToken: 3n });
    expect(await lease.acquire('g', 'i', 1000)).toBeNull();
    await expect(lease.acquire('g', 'i', 0)).rejects.toThrow(RangeError);
    await expect(lease.heartbeat({ gameId: 'g', instanceId: 'i', fencingToken: 1n }, -1)).rejects.toThrow(RangeError);
  });
});

describe('domain helpers', () => {
  it('validates UUIDs with a validation AppError', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(() => requireUuid("1'; DROP TABLE users;--", 'id')).toThrow(AppError);
    try { requireUuid('x', 'id'); } catch (e) { expect((e as AppError).code).toBe(ErrorCode.VALIDATION_ERROR); }
  });
  it('treats ENDED and CANCELLED as terminal', () => {
    expect(GAME_STATUS_TRANSITIONS.ENDED).toEqual([]);
    expect(GAME_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    expect(GAME_STATUS_TRANSITIONS.LOBBY).not.toContain('RUNNING');
  });
});
