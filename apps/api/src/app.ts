import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { AppError, ErrorCode } from '@bingo/shared';
import type { Logger } from 'pino';
import { parseEnv, type Env } from './config/env.js';
import type { ApplicationEventHandlers, AuthenticationPort, DependencyProbes } from './domain/ports.js';
import { assessReadiness } from './application/readiness.js';
import { createInfrastructure } from './infrastructure/bootstrap.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { TelegramAuthentication } from './infrastructure/telegram/initData.js';
import { mapError } from './interfaces/http/errors.js';
import { attachSocketServer } from './interfaces/ws/socket.js';

export interface BuildAppOptions {
  env?: Env;
  logger?: Logger;
  probes?: DependencyProbes;
  authentication?: AuthenticationPort;
  eventHandlers?: ApplicationEventHandlers;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? parseEnv();
  const logger: FastifyBaseLogger = options.logger ?? createLogger(env);
  const infrastructure = createInfrastructure(env, logger as Logger, options.probes);
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    bodyLimit: 16 * 1024,
    requestTimeout: 30_000,
  });
  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: false });
  await app.register(sensible);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    if (mapped.status === 500) request.log.error({ requestId: request.id }, 'HTTP request failed');
    void reply.code(mapped.status).send(mapped.body);
  });
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    const mapped = mapError(new AppError(ErrorCode.NOT_FOUND, 404, 'Route not found'), request.id);
    void reply.code(mapped.status).send(mapped.body);
  });
  app.get('/healthz', { config: { rateLimit: false } }, () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    const result = await assessReadiness(
      { database: Boolean(env.DATABASE_URL), redis: Boolean(env.REDIS_URL) },
      infrastructure.probes,
    );
    return reply.code(result.ready ? 200 : 503).send({
      status: result.ready ? 'ready' : 'not_ready', dependencies: result.dependencies,
    });
  });
  const io = attachSocketServer(app.server, {
    authentication: options.authentication ?? new TelegramAuthentication(env.BOT_TOKEN),
    handlers: options.eventHandlers ?? {},
    origins: env.CORS_ORIGINS,
    logger: app.log,
  });
  app.addHook('preClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
  app.addHook('onClose', async () => {
    await infrastructure.close();
  });
  await app.ready();
  return app;
}
