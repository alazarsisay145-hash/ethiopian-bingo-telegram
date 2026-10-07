import { describe, expect, it, vi } from 'vitest';
import { generateCard } from '@bingo/engine';
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
});
