import { describe, expect, it, vi } from 'vitest';
import { generateDrawSequence } from '@bingo/engine';
import type { Game } from '../../domain/entities.js';
import { InMemoryGameOwnershipLease, ManualClock } from '../../../test/fakes/gameFakes.js';
import { createGameTestHarness } from '../../../test/helpers/createGameTestHarness.js';
import { GameRunner } from './gameRunner.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

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
      gameId: game.id,
      type: 'NUMBER_CALLED',
      seq: 2,
      payload: { number: 17, calledNumbers: [17] },
      createdAt: clock.now(),
    })),
  };
  const publisher = { publishUser: vi.fn(async () => {}) };
  const schedule = vi.fn(clock.schedule.bind(clock));
  const runner = new GameRunner(
    'runner-a',
    games as never,
    { findById: async () => ({ drawIntervalMs: 1000 }) } as never,
    { listSince: async () => [] } as never,
    { listByGame: async () => [{ userId: 'user-1' }] } as never,
    ownership,
    draws as never,
    publisher,
    clock,
    { schedule },
    3000,
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

  describe('GameRunner ownership failover', () => {
    it('stops the stale owner within a heartbeat and recovers at the next deterministic index', async () => {
      const h = await createGameTestHarness();
      await h.start();
      await h.lease.release(h.initialLease);
      const { games, rooms, events, players } = h.repositories;
      const makeRunner = (instanceId: string) =>
        new GameRunner(
          instanceId,
          games,
          rooms,
          events,
          players,
          h.lease,
          h.drawService,
          h.publisher,
          h.clock,
          h.clock,
          10_000,
        );
      const runnerA = makeRunner('runner-a');
      const runnerB = makeRunner('runner-b');
      const drawNext = vi.spyOn(h.drawService, 'drawNext');
      try {
        expect(await runnerA.start(h.game.id)).toBe(true);
        expect(await runnerB.start(h.game.id)).toBe(false);
        const fenceA = await h.fence();
        await h.clock.advanceBy(3000);
        const before = (await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED');
        expect(before).toHaveLength(3);
        h.lease.invalidate(h.game.id);
        await h.clock.advanceBy(333);
        await h.clock.flush();
        const attemptsA = drawNext.mock.calls.filter(
          ([, fence]) => fence.instanceId === 'runner-a',
        ).length;
        expect(attemptsA).toBe(3);
        expect(h.clock.pendingTasks).toBe(0);
        expect((await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')).toEqual(
          before,
        );

        await runnerB.recover();
        const fenceB = await h.fence();
        expect(fenceB.instanceId).toBe('runner-b');
        expect(fenceB.fencingToken).toBeGreaterThan(fenceA.fencingToken);
        const seqBeforeStaleAppend = await events.latestSeq(h.game.id);
        await expect(
          events.append({
            gameId: h.game.id,
            type: 'NUMBER_CALLED',
            payload: { number: 1, index: 3 },
            fence: fenceA,
            expectedStatus: 'RUNNING',
            expectedDrawIndex: 3,
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await events.latestSeq(h.game.id)).toBe(seqBeforeStaleAppend);
        await expect(h.drawService.drawNext(h.game.id, fenceA)).rejects.toMatchObject({
          code: 'CONFLICT',
        });
        const staleAttempts = drawNext.mock.calls.filter(
          ([, fence]) => fence.instanceId === 'runner-a',
        ).length;
        await h.clock.advanceBy(2667);
        expect(
          drawNext.mock.calls.filter(([, fence]) => fence.instanceId === 'runner-a'),
        ).toHaveLength(staleAttempts);

        const after = (await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED');
        expect(after).toHaveLength(6);
        expect(after.slice(0, 3)).toEqual(before);
        const commitment = (await games.getSeedCommitment(h.game.id))!;
        const sequence = generateDrawSequence(await h.vault.open(commitment.seedEncrypted));
        expect(after.map(({ payload }) => (payload as { number: number }).number)).toEqual(
          sequence.slice(0, 6),
        );
        expect(after.map(({ payload }) => (payload as { index: number }).index)).toEqual([
          0, 1, 2, 3, 4, 5,
        ]);
        expect(
          new Set(after.map(({ payload }) => (payload as { number: number }).number)).size,
        ).toBe(6);
      } finally {
        await runnerA.stopAll();
        await runnerB.stopAll();
      }
      expect(h.clock.pendingTasks).toBe(0);
    });
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
