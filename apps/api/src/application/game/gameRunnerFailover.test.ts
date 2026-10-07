import { describe, expect, it, vi } from 'vitest';
import type { Game } from '../../domain/entities.js';
import { InMemoryGameOwnershipLease, ManualClock } from '../../../test/fakes/gameFakes.js';
import { GameRunner } from './gameRunner.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

const game: Game = {
  id: 'game-1', roomId: 'room-1', status: 'RUNNING',
  seedHash: 'a'.repeat(64), seedRevealedAt: null,
  startedAt: new Date(0), endedAt: null, ownerInstanceId: null,
  fencingToken: 0n, currentSeq: 1, potMinor: 0n,
  createdAt: new Date(0), updatedAt: new Date(0),
};

function shutdownHarness() {
  const clock = new ManualClock();
  const ownership = new InMemoryGameOwnershipLease();
  const games = {
    findById: vi.fn(async () => game),
    listRunnable: vi.fn(async () => [game]),
    getSeedCommitment: async () => ({ seedHash: 'hash', seedEncrypted: 'encrypted' }),
    tryAcquireOwnership: vi.fn(async () => true),
  };
  const draws = {
    drawNext: vi.fn(async () => ({
      gameId: game.id, type: 'NUMBER_CALLED', seq: 2,
      payload: { number: 17, calledNumbers: [17] }, createdAt: clock.now(),
    })),
  };
  const publisher = { publishUser: vi.fn(async () => {}) };
  const schedule = vi.fn(clock.schedule.bind(clock));
  const runner = new GameRunner(
    'runner-a', games as never,
    { findById: async () => ({ drawIntervalMs: 1000 }) } as never,
    { listSince: async () => [] } as never,
    { listByGame: async () => [{ userId: 'user-1' }] } as never,
    ownership, draws as never, publisher, clock, { schedule }, 3000,
  );
  return { runner, clock, games, ownership, draws, publisher, schedule };
}

describe('GameRunner shutdown races', () => {
  it('stopAll during an in-flight recovery tick neither starts games nor reschedules recovery', async () => {
    const h = shutdownHarness();
    const pending = deferred<Game[]>();
    h.games.listRunnable.mockReturnValueOnce(pending.promise);
    h.runner.startRecovery(100);
    await h.clock.advanceBy(100);
    expect(h.games.listRunnable).toHaveBeenCalledOnce();
    await h.runner.stopAll();
    pending.resolve([game]);
    await flush();
    await h.clock.advanceBy(10_000);
    await flush();
    expect(h.games.listRunnable).toHaveBeenCalledOnce();
    expect(h.games.tryAcquireOwnership).not.toHaveBeenCalled();
    expect(h.draws.drawNext).not.toHaveBeenCalled();
    expect(h.schedule).toHaveBeenCalledOnce();
  });

  it('releases an acquired lease when stopAll races with start', async () => {
    const h = shutdownHarness();
    const pending = deferred<{ gameId: string; instanceId: string; fencingToken: bigint }>();
    vi.spyOn(h.ownership, 'acquire').mockReturnValueOnce(pending.promise);
    const release = vi.spyOn(h.ownership, 'release');
    const started = h.runner.start(game.id);
    await flush();
    await h.runner.stopAll();
    const lease = { gameId: game.id, instanceId: 'runner-a', fencingToken: 1n };
    pending.resolve(lease);
    expect(await started).toBe(false);
    expect(release).toHaveBeenCalledWith(lease);
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('does not schedule another draw after shutdown interrupts publication', async () => {
    const h = shutdownHarness();
    const pending = deferred<void>();
    h.publisher.publishUser.mockReturnValueOnce(pending.promise);
    expect(await h.runner.start(game.id)).toBe(true);
    await h.clock.advanceBy(1000);
    await flush();
    expect(h.publisher.publishUser).toHaveBeenCalledOnce();
    await h.runner.stopAll();
    const scheduledAtStop = h.schedule.mock.calls.length;
    pending.resolve();
    await flush();
    expect(h.schedule).toHaveBeenCalledTimes(scheduledAtStop);
    await h.clock.advanceBy(10_000);
    await flush();
    expect(h.draws.drawNext).toHaveBeenCalledOnce();
  });
});
