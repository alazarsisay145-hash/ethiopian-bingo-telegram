import { Redis } from 'ioredis';
import type { Logger } from 'pino';

/**
 * Creates the shared Redis client. Commands fail fast (maxRetriesPerRequest) when Redis is unreachable
 * so readiness reports honestly. The URL is never logged.
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  const log = logger.child({ component: 'redis' });
  let reportedDown = false;
  client.on('error', () => {
    if (!reportedDown) log.error('Redis connection error');
    reportedDown = true;
  });
  client.on('ready', () => {
    if (reportedDown) log.info('Redis connection restored');
    reportedDown = false;
  });
  return client;
}

export type RedisClient = Redis;
