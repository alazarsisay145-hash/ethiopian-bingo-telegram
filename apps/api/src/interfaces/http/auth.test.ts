import Fastify from 'fastify';
import { AppError, ErrorCode } from '@bingo/shared';
import { describe, expect, it } from 'vitest';
import { createInMemoryRepositories } from '../../../test/fakes/inMemoryRepositories.js';
import type { AuthenticationPort } from '../../domain/ports.js';
import { mapError } from './errors.js';
import { requireRole, requireUser } from './auth.js';

describe('HTTP authentication and authorization', () => {
  it('requires verified Telegram initData and resolves roles/status only from persisted users', async () => {
    const repositories = createInMemoryRepositories();
    const player = await repositories.users.upsertFromTelegram({ telegramId: 2001n, firstName: 'Player' });
    const admin = await repositories.users.upsertFromTelegram({ telegramId: 2002n, firstName: 'Admin' });
    await repositories.users.setRole(admin.id, 'ADMIN');
    const authentication: AuthenticationPort = {
      async authenticate(initData) {
        if (initData === 'invalid') throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized');
        return {
          id: initData === 'admin' ? admin.id : player.id,
          telegramId: 2001,
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
    app.get('/admin', {
      preHandler: [requireUser(authentication, repositories.users), requireRole('ADMIN', 'SUPER_ADMIN')],
    }, () => ({ ok: true }));

    try {
      const missing = await app.inject('/me');
      expect(missing.statusCode).toBe(401);
      expect(missing.json().error.code).toBe(ErrorCode.UNAUTHORIZED);
      expect((await app.inject({ url: '/me', headers: { 'x-telegram-init-data': 'invalid' } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/admin', headers: { 'x-telegram-init-data': 'player' } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/admin', headers: { 'x-telegram-init-data': 'admin' } })).statusCode).toBe(200);

      await repositories.users.setStatus(player.id, 'BANNED');
      const banned = await app.inject({ url: '/me', headers: { 'x-telegram-init-data': 'player' } });
      expect(banned.statusCode).toBe(403);
      expect(banned.json().error.code).toBe(ErrorCode.FORBIDDEN);
    } finally {
      await app.close();
    }
  });
});
