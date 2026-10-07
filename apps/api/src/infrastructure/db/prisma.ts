import { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';

export type Db = PrismaClient;

/**
 * Creates the process-wide Prisma client. Connects lazily on first query.
 * Query logging (SQL text only, never parameters) is limited to non-production
 * debug/trace levels. Warning/error messages are not forwarded because Prisma embeds
 * connection details (host, port) in them; the connection string is never logged.
 */
export function createPrismaClient(env: Env, logger: Logger): Db {
  const logQueries = env.NODE_ENV !== 'production' && ['debug', 'trace'].includes(env.LOG_LEVEL);
  const client = new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
      ...(logQueries ? [{ emit: 'event' as const, level: 'query' as const }] : []),
    ],
  });
  const log = logger.child({ component: 'prisma' });
  client.$on('warn', (event) => log.warn({ target: event.target }, 'Prisma warning'));
  client.$on('error', (event) => log.error({ target: event.target }, 'Prisma error'));
  if (logQueries) {
    (client as unknown as { $on(event: 'query', cb: (e: { query: string; duration: number }) => void): void })
      .$on('query', (event) => log.debug({ durationMs: event.duration }, event.query));
  }
  return client;
}
