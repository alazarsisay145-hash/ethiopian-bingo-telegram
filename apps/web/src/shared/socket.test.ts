import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: unknown) => void>(),
  socket: { on: vi.fn(), emit: vi.fn() },
  io: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: mock.io }));

import { createBingoSocket, sendCommand } from './socket';
import { createSessionStore } from './store';

const started = { gameId: 'game-1', roomId: 'room-1', seedHash: 'a'.repeat(64), drawIntervalMs: 3000, seq: 1 };

describe('typed socket contracts', () => {
  beforeEach(() => {
    mock.handlers.clear();
    mock.socket.on.mockImplementation((event: string, handler: (payload?: unknown) => void) => {
      mock.handlers.set(event, handler);
      return mock.socket;
    });
    mock.io.mockReturnValue(mock.socket);
  });

  it('does not connect automatically and passes only real initData for server authentication', () => {
    createBingoSocket('https://api.example', 'launch-data', createSessionStore());
    expect(mock.io).toHaveBeenCalledWith('https://api.example', {
      autoConnect: false, auth: { initData: 'launch-data' }, transports: ['websocket'],
    });
  });

  it('refuses a socket without Telegram launch data', () => {
    expect(() => createBingoSocket('https://api.example', '', createSessionStore())).toThrow();
    expect(mock.io).not.toHaveBeenCalled();
  });

  it('validates commands before emitting and does not optimistically mutate state', () => {
    const session = createSessionStore();
    const socket = createBingoSocket('https://api.example', 'raw', session);
    const state = session.store.getState();
    sendCommand(socket, 'card:select', { roomId: 'room-1', cardNumber: 4 });
    expect(mock.socket.emit).toHaveBeenCalledWith('card:select', { roomId: 'room-1', cardNumber: 4 });
    expect(session.store.getState()).toBe(state);
    mock.socket.emit.mockClear();
    expect(() => sendCommand(socket, 'card:select', { roomId: 'room-1', cardNumber: -1 })).toThrow();
    expect(mock.socket.emit).not.toHaveBeenCalled();
  });

  it('requests one resync for a gap and resumes only after a valid snapshot', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = createSessionStore();
    createBingoSocket('https://api.example', 'raw', session);
    mock.handlers.get('game:started')?.(started);
    mock.handlers.get('game:number')?.({ gameId: 'game-1', number: 7, calledNumbers: [4, 7], seq: 3 });
    mock.handlers.get('game:number')?.({ gameId: 'game-1', number: 8, calledNumbers: [4, 7, 8], seq: 4 });
    expect(mock.socket.emit).toHaveBeenCalledTimes(1);
    expect(mock.socket.emit).toHaveBeenCalledWith('state:resync', { gameId: 'game-1', lastSeq: 1 });
    mock.handlers.get('state:snapshot')?.({
      game: { gameId: 'game-1', roomId: 'room-1', seedHash: started.seedHash, status: 'running', calledNumbers: [4, 7, 8], seq: 4 }, seq: 4,
    });
    expect(session.store.getState().game?.seq).toBe(4);
    expect(session.store.getState().syncing['game:game-1']).toBe(false);
    consoleSpy.mockRestore();
  });

  it('requests a fresh server snapshot on reconnect', () => {
    const session = createSessionStore();
    createBingoSocket('https://api.example', 'raw', session);
    session.ingest('game:started', started);
    mock.handlers.get('connect')?.();
    expect(mock.socket.emit).toHaveBeenCalledWith('state:resync', { gameId: 'game-1', lastSeq: 1 });
    mock.handlers.get('connect')?.();
    expect(mock.socket.emit).toHaveBeenCalledTimes(2);
  });

  it('never logs launch data or malformed server payloads', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = createSessionStore();
    createBingoSocket('https://api.example', 'private-credential', session);
    mock.handlers.get('wallet:update')?.({ private: 'private-credential' });
    expect(session.store.getState().wallet).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-credential');
    log.mockRestore();
  });
});
