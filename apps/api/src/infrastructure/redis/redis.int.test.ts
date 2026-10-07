import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { PostgresProbe } from '../db/probe.js';
import { createTestDb } from '../../integration-support.js';
import { createRedisClient } from './client.js';
import { RedisGameOwnershipLease } from './gameOwnershipLease.js';
import { RedisProbe } from './probe.js';
import { buildApp } from '../../app.js';
import { createLogger } from '../logging/logger.js';
import { testEnv } from '../../test-support.js';

const enabled = inject('dockerAvailable');
if (!enabled) console.warn('[integration] Docker unavailable: skipping Redis/probe tests');
const deadUrl = (scheme: string, port: number): string => `${scheme}://127.0.0.1:${port}/0`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)('Redis ownership lease', () => {
  const redis = createRedisClient(inject('redisUrl'), createLogger(testEnv));
  const lease = new RedisGameOwnershipLease(redis);
  afterAll(async () => { await redis.quit(); });

  it('prevents a second instance from acquiring while held, then allows it after release', async () => {
    const gameId = randomUUID();
    const a = await lease.acquire(gameId, 'a', 5000);
    expect(a).not.toBeNull();
    expect(await lease.acquire(gameId, 'b', 5000)).toBeNull();
    expect(await lease.acquire(gameId, 'a', 5000)).toBeNull();
    expect(await redis.get(`game:{${gameId}}:owner`)).toBe(`a:${a?.fencingToken}`);
    expect(await lease.release(a!)).toBe(true);
    expect(await lease.release(a!)).toBe(false);
    const b = await lease.acquire(gameId, 'b', 5000);
    expect(b).not.toBeNull();
    expect(b!.fencingToken).toBeGreaterThan(a!.fencingToken);
  });

  it('extends on heartbeat and refuses heartbeat/release from a stale holder', async () => {
    const gameId = randomUUID();
    const a = (await lease.acquire(gameId, 'a', 300))!;
    await sleep(150);
    expect(await lease.heartbeat(a, 1000)).toBe(true);
    await sleep(300);
    expect(await lease.acquire(gameId, 'b', 1000)).toBeNull();
    expect(await redis.pttl(`game:{${gameId}}:owner`)).toBeGreaterThan(0);
    await sleep(900);
    expect(await lease.heartbeat(a, 1000)).toBe(false);
    const b = (await lease.acquire(gameId, 'b', 5000))!;
    expect(await lease.heartbeat(a, 1000)).toBe(false);
    expect(await lease.release(a)).toBe(false);
    expect(await lease.heartbeat(b, 1000)).toBe(true);
  });

  it('issues strictly increasing fencing tokens and lets an expired lease be re-acquired', async () => {
    const gameId = randomUUID();
    const tokens: bigint[] = [];
    for (let i = 0; i < 4; i += 1) {
      const held = await lease.acquire(gameId, `i${i}`, 100);
      expect(held).not.toBeNull();
      tokens.push(held!.fencingToken);
      await sleep(180);
    }
    expect(tokens).toEqual([1n, 2n, 3n, 4n]);
  });

  it('gives exactly one winner under concurrent acquisition', async () => {
    const gameId = randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => lease.acquire(gameId, `n${i}`, 5000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe.skipIf(!enabled)('dependency probes', () => {
  it('report available against live containers and unavailable once closed', async () => {
    const redis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: 1 });
    const db = createTestDb(inject('postgresUrl'));
    try {
      expect(await new RedisProbe(redis).check()).toBe(true);
      expect(await new PostgresProbe(db).check()).toBe(true);
    } finally {
      redis.disconnect();
      await db.$disconnect();
    }
    expect(await new RedisProbe(redis).check()).toBe(false);
  });
});

describe.skipIf(!enabled)('composition root with real dependencies', () => {
  it('reports /readyz available for live containers and unavailable for dead ones', async () => {
    const live = await buildApp({
      env: { ...testEnv, DATABASE_URL: inject('postgresUrl'), REDIS_URL: inject('redisUrl') },
    });
    try {
      const ready = await live.inject('/readyz');
      expect(ready.statusCode).toBe(200);
      expect(ready.json().dependencies).toEqual({ database: 'available', redis: 'available' });
    } finally { await live.close(); }
    const dead = await buildApp({
      env: { ...testEnv, DATABASE_URL: deadUrl('postgresql', 1), REDIS_URL: deadUrl('redis', 1) },
    });
    try {
      const down = await dead.inject('/readyz');
      expect(down.statusCode).toBe(503);
      expect(down.json().dependencies).toEqual({ database: 'unavailable', redis: 'unavailable' });
    } finally { await dead.close(); }
  });
});
