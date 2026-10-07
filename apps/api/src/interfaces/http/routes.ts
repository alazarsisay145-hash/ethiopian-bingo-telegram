import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { generateDrawSequence, verifySeed } from '@bingo/engine';
import {
  AppError,
  ErrorCode,
  cancelGameBodySchema,
  cardParamsSchema,
  createRoomBodySchema,
  emptyBodySchema,
  gameListQuerySchema,
  gameParamsSchema,
  historyQuerySchema,
  joinGameBodySchema,
  roomParamsSchema,
  updateRoomBodySchema,
  uuidSchema,
} from '@bingo/shared';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../config/env.js';
import type { GameOwnershipLease } from '../../domain/ownership.js';
import type {
  GameEventPublisher,
  AuthenticationPort,
  RateLimiter,
  SeedVault,
} from '../../domain/ports.js';
import type { Repositories } from '../../infrastructure/db/index.js';
import type { GameRunner } from '../../application/game/gameRunner.js';
import type { GameLifecycleService } from '../../application/game/gameLifecycleService.js';
import type { ClaimService } from '../../application/game/claimService.js';
import type { GameRoomService } from '../../application/rooms/gameRoomService.js';
import { rejectIdentityClaims, requireGameMembership, requireRole, requireUser } from './auth.js';
import { validate } from './errors.js';

export interface HttpApiDependencies {
  env: Env;
  repositories: Repositories;
  authentication: AuthenticationPort;
  gameRooms: GameRoomService;
  lifecycle: GameLifecycleService;
  claims: ClaimService;
  runner: GameRunner;
  ownership: GameOwnershipLease;
  vault: SeedVault;
  publisher?: GameEventPublisher;
  instanceId: string;
  rateLimiter?: RateLimiter;
}

function roomDto(
  room: Awaited<ReturnType<Repositories['rooms']['findById']>> extends infer R
    ? NonNullable<R>
    : never,
) {
  const stakeMinor = Number(room.stakeMinor);
  if (!Number.isSafeInteger(stakeMinor)) {
    throw new AppError(ErrorCode.INTERNAL, 500, 'Room stake exceeds the supported range');
  }
  return {
    id: room.id,
    name: room.name,
    stakeMinor,
    cardPoolSize: room.cardPoolSize,
    status: room.status.toLowerCase(),
  };
}

export function registerHttpRoutes(app: FastifyInstance, deps: HttpApiDependencies): void {
  app.decorateRequest('user', null);
  app.decorateRequest('auth', null);
  const auth = requireUser(
    deps.authentication,
    deps.repositories.users,
    deps.rateLimiter,
    deps.env.HTTP_RATE_LIMIT_MAX,
    deps.env.HTTP_RATE_LIMIT_WINDOW_MS,
    deps.env.TELEGRAM_INITDATA_MAX_BYTES,
  );
  const admin = [auth, requireRole('ADMIN', 'SUPER_ADMIN')];
  const gameMember = requireGameMembership(deps.repositories.gamePlayers);
  app.addHook('onRequest', async (request) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (path !== '/api/v1' && !path.startsWith('/api/v1/')) return;
    await auth(request);
    if (path === '/api/v1/admin' || path.startsWith('/api/v1/admin/')) {
      await admin[1]!(request);
    }
  });
  app.addHook('preValidation', async (request) => {
    if (request.auth) rejectIdentityClaims(request);
  });

  app.get('/api/v1/rooms', { preHandler: auth }, async () =>
    (await deps.repositories.rooms.listOpen()).map(roomDto),
  );

  app.get('/api/v1/rooms/:roomId', { preHandler: auth }, async (request) => {
    const { roomId } = validate(roomParamsSchema, request.params);
    const room = await deps.repositories.rooms.findById(roomId);
    if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
    return roomDto(room);
  });

  app.get('/api/v1/rooms/:roomId/cards/:cardNumber', { preHandler: auth }, async (request) => {
    const { roomId, cardNumber } = validate(cardParamsSchema, request.params);
    const room = await deps.repositories.rooms.findById(roomId);
    if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
    if (!Number.isSafeInteger(cardNumber) || cardNumber > room.cardPoolSize) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Card number is outside this room’s pool',
      );
    }
    const game = await deps.repositories.games.findActiveByRoom(roomId);
    const player = game
      ? await deps.repositories.gamePlayers.findByGameAndUser(game.id, request.auth!.userId)
      : null;
    if (!player || player.cardNumber !== cardNumber) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Card ownership required');
    }
    return { cardNumber: player.cardNumber, cells: player.cardCells };
  });

  app.post('/api/v1/rooms/:roomId/games', { preHandler: auth }, async (request, reply) => {
    validateEmptyBody(request.body);
    const { roomId } = validate(roomParamsSchema, request.params);
    const game = await deps.gameRooms.getOrCreateWaitingGame(roomId);
    return reply.code(200).send({
      gameId: game.id,
      roomId: game.roomId,
      status: game.status === 'STARTING' ? 'starting' : 'waiting',
    });
  });

  app.get('/api/v1/games', { preHandler: auth }, async (request) => {
    const { status } = validate(gameListQuerySchema, request.query);
    const statuses =
      status === 'waiting'
        ? (['LOBBY', 'STARTING'] as const)
        : status === 'active'
          ? (['STARTING', 'RUNNING', 'SETTLING'] as const)
          : (['LOBBY', 'STARTING', 'RUNNING', 'SETTLING'] as const);
    const games = await deps.repositories.games.listByStatus([...statuses]);
    return Promise.all(
      games.map(async (game) => {
        const [room, players] = await Promise.all([
          deps.repositories.rooms.findById(game.roomId),
          deps.repositories.gamePlayers.listByGame(game.id),
        ]);
        return {
          gameId: game.id,
          roomId: game.roomId,
          status:
            game.status === 'LOBBY'
              ? 'waiting'
              : game.status === 'STARTING'
                ? 'starting'
                : 'active',
          playerCount: players.length,
          takenCardNumbers: players.map(({ cardNumber }) => cardNumber),
          ...(room ? { room: roomDto(room) } : {}),
        };
      }),
    );
  });

  app.get('/api/v1/games/:gameId', { preHandler: auth }, async (request) => {
    const { gameId } = validate(gameParamsSchema, request.params);
    return deps.gameRooms.getGameState(gameId, request.user!.id);
  });

  app.post('/api/v1/games/:gameId/join', { preHandler: auth }, async (request, reply) => {
    const { gameId } = validate(gameParamsSchema, request.params);
    const { cardNumber } = validate(joinGameBodySchema, request.body);
    const player = await deps.gameRooms.joinGame({
      gameId,
      userId: request.user!.id,
      cardNumber,
      requestId: request.id,
    });
    return reply.code(201).send({ gameId, cardNumber: player.cardNumber });
  });

  app.post('/api/v1/games/:gameId/leave', { preHandler: auth }, async (request, reply) => {
    validateEmptyBody(request.body);
    const { gameId } = validate(gameParamsSchema, request.params);
    await deps.gameRooms.leaveGame(gameId, request.user!.id, request.id);
    return reply.code(204).send();
  });

  app.get('/api/v1/games/:gameId/card', { preHandler: [auth, gameMember] }, async (request) => {
    const { gameId } = validate(gameParamsSchema, request.params);
    return deps.gameRooms.getMyCard(gameId, request.user!.id);
  });

  app.get('/api/v1/games/:gameId/players', { preHandler: [auth, gameMember] }, async (request) => {
    const { gameId } = validate(gameParamsSchema, request.params);
    return deps.gameRooms.listPlayers(gameId, request.user!.id);
  });

  app.post('/api/v1/games/:gameId/claim', { preHandler: [auth, gameMember] }, async (request) => {
    validateEmptyBody(request.body);
    const { gameId } = validate(gameParamsSchema, request.params);
    await deps.gameRooms.getMyCard(gameId, request.user!.id);
    const game = await deps.repositories.games.findById(gameId);
    if (!game || !game.ownerInstanceId)
      throw new AppError(ErrorCode.CONFLICT, 409, 'Game has no active owner');
    const result = await deps.claims.claim(
      { gameId, userId: request.user!.id, requestId: request.id },
      { instanceId: game.ownerInstanceId, fencingToken: game.fencingToken },
    );
    return result;
  });

  app.get(
    '/api/v1/games/:gameId/results',
    {
      preHandler: [auth, gameMember],
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request) => {
      const { gameId } = validate(gameParamsSchema, request.params);
      await deps.gameRooms.getMyCard(gameId, request.user!.id);
      const game = await deps.repositories.games.findById(gameId);
      if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
      if (game.status !== 'ENDED' && game.status !== 'CANCELLED') {
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Results are not available yet');
      }
      const [events, claims] = await Promise.all([
        deps.repositories.gameEvents.listSince(gameId, 0, 1000),
        deps.repositories.claims.listByGame(gameId),
      ]);
      const end = events.find(({ type }) => type === 'GAME_ENDED');
      const endPayload = (end?.payload ?? {}) as {
        winnerIds?: string[];
        drawSequence?: number[];
        seedRevealed?: string;
      };
      let seedRevealed = endPayload.seedRevealed;
      let fairnessVerified = false;
      const drawnNumbers = events
        .filter(({ type }) => type === 'NUMBER_CALLED')
        .map(({ payload }) => (payload as { number: number }).number);
      if (game.seedHash && !seedRevealed) {
        const revealed = await deps.repositories.games.revealSeed(gameId);
        seedRevealed = await deps.vault.open(revealed.seedEncrypted);
      }
      if (game.seedHash && seedRevealed && verifySeed(seedRevealed, game.seedHash)) {
        const expected = generateDrawSequence(seedRevealed);
        fairnessVerified =
          expected
            .slice(0, drawnNumbers.length)
            .every((number, index) => number === drawnNumbers[index]) &&
          (!endPayload.drawSequence ||
            JSON.stringify(endPayload.drawSequence) === JSON.stringify(expected));
      }
      return {
        gameId,
        status: game.status === 'ENDED' ? 'finished' : 'cancelled',
        winners: (endPayload.winnerIds ?? []).map((userId) => ({ userId })),
        patterns: claims.filter((claim) => claim.accepted).flatMap((claim) => claim.patterns),
        payouts: await getPayouts(deps, gameId),
        seedHash: game.seedHash,
        ...(seedRevealed ? { seedRevealed } : {}),
        drawSequence: endPayload.drawSequence ?? drawnNumbers,
        fairnessVerified,
      };
    },
  );

  app.get('/api/v1/me', { preHandler: auth }, async (request) => {
    const { id, telegramId, username, firstName, lastName, role, status } = request.user!;
    return {
      id,
      telegramId: telegramId.toString(),
      username,
      firstName,
      lastName,
      role,
      status,
    };
  });

  app.get('/api/v1/me/wallet', { preHandler: auth }, async (request) => {
    const balance = await deps.repositories.ledger.getBalance(request.user!.id);
    if (balance > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError(ErrorCode.INTERNAL, 500, 'Wallet balance exceeds the supported range');
    }
    return { balanceMinor: Number(balance), currency: 'ETB' };
  });

  app.get('/api/v1/me/games', { preHandler: auth }, async (request) => {
    const { cursor } = validate(historyQuerySchema, request.query);
    const games = await deps.repositories.gamePlayers.listByUser(request.user!.id, [
      'LOBBY',
      'STARTING',
      'RUNNING',
      'SETTLING',
      'ENDED',
      'CANCELLED',
    ]);
    const filtered = cursor ? games.filter(({ joinedAt }) => joinedAt < new Date(cursor)) : games;
    return filtered.slice(0, 50).map(({ gameId, cardNumber }) => ({ gameId, cardNumber }));
  });

  void app.register(
    async function adminRoutes(app) {
      app.addHook('onRequest', requireRole('ADMIN', 'SUPER_ADMIN'));
      app.post('/rooms', async (request, reply) => {
        const input = validate(createRoomBodySchema, request.body);
        const room = await deps.repositories.rooms.create({
          ...input,
          stakeMinor: BigInt(input.stakeMinor),
          activePatterns: input.activePatterns,
          cardPoolSeed: randomBytes(32).toString('base64url'),
          createdById: request.user!.id,
        });
        await deps.repositories.auditLogs.record({
          actorUserId: request.user!.id,
          action: 'ROOM_CREATED',
          targetType: 'room',
          targetId: room.id,
          requestId: request.id,
        });
        return reply.code(201).send(roomDto(room));
      });

      app.patch('/rooms/:roomId', async (request) => {
        const { roomId } = validate(roomParamsSchema, request.params);
        const input = validate(updateRoomBodySchema, request.body);
        const before = await deps.repositories.rooms.findById(roomId);
        if (!before) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
        const minPlayers = input.minPlayers ?? before.minPlayers;
        const maxPlayers = input.maxPlayers ?? before.maxPlayers;
        const cardPoolSize = input.cardPoolSize ?? before.cardPoolSize;
        if (minPlayers < 2 || maxPlayers < minPlayers || maxPlayers > cardPoolSize) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            'Require 2 <= minPlayers <= maxPlayers <= cardPoolSize',
          );
        }
        const { stakeMinor, ...patch } = input;
        const room = await deps.repositories.rooms.update(roomId, {
          ...patch,
          ...(stakeMinor === undefined ? {} : { stakeMinor: BigInt(stakeMinor) }),
        });
        await deps.repositories.auditLogs.record({
          actorUserId: request.user!.id,
          action: 'ROOM_UPDATED',
          targetType: 'room',
          targetId: room.id,
          requestId: request.id,
          before: { name: before.name, status: before.status },
          after: { name: room.name, status: room.status },
        });
        return roomDto(room);
      });

      app.post('/rooms/:roomId/close', async (request) => {
        validateEmptyBody(request.body);
        const { roomId } = validate(roomParamsSchema, request.params);
        const room = await deps.repositories.rooms.update(roomId, { status: 'CLOSED' });
        await deps.repositories.auditLogs.record({
          actorUserId: request.user!.id,
          action: 'ROOM_CLOSED',
          targetType: 'room',
          targetId: roomId,
          requestId: request.id,
        });
        return roomDto(room);
      });

      app.post('/games/:gameId/start', async (request) => {
        validateEmptyBody(request.body);
        const { gameId } = validate(gameParamsSchema, request.params);
        const lease = await deps.ownership.acquire(gameId, deps.instanceId, 10_000);
        if (!lease) throw new AppError(ErrorCode.CONFLICT, 409, 'Game is already being started');
        let started: Awaited<ReturnType<GameLifecycleService['startGame']>>;
        try {
          if (
            !(await deps.repositories.games.tryAcquireOwnership(
              gameId,
              lease.instanceId,
              lease.fencingToken,
            ))
          ) {
            throw new AppError(ErrorCode.CONFLICT, 409, 'Game ownership changed');
          }
          started = await deps.lifecycle.startGame(gameId, {
            instanceId: lease.instanceId,
            fencingToken: lease.fencingToken,
          });
          await deps.repositories.auditLogs.record({
            actorUserId: request.user!.id,
            action: 'GAME_STARTED_BY_ADMIN',
            targetType: 'game',
            targetId: gameId,
            requestId: request.id,
          });
        } finally {
          await deps.ownership.release(lease);
        }
        await deps.runner.start(gameId);
        return { gameId, status: started.game.status.toLowerCase() };
      });

      app.post('/games/:gameId/cancel', async (request) => {
        const { gameId } = validate(gameParamsSchema, request.params);
        const { reason } = validate(cancelGameBodySchema, request.body);
        const players = await deps.repositories.gamePlayers.listByGame(gameId);
        await deps.gameRooms.cancelGame(gameId, reason, request.id);
        if (deps.publisher) {
          await Promise.all(
            players.map(async ({ userId }) => {
              const wallet = await deps.repositories.ledger.getWallet(userId);
              if (wallet.balanceMinor <= BigInt(Number.MAX_SAFE_INTEGER)) {
                await deps.publisher!.publishUser(userId, 'wallet:update', {
                  balanceMinor: Number(wallet.balanceMinor),
                  currency: 'ETB',
                  seq: wallet.version,
                });
              }
            }),
          );
        }
        await deps.repositories.auditLogs.record({
          actorUserId: request.user!.id,
          action: 'GAME_CANCELLED_BY_ADMIN',
          targetType: 'game',
          targetId: gameId,
          requestId: request.id,
          after: { reason },
        });
        return { gameId, status: 'cancelled' };
      });

      app.post('/users/:userId/ban', async (request) => updateUserStatus(request, deps, 'BANNED'));
      app.post('/users/:userId/unban', async (request) =>
        updateUserStatus(request, deps, 'ACTIVE'),
      );

      app.get('/audit', async (request) => {
        const { cursor } = validate(historyQuerySchema, request.query);
        return deps.repositories.auditLogs.list({
          before: cursor ? new Date(cursor) : undefined,
          limit: 50,
        });
      });
    },
    { prefix: '/api/v1/admin' },
  );
}

async function updateUserStatus(
  request: import('fastify').FastifyRequest,
  deps: HttpApiDependencies,
  status: 'ACTIVE' | 'BANNED',
) {
  validateEmptyBody(request.body);
  const { userId } = validate(zUserParams, request.params);
  const user = await deps.repositories.users.setStatus(userId, status);
  await deps.repositories.auditLogs.record({
    actorUserId: request.user!.id,
    action: status === 'BANNED' ? 'USER_BANNED' : 'USER_UNBANNED',
    targetType: 'user',
    targetId: userId,
    requestId: request.id,
  });
  return { id: user.id, status: user.status };
}

const zUserParams = z.object({ userId: uuidSchema }).strict();

function validateEmptyBody(value: unknown): void {
  if (value !== undefined) validate(emptyBodySchema, value);
}

async function getPayouts(deps: HttpApiDependencies, gameId: string) {
  const players = await deps.repositories.gamePlayers.listByGame(gameId);
  const entries = await Promise.all(
    players.map(({ userId }) => deps.repositories.ledger.listByUser(userId)),
  );
  return entries
    .flat()
    .filter((entry) => entry.type === 'PRIZE' && entry.refId === gameId)
    .map((entry) => ({
      userId: entry.userId,
      amountMinor: entry.amountMinor.toString(),
    }));
}
