import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@bingo/shared';
import { createInMemoryRepositories } from '../../../test/fakes/inMemoryRepositories.js';
import { GameRoomService } from './gameRoomService.js';

async function createHarness(options: { stakeMinor?: bigint; balanceMinor?: bigint } = {}) {
  const repositories = createInMemoryRepositories();
  const user = await repositories.users.upsertFromTelegram({
    telegramId: 1001n,
    firstName: 'Player One',
  });
  const secondUser = await repositories.users.upsertFromTelegram({
    telegramId: 1002n,
    firstName: 'Player Two',
  });
  for (const player of [user, secondUser]) {
    const balance = options.balanceMinor ?? 100n;
    if (balance > 0n) {
      await repositories.ledger.apply({
        userId: player.id,
        type: 'ADMIN_ADJUSTMENT',
        amountMinor: balance,
        idempotencyKey: `seed:${player.id}`,
      });
    }
  }
  const room = await repositories.rooms.create({
    name: 'Test room',
    stakeMinor: options.stakeMinor ?? 10n,
    minPlayers: 2,
    maxPlayers: 5,
    drawIntervalMs: 5000,
    activePatterns: ['row-1'],
    cardPoolSize: 10,
    cardPoolSeed: 'test-card-pool-seed',
  });
  const lifecycle = { createGame: (roomId: string) => repositories.games.create({ roomId }) };
  const service = new GameRoomService(
    repositories.rooms,
    repositories.games,
    repositories.players,
    repositories.users,
    repositories.events,
    repositories.ledger,
    repositories.auditLogs,
    repositories.unitOfWork,
    lifecycle as never,
  );
  const game = await service.getOrCreateWaitingGame(room.id);
  return { repositories, service, user, secondUser, room, game };
}

describe('GameRoomService stake and membership transactions', () => {
  it('serializes simultaneous attempts for one card and debits exactly one stake', async () => {
    const { repositories, service, user, secondUser, game } = await createHarness();
    const outcomes = await Promise.allSettled([
      service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 }),
      service.joinGame({ gameId: game.id, userId: secondUser.id, cardNumber: 1 }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: ErrorCode.CARD_TAKEN } });
    expect((await repositories.players.listByGame(game.id))).toHaveLength(1);
    expect((await repositories.games.findById(game.id))?.potMinor).toBe(10n);
    expect(await repositories.ledger.getBalance(user.id) + await repositories.ledger.getBalance(secondUser.id)).toBe(190n);
  });

  it('rejects a repeated join without applying a second debit', async () => {
    const { repositories, service, user, game } = await createHarness();
    await service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 });
    await expect(service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await repositories.ledger.getBalance(user.id)).toBe(90n);
    expect((await repositories.games.findById(game.id))?.potMinor).toBe(10n);
  });

  it('rolls card reservation and pot updates back when the stake debit fails', async () => {
    const { repositories, service, user, game } = await createHarness({ balanceMinor: 0n });
    await expect(service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_FUNDS });
    expect(await repositories.players.findByGameAndUser(game.id, user.id)).toBeNull();
    expect((await repositories.games.findById(game.id))?.potMinor).toBe(0n);
  });

  it('enforces the configured active-game cap before reserving or debiting', async () => {
    const { repositories, service, user, game } = await createHarness();
    await service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 });
    const secondRoom = await repositories.rooms.create({
      name: 'Another room',
      stakeMinor: 10n,
      minPlayers: 2,
      maxPlayers: 5,
      drawIntervalMs: 5000,
      activePatterns: ['row-1'],
      cardPoolSize: 10,
      cardPoolSeed: 'another-test-card-pool-seed',
    });
    const secondGame = await repositories.games.create({ roomId: secondRoom.id });
    const limited = new GameRoomService(
      repositories.rooms,
      repositories.games,
      repositories.players,
      repositories.users,
      repositories.events,
      repositories.ledger,
      repositories.auditLogs,
      repositories.unitOfWork,
      { createGame: (roomId: string) => repositories.games.create({ roomId }) } as never,
      undefined,
      1,
    );
    await expect(limited.joinGame({ gameId: secondGame.id, userId: user.id, cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect((await repositories.games.findById(secondGame.id))?.potMinor).toBe(0n);
    expect(await repositories.players.findByGameAndUser(secondGame.id, user.id)).toBeNull();
    expect(await repositories.ledger.getBalance(user.id)).toBe(90n);
  });

  it('refunds leave and cancellation exactly once and clears the pot', async () => {
    const { repositories, service, user, secondUser, game } = await createHarness();
    await service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 });
    await service.leaveGame(game.id, user.id);
    await expect(service.leaveGame(game.id, user.id)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(await repositories.ledger.getBalance(user.id)).toBe(100n);
    expect((await repositories.games.findById(game.id))?.potMinor).toBe(0n);

    await service.joinGame({ gameId: game.id, userId: user.id, cardNumber: 1 });
    await service.joinGame({ gameId: game.id, userId: secondUser.id, cardNumber: 2 });
    await service.cancelGame(game.id, 'administrative cancellation');
    await service.cancelGame(game.id, 'retry');
    expect(await repositories.ledger.getBalance(user.id)).toBe(100n);
    expect(await repositories.ledger.getBalance(secondUser.id)).toBe(100n);
    expect((await repositories.games.findById(game.id))?.potMinor).toBe(0n);
    expect((await repositories.games.findById(game.id))?.status).toBe('CANCELLED');
  });
});
