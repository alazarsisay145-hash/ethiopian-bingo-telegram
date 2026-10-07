import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AppError, ErrorCode } from '@bingo/shared';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryRepositories } from '../../../test/fakes/inMemoryRepositories.js';
import { InMemoryRateLimiter } from '../../../test/fakes/gameFakes.js';
import type { AuthenticationPort } from '../../domain/ports.js';
import { mapError } from './errors.js';
import {
  rejectIdentityClaims,
  requireActiveUser,
  requireAuth,
  requireGameMembership,
  requireRole,
  requireRoomMembership,
  requireUser,
} from './auth.js';

describe('HTTP authentication and authorization', () => {
  it('honors configurable UTF-8 credential bounds above the default transport limit', async () => {
    const repositories = createInMemoryRepositories();
    const user = await repositories.users.upsertFromTelegram({
      telegramId: 2005n,
      firstName: 'Bounded',
    });
    const authenticate = vi.fn(async () => ({
      id: user.id,
      userId: user.id,
      telegramId: 2005,
      firstName: 'Bounded',
      role: 'PLAYER' as const,
      status: 'ACTIVE' as const,
      authDate: 1,
      verifiedAt: 1000,
    }));
    const app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('auth', null);
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id);
      void reply.code(mapped.status).send(mapped.body);
    });
    app.get(
      '/me',
      {
        onRequest: requireUser(
          { authenticate },
          repositories.users,
          undefined,
          100,
          60_000,
          20_000,
        ),
      },
      () => true,
    );
    try {
      expect(
        (
          await app.inject({
            url: '/me',
            headers: { authorization: `tma ${'a'.repeat(18_000)}` },
          })
        ).statusCode,
      ).toBe(200);
      for (const initData of ['a'.repeat(20_001), '😀'.repeat(6000)]) {
        expect(
          (
            await app.inject({
              url: '/me',
              headers: { 'x-telegram-init-data': initData },
            })
          ).statusCode,
        ).toBe(401);
      }
      expect(authenticate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('uses persisted game and room membership rather than client claims', async () => {
    const findByGameAndUser = vi.fn(async () => null as object | null);
    const players = { findByGameAndUser } as never;
    const findActiveByRoom = vi.fn(async () => ({ id: 'game-1' }));
    const request = {
      auth: { userId: 'verified-user' },
      user: { id: 'forged-profile-user' },
      body: { userId: 'forged-body-user' },
    } as never;
    await expect(requireGameMembership(players, () => 'game-1')(request)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    await expect(
      requireRoomMembership({ findActiveByRoom } as never, players, () => 'room-1')(request),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect(findActiveByRoom).toHaveBeenCalledWith('room-1');
    expect(findByGameAndUser).toHaveBeenCalledWith('game-1', 'verified-user');
    findByGameAndUser.mockResolvedValue({ userId: 'verified-user' });
    await expect(
      requireRoomMembership({ findActiveByRoom } as never, players, () => 'room-1')(request),
    ).resolves.toBeUndefined();
    await expect(requireGameMembership(players)({ auth: null } as never)).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    await expect(
      requireRoomMembership({ findActiveByRoom } as never, players)({ auth: null } as never),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
  });
  it('composes early authentication, active-user policy and ignores only matching identity claims', async () => {
    const repositories = createInMemoryRepositories();
    const user = await repositories.users.upsertFromTelegram({
      telegramId: 2004n,
      firstName: 'Player',
      username: 'real',
    });
    const authenticate = vi.fn(async () => ({
      id: user.id,
      userId: user.id,
      telegramId: 2004,
      firstName: 'Player',
      username: 'real',
      role: 'ADMIN' as const,
      status: 'ACTIVE' as const,
      authDate: 7,
      verifiedAt: 8000,
    }));
    const app = Fastify();
    await app.register(rateLimit, { max: 100, timeWindow: 60_000 });
    app.decorateRequest('user', null);
    app.decorateRequest('auth', null);
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id);
      void reply.code(mapped.status).send(mapped.body);
    });
    app.addHook(
      'onRequest',
      requireAuth({ authenticate }, repositories.users, new InMemoryRateLimiter()),
    );
    app.addHook('onRequest', requireActiveUser());
    app.addHook('preValidation', async (request) => rejectIdentityClaims(request));
    app.post('/intent', (request) => ({
      auth: request.auth,
      body: request.body,
      query: request.query,
    }));
    try {
      const malformed = await app.inject({
        method: 'POST',
        url: '/intent',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(malformed.statusCode).toBe(401);
      for (const authorization of ['******', 'TMA proof', 'tma', 'tma ', 'tma  proof']) {
        const response = await app.inject({
          method: 'POST',
          url: '/intent',
          headers: { authorization },
        });
        expect(response.statusCode).toBe(401);
      }
      const success = await app.inject({
        method: 'POST',
        url: `/intent?telegramId=2004&username=real`,
        headers: {
          authorization: 'tma proof',
          'x-user-id': user.id,
          'x-telegram-id': '2004',
          'x-username': 'real',
          'x-telegram-username': 'real',
        },
        payload: { userId: user.id, telegramId: 2004, username: 'real', cardNumber: 1 },
      });
      expect(success.statusCode).toBe(200);
      expect(success.json()).toEqual({
        auth: {
          userId: user.id,
          telegramId: 2004,
          role: 'PLAYER',
          status: 'ACTIVE',
          authDate: 7,
          verifiedAt: 8000,
        },
        body: { cardNumber: 1 },
        query: {},
      });
      for (const claim of [{ userId: 'forged' }, { telegramId: 999 }, { username: 'forged' }]) {
        const result = await app.inject({
          method: 'POST',
          url: '/intent',
          headers: { authorization: 'tma proof' },
          payload: claim,
        });
        expect(result.statusCode).toBe(400);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/intent?userId=forged',
            headers: { authorization: 'tma proof' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/intent',
            headers: { authorization: 'tma proof', 'x-user-id': 'forged' },
          })
        ).statusCode,
      ).toBe(403);
      for (const headers of [
        { 'x-username': 'forged' },
        { 'x-telegram-username': 'forged' },
        { 'x-username': 'forged', 'x-telegram-username': 'real' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/intent',
              headers: { authorization: 'tma proof', ...headers },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/intent',
            headers: { authorization: 'tma proof', 'x-telegram-init-data': 'different' },
          })
        ).statusCode,
      ).toBe(401);
      await repositories.users.setStatus(user.id, 'BANNED');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/intent',
            headers: { authorization: 'tma proof' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rate limits invalid authentication by IP, never by an unsigned claimed user', async () => {
    const repositories = createInMemoryRepositories();
    const consume = vi.fn(async () => true);
    const authenticate = vi.fn(async () => {
      throw new Error('credential secret');
    });
    const app = Fastify();
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id);
      void reply.code(mapped.status).send(mapped.body);
    });
    app.get(
      '/me',
      { onRequest: requireAuth({ authenticate }, repositories.users, { consume }) },
      () => true,
    );
    try {
      const response = await app.inject({
        url: '/me?userId=forged',
        headers: { authorization: 'tma unsigned', 'x-user-id': 'forged' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('secret');
      expect(consume).toHaveBeenCalledTimes(1);
      expect(consume.mock.calls[0]).toEqual(['auth:http:ip:127.0.0.1', 100, 60000]);
      authenticate.mockRejectedValueOnce(new AppError(ErrorCode.RATE_LIMITED, 429, 'secret proof'));
      const limited = await app.inject({
        url: '/me',
        headers: { authorization: 'tma signed' },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe(ErrorCode.RATE_LIMITED);
      expect(limited.body).not.toContain('secret proof');
    } finally {
      await app.close();
    }
  });
  it('requires verified Telegram initData and resolves roles/status only from persisted users', async () => {
    const repositories = createInMemoryRepositories();
    const player = await repositories.users.upsertFromTelegram({
      telegramId: 2001n,
      firstName: 'Player',
    });
    const admin = await repositories.users.upsertFromTelegram({
      telegramId: 2002n,
      firstName: 'Admin',
    });
    await repositories.users.setRole(admin.id, 'ADMIN');
    const authentication: AuthenticationPort = {
      async authenticate(initData) {
        if (initData === 'invalid') throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized');
        return {
          id: initData === 'admin' ? admin.id : player.id,
          userId: initData === 'admin' ? admin.id : player.id,
          telegramId: initData === 'admin' ? 2002 : 2001,
          role: 'PLAYER',
          status: 'ACTIVE',
          authDate: 1,
          verifiedAt: 1000,
          firstName: 'Client supplied profile',
        };
      },
    };
    const app = Fastify();
    app.decorateRequest('user', null);
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id);
      void reply.code(mapped.status).send(mapped.body);
    });
    app.get('/me', { preHandler: requireUser(authentication, repositories.users) }, (request) => ({
      id: request.user!.id,
      role: request.user!.role,
      firstName: request.user!.firstName,
    }));
    app.get(
      '/admin',
      {
        preHandler: [
          requireUser(authentication, repositories.users),
          requireRole('ADMIN', 'SUPER_ADMIN'),
        ],
      },
      () => ({ ok: true }),
    );

    try {
      const missing = await app.inject('/me');
      expect(missing.statusCode).toBe(401);
      expect(missing.json().error.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(
        (await app.inject({ url: '/me', headers: { 'x-telegram-init-data': 'invalid' } }))
          .statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ url: '/admin', headers: { 'x-telegram-init-data': 'player' } }))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: '/admin', headers: { 'x-telegram-init-data': 'admin' } }))
          .statusCode,
      ).toBe(200);

      await repositories.users.setStatus(player.id, 'BANNED');
      const banned = await app.inject({
        url: '/me',
        headers: { 'x-telegram-init-data': 'player' },
      });
      expect(banned.statusCode).toBe(403);
      expect(banned.json().error.code).toBe(ErrorCode.FORBIDDEN);
    } finally {
      await app.close();
    }
  });

  it('limits authenticated HTTP requests by persisted user id', async () => {
    const repositories = createInMemoryRepositories();
    const user = await repositories.users.upsertFromTelegram({
      telegramId: 2003n,
      firstName: 'Limited',
    });
    const app = Fastify();
    app.decorateRequest('user', null);
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id);
      void reply.code(mapped.status).send(mapped.body);
    });
    const authentication: AuthenticationPort = {
      async authenticate() {
        return {
          id: user.id,
          userId: user.id,
          telegramId: 2003,
          firstName: 'Limited',
          role: 'PLAYER',
          status: 'ACTIVE',
          authDate: 1,
          verifiedAt: 1000,
        };
      },
    };
    app.get(
      '/limited',
      {
        preHandler: requireUser(
          authentication,
          repositories.users,
          new InMemoryRateLimiter(),
          1,
          60_000,
        ),
      },
      () => ({ ok: true }),
    );
    try {
      const headers = { 'x-telegram-init-data': 'verified' };
      expect((await app.inject({ url: '/limited', headers })).statusCode).toBe(200);
      const limited = await app.inject({ url: '/limited', headers });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe(ErrorCode.RATE_LIMITED);
    } finally {
      await app.close();
    }
  });
});
