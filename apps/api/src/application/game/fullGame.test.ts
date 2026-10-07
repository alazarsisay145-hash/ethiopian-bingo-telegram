import { checkWin, commitSeed, generateDrawSequence, verifySeed, WIN_PATTERNS } from '@bingo/engine';
import { ErrorCode, serverPayloadSchemas } from '@bingo/shared';
import { describe, expect, it } from 'vitest';
import { createGameTestHarness } from '../../../test/helpers/createGameTestHarness.js';
import { projectGameState } from './state.js';

describe('complete games through real application services', () => {
  it('runs five distinct players to an actual row winner with exact private event prefixes and fold-consistent snapshots', async () => {
    const h = await createGameTestHarness({ playerCount: 5, potMinor: 17n, room: { minPlayers: 5 } });
    await h.start();
    expect(new Set(h.users.map(({ id }) => id)).size).toBe(5);
    const players = await h.repositories.players.listByGame(h.game.id);
    expect(new Set(players.map(({ cardNumber }) => cardNumber)).size).toBe(5);
    const own = (await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))!;
    const required = own.cardCells.slice(0, 5);
    const called = new Set<number>();
    await h.startRunner();
    while (!required.every((number) => called.has(number))) {
      await h.clock.advanceBy(h.room.drawIntervalMs);
      const latest = (await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED').at(-1)!;
      called.add((latest.payload as { number: number }).number);
    }
    await h.handlers['game:claim']!({ gameId: h.game.id }, h.context(h.users[0]!));
    await h.clock.advanceBy(h.room.drawIntervalMs);
    const game = (await h.repositories.games.findById(h.game.id))!;
    expect(game.status).toBe('ENDED');
    const allEvents = await h.allEvents();
    const endPayload = allEvents.at(-1)!.payload as { seedRevealed: string; drawSequence: number[]; winnerIds: string[] };
    const calledSequence = [...called];
    expect(calledSequence.length).toBeGreaterThanOrEqual(4);
    expect(calledSequence.length).toBeLessThanOrEqual(75);
    expect(new Set(calledSequence).size).toBe(calledSequence.length);
    expect(calledSequence).toEqual(generateDrawSequence(endPayload.seedRevealed).slice(0, calledSequence.length));
    expect(endPayload.drawSequence).toHaveLength(75);
    expect(new Set(endPayload.drawSequence).size).toBe(75);
    expect(endPayload.winnerIds).toEqual([h.users[0]!.id]);
    expect(endPayload.drawSequence.slice(0, calledSequence.length)).toEqual(calledSequence);
    for (const user of h.users) {
      const started = h.publisher.forUser(user.id, 'game:started');
      expect(started).toHaveLength(1);
      const startedPayload = serverPayloadSchemas['game:started'].parse(started[0]!.payload);
      expect(verifySeed(endPayload.seedRevealed, startedPayload.seedHash)).toBe(true);
      expect(startedPayload.seedHash).toBe(commitSeed(endPayload.seedRevealed));
      const numbers = h.publisher.forUser(user.id, 'game:number');
      expect(numbers).toHaveLength(calledSequence.length);
      for (const [index, message] of numbers.entries()) {
        const payload = serverPayloadSchemas['game:number'].parse(message.payload);
        expect(payload.number).toBe(calledSequence[index]);
        expect(payload.calledNumbers).toEqual(calledSequence.slice(0, index + 1));
      }
      const messages = h.publisher.forUser(user.id);
      const seqs = messages.map(({ payload }) => (payload as { seq: number }).seq);
      expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true);
      expect(h.publisher.forUser(user.id, 'game:ended')).toHaveLength(1);
      const publishedEnd = serverPayloadSchemas['game:ended'].parse(
        h.publisher.forUser(user.id, 'game:ended')[0]!.payload,
      );
      expect(verifySeed(publishedEnd.seedRevealed, startedPayload.seedHash)).toBe(true);
      expect(publishedEnd.drawSequence).toEqual(endPayload.drawSequence);
      for (const message of messages.filter(({ event }) => event !== 'game:ended')) {
        expect(JSON.stringify(message.payload)).not.toContain(endPayload.seedRevealed);
      }
    }
    const projection = await h.projector.project(game);
    expect(projection).toEqual(projectGameState({
      gameId: h.game.id, roomId: h.room.id, events: allEvents,
      players: players.map(({ userId }) => ({ userId, status: 'ACTIVE' })),
    }));
    await h.handlers['state:resync']!({ gameId: h.game.id, lastSeq: projection.seq }, h.context(h.users[4]!));
    const snapshot = serverPayloadSchemas['state:snapshot'].parse(
      h.publisher.forUser(h.users[4]!.id, 'state:snapshot')[0]!.payload,
    );
    expect(snapshot).toEqual({
      game: {
        gameId: projection.gameId, roomId: projection.roomId, status: projection.status,
        seq: projection.seq, calledNumbers: projection.calledNumbers, seedHash: game.seedHash,
        players: projection.players.map(({ userId, status }) => ({ userId, status: status.toLowerCase() })),
        winnerIds: projection.winnerIds,
        yourCard: { cardNumber: 5, cells: players[4]!.cardCells },
      },
      seq: projection.seq,
    });
    expect(await h.repositories.ledger.getBalance(h.users[0]!.id)).toBe(17n);
    expect(await h.claimService.verifyFairness(h.game.id)).toBe(true);
    expect(h.lease.hasOwner(h.game.id)).toBe(false);
    expect(h.clock.pendingTasks).toBe(0);
  });

  it('finishes on an early row win and reveals the full permutation, including undrawn numbers', async () => {
    const h = await createGameTestHarness({ potMinor: 13n });
    await h.start();
    const player = (await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))!;
    const called = new Set<number>();
    const row = WIN_PATTERNS.filter(({ id }) => id === 'row-1');
    while (!checkWin({ cardNumber: player.cardNumber, cells: player.cardCells }, called, row).won) {
      called.add(((await h.drawNext()).payload as { number: number }).number);
    }
    expect(called.size).toBeLessThan(75);
    const accepted = await h.claim();
    expect(accepted).toMatchObject({ accepted: true, patterns: ['row-1'] });
    const ended = await h.drawNext();
    const payload = ended.payload as { seedRevealed: string; drawSequence: number[]; winnerIds: string[] };
    expect(payload.winnerIds).toEqual([h.users[0]!.id]);
    expect(payload.drawSequence).toHaveLength(75);
    expect(payload.drawSequence.slice(0, called.size)).toEqual([...called]);
    expect((await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')).toHaveLength(called.size);
    expect(await h.repositories.ledger.getBalance(h.users[0]!.id)).toBe(13n);
    expect(await h.repositories.ledger.getBalance(h.users[1]!.id)).toBe(0n);
    expect(await h.claimService.verifyFairness(h.game.id)).toBe(true);
  });

  it('runs all 75 unique seeded draws to winnerless completion and verifies fairness', async () => {
    const h = await createGameTestHarness({ playerCount: 5, room: { minPlayers: 5 } });
    await h.start();
    expect(await h.startRunner()).toBe(true);
    await h.clock.advanceBy(h.room.drawIntervalMs * 76);
    const events = await h.allEvents();
    const draws = events.filter(({ type }) => type === 'NUMBER_CALLED');
    const end = events.at(-1)!;
    expect(draws).toHaveLength(75);
    expect(events.map(({ seq }) => seq)).toEqual(Array.from({ length: 77 }, (_, index) => index + 1));
    expect(end.type).toBe('GAME_ENDED');
    const payload = end.payload as { seedRevealed: string; drawSequence: number[]; winnerIds: string[] };
    expect(payload.winnerIds).toEqual([]);
    expect(payload.drawSequence).toEqual(generateDrawSequence(payload.seedRevealed));
    expect(new Set(payload.drawSequence).size).toBe(75);
    expect([...payload.drawSequence].sort((a, b) => a - b)).toEqual(Array.from({ length: 75 }, (_, index) => index + 1));
    expect(draws.map(({ payload }) => (payload as { number: number }).number)).toEqual(payload.drawSequence);
    expect(verifySeed(payload.seedRevealed, (await h.repositories.games.findById(h.game.id))!.seedHash!)).toBe(true);
    expect(await h.claimService.verifyFairness(h.game.id)).toBe(true);
    expect(await h.repositories.games.revealSeed(h.game.id)).toMatchObject({ seedHash: commitSeed(payload.seedRevealed) });
    expect(h.clock.pendingTasks).toBe(0);
    expect(h.lease.hasOwner(h.game.id)).toBe(false);
    for (const user of h.users) {
      const started = serverPayloadSchemas['game:started'].parse(
        h.publisher.forUser(user.id, 'game:started')[0]!.payload,
      );
      expect(verifySeed(payload.seedRevealed, started.seedHash)).toBe(true);
      const numberMessages = h.publisher.forUser(user.id, 'game:number');
      expect(numberMessages).toHaveLength(75);
      for (const [index, message] of numberMessages.entries()) {
        const number = serverPayloadSchemas['game:number'].parse(message.payload);
        expect(number.calledNumbers).toEqual(payload.drawSequence.slice(0, index + 1));
        expect(number.number).toBe(payload.drawSequence[index]);
        expect(number.seq).toBe(index + 2);
      }
      expect(h.publisher.forUser(user.id, 'game:ended')).toHaveLength(1);
      expect(await h.repositories.ledger.listByUser(user.id)).toEqual([]);
    }
    const before = await h.allEvents();
    await h.clock.advanceBy(10_000);
    expect(await h.allEvents()).toEqual(before);
    await expect(h.drawNext()).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });

  it('rejects early claims, keeps drawing for others, settles simultaneous winners and resyncs private state', async () => {
    const h = await createGameTestHarness({
      playerCount: 3, potMinor: 7n, room: { activePatterns: ['full-house'] },
    });
    await h.start();
    await h.handlers['game:claim']!({ gameId: h.game.id }, h.context(h.users[0]!));
    expect(await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id)).toMatchObject({ status: 'DISQUALIFIED' });
    expect(await h.startRunner()).toBe(true);
    await h.clock.advanceBy(75 * h.room.drawIntervalMs);
    await Promise.all(h.users.slice(1).map((user) =>
      h.handlers['game:claim']!({ gameId: h.game.id }, h.context(user))));
    await h.clock.advanceBy(h.room.drawIntervalMs);
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'ENDED' });
    expect((await h.allEvents()).at(-1)!.payload).toMatchObject({ winnerIds: h.users.slice(1).map(({ id }) => id) });
    expect(await h.repositories.ledger.getBalance(h.users[0]!.id)).toBe(0n);
    expect(await h.repositories.ledger.getBalance(h.users[1]!.id)).toBe(4n);
    expect(await h.repositories.ledger.getBalance(h.users[2]!.id)).toBe(3n);
    expect(await h.claimService.verifyFairness(h.game.id)).toBe(true);
    h.publisher.clear();
    const seq = await h.repositories.events.latestSeq(h.game.id);
    await h.handlers['state:resync']!({ gameId: h.game.id, lastSeq: seq }, h.context(h.users[1]!));
    expect(h.publisher.messages).toHaveLength(1);
    const snapshot = h.publisher.messages[0]!;
    expect(snapshot.userId).toBe(h.users[1]!.id);
    expect(snapshot.payload).toMatchObject({
      game: {
        status: 'finished', yourCard: { cardNumber: 2 },
        winnerIds: h.users.slice(1).map(({ id }) => id),
        players: [
          { userId: h.users[0]!.id, status: 'disqualified' },
          { userId: h.users[1]!.id, status: 'winner' },
          { userId: h.users[2]!.id, status: 'winner' },
        ],
      },
      seq,
    });
    expect(snapshot.payload).not.toHaveProperty('game.seedRevealed');
    expect(snapshot.payload).not.toHaveProperty('game.drawSequence');
  });

  it('restarts an interrupted runner from persisted draw index without repeats or skipped sequences', async () => {
    const h = await createGameTestHarness();
    await h.start();
    await h.startRunner();
    await h.clock.advanceBy(5 * h.room.drawIntervalMs);
    await h.runner.stop(h.game.id);
    expect(h.clock.pendingTasks).toBe(0);
    const before = await h.allEvents();
    await h.clock.advanceBy(3 * h.room.drawIntervalMs);
    expect(await h.allEvents()).toEqual(before);
    expect(await h.runner.start(h.game.id)).toBe(true);
    await h.clock.advanceBy(0);
    expect((await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')).toHaveLength(6);
    await h.clock.advanceBy(70 * h.room.drawIntervalMs);
    const events = await h.allEvents();
    const draws = events.filter(({ type }) => type === 'NUMBER_CALLED');
    expect(draws).toHaveLength(75);
    expect(new Set(draws.map(({ payload }) => (payload as { number: number }).number)).size).toBe(75);
    expect(events.at(-1)!.type).toBe('GAME_ENDED');
    expect(await h.claimService.verifyFairness(h.game.id)).toBe(true);
    expect(h.clock.pendingTasks).toBe(0);
  });
});
