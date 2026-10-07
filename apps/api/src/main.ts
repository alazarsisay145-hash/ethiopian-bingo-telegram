import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { parseEnv } from './config/env.js';

export async function main(): Promise<void> {
  const env = parseEnv();
  const app = await buildApp({ env });
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'Shutting down');
    const timeout = setTimeout(() => {
      app.log.fatal('Graceful shutdown timed out');
      process.exit(1);
    }, 10_000);
    timeout.unref();
    try {
      await app.close();
    } catch {
      app.log.error('Graceful shutdown failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error('API startup failed; check configuration and service availability');
    process.exitCode = 1;
  });
}
