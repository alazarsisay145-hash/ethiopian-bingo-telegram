import { generateCard } from '@bingo/engine';
import { ErrorCode } from '@bingo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Claim, Game, GameEvent, GamePlayer, Room } from '../../domain/entities.js';
import {
  InMemoryGameLock,
  InMemoryGameOwnershipLease,
  InMemorySeedVault,
} from '../../../test/fakes/gameFakes.js';
import { ClaimService } from './claimService.js';

function createClaimHarness(activePatterns: Room['activePatterns'], withWinningRow: boolean) {
  const card = generateCard('claim-test-pool', 1);
  const game: Game = {
    id: 'game-1',
    roomId: 'room-1',
    status: 'RUNNING',
    seedHash: null,
    seedRevealedAt: null,
    startedAt: null,
    endedAt: null,
    ownerInstanceId: 'runner',
    fencingToken: 1n,
    currentSeq: 1,
    potMinor: 0n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const room: Room = {
    id: 'room-1',
    name: 'Room',
    stakeMinor: 10n,
    minPlayers: 1,
    maxPlayers: 20,
    drawIntervalMs: 1000,
    activePatterns,
    cardPoolSize: 20,
    status: 'OPEN',
    createdById: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const player: GamePlayer = {
    gameId: game.id,
    userId: 'user-1',
    cardNumber: card.cardNumber,
    cardCells: card.cells,
    status: 'ACTIVE',
    joinedAt: new Date(0),
  };
  const storedEvents: GameEvent[] = withWinningRow
    ? card.cells.slice(0, 5).map((number, index) => ({
        gameId: game.id,
        seq: index + 2,
        type: 'NUMBER_CALLED',
        payload: { number },
        createdAt: new Date(index),
      }))
    : [];
  const storedClaims: Claim[] = [];
  const games = { findById: async () => game };
  const rooms = { findById: async () => room };
  const players = {
    findByGameAndUser: async () => player,
    setStatus: vi.fn(async (_gameId: string, _userId: string, status: GamePlayer['status']) => {
      player.status = status;
      return player;
    }),
  };
  const events = {
    listSince: async (_gameId: string, afterSeq: number) =>
      storedEvents.filter(({ seq }) => seq > afterSeq),
    append: async (input: { gameId: string; type: string; payload: unknown }) => {
      const event = {
        gameId: input.gameId,
        seq: (storedEvents.at(-1)?.seq ?? 1) + 1,
        type: input.type,
        payload: input.payload,
        createdAt: new Date(),
      };
      storedEvents.push(event);
      return event;
    },
  };
  const claims = {
    listByGame: async () => storedClaims,
    recordWithEvent: async (input: Omit<Claim, 'id' | 'createdAt'> & { disqualifyOnFalseClaim: boolean }) => {
      const { disqualifyOnFalseClaim, ...claimInput } = input;
      const claim: Claim = {
        ...claimInput,
        id: `claim-${storedClaims.length + 1}`,
        createdAt: new Date(),
      };
      storedClaims.push(claim);
      if (!claim.accepted && disqualifyOnFalseClaim) player.status = 'DISQUALIFIED';
      const event = {
        gameId: game.id,
        seq: (storedEvents.at(-1)?.seq ?? 1) + 1,
        type: claim.accepted ? 'CLAIM_ACCEPTED' : 'CLAIM_REJECTED',
        payload: { userId: claim.userId, atSeq: claim.atSeq, patterns: claim.patterns },
        createdAt: new Date(),
      };
      storedEvents.push(event);
      return { claim, event };
    },
  };
  const service = new ClaimService(
    games as never,
    rooms as never,
    players as never,
    events as never,
    claims as never,
    new InMemoryGameOwnershipLease(),
    new InMemoryGameLock(),
    new InMemorySeedVault(),
  );
  return { service, game, player, storedClaims, storedEvents, players };
}

describe('ClaimService', () => {
  it('accepts a server-verified win and makes repeated claims idempotent', async () => {
    const { service, game, storedClaims, storedEvents } = createClaimHarness(['row-1'], true);
    const first = await service.claim(
      { gameId: game.id, userId: 'user-1' },
      {
        instanceId: 'runner',
        fencingToken: 1n,
      },
    );
    game.status = 'ENDED';
    const repeated = await service.claim(
      { gameId: game.id, userId: 'user-1' },
      {
        instanceId: 'runner',
        fencingToken: 1n,
      },
    );
    expect(first).toMatchObject({ accepted: true, patterns: ['row-1'] });
    expect(repeated).toEqual(first);
    expect(storedClaims).toHaveLength(1);
    expect(storedEvents.filter(({ type }) => type === 'CLAIM_ACCEPTED')).toHaveLength(1);
  });

  it('rejects inactive patterns, records the false claim and disqualifies repeat claimants', async () => {
    const { service, game, storedClaims, storedEvents, player } = createClaimHarness(
      ['column-B'],
      true,
    );
    const result = await service.claim(
      { gameId: game.id, userId: 'user-1' },
      {
        instanceId: 'runner',
        fencingToken: 1n,
      },
    );
    expect(result).toMatchObject({ accepted: false, patterns: [] });
    expect(player.status).toBe('DISQUALIFIED');
    expect(storedClaims).toHaveLength(1);
    expect(storedEvents.at(-1)?.type).toBe('CLAIM_REJECTED');
    await expect(
      service.claim(
        { gameId: game.id, userId: 'user-1' },
        {
          instanceId: 'runner',
          fencingToken: 1n,
        },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});
