import Fastify from 'fastify';
import { AppError, ErrorCode } from '@bingo/shared';
import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories } from '../../../test/fakes/inMemoryRepositories.js';
import { GameRoomService } from '../../application/rooms/gameRoomService.js';
import type { AuthenticationPort } from '../../domain/ports.js';
import { testEnv } from '../../test-support.js';
import { mapError } from './errors.js';
import { registerHttpRoutes } from './routes.js';

async function createApi() {
  const repositories = createInMemoryRepositories();
  const users = await Promise.all([
    repositories.users.upsertFromTelegram({ telegramId: 3001n, firstName: 'Player One' }),
    repositories.users.upsertFromTelegram({ telegramId: 3002n, firstName: 'Player Two' }),
  ]);
  for (const user of users) {
    await repositories.ledger.apply({
      userId: user.id,
      type: 'ADMIN_ADJUSTMENT',
      amountMinor: 100n,
      idempotencyKey: `test-fund:${user.id}`,
    });
  }
  const room = await repositories.rooms.create({
    name: 'Open room',
    stakeMinor: 5n,
    minPlayers: 2,
    maxPlayers: 4,
    drawIntervalMs: 5000,
    activePatterns: ['row-1'],
    cardPoolSize: 4,
    cardPoolSeed: 'test-card-pool-seed',
  });
  const lifecycle = {
    createGame: (roomId: string) => repositories.games.create({ roomId }),
    startGame: async (gameId: string) => ({
      game: await repositories.games.findById(gameId),
      players: [],
    }),
  };
  const gameRooms = new GameRoomService(
    repositories.rooms,
    repositories.games,
    repositories.players,
    repositories.users,
    repositories.events,
    repositories.ledger,
    repositories.auditLogs,
    repositories.unitOfWork,
    lifecycle as never,
  );
  const authentication: AuthenticationPort = {
    async authenticate(initData) {
      const user = users[Number(initData)];
      if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Invalid Telegram authentication');
      return {
        id: user.id,
        userId: user.id,
        telegramId: 3001 + Number(initData),
        firstName: user.firstName,
        role: 'PLAYER',
        status: 'ACTIVE',
        authDate: 1,
        verifiedAt: 1000,
      };
    },
  };
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    void reply.code(mapped.status).send(mapped.body);
  });
  registerHttpRoutes(app, {
    env: testEnv,
    repositories: repositories as never,
    authentication,
    gameRooms,
    lifecycle: lifecycle as never,
    claims: {} as never,
    runner: { start: async () => true } as never,
    ownership: {
      acquire: async (gameId: string, instanceId: string) => ({
        gameId,
        instanceId,
        fencingToken: 1n,
      }),
      release: async () => true,
      heartbeat: async () => true,
    },
    vault: { seal: async (seed: string) => seed, open: async (seed: string) => seed },
    instanceId: 'http-test',
  });
  app.post('/api/v1/admin/future-route', () => ({ ok: true }));
  await app.ready();
  const headers = (index = 0) => ({ 'x-telegram-init-data': String(index) });
  return { app, headers, repositories, users, room };
}

describe('player HTTP API', () => {
  it('returns personalized snapshots without another member card or server secrets', async () => {
    const { app, headers, room, users } = await createApi();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${room.id}/games`,
        headers: headers(),
      });
      const gameId = response.json().gameId as string;
      for (const index of [0, 1]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/v1/games/${gameId}/join`,
              headers: headers(index),
              payload: { cardNumber: index + 1, userId: users[index]!.id },
            })
          ).statusCode,
        ).toBe(201);
      }
      const otherCard = await app.inject({
        url: `/api/v1/games/${gameId}/card`,
        headers: headers(1),
      });
      const snapshot = await app.inject({ url: `/api/v1/games/${gameId}`, headers: headers() });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json().yourCard.cardNumber).toBe(1);
      expect(snapshot.body).not.toContain(JSON.stringify(otherCard.json().cells));
      for (const secret of ['cardPoolSeed', 'seedEncrypted', 'seedRevealed', 'drawSequence']) {
        expect(snapshot.body).not.toContain(secret);
      }
    } finally {
      await app.close();
    }
  });

  it('protects every private route before JSON parsing and future admin routes before handlers', async () => {
    const { app, headers, room } = await createApi();
    try {
      for (const url of [
        `/api/v1/rooms/${room.id}/games`,
        '/api/v1/games/not-a-uuid/join',
        '/api/v1/games/not-a-uuid/claim',
        '/api/v1/admin/rooms',
        '/api/v1/admin/future-route',
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url,
              headers: { 'content-type': 'application/json' },
              payload: '{',
            })
          ).statusCode,
        ).toBe(401);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/future-route',
            headers: headers(),
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('authenticates requests, validates UUIDs and rejects mass-assignment', async () => {
    const { app, headers, room } = await createApi();
    try {
      expect((await app.inject('/api/v1/rooms')).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/rooms', headers: headers(99) })).statusCode).toBe(
        401,
      );
      const malformed = await app.inject({ url: '/api/v1/games/not-a-uuid', headers: headers() });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error.code).toBe(ErrorCode.VALIDATION_ERROR);
      const game = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${room.id}/games`,
        headers: headers(),
      });
      expect(game.statusCode).toBe(200);
      const forged = await app.inject({
        method: 'POST',
        url: `/api/v1/games/${game.json().gameId}/join`,
        headers: headers(),
        payload: { cardNumber: 1, userId: 'forged-user' },
      });
      expect(forged.statusCode).toBe(400);
      expect(forged.json().error.code).toBe(ErrorCode.VALIDATION_ERROR);
    } finally {
      await app.close();
    }
  });

  it('returns only a member card and safe public state to a non-member', async () => {
    const { app, headers, room, users } = await createApi();
    try {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${room.id}/games`,
        headers: headers(),
      });
      const gameId = created.json().gameId as string;
      const forgedCreate = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${room.id}/games`,
        headers: headers(),
        payload: { userId: 'another-player' },
      });
      expect(forgedCreate.statusCode).toBe(400);
      const preview = await app.inject({
        url: `/api/v1/rooms/${room.id}/cards/1`,
        headers: headers(),
      });
      expect(preview.statusCode).toBe(403);
      const join = await app.inject({
        method: 'POST',
        url: `/api/v1/games/${gameId}/join`,
        headers: headers(),
        payload: { cardNumber: 1 },
      });
      expect(join.statusCode).toBe(201);
      expect((await app.inject({
        url: `/api/v1/rooms/${room.id}/cards/1`, headers: headers(),
      })).statusCode).toBe(200);
      for (const [index, cardNumber] of [[0, 2], [1, 1]]) {
        expect((await app.inject({
          url: `/api/v1/rooms/${room.id}/cards/${cardNumber}`, headers: headers(index),
        })).statusCode).toBe(403);
      }
      const memberCard = await app.inject({
        url: `/api/v1/games/${gameId}/card`,
        headers: headers(),
      });
      expect(memberCard.json().cardNumber).toBe(1);
      const nonMemberState = await app.inject({
        url: `/api/v1/games/${gameId}`,
        headers: headers(1),
      });
      expect(nonMemberState.statusCode).toBe(200);
      expect(nonMemberState.json()).not.toHaveProperty('yourCard');
      expect(nonMemberState.json().takenCardNumbers).toEqual([1]);
      expect(
        (await app.inject({ url: `/api/v1/games/${gameId}/card`, headers: headers(1) })).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: `/api/v1/games/${gameId}/players`, headers: headers(1) }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/games/${gameId}/claim`,
            headers: headers(1),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: `/api/v1/games/${gameId}/card?userId=${users[0]!.id}`,
            headers: headers(1),
          })
        ).statusCode,
      ).toBe(400);
      const duplicate = await app.inject({
        method: 'POST',
        url: `/api/v1/games/${gameId}/join`,
        headers: headers(),
        payload: { cardNumber: 1 },
      });
      expect(duplicate.statusCode).toBe(409);
      const forgedLeave = await app.inject({
        method: 'POST',
        url: `/api/v1/games/${gameId}/leave`,
        headers: headers(),
        payload: { userId: 'another-player' },
      });
      expect(forgedLeave.statusCode).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/games/${gameId}/leave`,
            headers: headers(),
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/games/${gameId}/leave`,
            headers: headers(),
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('allows only one simultaneous reservation and stake debit for a card', async () => {
    const { app, headers, room } = await createApi();
    try {
      const game = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${room.id}/games`,
        headers: headers(),
      });
      const gameId = game.json().gameId as string;
      const requests = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/v1/games/${gameId}/join`,
          headers: headers(),
          payload: { cardNumber: 2 },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/games/${gameId}/join`,
          headers: headers(1),
          payload: { cardNumber: 2 },
        }),
      ]);
      expect(requests.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
      expect(
        (await app.inject({ url: '/api/v1/me/wallet', headers: headers() })).json().balanceMinor,
      ).toBe(95);
      expect(
        (await app.inject({ url: '/api/v1/me/wallet', headers: headers(1) })).json().balanceMinor,
      ).toBe(100);
    } finally {
      await app.close();
    }
  });
});
