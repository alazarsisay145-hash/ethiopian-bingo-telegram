import { afterEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { AppError, ErrorCode } from '@bingo/shared';
import type { ErrorDto } from '@bingo/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../app.js';
import { signedInitData, testEnv } from '../../test-support.js';
import { InMemoryRateLimiter } from '../../../test/fakes/gameFakes.js';

let app: FastifyInstance | undefined;
const clients: Socket[] = [];

async function start(options: BuildAppOptions = {}): Promise<string> {
  app = await buildApp({ env: testEnv, ...options });
  return app.listen({ port: 0, host: '127.0.0.1' });
}

function client(url: string, auth?: unknown): Socket {
  const socket = io(url, { auth, transports: ['websocket'], reconnection: false, autoConnect: false });
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
  it('accepts real verified Telegram initData', async () => {
    const url = await start();
    const socket = client(url, { initData: signedInitData() });
    await connected(socket);
    expect(socket.connected).toBe(true);
  });
  it.each([undefined, {}, { initData: '' }, { initData: 123 }, { initData: 'tampered' }])(
    'rejects absent or invalid authentication %#', async (auth) => {
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
  it('rejects a persisted banned user rather than allowing a socket session', async () => {
    const socket = client(await start({
      authentication: {
        authenticate: async () => {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'User is banned');
        },
      },
    }), { initData: 'verified' });
    const error = await rejected(socket);
    expect(error.data?.code).toBe(ErrorCode.FORBIDDEN);
  });
  it('rejects untrusted browser origins even for websocket transport', async () => {
    const socket = io(await start(), {
      auth: { initData: signedInitData() }, transports: ['websocket'],
      extraHeaders: { origin: 'https://untrusted.example' },
      reconnection: false, autoConnect: false,
    });
    clients.push(socket);
    expect((await rejected(socket)).message).toBe('websocket error');
  });
  it('uses an injected authentication port rather than an unverified handshake user', async () => {
    const authenticate = vi.fn(async () => ({ id: 'trusted', telegramId: 99, firstName: 'Trusted' }));
    const handler = vi.fn(async () => undefined);
    const url = await start({ authentication: { authenticate }, eventHandlers: { 'room:join': handler } });
    const socket = client(url, { initData: 'adapter-proof', user: { id: 'forged' } });
    await connected(socket);
    await new Promise<void>((resolve) => socket.emit('room:join', { roomId: 'room-1' }, resolve));
    expect(authenticate).toHaveBeenCalledWith('adapter-proof');
    expect(handler).toHaveBeenCalledWith({ roomId: 'room-1' }, expect.objectContaining({
      user: { id: 'trusted', telegramId: 99, firstName: 'Trusted' },
    }));
  });
  it('validates incoming intents before executing handlers', async () => {
    const handler = vi.fn(async () => undefined);
    const socket = client(await start({ eventHandlers: { 'card:select': handler } }), { initData: signedInitData() });
    await connected(socket);
    const failure = errorEvent(socket);
    socket.emit('card:select', { roomId: 'room-1', cardNumber: -1 });
    expect((await failure).error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(handler).not.toHaveBeenCalled();
  });
  it('applies per-user WebSocket intent limits', async () => {
    const handler = vi.fn(async () => undefined);
    const socket = client(await start({
      rateLimiter: new InMemoryRateLimiter(),
      eventHandlers: { 'game:claim': handler },
    }), { initData: signedInitData() });
    await connected(socket);
    for (let index = 0; index < 5; index += 1) {
      const result = new Promise<{ ok: boolean }>((resolve) =>
        socket.emit('game:claim', { gameId: 'game-1' }, resolve));
      await expect(result).resolves.toEqual({ ok: true });
    }
    const limited = new Promise<{ ok: boolean; error?: { code: string } }>((resolve) =>
      socket.emit('game:claim', { gameId: 'game-1' }, resolve));
    expect(await limited).toMatchObject({ ok: false, error: { code: ErrorCode.RATE_LIMITED } });
    expect(handler).toHaveBeenCalledTimes(5);
  });
  it('rechecks persisted user status before each socket intent', async () => {
    const handler = vi.fn(async () => undefined);
    const socket = client(await start({
      authorizeUser: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'User was banned');
      },
      eventHandlers: { 'room:join': handler },
    }), { initData: signedInitData() });
    await connected(socket);
    const result = new Promise<{ ok: boolean; error?: { code: string } }>((resolve) =>
      socket.emit('room:join', { roomId: 'room-1' }, resolve));
    expect(await result).toMatchObject({ ok: false, error: { code: ErrorCode.FORBIDDEN } });
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['room:join', 'room:leave', 'card:select', 'card:release', 'game:ready', 'game:claim', 'state:resync'])(
    'reports unimplemented %s explicitly without inventing game work', async (event) => {
      const socket = client(await start(), { initData: signedInitData() });
      await connected(socket);
      const failure = errorEvent(socket);
      const payload = event === 'state:resync' ? { gameId: 'game-1', lastSeq: 0 }
        : event === 'game:claim' ? { gameId: 'game-1' }
        : event === 'card:select' ? { roomId: 'room-1', cardNumber: 1 } : { roomId: 'room-1' };
      socket.emit(event, payload);
      expect((await failure).error.code).toBe(ErrorCode.NOT_FOUND);
    },
  );
  it('reports unknown events as unsupported', async () => {
    const socket = client(await start(), { initData: signedInitData() });
    await connected(socket);
    const failure = errorEvent(socket);
    socket.emit('payments:withdraw', { amount: 100 });
    expect((await failure).error.code).toBe(ErrorCode.NOT_FOUND);
  });
  it('normalizes handler failures without leaking internals', async () => {
    const socket = client(await start({
      eventHandlers: { 'room:join': async () => { throw new Error('database secret'); } },
    }), { initData: signedInitData() });
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
