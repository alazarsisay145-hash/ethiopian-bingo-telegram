import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { AppError, ErrorCode } from '@bingo/shared';
import type { Logger } from 'pino';
import { parseEnv, type Env } from './config/env.js';
import type {
  ApplicationEventHandlers,
  AuthenticationPort,
  DependencyProbes,
  GameEventPublisher,
  RateLimiter,
} from './domain/ports.js';
import { ClaimService } from './application/game/claimService.js';
import { DrawService } from './application/game/drawService.js';
import { createGameEventHandlers } from './application/game/gameEventHandlers.js';
import { GameLifecycleService } from './application/game/gameLifecycleService.js';
import { GameRunner } from './application/game/gameRunner.js';
import { GameSettlementService } from './application/game/gameSettlementService.js';
import { GameStateProjector } from './application/game/gameStateProjector.js';
import { GameRoomService } from './application/rooms/gameRoomService.js';
import { LobbyScheduler } from './application/rooms/lobbyScheduler.js';
import { assessReadiness } from './application/readiness.js';
import { AesGcmSeedVault, NodeSecretSource } from './infrastructure/crypto/seedVault.js';
import { createInfrastructure } from './infrastructure/bootstrap.js';
import {
  RepositoryGameFenceProvider,
  RepositoryGameMembership,
} from './infrastructure/game/repositoryGameAccess.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { RedisGameLock } from './infrastructure/redis/gameLock.js';
import { RedisGameOwnershipLease } from './infrastructure/redis/gameOwnershipLease.js';
import { RedisRateLimiter } from './infrastructure/redis/rateLimiter.js';
import { SystemClock, SystemScheduler } from './infrastructure/time/systemScheduler.js';
import { TelegramAuthentication } from './infrastructure/telegram/initData.js';
import { SocketIoGameEventPublisher } from './infrastructure/ws/socketIoGameEventPublisher.js';
import { mapError } from './interfaces/http/errors.js';
import { registerHttpRoutes } from './interfaces/http/routes.js';
import { attachSocketServer, type BingoSocketServer } from './interfaces/ws/socket.js';

export interface BuildAppOptions {
  env?: Env;
  logger?: Logger;
  probes?: DependencyProbes;
  authentication?: AuthenticationPort;
  authorizeUser?: (userId: string) => Promise<void>;
  rateLimiter?: RateLimiter;
  eventHandlers?: ApplicationEventHandlers | ((io: BingoSocketServer) => ApplicationEventHandlers);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? parseEnv();
  const logger: FastifyBaseLogger = options.logger ?? createLogger(env);
  const infrastructure = createInfrastructure(env, logger as Logger, options.probes);
  const repositories = infrastructure.repositories;
  const redis = infrastructure.redis;
  const authentication =
    options.authentication ?? new TelegramAuthentication(env.BOT_TOKEN, {}, repositories?.users);
  const gameRuntime =
    repositories && redis && infrastructure.unitOfWork && env.SEED_ENCRYPTION_KEY
      ? (() => {
          const clock = new SystemClock();
          const scheduler = new SystemScheduler();
          const ownership = new RedisGameOwnershipLease(redis);
          const rateLimiter = options.rateLimiter ?? new RedisRateLimiter(redis);
          const lock = new RedisGameLock(redis, clock, scheduler);
          const vault = new AesGcmSeedVault(env.SEED_ENCRYPTION_KEY);
          const instanceId = randomUUID();
          let publisher: SocketIoGameEventPublisher | undefined;
          const eventPublisher: GameEventPublisher = {
            publishUser: (userId, event, payload) => {
              if (!publisher)
                throw new AppError(ErrorCode.INTERNAL, 500, 'Game publisher is unavailable');
              return publisher.publishUser(userId, event, payload);
            },
            publishRoom: (roomId, event, payload) => {
              if (!publisher)
                throw new AppError(ErrorCode.INTERNAL, 500, 'Game publisher is unavailable');
              return publisher.publishRoom(roomId, event, payload);
            },
          };
          const settlement = new GameSettlementService(
            repositories.games,
            repositories.gameEvents,
            repositories.gamePlayers,
            repositories.claims,
            repositories.ledger,
            ownership,
            vault,
            undefined,
            undefined,
            repositories.auditLogs,
            eventPublisher,
          );
          const draws = new DrawService(
            repositories.games,
            repositories.gameEvents,
            repositories.claims,
            ownership,
            vault,
            lock,
            settlement,
          );
          const claims = new ClaimService(
            repositories.games,
            repositories.rooms,
            repositories.gamePlayers,
            repositories.gameEvents,
            repositories.claims,
            ownership,
            lock,
            vault,
            true,
            repositories.auditLogs,
          );
          const projector = new GameStateProjector(
            repositories.gameEvents,
            repositories.gamePlayers,
          );
          const runner = new GameRunner(
            randomUUID(),
            repositories.games,
            repositories.rooms,
            repositories.gameEvents,
            repositories.gamePlayers,
            ownership,
            draws,
            eventPublisher,
            clock,
            scheduler,
            undefined,
            repositories.auditLogs,
          );
          const lifecycle = new GameLifecycleService(
            repositories.rooms,
            repositories.games,
            repositories.gamePlayers,
            repositories.users,
            repositories.gameEvents,
            new NodeSecretSource(),
            vault,
            lock,
            eventPublisher,
          );
          const gameRooms = new GameRoomService(
            repositories.rooms,
            repositories.games,
            repositories.gamePlayers,
            repositories.users,
            repositories.gameEvents,
            repositories.ledger,
            repositories.auditLogs,
            infrastructure.unitOfWork,
            lifecycle,
            eventPublisher,
            env.MAX_ACTIVE_GAMES_PER_USER,
          );
          const lobby = new LobbyScheduler(
            instanceId,
            repositories.games,
            repositories.rooms,
            repositories.gamePlayers,
            ownership,
            lifecycle,
            runner,
            eventPublisher,
            clock,
            scheduler,
            repositories.auditLogs,
          );
          return {
            runner,
            lobby,
            lifecycle,
            gameRooms,
            claims,
            ownership,
            vault,
            instanceId,
            httpDependencies: {
              env,
              repositories,
              authentication,
              gameRooms,
              lifecycle,
              claims,
              runner,
              ownership,
              vault,
              publisher: eventPublisher,
              instanceId,
              rateLimiter,
            },
            rateLimiter,
            handlers: (io: BingoSocketServer) => {
              publisher = new SocketIoGameEventPublisher(io, redis.duplicate(), redis.duplicate());
              return createGameEventHandlers({
                games: repositories.games,
                players: repositories.gamePlayers,
                events: repositories.gameEvents,
                claims,
                projector,
                membership: new RepositoryGameMembership(repositories.gamePlayers),
                fences: new RepositoryGameFenceProvider(repositories.games),
                publisher: eventPublisher,
                gameRooms,
              });
            },
            close: async () => {
              lobby.stop();
              await runner.stopAll();
              await publisher?.close();
            },
          };
        })()
      : undefined;
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    bodyLimit: 16 * 1024,
    requestTimeout: 30_000,
  });
  if (gameRuntime) {
    app.decorate('gameLifecycleService', gameRuntime.lifecycle);
    app.decorate('gameRunner', gameRuntime.runner);
    registerHttpRoutes(app, gameRuntime.httpDependencies);
  }
  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: false });
  await app.register(sensible);
  await app.register(rateLimit, {
    max: env.HTTP_RATE_LIMIT_MAX,
    timeWindow: env.HTTP_RATE_LIMIT_WINDOW_MS,
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (
      gameRuntime?.rateLimiter &&
      !(await gameRuntime.rateLimiter.consume(
        `http:ip:${request.ip}`,
        env.HTTP_RATE_LIMIT_MAX,
        env.HTTP_RATE_LIMIT_WINDOW_MS,
      ))
    ) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
    }
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
      status: result.ready ? 'ready' : 'not_ready',
      dependencies: result.dependencies,
    });
  });
  const io = attachSocketServer(app.server, {
    authentication,
    handlers: (socketServer) => {
      const gameHandlers = gameRuntime?.handlers(socketServer);
      return typeof options.eventHandlers === 'function'
        ? options.eventHandlers(socketServer)
        : (options.eventHandlers ?? gameHandlers ?? {});
    },
    origins: env.CORS_ORIGINS,
    logger: app.log,
    ...(gameRuntime ? {
      rateLimiter: options.rateLimiter ?? gameRuntime.rateLimiter,
      rateLimitWindowMs: env.WS_RATE_LIMIT_WINDOW_MS,
    } : {}),
    ...(options.rateLimiter && !gameRuntime
      ? { rateLimiter: options.rateLimiter, rateLimitWindowMs: env.WS_RATE_LIMIT_WINDOW_MS }
      : {}),
    ...(options.authorizeUser || repositories
      ? {
          authorizeUser: options.authorizeUser ?? (async (userId: string) => {
            const user = await repositories!.users.findById(userId);
            if (!user || user.status === 'BANNED') {
              throw new AppError(ErrorCode.FORBIDDEN, 403, 'User is banned or unavailable');
            }
          }),
          ...(repositories
            ? { restoreRooms: async (userId: string) =>
                (await repositories.gamePlayers.listByUser(userId)).map(({ gameId }) => `game:${gameId}`) }
            : {}),
        }
      : {}),
  });
  app.addHook('preClose', async () => {
    gameRuntime?.lobby.stop();
    await gameRuntime?.runner.stopAll();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
  app.addHook('onClose', async () => {
    await gameRuntime?.close();
    await infrastructure.close();
  });
  await app.ready();
  if (gameRuntime && repositories) {
    await gameRuntime.runner.recover().catch(() => {
      app.log.error('Game runner recovery failed');
    });
    gameRuntime.runner.startRecovery(5_000);
    await gameRuntime.lobby.recover().catch(() => {
      app.log.error('Lobby recovery failed');
    });
    gameRuntime.lobby.start();
  }
  return app;
}
