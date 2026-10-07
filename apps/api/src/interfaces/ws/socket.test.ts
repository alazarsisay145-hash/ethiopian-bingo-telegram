import { afterEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { AppError, ErrorCode } from '@bingo/shared';
import type { ErrorDto } from '@bingo/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../app.js';
import { signedInitData, testEnv } from '../../test-support.js';
import { InMemoryRateLimiter } from '../../../test/fakes/gameFakes.js';
import { createInMemoryRepositories } from '../../../test/fakes/inMemoryRepositories.js';
import { TelegramAuthentication } from '../../infrastructure/telegram/initData.js';
import { testBotToken } from '../../test-support.js';
import pino from 'pino';

let app: FastifyInstance | undefined;
const clients: Socket[] = [];

async function start(options: BuildAppOptions = {}): Promise<string> {
  const repositories = createInMemoryRepositories();
  app = await buildApp({
    env: testEnv,
    authentication: new TelegramAuthentication(testBotToken, {}, repositories.users),
    ...options,
  });
  return app.listen({ port: 0, host: '127.0.0.1' });
}

function client(url: string, auth?: unknown): Socket {
  const socket = io(url, {
    auth,
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
  });
  clients.push(socket);
  return socket;
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
    socket.connect();
  });
}

function rejected(socket: Socket): Promise<Error & { data?: { code?: string } }> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => reject(new Error('Unexpected authenticated connection')));
    socket.once('connect_error', resolve);
    socket.connect();
  });
}

function errorEvent(socket: Socket): Promise<ErrorDto> {
  return new Promise((resolve) => socket.once('error', resolve));
}

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await app?.close();
  app = undefined;
});

describe('Socket.IO authentication and intent boundary', () => {
  it.each([16_384, 25_000])(
    'honors a configured %i-byte signed credential limit',
    async (maxBytes) => {
      const repositories = createInMemoryRepositories();
      const socket = client(
        await start({
          env: { ...testEnv, TELEGRAM_INITDATA_MAX_BYTES: maxBytes },
          authentication: new TelegramAuthentication(
            testBotToken,
            { maxBytes },
            repositories.users,
          ),
        }),
        { initData: signedInitData({ query_id: 'a'.repeat(18_000) }) },
      );
      if (maxBytes < 18_000) {
        expect((await rejected(socket)).data?.code).toBe(ErrorCode.UNAUTHORIZED);
      } else {
        await connected(socket);
        expect(socket.connected).toBe(true);
      }
    },
  );

  it('restores both active room/game channels before connection and stores server auth context', async () => {
    const restoreRooms = vi.fn(async () => ['room:active-room', 'game:active-game']);
    const observe = vi.fn();
    const socket = client(
      await start({
        restoreRooms,
        eventHandlers: (io) => {
          io.on('connection', (serverSocket) =>
            observe(serverSocket.data.auth, [...serverSocket.rooms]),
          );
          return {};
        },
      }),
      { initData: signedInitData() },
    );
    await connected(socket);
    expect(restoreRooms).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: expect.any(String),
        telegramId: 12345,
        role: 'PLAYER',
        status: 'ACTIVE',
      }),
      expect.arrayContaining(['room:active-room', 'game:active-game']),
    );
  });

  it('does not log signed data, bot tokens, or handler exception credentials through Pino', async () => {
    const messages: string[] = [];
    const logger = pino(
      { level: 'info' },
      {
        write: (message) => {
          messages.push(message);
        },
      },
    );
    const initData = signedInitData();
    const socket = client(
      await start({
        logger,
        eventHandlers: {
          'room:join': async () => {
            throw new Error('private-password-and-token');
          },
        },
      }),
      { initData },
    );
    await connected(socket);
    const response = new Promise((resolve) =>
      socket.emit('room:join', { roomId: 'room-1' }, resolve),
    );
    await response;
    const serialized = messages.join('');
    expect(serialized).toContain('Socket handler failed');
    for (const secret of [initData, testBotToken, 'private-password-and-token']) {
      expect(serialized).not.toContain(secret);
    }
  });
  it('accepts real verified Telegram initData', async () => {
    const url = await start();
    const socket = client(url, { initData: signedInitData() });
    await connected(socket);
    expect(socket.connected).toBe(true);
  });
  it.each([undefined, {}, { initData: '' }, { initData: 123 }, { initData: 'tampered' }])(
    'rejects absent or invalid authentication %#',
    async (auth) => {
      const socket = client(await start(), auth);
      const error = await rejected(socket);
      expect(error.message).toBe('UNAUTHORIZED');
      expect(error.data?.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(socket.connected).toBe(false);
    },
  );
  it('rejects expired authenticated data', async () => {
    const socket = client(await start(), { initData: signedInitData({ auth_date: '1' }) });
    expect((await rejected(socket)).message).toBe('UNAUTHORIZED');
  });
  it('rejects forged handshake identities and ignores matching claims', async () => {
    const url = await start();
    for (const claim of [{ userId: 'forged' }, { telegramId: 999 }, { username: 'forged' }]) {
      const error = await rejected(client(url, { initData: signedInitData(), ...claim }));
      expect(error.data?.code).toBe(ErrorCode.FORBIDDEN);
    }
    const socket = client(url, {
      initData: signedInitData(),
      telegramId: 12345,
      username: 'tester',
    });
    await connected(socket);
    expect(socket.connected).toBe(true);
  });
  it('rejects identity claims smuggled through socket headers and query parameters', async () => {
    const url = await start();
    for (const options of [
      { query: { telegramId: '999' } },
      { extraHeaders: { 'x-user-id': 'forged' } },
      { extraHeaders: { 'x-telegram-id': '999' } },
      { extraHeaders: { 'x-username': 'forged' } },
      { extraHeaders: { 'x-telegram-username': 'forged' } },
      { extraHeaders: { 'x-username': 'forged', 'x-telegram-username': 'tester' } },
    ]) {
      const socket = io(url, {
        auth: { initData: signedInitData() },
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        ...options,
      });
      clients.push(socket);
      expect((await rejected(socket)).data?.code).toBe(ErrorCode.FORBIDDEN);
    }
    const matching = io(url, {
      auth: { initData: signedInitData() },
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      extraHeaders: {
        'x-telegram-id': '12345',
        'x-username': 'tester',
        'x-telegram-username': 'tester',
      },
    });
    clients.push(matching);
    await connected(matching);
  });
  it('consumes verified-user handshake budget before rejecting identity claims', async () => {
    let attempts = 0;
    const consume = vi.fn(
      async (key: string) => !key.startsWith('auth:ws:user:') || ++attempts <= 2,
    );
    const url = await start({ rateLimiter: { consume } });
    for (const expected of [ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN, ErrorCode.RATE_LIMITED]) {
      const socket = client(url, { initData: signedInitData(), telegramId: 999 });
      expect((await rejected(socket)).data?.code).toBe(expected);
    }
    const userKeys = consume.mock.calls
      .map(([key]) => key)
      .filter((key) => key.startsWith('auth:ws:user:'));
    expect(userKeys).toHaveLength(3);
    expect(new Set(userKeys).size).toBe(1);
    expect(userKeys[0]).not.toContain('999');
  });
  it('revalidates signed freshness on reconnect instead of trusting a previous connection', async () => {
    const socket = client(await start(), { initData: signedInitData() });
    await connected(socket);
    socket.disconnect();
    socket.auth = { initData: signedInitData({ auth_date: '1' }) };
    expect((await rejected(socket)).data?.code).toBe(ErrorCode.UNAUTHORIZED);
  });
  it('limits authentication failures by IP with a stable structured code', async () => {
    const consume = vi.fn(async () => false);
    const socket = client(await start({ rateLimiter: { consume } }), {
      initData: 'unsigned',
      userId: 'forged',
    });
    expect((await rejected(socket)).data?.code).toBe(ErrorCode.RATE_LIMITED);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.[0]).toMatch(/^auth:ws:ip:/);
    expect(JSON.stringify(consume.mock.calls)).not.toContain('forged');
  });
  it('limits stale signed proofs by verified Telegram identity, never by an unsigned claim', async () => {
    const consume = vi.fn(async (key: string) => !key.startsWith('auth:telegram:'));
    const url = await start({ authentication: undefined, rateLimiter: { consume } });
    const unsigned = client(url, { initData: 'unsigned', telegramId: 999 });
    expect((await rejected(unsigned)).data?.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(consume.mock.calls.map(([key]) => key)).not.toContain('auth:telegram:999');
    expect(consume.mock.calls.some(([key]) => key.startsWith('auth:telegram:'))).toBe(false);
    const signed = client(url, { initData: signedInitData({ auth_date: '1' }) });
    expect((await rejected(signed)).data?.code).toBe(ErrorCode.RATE_LIMITED);
    expect(consume.mock.calls.map(([key]) => key)).toContain('auth:telegram:12345');
  });
  it('rejects a persisted banned user rather than allowing a socket session', async () => {
    const socket = client(
      await start({
        authentication: {
          authenticate: async () => {
            throw new AppError(ErrorCode.FORBIDDEN, 403, 'User is banned');
          },
        },
      }),
      { initData: 'verified' },
    );
    const error = await rejected(socket);
    expect(error.data?.code).toBe(ErrorCode.FORBIDDEN);
  });
  it('rejects untrusted browser origins even for websocket transport', async () => {
    const socket = io(await start(), {
      auth: { initData: signedInitData() },
      transports: ['websocket'],
      extraHeaders: { origin: 'https://untrusted.example' },
      reconnection: false,
      autoConnect: false,
    });
    clients.push(socket);
    expect((await rejected(socket)).message).toBe('websocket error');
  });
  it('uses an injected authentication port rather than an unverified handshake user', async () => {
    const authenticate = vi.fn(async () => ({
      id: 'trusted',
      userId: 'trusted',
      telegramId: 99,
      firstName: 'Trusted',
      role: 'PLAYER' as const,
      status: 'ACTIVE' as const,
      authDate: 1,
      verifiedAt: 1000,
    }));
    const handler = vi.fn(async () => undefined);
    const url = await start({
      authentication: { authenticate },
      eventHandlers: { 'room:join': handler },
    });
    const socket = client(url, { initData: 'adapter-proof', user: { id: 'forged' } });
    await connected(socket);
    await new Promise<void>((resolve) => socket.emit('room:join', { roomId: 'room-1' }, resolve));
    expect(authenticate).toHaveBeenCalledWith('adapter-proof');
    expect(handler).toHaveBeenCalledWith(
      { roomId: 'room-1' },
      expect.objectContaining({
        user: expect.objectContaining({ id: 'trusted', telegramId: 99, firstName: 'Trusted' }),
      }),
    );
  });
  it('validates incoming intents before executing handlers', async () => {
    const handler = vi.fn(async () => undefined);
    const socket = client(await start({ eventHandlers: { 'card:select': handler } }), {
      initData: signedInitData(),
    });
    await connected(socket);
    const failure = errorEvent(socket);
    socket.emit('card:select', { roomId: 'room-1', cardNumber: -1 });
    expect((await failure).error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    'room:join',
    'room:leave',
    'card:select',
    'card:release',
    'game:ready',
    'game:claim',
    'state:resync',
  ])('rejects injected userId on every %s intent, even when matching', async (event) => {
    const handler = vi.fn(async () => undefined);
    let userId = '';
    const socket = client(
      await start({
        eventHandlers: (io) => {
          io.once('connection', (socket) => {
            userId = socket.data.auth.userId;
          });
          return { [event]: handler };
        },
      }),
      {
        initData: signedInitData(),
      },
    );
    await connected(socket);
    const payload =
      event === 'state:resync'
        ? { gameId: 'game-1', lastSeq: 0 }
        : event === 'game:claim'
          ? { gameId: 'game-1' }
          : event === 'card:select'
            ? { roomId: 'room-1', cardNumber: 1 }
            : { roomId: 'room-1' };
    const response = new Promise<{ ok: boolean; error: { code: string } }>((resolve) =>
      socket.emit(event, { ...payload, userId }, resolve),
    );
    expect(await response).toMatchObject({
      ok: false,
      error: { code: ErrorCode.VALIDATION_ERROR },
    });
    expect(handler).not.toHaveBeenCalled();
  });
  it('applies per-user WebSocket intent limits', async () => {
    const handler = vi.fn(async () => undefined);
    const socket = client(
      await start({
        rateLimiter: new InMemoryRateLimiter(),
        eventHandlers: { 'game:claim': handler },
      }),
      { initData: signedInitData() },
    );
    await connected(socket);
    for (let index = 0; index < 5; index += 1) {
      const result = new Promise<{ ok: boolean }>((resolve) =>
        socket.emit('game:claim', { gameId: 'game-1' }, resolve),
      );
      await expect(result).resolves.toEqual({ ok: true });
    }
    const limited = new Promise<{ ok: boolean; error?: { code: string } }>((resolve) =>
      socket.emit('game:claim', { gameId: 'game-1' }, resolve),
    );
    expect(await limited).toMatchObject({ ok: false, error: { code: ErrorCode.RATE_LIMITED } });
    expect(handler).toHaveBeenCalledTimes(5);
  });
  it.each([
    'room:join',
    'room:leave',
    'card:select',
    'card:release',
    'game:ready',
    'game:claim',
    'state:resync',
    'unsupported:event',
  ])('rechecks persisted user status before %s', async (event) => {
    const handler = vi.fn(async () => undefined);
    let banned = false;
    const socket = client(
      await start({
        authorizeUser: async () => {
          if (banned) throw new AppError(ErrorCode.FORBIDDEN, 403, 'User was banned');
        },
        eventHandlers: { [event]: handler },
      }),
      { initData: signedInitData() },
    );
    await connected(socket);
    banned = true;
    const result = new Promise<{ ok: boolean; error?: { code: string } }>((resolve) =>
      socket.emit(event, {}, resolve),
    );
    expect(await result).toMatchObject({ ok: false, error: { code: ErrorCode.FORBIDDEN } });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([
    'room:join',
    'room:leave',
    'card:select',
    'card:release',
    'game:ready',
    'game:claim',
    'state:resync',
  ])('reports unimplemented %s explicitly without inventing game work', async (event) => {
    const socket = client(await start(), { initData: signedInitData() });
    await connected(socket);
    const failure = errorEvent(socket);
    const payload =
      event === 'state:resync'
        ? { gameId: 'game-1', lastSeq: 0 }
        : event === 'game:claim'
          ? { gameId: 'game-1' }
          : event === 'card:select'
            ? { roomId: 'room-1', cardNumber: 1 }
            : { roomId: 'room-1' };
    socket.emit(event, payload);
    expect((await failure).error.code).toBe(ErrorCode.NOT_FOUND);
  });
  it('reports unknown events as unsupported', async () => {
    const socket = client(await start(), { initData: signedInitData() });
    await connected(socket);
    const failure = errorEvent(socket);
    socket.emit('payments:withdraw', { amount: 100 });
    expect((await failure).error).toMatchObject({
      code: ErrorCode.NOT_FOUND,
      message: 'Unsupported event',
    });
  });
  it('normalizes handler failures without leaking internals', async () => {
    const socket = client(
      await start({
        eventHandlers: {
          'room:join': async () => {
            throw new Error('database secret');
          },
        },
      }),
      { initData: signedInitData() },
    );
    await connected(socket);
    const failure = errorEvent(socket);
    socket.emit('room:join', { roomId: 'room-1' });
    const result = await failure;
    expect(result.error.code).toBe(ErrorCode.INTERNAL);
    expect(result.error.message).not.toContain('secret');
  });
  it('disconnects connected clients on application shutdown', async () => {
    const socket = client(await start(), { initData: signedInitData() });
    await connected(socket);
    const disconnect = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    await app?.close();
    await disconnect;
    expect(socket.connected).toBe(false);
  });
});
