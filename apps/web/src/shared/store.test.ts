import { describe, expect, it } from 'vitest';
import { createSessionStore } from './store';

const gameId = 'game-1';
const started = {
  gameId,
  roomId: 'room-1',
  seedHash: 'a'.repeat(64),
  drawIntervalMs: 3000,
  seq: 1,
};
const snapshot = (seq: number, calledNumbers: number[] = []) => ({
  game: {
    gameId,
    roomId: 'room-1',
    seedHash: started.seedHash,
    status: 'active',
    calledNumbers,
    seq,
  },
  seq,
});

describe('server-authoritative session store', () => {
  it('starts without invented game, wallet, cards, or rooms', () => {
    expect(createSessionStore().store.getState()).toMatchObject({
      game: null,
      wallet: null,
      rooms: {},
      claim: null,
    });
  });
  it('rejects invalid server payloads without changing state', () => {
    const session = createSessionStore();
    const state = session.store.getState();
    expect(session.ingest('wallet:update', { balanceMinor: -5, currency: 'ETB', seq: 1 })).toBe(
      false,
    );
    expect(session.store.getState()).toBe(state);
  });
  it('applies validated events and ignores stale or duplicate sequence numbers', () => {
    const session = createSessionStore();
    expect(session.ingest('game:started', started)).toBe(true);
    expect(session.ingest('game:number', { gameId, number: 4, calledNumbers: [4], seq: 2 })).toBe(
      true,
    );
    const state = session.store.getState();
    expect(session.ingest('game:number', { gameId, number: 5, calledNumbers: [5], seq: 2 })).toBe(
      false,
    );
    expect(session.ingest('game:started', started)).toBe(false);
    expect(session.store.getState()).toBe(state);
  });
  it('quarantines sequence gaps until a server snapshot, never from later deltas', () => {
    const session = createSessionStore();
    session.ingest('game:started', started);
    expect(
      session.ingest('game:number', { gameId, number: 7, calledNumbers: [4, 7], seq: 3 }),
    ).toBe(false);
    expect(session.store.getState().game?.calledNumbers).toEqual([]);
    expect(session.store.getState().syncing[`game:${gameId}`]).toBe(true);
    expect(session.ingest('game:number', { gameId, number: 4, calledNumbers: [4], seq: 2 })).toBe(
      false,
    );
    expect(session.ingest('state:snapshot', snapshot(3, [4, 7]))).toBe(true);
    expect(session.store.getState().syncing[`game:${gameId}`]).toBe(false);
    expect(
      session.ingest('game:number', { gameId, number: 8, calledNumbers: [4, 7, 8], seq: 4 }),
    ).toBe(true);
  });
  it('rejects stale and internally inconsistent snapshots', () => {
    const session = createSessionStore();
    session.ingest('state:snapshot', snapshot(5, [1]));
    expect(session.ingest('state:snapshot', snapshot(4))).toBe(false);
    expect(session.ingest('state:snapshot', { ...snapshot(6), seq: 7 })).toBe(false);
    expect(session.store.getState().game?.seq).toBe(5);
  });
  it('ignores a duplicate snapshot rather than rewriting same-sequence state', () => {
    const session = createSessionStore();
    session.ingest('state:snapshot', snapshot(5, [1]));
    expect(session.ingest('state:snapshot', snapshot(5, [2]))).toBe(false);
    expect(session.store.getState().game?.calledNumbers).toEqual([1]);
  });
  it('does not clear syncing with a snapshot older than the observed gap', () => {
    const session = createSessionStore();
    session.ingest('game:started', started);
    session.ingest('game:number', { gameId, number: 8, calledNumbers: [4, 7, 8], seq: 4 });
    expect(session.ingest('state:snapshot', snapshot(3, [4, 7]))).toBe(false);
    expect(session.store.getState().syncing[`game:${gameId}`]).toBe(true);
    expect(session.ingest('state:snapshot', snapshot(4, [4, 7, 8]))).toBe(true);
  });
  it('cannot switch back to a retired game from delayed events or snapshots', () => {
    const session = createSessionStore();
    session.ingest('game:started', started);
    session.ingest('game:started', { ...started, gameId: 'game-2' });
    expect(session.ingest('state:snapshot', snapshot(20, [1, 2]))).toBe(false);
    expect(session.ingest('game:number', { gameId, number: 4, calledNumbers: [4], seq: 2 })).toBe(
      false,
    );
    expect(session.store.getState().game?.gameId).toBe('game-2');
  });
  it('requires a snapshot for events received without game initialization', () => {
    const session = createSessionStore();
    expect(session.ingest('game:number', { gameId, number: 4, calledNumbers: [4], seq: 9 })).toBe(
      false,
    );
    expect(session.store.getState().game).toBeNull();
    expect(session.ingest('state:snapshot', snapshot(9, [4]))).toBe(true);
  });
  it('does not rewrite called-number history even with a contiguous seq', () => {
    const session = createSessionStore();
    session.ingest('state:snapshot', snapshot(3, [1, 4]));
    expect(
      session.ingest('game:number', { gameId, number: 8, calledNumbers: [2, 4, 8], seq: 4 }),
    ).toBe(false);
    expect(session.store.getState().game?.calledNumbers).toEqual([1, 4]);
    expect(session.store.getState().syncing[`game:${gameId}`]).toBe(true);
  });
  it('keeps room and wallet stream sequences independent of game events', () => {
    const session = createSessionStore();
    expect(session.ingest('wallet:update', { balanceMinor: 100, currency: 'ETB', seq: 20 })).toBe(
      true,
    );
    expect(session.ingest('game:started', started)).toBe(true);
    expect(session.ingest('wallet:update', { balanceMinor: 200, currency: 'ETB', seq: 22 })).toBe(
      false,
    );
    expect(session.store.getState().wallet?.balanceMinor).toBe(100);
    expect(session.store.getState().syncing.wallet).toBe(true);
  });
});
