import { generateCard, commitSeed } from '@bingo/engine';
import { ErrorCode } from '@bingo/shared';
import { describe, expect, it } from 'vitest';
import { createGameTestHarness } from '../../../test/helpers/createGameTestHarness.js';

describe('GameLifecycleService with transactional repositories', () => {
  it('creates an empty waiting game without invented stake revenue', async () => {
    const h = await createGameTestHarness();
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({
      status: 'LOBBY', currentSeq: 0, seedHash: null, potMinor: 0n,
    });
    expect(await h.repositories.players.listByGame(h.game.id)).toEqual([]);
    expect(await h.allEvents()).toEqual([]);
    expect(h.publisher.messages).toEqual([]);
  });

  it('rejects missing/closed rooms and atomically permits only one active game', async () => {
    const h = await createGameTestHarness();
    await expect(h.lifecycle.createGame(crypto.randomUUID())).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await h.repositories.rooms.update(h.room.id, { status: 'CLOSED' });
    await expect(h.lifecycle.createGame(h.room.id)).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await h.repositories.rooms.update(h.room.id, { status: 'OPEN' });
    const results = await Promise.allSettled([
      h.lifecycle.createGame(h.room.id), h.lifecycle.createGame(h.room.id),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: ErrorCode.CONFLICT });
    }
    expect(await h.repositories.games.findActiveByRoom(h.room.id)).toMatchObject({ id: h.game.id });
  });

  it('reserves deterministic private cards, prevents collision and makes rejoin idempotent', async () => {
    const h = await createGameTestHarness();
    const input = { gameId: h.game.id, userId: h.users[0]!.id, cardNumber: 1 };
    expect(await h.lifecycle.joinGame(input)).toBe('reserved');
    expect(await h.lifecycle.joinGame({ ...input, cardNumber: 2 })).toBe('already_joined');
    expect(await h.lifecycle.joinGame({ ...input, userId: h.users[1]!.id })).toBe('card_taken');
    const player = (await h.repositories.players.listByGame(h.game.id))[0]!;
    expect(player.cardCells).toEqual(generateCard('deterministic-test-card-pool', 1).cells);
    expect(player.cardCells).toHaveLength(25);
    expect(player.cardCells[12]).toBe(0);
    expect(await h.repositories.ledger.getBalance(input.userId)).toBe(0n);
  });

  it('serializes concurrent card reservations and enforces player capacity', async () => {
    const h = await createGameTestHarness({ room: { minPlayers: 1, maxPlayers: 1 } });
    const outcomes = await Promise.allSettled(h.users.map((user) =>
      h.lifecycle.joinGame({ gameId: h.game.id, userId: user.id, cardNumber: 1 })));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected')!;
    if (rejected.status === 'rejected') expect(rejected.reason).toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.repositories.players.listByGame(h.game.id)).toHaveLength(1);
  });

  it('returns reserved/card_taken for concurrent same-card joins without capacity interference', async () => {
    const h = await createGameTestHarness({ room: { maxPlayers: 4 } });
    expect(await Promise.all(h.users.map((user) =>
      h.lifecycle.joinGame({ gameId: h.game.id, userId: user.id, cardNumber: 1 }))))
      .toEqual(['reserved', 'card_taken']);
    expect(await h.repositories.players.listByGame(h.game.id)).toHaveLength(1);
  });

  it.each([0, -1, 101, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid pool card number %s without reservation', async (cardNumber) => {
    const h = await createGameTestHarness();
    await expect(h.lifecycle.joinGame({ gameId: h.game.id, userId: h.users[0]!.id, cardNumber }))
      .rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(await h.repositories.players.listByGame(h.game.id)).toEqual([]);
  });

  it('rejects banned/nonexistent users and closed rooms without reserving cards', async () => {
    const h = await createGameTestHarness();
    await h.repositories.users.setStatus(h.users[0]!.id, 'BANNED');
    await expect(h.lifecycle.joinGame({ gameId: h.game.id, userId: h.users[0]!.id, cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    await expect(h.lifecycle.joinGame({ gameId: h.game.id, userId: crypto.randomUUID(), cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await h.repositories.rooms.update(h.room.id, { status: 'CLOSED' });
    await expect(h.lifecycle.joinGame({ gameId: h.game.id, userId: h.users[1]!.id, cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect(await h.repositories.players.listByGame(h.game.id)).toEqual([]);
  });

  it('releases waiting cards and makes absent-player leave a no-op', async () => {
    const h = await createGameTestHarness();
    await h.join();
    await h.lifecycle.leaveGame(h.game.id, h.users[0]!.id);
    await h.lifecycle.leaveGame(h.game.id, h.users[0]!.id);
    expect(await h.repositories.players.listByGame(h.game.id)).toHaveLength(1);
    expect(await h.lifecycle.joinGame({ gameId: h.game.id, userId: h.users[0]!.id, cardNumber: 1 })).toBe('reserved');
  });

  it('does not start below minimum and does not consume or publish a seed', async () => {
    const h = await createGameTestHarness();
    await h.lifecycle.joinGame({ gameId: h.game.id, userId: h.users[0]!.id, cardNumber: 1 });
    await expect(h.lifecycle.startGame(h.game.id, h.initialFence)).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'LOBBY', seedHash: null });
    expect(await h.allEvents()).toEqual([]);
    expect(h.publisher.messages).toEqual([]);
  });

  it('starts once with a 32-byte commitment and schema-valid recipient-only cards', async () => {
    const h = await createGameTestHarness();
    const results = await h.start();
    const commitment = (await h.repositories.games.getSeedCommitment(h.game.id))!;
    const seed = await h.vault.open(commitment.seedEncrypted);
    expect(Buffer.from(seed, 'base64url')).toHaveLength(32);
    expect(commitment.seedHash).toBe(commitSeed(seed));
    expect(results.game).toMatchObject({ status: 'RUNNING', currentSeq: 1 });
    expect(results.game).not.toHaveProperty('seedEncrypted');
    await expect(h.repositories.games.revealSeed(h.game.id)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.allEvents()).toMatchObject([{ type: 'GAME_STARTED', seq: 1 }]);
    for (const user of h.users) {
      const started = h.publisher.forUser(user.id, 'game:started');
      expect(started).toHaveLength(1);
      const message = started[0]!;
      const card = (await h.repositories.players.findByGameAndUser(h.game.id, user.id))!;
      expect(message.payload).toMatchObject({ yourCard: { cardNumber: card.cardNumber, cells: card.cardCells }, seq: 1 });
      expect(message.payload).not.toHaveProperty('seedRevealed');
      expect(message.payload).not.toHaveProperty('drawSequence');
    }
    for (const message of h.publisher.messages) {
      const serialized = JSON.stringify(message.payload);
      expect(serialized).not.toContain(seed);
      expect(serialized).not.toContain(commitment.seedEncrypted);
      expect(serialized).not.toContain('deterministic-test-card-pool');
    }
    const before = await h.allEvents();
    await expect(h.lifecycle.startGame(h.game.id, h.initialFence)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.allEvents()).toEqual(before);
    for (const user of h.users) expect(h.publisher.forUser(user.id, 'game:started')).toHaveLength(1);
  });

  it('rejects a stale start fence without seed commitment or status mutation', async () => {
    const h = await createGameTestHarness();
    await h.join();
    await expect(h.lifecycle.startGame(h.game.id, { instanceId: 'stale', fencingToken: 0n }))
      .rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'LOBBY', currentSeq: 0, seedHash: null });
  });

  it('prevents join/leave after start', async () => {
    const h = await createGameTestHarness();
    await h.start();
    await expect(h.lifecycle.joinGame({ gameId: h.game.id, userId: h.users[0]!.id, cardNumber: 1 }))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await expect(h.lifecycle.leaveGame(h.game.id, h.users[0]!.id)).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });

  it.each(['waiting', 'starting', 'running'] as const)('cancels a %s game, emits private snapshots and frees the room', async (phase) => {
    const h = await createGameTestHarness();
    if (phase === 'running') await h.start();
    else await h.join();
    if (phase === 'starting') await h.repositories.games.updateStatus(h.game.id, 'STARTING', h.initialFence);
    h.publisher.clear();
    await h.lifecycle.cancelGame(h.game.id, 'x'.repeat(600), await h.fence());
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'CANCELLED', endedAt: new Date(0) });
    expect((await h.allEvents()).at(-1)).toMatchObject({ type: 'GAME_CANCELLED', payload: { reason: 'x'.repeat(500) } });
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_CANCELLED')).toHaveLength(1);
    expect(await h.projector.project((await h.repositories.games.findById(h.game.id))!)).toMatchObject({ status: 'cancelled' });
    for (const user of h.users) {
      expect(h.publisher.forUser(user.id, 'state:snapshot')[0]!.payload).toMatchObject({
        game: { status: 'cancelled', yourCard: { cardNumber: h.users.indexOf(user) + 1 } },
      });
    }
    await expect(h.drawNext()).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await expect(h.claim()).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await expect(h.lifecycle.cancelGame(h.game.id, 'again', await h.fence())).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_CANCELLED')).toHaveLength(1);
    expect((await h.lifecycle.createGame(h.room.id)).id).not.toBe(h.game.id);
  });

  it('permits a new game after the previous room game has ended', async () => {
    const h = await createGameTestHarness();
    await h.start();
    for (let index = 0; index < 76; index += 1) await h.drawNext();
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'ENDED' });
    const next = await h.lifecycle.createGame(h.room.id);
    expect(next).toMatchObject({ roomId: h.room.id, status: 'LOBBY' });
    expect(next.id).not.toBe(h.game.id);
  });
});
