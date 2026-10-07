import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { generateCard } from '@bingo/engine';
import { Redis } from 'ioredis';
import { buildApp } from '../../app.js';
import { createFixtures } from '../../integration-support.js';
import { signedInitData, testBotToken, testEnv } from '../../test-support.js';
import { PrismaUserRepository } from '../db/userRepository.js';
import { TelegramAuthentication } from './initData.js';

const enabled = inject('dockerAvailable');

describe.skipIf(!enabled)('Telegram authentication with Postgres and Redis', () => {
  const { db, repos, newGame } = createFixtures(inject('postgresUrl'));
  const authentication = new TelegramAuthentication(testBotToken, {}, repos.users);
  const clients: Socket[] = [];
  let app: FastifyInstance;
  let url: string;
  let identityCounter = 0;

  function credential(id = Date.now() * 100 + identityCounter++, profile = {}) {
    return {
      telegramId: id,
      initData: signedInitData({
        user: JSON.stringify({ id, first_name: 'Telegram test', username: 'original', ...profile }),
      }),
    };
  }

  function connect(initData: string): Promise<Socket> {
    const socket = io(url, {
      auth: { initData }, transports: ['websocket'], reconnection: false, autoConnect: false,
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
      socket.connect();
    });
  }

  function ack(socket: Socket, event: string, payload: unknown): Promise<{
    ok: boolean; error?: { code: string };
  }> {
    return socket.timeout(5000).emitWithAck(event, payload);
  }

  beforeAll(async () => {
    app = await buildApp({
      env: {
        ...testEnv,
        DATABASE_URL: inject('postgresUrl'),
        REDIS_URL: inject('redisUrl'),
        SEED_ENCRYPTION_KEY: 'ab'.repeat(32),
        HTTP_RATE_LIMIT_MAX: 1000,
      },
    });
    url = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    for (const socket of clients) socket.disconnect();
    await app?.close();
    await db.$disconnect();
  });

  it('creates a PLAYER and zero-balance wallet on the first HTTP authentication', async () => {
    const launch = credential();
    const response = await app.inject({
      url: '/api/v1/me', headers: { authorization: `tma ${launch.initData}` },
    });
    expect(response.statusCode).toBe(200);
    const user = await repos.users.findByTelegramId(BigInt(launch.telegramId));
    expect(user).toMatchObject({ role: 'PLAYER', status: 'ACTIVE', username: 'original' });
    expect(user?.lastSeenAt).toBeInstanceOf(Date);
    expect(response.json()).toMatchObject({ id: user?.id, telegramId: String(launch.telegramId) });
    expect(await repos.ledger.getBalance(user!.id)).toBe(0n);
  });

  it('updates only present safe fields on return visits without changing role, status or balance', async () => {
    const launch = credential();
    const first = await authentication.authenticate(launch.initData);
    await repos.users.setRole(first.id, 'ADMIN');
    await repos.ledger.apply({
      userId: first.id, type: 'ADMIN_ADJUSTMENT', amountMinor: 500n,
      idempotencyKey: randomUUID(),
    });
    const next = credential(launch.telegramId, {
      first_name: 'Updated', last_name: 'Profile', username: 'updated',
      language_code: 'am', photo_url: 'https://example.org/avatar.png',
      role: 'SUPER_ADMIN', status: 'BANNED', userId: randomUUID(), balance: 999999,
    });
    const returning = await authentication.authenticate(next.initData);
    expect(returning.id).toBe(first.id);
    expect(await repos.users.findById(first.id)).toMatchObject({
      firstName: 'Updated', lastName: 'Profile', username: 'updated',
      languageCode: 'am', photoUrl: 'https://example.org/avatar.png',
      role: 'ADMIN', status: 'ACTIVE',
    });
    expect(await repos.ledger.getBalance(first.id)).toBe(500n);
    const withoutOptionalFields = signedInitData({
      user: JSON.stringify({ id: launch.telegramId, first_name: 'Still updated' }),
    });
    await authentication.authenticate(withoutOptionalFields);
    expect(await repos.users.findById(first.id)).toMatchObject({
      username: 'updated', lastName: 'Profile', photoUrl: 'https://example.org/avatar.png',
    });
  });

  it('maps concurrent first authentications to one database user and wallet', async () => {
    const launch = credential();
    const identities = await Promise.all(Array.from({ length: 10 }, () =>
      authentication.authenticate(launch.initData)));
    expect(new Set(identities.map(({ id }) => id)).size).toBe(1);
    expect(await db.user.count({ where: { telegramId: BigInt(launch.telegramId) } })).toBe(1);
    expect(await db.wallet.count({ where: { userId: identities[0]!.id } })).toBe(1);
  });

  it('maps two Telegram identities to distinct internal users', async () => {
    const first = await authentication.authenticate(credential().initData);
    const second = await authentication.authenticate(credential().initData);
    expect(first.id).not.toBe(second.id);
    expect(first.telegramId).not.toBe(second.telegramId);
  });

  it('bootstraps ADMIN once but does not re-promote an existing PLAYER', async () => {
    const launch = credential();
    const adminUsers = new PrismaUserRepository(db, [launch.telegramId]);
    const adminAuthentication = new TelegramAuthentication(testBotToken, {}, adminUsers);
    const first = await adminAuthentication.authenticate(launch.initData);
    expect(first.role).toBe('ADMIN');
    await adminUsers.setRole(first.id, 'PLAYER');
    const next = await adminAuthentication.authenticate(launch.initData);
    expect(next.role).toBe('PLAYER');
    expect(await db.auditLog.count({
      where: { action: 'ROLE_BOOTSTRAPPED', targetId: first.id },
    })).toBe(1);
  });

  it.each(['BANNED', 'SUSPENDED'] as const)('rejects a persisted %s user over HTTP and WS', async (status) => {
    const launch = credential();
    const user = await authentication.authenticate(launch.initData);
    await repos.users.setStatus(user.id, status);
    const response = await app.inject({
      url: '/api/v1/me', headers: { authorization: `tma ${launch.initData}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    await expect(connect(launch.initData)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
    expect((await repos.users.findById(user.id))?.status).toBe(status);
  });

  it('uses the same persisted identity over HTTP and WS and never snapshots another card', async () => {
    const firstLaunch = credential();
    const secondLaunch = credential();
    const first = await authentication.authenticate(firstLaunch.initData);
    const second = await authentication.authenticate(secondLaunch.initData);
    const game = await newGame();
    const ownCells = generateCard('authentication-integration', 1).cells;
    const otherCells = generateCard('authentication-integration', 2).cells;
    await repos.gamePlayers.reserveCard({
      gameId: game.id, userId: first.id, cardNumber: 1, cardCells: ownCells,
    });
    await repos.gamePlayers.reserveCard({
      gameId: game.id, userId: second.id, cardNumber: 2, cardCells: otherCells,
    });
    const headers = { authorization: `tma ${firstLaunch.initData}` };
    const response = await app.inject({ url: `/api/v1/games/${game.id}/card`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ cardNumber: 1, cells: ownCells });
    const attempted = await app.inject({
      url: `/api/v1/games/${game.id}/card?userId=${second.id}`, headers,
    });
    expect([403, 404]).toContain(attempted.statusCode);
    expect(attempted.body).not.toContain(JSON.stringify(otherCells));

    const socket = await connect(firstLaunch.initData);
    const snapshot = new Promise<{ game: { yourCard: { cells: number[] } } }>((resolve) =>
      socket.once('state:snapshot', resolve));
    expect(await ack(socket, 'state:resync', { gameId: game.id })).toEqual({ ok: true });
    const state = await snapshot;
    expect(state.game.yourCard.cells).toEqual(ownCells);
    expect(JSON.stringify(state)).not.toContain(JSON.stringify(otherCells));
    expect(await ack(socket, 'state:resync', { gameId: game.id, userId: second.id }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    socket.disconnect();
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    const restoredRoom = new Promise<{ room: { id: string } }>((resolve) =>
      socket.once('room:state', resolve));
    const redis = new Redis(inject('redisUrl'));
    try {
      const room = await repos.rooms.findById(game.roomId);
      await redis.publish(`room:${game.roomId}`, JSON.stringify({
        roomId: game.roomId, event: 'room:state',
        payload: {
          room: {
            id: room!.id, name: room!.name, stakeMinor: Number(room!.stakeMinor),
            cardPoolSize: room!.cardPoolSize, status: 'open',
          },
          playerIds: [first.id, second.id], takenCardNumbers: [1, 2], seq: 0,
        },
      }));
      expect((await restoredRoom).room.id).toBe(game.roomId);
    } finally {
      await redis.quit();
    }
    const restored = new Promise<{ game: { gameId: string; yourCard: { cells: number[] } } }>(
      (resolve) => socket.once('state:snapshot', resolve),
    );
    expect(await ack(socket, 'state:resync', {})).toEqual({ ok: true });
    expect((await restored).game).toMatchObject({ gameId: game.id, yourCard: { cells: ownCells } });
  });

  it('denies HTTP card reads and socket resync to nonmembers', async () => {
    const owner = await authentication.authenticate(credential().initData);
    const outsider = credential();
    const game = await newGame();
    await repos.gamePlayers.reserveCard({
      gameId: game.id, userId: owner.id, cardNumber: 1,
      cardCells: generateCard('authentication-integration', 1).cells,
    });
    const response = await app.inject({
      url: `/api/v1/games/${game.id}/card`,
      headers: { authorization: `tma ${outsider.initData}` },
    });
    expect([403, 404]).toContain(response.statusCode);
    const socket = await connect(outsider.initData);
    expect(await ack(socket, 'state:resync', { gameId: game.id }))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('re-verifies launch freshness on reconnect after expiry', async () => {
    let now = 2_000_000_000_000;
    const launch = credential();
    const expiring = signedInitData({
      auth_date: String(now / 1000),
      user: JSON.stringify({ id: launch.telegramId, first_name: 'Expiring' }),
    });
    const auth = new TelegramAuthentication(testBotToken, { now: () => now, maxAgeSeconds: 60 }, repos.users);
    const testApp = await buildApp({ env: testEnv, authentication: auth });
    const testUrl = await testApp.listen({ port: 0, host: '127.0.0.1' });
    const socket = io(testUrl, {
      auth: { initData: expiring }, transports: ['websocket'], reconnection: false, autoConnect: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        socket.connect();
      });
      socket.disconnect();
      now += 61_000;
      const rejection = new Promise<Error & { data: { code: string } }>((resolve) =>
        socket.once('connect_error', resolve));
      socket.connect();
      expect((await rejection).data.code).toBe('UNAUTHORIZED');
    } finally {
      socket.disconnect();
      await testApp.close();
    }
  });

  it('limits failed HTTP authentication attempts by IP using Redis', async () => {
    const limitedApp = await buildApp({
      env: {
        ...testEnv, DATABASE_URL: inject('postgresUrl'), REDIS_URL: inject('redisUrl'),
        SEED_ENCRYPTION_KEY: 'ab'.repeat(32), HTTP_RATE_LIMIT_MAX: 2,
      },
    });
    try {
      const attempts = [];
      for (let index = 0; index < 3; index++) {
        attempts.push(await limitedApp.inject({
          url: '/api/v1/me', remoteAddress: '198.51.100.17',
          headers: { authorization: 'tma invalid-signature' },
        }));
      }
      expect(attempts.map(({ statusCode }) => statusCode)).toEqual([401, 401, 429]);
      expect(attempts[2]!.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limitedApp.close();
    }
  });

  it('limits verified-user identity substitution failures across different IPs using Redis', async () => {
    const launch = credential();
    const limitedApp = await buildApp({
      env: {
        ...testEnv, DATABASE_URL: inject('postgresUrl'), REDIS_URL: inject('redisUrl'),
        SEED_ENCRYPTION_KEY: 'ab'.repeat(32), HTTP_RATE_LIMIT_MAX: 2,
      },
    });
    try {
      const attempts = [];
      for (let index = 0; index < 3; index++) {
        attempts.push(await limitedApp.inject({
          url: '/api/v1/me', remoteAddress: `198.51.100.${18 + index}`,
          headers: { authorization: `tma ${launch.initData}`, 'x-user-id': randomUUID() },
        }));
      }
      expect(attempts.map(({ statusCode }) => statusCode)).toEqual([403, 403, 429]);
      expect(attempts[2]!.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limitedApp.close();
    }
  });

  it('limits expired signed launches by verified Telegram identity without creating a user', async () => {
    const launch = credential();
    const expired = signedInitData({
      auth_date: '1',
      user: JSON.stringify({ id: launch.telegramId, first_name: 'Expired' }),
    });
    const limitedApp = await buildApp({
      env: {
        ...testEnv, DATABASE_URL: inject('postgresUrl'), REDIS_URL: inject('redisUrl'),
        SEED_ENCRYPTION_KEY: 'ab'.repeat(32), HTTP_RATE_LIMIT_MAX: 2,
      },
    });
    try {
      const attempts = [];
      for (let index = 0; index < 3; index++) {
        attempts.push(await limitedApp.inject({
          url: '/api/v1/me', remoteAddress: `198.51.100.${21 + index}`,
          headers: { authorization: `tma ${expired}` },
        }));
      }
      expect(attempts.map(({ statusCode }) => statusCode)).toEqual([401, 401, 429]);
      expect(await repos.users.findByTelegramId(BigInt(launch.telegramId))).toBeNull();
    } finally {
      await limitedApp.close();
    }
  });
});
