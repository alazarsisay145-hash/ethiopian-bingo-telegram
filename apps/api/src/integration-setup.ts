import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dockerAvailable: boolean;
    postgresUrl: string;
    redisUrl: string;
  }
}

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Starts disposable Postgres and Redis containers once for the whole integration run and applies
 * the committed migrations with `prisma migrate deploy`. Without Docker the suites are skipped
 * (with a clear message) instead of failing.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const stoppers: (() => Promise<unknown>)[] = [];
  try {
    const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    stoppers.push(() => postgres.stop());
    const redis = await new RedisContainer('redis:7-alpine').start();
    stoppers.push(() => redis.stop());
    const postgresUrl = postgres.getConnectionUri();
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: apiRoot,
        env: { ...process.env, DATABASE_URL: postgresUrl },
        stdio: 'pipe',
      });
    } catch (error) {
      await Promise.allSettled(stoppers.map((stop) => stop()));
      throw new Error(`prisma migrate deploy failed: ${(error as { stderr?: Buffer }).stderr?.toString() ?? ''}`);
    }
    project.provide('dockerAvailable', true);
    project.provide('postgresUrl', postgresUrl);
    project.provide('redisUrl', redis.getConnectionUrl());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('prisma migrate deploy failed')) throw error;
    await Promise.allSettled(stoppers.map((stop) => stop()));
    stoppers.length = 0;
    console.warn(
      `[integration] Skipping integration tests: Docker/Testcontainers unavailable (${
        error instanceof Error ? error.message.split('\n')[0] : 'unknown error'
      })`,
    );
    project.provide('dockerAvailable', false);
    project.provide('postgresUrl', '');
    project.provide('redisUrl', '');
  }
  return async () => { await Promise.allSettled(stoppers.map((stop) => stop())); };
}
