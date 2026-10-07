import { describe, expect, it, vi } from 'vitest';
import { createInMemoryRepositories } from '../../../test/fakes/inMemoryRepositories.js';
import { InMemoryGameOwnershipLease, ManualClock } from '../../../test/fakes/gameFakes.js';
import type { GameLifecycleService } from '../game/gameLifecycleService.js';
import { LobbyScheduler } from './lobbyScheduler.js';

async function createLobby() {
  const repositories = createInMemoryRepositories();
  const clock = new ManualClock();
  const room = await repositories.rooms.create({
    name: 'Countdown room',
    stakeMinor: 0n,
    minPlayers: 2,
    maxPlayers: 3,
    drawIntervalMs: 5000,
    startCountdownMs: 1500,
    activePatterns: ['row-1'],
    cardPoolSize: 3,
    cardPoolSeed: 'countdown-test-seed',
  });
  const users = await Promise.all([
    repositories.users.upsertFromTelegram({ telegramId: 4001n, firstName: 'One' }),
    repositories.users.upsertFromTelegram({ telegramId: 4002n, firstName: 'Two' }),
  ]);
  const game = await repositories.games.create({ roomId: room.id });
  await Promise.all(users.map((user, index) =>
    repositories.players.reserveCard({
      gameId: game.id,
      userId: user.id,
      cardNumber: index + 1,
      cardCells: Array.from({ length: 25 }, (_, cell) => cell),
    }),
  ));
  const owner = new InMemoryGameOwnershipLease(clock);
  const publisher = { publishUser: vi.fn(async () => undefined) };
  const runner = { start: vi.fn(async () => true) };
  const lifecycle = {
    async startGame(gameId: string, fence: { instanceId: string; fencingToken: bigint }) {
      if ((await repositories.games.findById(gameId))?.status === 'LOBBY') {
        await repositories.games.updateStatus(gameId, 'STARTING', fence);
      }
      const active = await repositories.games.updateStatus(gameId, 'RUNNING', fence);
      return { game: active, players: await repositories.players.listByGame(gameId) };
    },
  };
  const createScheduler = () => new LobbyScheduler(
    'test-instance',
    repositories.games,
    repositories.rooms,
    repositories.players,
    owner,
    lifecycle as unknown as GameLifecycleService,
    runner as unknown as ConstructorParameters<typeof LobbyScheduler>[6],
    publisher,
    clock,
    clock,
    repositories.auditLogs,
    100,
  );
  return { createScheduler, repositories, room, game, users, clock, publisher, runner };
}

describe('LobbyScheduler', () => {
  it('recovers a persisted countdown and starts only once after expiry', async () => {
    const { createScheduler, repositories, game, clock, publisher, runner } = await createLobby();
    const firstInstance = createScheduler();
    await firstInstance.recover();
    const starting = await repositories.games.findById(game.id);
    expect(starting?.startingAt?.getTime()).toBe(1500);
    expect(publisher.publishUser).toHaveBeenCalledTimes(2);

    const restartedInstance = createScheduler();
    await restartedInstance.recover();
    expect(publisher.publishUser).toHaveBeenCalledTimes(2);

    await clock.advanceBy(1500);
    await restartedInstance.recover();
    expect((await repositories.games.findById(game.id))?.status).toBe('RUNNING');
    expect(runner.start).toHaveBeenCalledTimes(1);
    await restartedInstance.recover();
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('cancels the countdown when the lobby falls below its minimum', async () => {
    const { createScheduler, repositories, game, users, clock, runner } = await createLobby();
    const scheduler = createScheduler();
    await scheduler.recover();
    await repositories.players.remove(game.id, users[0]!.id);
    await clock.advanceBy(1500);
    await scheduler.recover();
    expect((await repositories.games.findById(game.id))?.status).toBe('LOBBY');
    expect((await repositories.games.findById(game.id))?.startingAt).toBeNull();
    expect(runner.start).not.toHaveBeenCalled();
  });
});
