import { describe, expect, it, vi } from 'vitest';
import { generateCard } from '@bingo/engine';
import { clientPayloadSchemas, serverPayloadSchemas } from '@bingo/shared';
import type { Game, GamePlayer } from '../../domain/entities.js';
import type { EventContext } from '../../domain/ports.js';
import { createGameEventHandlers } from './gameEventHandlers.js';

const game: Game = {
  id: 'game-1',
  roomId: 'room-1',
  status: 'RUNNING',
  seedHash: 'a'.repeat(64),
  seedRevealedAt: null,
  startedAt: new Date(0),
  endedAt: null,
  ownerInstanceId: 'runner',
  fencingToken: 1n,
  currentSeq: 2,
  potMinor: 0n,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const ownCard: GamePlayer = {
  gameId: game.id,
  userId: 'user-1',
  cardNumber: 1,
  cardCells: generateCard('test-pool', 1).cells,
  status: 'ACTIVE',
  joinedAt: new Date(0),
};
const otherCard: GamePlayer = {
  ...ownCard,
  userId: 'user-2',
  cardCells: generateCard('test-pool', 2).cells,
};
const context: EventContext = {
  user: { id: ownCard.userId, telegramId: 123, firstName: 'Player' },
  socketId: 'socket-1',
  requestId: 'request-1',
};

describe('GameEventHandlers', () => {
  it('resyncs only the authenticated player card and never serializes the hidden seed', async () => {
    const messages: Array<[string, string, unknown]> = [];
    const publishUser = vi.fn(async (userId: string, event: string, payload: unknown) => {
      messages.push([userId, event, payload]);
    });
    const handlers = createGameEventHandlers({
      games: { findById: async () => game } as never,
      players: {
        findByGameAndUser: async () => ownCard,
        listByGame: async () => [ownCard, otherCard],
      } as never,
      events: { listSince: async () => [], latestSeq: async () => 2 } as never,
      claims: {} as never,
      projector: {
        project: async () => ({
          gameId: game.id,
          roomId: game.roomId,
          status: 'active',
          calledNumbers: [7],
          lastNumber: 7,
          seq: 2,
          players: [
            { userId: ownCard.userId, status: 'ACTIVE' },
            { userId: otherCard.userId, status: 'ACTIVE' },
          ],
          winnerIds: [],
        }),
      } as never,
      membership: { isMember: async () => true },
      fences: {} as never,
      publisher: { publishUser },
    });

    await handlers['state:resync']?.({ gameId: game.id, lastSeq: 2 }, context);
    expect(publishUser).toHaveBeenCalledTimes(1);
    const [recipient, event, payload] = messages[0]!;
    expect(recipient).toBe(ownCard.userId);
    expect(event).toBe('state:snapshot');
    expect(payload).toMatchObject({
      game: { yourCard: { cardNumber: ownCard.cardNumber, cells: ownCard.cardCells } },
    });
    expect(JSON.stringify(payload)).not.toContain(JSON.stringify(otherCard.cardCells));
    expect(JSON.stringify(payload)).not.toContain('seedRevealed');
  });

  it('rejects resync when the authenticated player is not a game member', async () => {
    const handlers = createGameEventHandlers({
      games: {} as never,
      players: {} as never,
      events: {} as never,
      claims: {} as never,
      projector: {} as never,
      membership: { isMember: async () => false },
      fences: {} as never,
      publisher: { publishUser: vi.fn(async () => {}) },
    });
    await expect(handlers['state:resync']?.({ gameId: game.id, lastSeq: 0 }, context))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects claims from non-members before reading a fence or recording a claim', async () => {
    const claim = vi.fn();
    const current = vi.fn();
    const publishUser = vi.fn();
    const handlers = createGameEventHandlers({
      games: {} as never,
      players: {} as never,
      events: {} as never,
      claims: { claim } as never,
      projector: {} as never,
      membership: { isMember: async () => false },
      fences: { current },
      publisher: { publishUser },
    });
    await expect(handlers['game:claim']?.({ gameId: game.id }, context))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(claim).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(publishUser).not.toHaveBeenCalled();
  });

  it('rejects client-supplied identity, verdict and card fields at the socket schema', () => {
    expect(clientPayloadSchemas['game:claim'].safeParse({ gameId: game.id }).success).toBe(true);
    for (const extra of [
      { userId: 'someone-else' },
      { accepted: true },
      { card: ownCard.cardCells },
      { userId: 'someone-else', accepted: true, card: ownCard.cardCells },
    ]) {
      expect(clientPayloadSchemas['game:claim'].safeParse({ gameId: game.id, ...extra }).success)
        .toBe(false);
    }
  });

  it.each([0, 101])('returns a private snapshot for a large or unfillable gap (lastSeq=%i)', async (lastSeq) => {
    const messages: Array<{ event: string; payload: unknown }> = [];
    const listSince = vi.fn(async () => []);
    const handlers = createGameEventHandlers({
      games: { findById: async () => ({ ...game, currentSeq: 150 }) } as never,
      players: { findByGameAndUser: async () => ownCard } as never,
      events: { listSince } as never,
      claims: {} as never,
      projector: {
        project: async () => ({
          status: 'active', seq: 150, calledNumbers: [7],
          players: [ownCard, otherCard], winnerIds: [],
        }),
      } as never,
      membership: { isMember: async () => true },
      fences: {} as never,
      publisher: {
        publishUser: async (userId, event, payload) => {
          expect(userId).toBe(ownCard.userId);
          expect(event).toBe('state:snapshot');
          serverPayloadSchemas['state:snapshot'].parse(payload);
          messages.push({ event, payload });
        },
      },
    });
    await handlers['state:resync']?.({ gameId: game.id, lastSeq }, context);
    expect(messages).toHaveLength(1);
    const serialized = JSON.stringify(messages[0]!.payload);
    for (const secret of ['seedEncrypted', 'cardPoolSeed', 'cardCells', JSON.stringify(otherCard.cardCells)]) {
      expect(serialized).not.toContain(secret);
    }
    expect(messages[0]!.payload).toMatchObject({
      game: { yourCard: { cells: ownCard.cardCells }, seq: 150 },
    });
    expect(listSince).toHaveBeenCalledTimes(lastSeq === 0 ? 0 : 1);
  });

  it('replays a small gap in order with prefix-consistent draws and only the recipient card', async () => {
    const events = [
      { gameId: game.id, seq: 1, type: 'GAME_STARTED', payload: { seedHash: game.seedHash, drawIntervalMs: 1000 }, createdAt: new Date(0) },
      { gameId: game.id, seq: 2, type: 'NUMBER_CALLED', payload: { number: 7 }, createdAt: new Date(0) },
      { gameId: game.id, seq: 3, type: 'NUMBER_CALLED', payload: { number: 19 }, createdAt: new Date(0) },
    ];
    const messages: Array<{ event: string; payload: unknown }> = [];
    const handlers = createGameEventHandlers({
      games: { findById: async () => ({ ...game, currentSeq: 3 }) } as never,
      players: { findByGameAndUser: async () => ownCard } as never,
      events: { listSince: async (_id: string, after: number) => events.filter(({ seq }) => seq > after) } as never,
      claims: {} as never,
      projector: {
        project: async () => ({
          status: 'active', seq: 3, calledNumbers: [7, 19],
          players: [ownCard, otherCard], winnerIds: [],
        }),
      } as never,
      membership: { isMember: async () => true },
      fences: {} as never,
      publisher: {
        publishUser: async (userId, event, payload) => {
          expect(userId).toBe(ownCard.userId);
          serverPayloadSchemas[event as keyof typeof serverPayloadSchemas].parse(payload);
          messages.push({ event, payload });
        },
      },
    });
    await handlers['state:resync']?.({ gameId: game.id, lastSeq: 0 }, context);
    expect(messages.map(({ event }) => event)).toEqual(['game:started', 'game:number', 'game:number']);
    expect(messages.map(({ payload }) => (payload as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(messages[0]!.payload).toMatchObject({ yourCard: { cells: ownCard.cardCells } });
    expect(messages[1]!.payload).toMatchObject({ calledNumbers: [7] });
    expect(messages[2]!.payload).toMatchObject({ calledNumbers: [7, 19] });
    const serialized = JSON.stringify(messages);
    for (const secret of ['seedEncrypted', 'cardPoolSeed', 'cardCells', JSON.stringify(otherCard.cardCells)]) {
      expect(serialized).not.toContain(secret);
    }
    messages.length = 0;
    await handlers['state:resync']?.({ gameId: game.id, lastSeq: 2 }, context);
    expect(messages).toEqual([{ event: 'game:number', payload: { gameId: game.id, number: 19, calledNumbers: [7, 19], seq: 3 } }]);
  });
});
