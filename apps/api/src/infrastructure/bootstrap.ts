import type { Logger } from 'pino';
import type { Env } from '../config/env.js';
import type { DependencyProbes } from '../domain/ports.js';
import { createPrismaClient } from './db/prisma.js';
import { createRepositories, type Repositories } from './db/index.js';
import { PrismaUnitOfWork } from './db/unitOfWork.js';
import type { UnitOfWork } from '../domain/ports.js';
import type { Db } from './db/prisma.js';
import type { RedisClient } from './redis/client.js';
import { PostgresProbe } from './db/probe.js';
import { createRedisClient } from './redis/client.js';
import { RedisProbe } from './redis/probe.js';

export interface Infrastructure {
  probes: DependencyProbes;
  repositories?: Repositories;
  unitOfWork?: UnitOfWork;
  db?: Db;
  redis?: RedisClient;
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
  let db: Db | undefined;
  let redis: RedisClient | undefined;
  if (env.DATABASE_URL && !probes.database) {
    const databaseClient = createPrismaClient(env, logger);
    db = databaseClient;
    probes.database = new PostgresProbe(databaseClient);
    closers.push(() => databaseClient.$disconnect());
  }
  if (env.REDIS_URL && !probes.redis) {
    const redisClient = createRedisClient(env.REDIS_URL, logger);
    redis = redisClient;
    probes.redis = new RedisProbe(redisClient);
    closers.push(async () => {
      try { await redisClient.quit(); } catch { redisClient.disconnect(); }
    });
  }
  return {
    probes,
    ...(db ? {
      db,
      repositories: createRepositories(db, false, env.ADMIN_TELEGRAM_IDS),
    } : {}),
    ...(db ? { unitOfWork: new PrismaUnitOfWork(db) } : {}),
    ...(redis ? { redis } : {}),
    close: async () => { await Promise.allSettled(closers.map((close) => close())); },
  };
}
