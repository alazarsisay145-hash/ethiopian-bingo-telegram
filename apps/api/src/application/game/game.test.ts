import { commitSeed, generateDrawSequence } from '@bingo/engine';
import { AppError, ErrorCode } from '@bingo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Game, GameEvent } from '../../domain/entities.js';
import type {
  ClaimRepository,
  GameEventRepository,
  GameRepository,
} from '../../domain/repositories.js';
import {
  InMemoryGameLock,
  InMemoryGameOwnershipLease,
  InMemorySeedVault,
} from '../../../test/fakes/gameFakes.js';
import { DrawService } from './drawService.js';
import { FirstClaimantRemainderPolicy } from './gameSettlementService.js';
import { projectGameState } from './state.js';

const fence = { instanceId: 'runner-a', fencingToken: 1n };

function createDrawHarness() {
  const seed = 'draw-test-seed';
  const game: Game = {
    id: 'game-1',
    roomId: 'room-1',
    status: 'RUNNING',
    seedHash: commitSeed(seed),
    seedRevealedAt: null,
    startedAt: new Date(0),
    endedAt: null,
    ownerInstanceId: fence.instanceId,
    fencingToken: fence.fencingToken,
    currentSeq: 1,
    potMinor: 0n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const storedEvents: GameEvent[] = [];
  const vault = new InMemorySeedVault();
  const games = {
    findById: async () => game,
    getSeedCommitment: async () => ({
      seedHash: commitSeed(seed),
      seedEncrypted: await vault.seal(seed),
    }),
  } as unknown as GameRepository;
  const events = {
    listSince: async (_gameId: string, afterSeq: number) =>
      storedEvents.filter(({ seq }) => seq > afterSeq),
    latestSeq: async () => storedEvents.at(-1)?.seq ?? 1,
    append: async (input: Parameters<GameEventRepository['append']>[0]) => {
      if (
        !input.fence ||
        input.fence.instanceId !== fence.instanceId ||
        input.fence.fencingToken !== fence.fencingToken
      ) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Stale game owner');
      }
      const drawn = storedEvents.filter(({ type }) => type === 'NUMBER_CALLED').length;
      if (input.expectedDrawIndex !== undefined && input.expectedDrawIndex !== drawn) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Draw sequence advanced concurrently');
      }
      const event: GameEvent = {
        gameId: input.gameId,
        seq: storedEvents.length + 2,
        type: input.type,
        payload: input.payload,
        createdAt: new Date(storedEvents.length),
      };
      storedEvents.push(event);
      return event;
    },
  } as unknown as GameEventRepository;
  const claims = { listByGame: async () => [] } as unknown as ClaimRepository;
  const settlement = {
    finish: vi.fn(async () => ({
      gameId: game.id,
      seq: 100,
      type: 'GAME_ENDED',
      payload: { winnerIds: [] },
      createdAt: new Date(),
    })),
  };
  const ownership = new InMemoryGameOwnershipLease();
  void ownership.acquire(game.id, fence.instanceId);
  const service = new DrawService(
    games,
    events,
    claims,
    ownership,
    vault,
    new InMemoryGameLock(),
    settlement as never,
  );
  return { service, storedEvents, seed, game, settlement };
}

describe('DrawService', () => {
  it('coalesces concurrent calls and persists the deterministic draw sequence without repeats', async () => {
    const { service, storedEvents, seed } = createDrawHarness();
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, () => service.drawNext('game-1', fence)),
    );
    expect(new Set(concurrent.map(({ seq }) => seq)).size).toBe(1);
    expect(storedEvents).toHaveLength(1);

    for (let index = 1; index < 75; index += 1) {
      await service.drawNext('game-1', fence);
    }
    const numbers = storedEvents
      .filter(({ type }) => type === 'NUMBER_CALLED')
      .map(({ payload }) => (payload as { number: number }).number);
    expect(numbers).toEqual(generateDrawSequence(seed));
    expect(new Set(numbers).size).toBe(75);
  });

  it('rejects writes with a stale fence', async () => {
    const { service } = createDrawHarness();
    await expect(
      service.drawNext('game-1', { instanceId: 'stale', fencingToken: 0n }),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it.each(['LOBBY', 'ENDED', 'CANCELLED'] as const)(
    'rejects draws while game is %s',
    async (status) => {
      const { service, game } = createDrawHarness();
      game.status = status;
      await expect(service.drawNext(game.id, fence)).rejects.toMatchObject({
        code: ErrorCode.INVALID_STATE,
      });
    },
  );

  it('requests a winnerless settlement only after the full permutation is drawn', async () => {
    const { service, storedEvents, settlement } = createDrawHarness();
    for (let index = 0; index < 75; index += 1) {
      await service.drawNext('game-1', fence);
    }
    expect(storedEvents.filter(({ type }) => type === 'NUMBER_CALLED')).toHaveLength(75);
    const end = await service.drawNext('game-1', fence);
    expect(end.type).toBe('GAME_ENDED');
    expect(settlement.finish).toHaveBeenCalledWith('game-1', [], fence);
  });
});

describe('game state projection', () => {
  it('folds ordered events into the public product state and winner statuses', () => {
    const state = projectGameState({
      gameId: 'game-1',
      roomId: 'room-1',
      events: [
        { gameId: 'game-1', seq: 1, type: 'GAME_STARTED', payload: {}, createdAt: new Date(0) },
        {
          gameId: 'game-1',
          seq: 2,
          type: 'NUMBER_CALLED',
          payload: { number: 14 },
          createdAt: new Date(1),
        },
        {
          gameId: 'game-1',
          seq: 3,
          type: 'CLAIM_REJECTED',
          payload: { userId: 'u2' },
          createdAt: new Date(2),
        },
        {
          gameId: 'game-1',
          seq: 4,
          type: 'GAME_ENDED',
          payload: { winnerIds: ['u1'] },
          createdAt: new Date(3),
        },
      ],
      players: [
        { userId: 'u1', status: 'ACTIVE' },
        { userId: 'u2', status: 'ACTIVE' },
      ],
    });
    expect(state).toMatchObject({
      status: 'finished',
      calledNumbers: [14],
      lastNumber: 14,
      seq: 4,
      winnerIds: ['u1'],
      players: [
        { userId: 'u1', status: 'WINNER' },
        { userId: 'u2', status: 'DISQUALIFIED' },
      ],
    });
  });

  describe('prize split policy', () => {
    it('splits in integer minor units and gives the remainder to the first accepted claimant', () => {
      expect(new FirstClaimantRemainderPolicy().split(1001n, ['first', 'second', 'third'])).toEqual([
        { userId: 'first', amountMinor: 335n },
        { userId: 'second', amountMinor: 333n },
        { userId: 'third', amountMinor: 333n },
      ]);
    });
  });
});
