import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { DependencyProbes } from '../domain/ports.js';
import { createPrismaClient } from './db/prisma.js';
import { PostgresProbe } from './db/probe.js';
import { createRedisClient } from './redis/client.js';
import { RedisProbe } from './redis/probe.js';

export interface Infrastructure {
  probes: DependencyProbes;
  close(): Promise<void>;
}

/**
 * Creates real clients only for configured URLs whose probe was not injected (tests inject
 * fakes). Prisma connects lazily, so a down database never prevents startup; `/readyz` reports it.
 */
export function createInfrastructure(
  env: Env,
  logger: Logger,
  injected: DependencyProbes = {},
): Infrastructure {
  const probes: DependencyProbes = { ...injected };
  const closers: (() => Promise<unknown>)[] = [];
  if (env.DATABASE_URL && !probes.database) {
    const db = createPrismaClient(env, logger);
    probes.database = new PostgresProbe(db);
    closers.push(() => db.$disconnect());
  }
  if (env.REDIS_URL && !probes.redis) {
    const redis = createRedisClient(env.REDIS_URL, logger);
    probes.redis = new RedisProbe(redis);
    closers.push(async () => {
      try { await redis.quit(); } catch { redis.disconnect(); }
    });
  }
  return {
    probes,
    close: async () => { await Promise.allSettled(closers.map((close) => close())); },
  };
}
