import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../../domain/entities.js';
import { InMemoryGameOwnershipLease, ManualClock } from '../../../test/fakes/gameFakes.js';
import { GameRunner } from './gameRunner.js';

const game: Game = {
  id: 'game-1',
  roomId: 'room-1',
  status: 'RUNNING',
  seedHash: 'a'.repeat(64),
  seedRevealedAt: null,
  startedAt: new Date(0),
  endedAt: null,
  ownerInstanceId: null,
  fencingToken: 0n,
  currentSeq: 1,
  potMinor: 0n,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('GameRunner', () => {
  it('stops scheduled draws immediately after lease loss', async () => {
    const clock = new ManualClock();
    const ownership = new InMemoryGameOwnershipLease();
    const draws = {
      drawNext: vi.fn(async () => ({
        gameId: game.id,
        seq: 2,
        type: 'NUMBER_CALLED',
        payload: { number: 17, calledNumbers: [17] },
        createdAt: new Date(),
      })),
    };
    const scheduler = {
      schedule: clock.schedule.bind(clock),
    };
    const runner = new GameRunner(
      'runner-a',
      {
        findById: async () => game,
        getSeedCommitment: async () => ({ seedHash: 'h', seedEncrypted: 'enc' }),
        tryAcquireOwnership: async () => true,
      } as never,
      { findById: async () => ({ drawIntervalMs: 1000 }) } as never,
      { listSince: async () => [] } as never,
      { listByGame: async () => [] } as never,
      ownership,
      draws as never,
      { publishUser: vi.fn(async () => {}) },
      clock,
      scheduler,
      3000,
    );

    expect(await runner.start(game.id)).toBe(true);
    await clock.advanceBy(1000);
    await Promise.resolve();
    expect(draws.drawNext).toHaveBeenCalledTimes(1);

    ownership.valid = false;
    await clock.advanceBy(3000);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    const stoppedAt = draws.drawNext.mock.calls.length;
    await clock.advanceBy(10_000);
    expect(draws.drawNext).toHaveBeenCalledTimes(stoppedAt);
  });
});
