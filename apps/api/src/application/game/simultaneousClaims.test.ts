import { ErrorCode } from '@bingo/shared';
import { generateCard, generateDrawSequence } from '@bingo/engine';
import { describe, expect, it } from 'vitest';
import { createGameTestHarness } from '../../../test/helpers/createGameTestHarness.js';

async function fullyDrawnGame(potMinor = 0n) {
  const h = await createGameTestHarness({ potMinor, playerCount: 3, room: { activePatterns: ['full-house'] } });
  await h.start();
  for (let index = 0; index < 75; index += 1) await h.drawNext();
  return h;
}

describe('simultaneous claim window and idempotent settlement', () => {
  it('settles three valid same-draw claimants while a fourth false claimant is disqualified', async () => {
    const poolSeed = 'deterministic-test-card-pool';
    const drawSequence = generateDrawSequence(Buffer.alloc(32, 1).toString('base64url'));
    const drawIndices = new Map(drawSequence.map((number, index) => [number, index]));
    const candidates = Array.from({ length: 1000 }, (_, index) => {
      const card = generateCard(poolSeed, index + 1);
      const completionIndex = Math.max(...card.cells.slice(0, 5).map((number) => drawIndices.get(number)!));
      return { card, completionIndex };
    });
    const groups = new Map<number, typeof candidates>();
    for (const candidate of candidates) {
      groups.set(candidate.completionIndex, [...(groups.get(candidate.completionIndex) ?? []), candidate]);
    }
    const [completionIndex, matching] = [...groups.entries()].sort(([a], [b]) => a - b)
      .find(([index, group]) => group.length >= 3 && candidates.some((candidate) => candidate.completionIndex > index))!;
    const incomplete = candidates.find((candidate) => candidate.completionIndex > completionIndex)!;
    const selected = [...matching.slice(0, 3), incomplete];
    const h = await createGameTestHarness({
      playerCount: 4, potMinor: 11n,
      room: { minPlayers: 4, cardPoolSize: 1000, activePatterns: ['row-1'] },
    });
    for (const [index, user] of h.users.entries()) {
      await h.lifecycle.joinGame({ gameId: h.game.id, userId: user.id, cardNumber: selected[index]!.card.cardNumber });
    }
    await h.start();
    for (let index = 0; index <= completionIndex; index += 1) await h.drawNext();
    const atSeq = (await h.allEvents()).at(-1)!.seq;
    const results = await Promise.all(h.users.map((user) => h.claim(user.id)));
    expect(results.map(({ accepted }) => accepted)).toEqual([true, true, true, false]);
    const recorded = await h.repositories.claims.listByGame(h.game.id);
    expect(recorded).toHaveLength(4);
    expect(recorded.every((claim) => claim.atSeq === atSeq)).toBe(true);
    expect(recorded.filter(({ accepted }) => accepted)).toHaveLength(3);
    expect(await h.repositories.players.findByGameAndUser(h.game.id, h.users[3]!.id))
      .toMatchObject({ status: 'DISQUALIFIED' });
    const ended = await h.drawNext();
    expect(ended.payload).toMatchObject({ winnerIds: h.users.slice(0, 3).map(({ id }) => id) });
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_ENDED')).toHaveLength(1);
    expect((await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')).toHaveLength(completionIndex + 1);
    const balances: bigint[] = [];
    for (const [index, user] of h.users.entries()) {
      balances.push(await h.repositories.ledger.getBalance(user.id));
      expect(await h.repositories.players.findByGameAndUser(h.game.id, user.id))
        .toMatchObject({ status: index === 3 ? 'DISQUALIFIED' : 'WINNER' });
      const entries = await h.repositories.ledger.listByUser(user.id);
      if (index === 3) expect(entries).toEqual([]);
      else expect(entries).toMatchObject([{
        type: 'PRIZE', refId: h.game.id, idempotencyKey: `game:${h.game.id}:prize:${user.id}`,
      }]);
      expect(entries).toHaveLength(index === 3 ? 0 : 1);
    }
    expect(balances).toEqual([5n, 3n, 3n, 0n]);
    expect(balances.reduce((sum, balance) => sum + balance, 0n)).toBe(11n);
  });

  it('accepts concurrent claims at one draw index and settles all on the next tick', async () => {
    const h = await fullyDrawnGame(11n);
    const drawSeq = (await h.allEvents()).at(-1)!.seq;
    const results = await Promise.all(h.users.map((user) => h.claim(user.id)));
    expect(results.every(({ accepted }) => accepted)).toBe(true);
    expect(new Set(results.map(({ seq }) => seq)).size).toBe(3);
    expect((await h.repositories.claims.listByGame(h.game.id)).every(({ atSeq }) => atSeq === drawSeq)).toBe(true);
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'RUNNING' });
    const ended = await h.drawNext();
    expect(ended.type).toBe('GAME_ENDED');
    expect(ended.payload).toMatchObject({ winnerIds: h.users.map(({ id }) => id) });
    expect((await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')).toHaveLength(75);
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'ENDED', seedRevealedAt: new Date(0) });
    expect(await h.repositories.ledger.getBalance(h.users[0]!.id)).toBe(5n);
    expect(await h.repositories.ledger.getBalance(h.users[1]!.id)).toBe(3n);
    expect(await h.repositories.ledger.getBalance(h.users[2]!.id)).toBe(3n);
    for (const user of h.users) {
      expect(await h.repositories.players.findByGameAndUser(h.game.id, user.id)).toMatchObject({ status: 'WINNER' });
      expect(await h.repositories.ledger.listByUser(user.id)).toHaveLength(1);
    }
    expect(await h.settlement.finish(h.game.id, [], await h.fence())).toEqual(ended);
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_ENDED')).toHaveLength(1);
  });

  it('orders remainder by accepted events, not player/card order or claim UUID ties', async () => {
    const h = await fullyDrawnGame(10n);
    const order = [h.users[2]!, h.users[0]!, h.users[1]!];
    for (const user of order) await h.claim(user.id);
    expect((await h.drawNext()).payload).toMatchObject({ winnerIds: order.map(({ id }) => id) });
    expect(await h.repositories.ledger.getBalance(order[0]!.id)).toBe(4n);
    expect(await h.repositories.ledger.getBalance(order[1]!.id)).toBe(3n);
    expect(await h.repositories.ledger.getBalance(order[2]!.id)).toBe(3n);
  });

  it('deduplicates active-game claims but rejects winner and non-winner retries after the game ends', async () => {
    const h = await fullyDrawnGame(12n);
    const results = await Promise.all(Array.from({ length: 10 }, () => h.claim()));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(await h.repositories.claims.listByGame(h.game.id)).toHaveLength(1);
    expect((await h.allEvents()).filter(({ type }) => type === 'CLAIM_ACCEPTED')).toHaveLength(1);
    await h.drawNext();
    const beforeRetries = await h.allEvents();
    await expect(h.claim()).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect(await h.repositories.ledger.getBalance(h.users[0]!.id)).toBe(12n);
    await expect(h.claim(h.users[1]!.id)).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect(await h.repositories.ledger.listByUser(h.users[1]!.id)).toEqual([]);
    expect(await h.repositories.claims.listByGame(h.game.id)).toHaveLength(1);
    expect((await h.allEvents()).filter(({ type }) => type === 'CLAIM_ACCEPTED')).toHaveLength(1);
    expect(await h.allEvents()).toEqual(beforeRetries);
  });

  it('does not invent ledger payouts for a zero pot', async () => {
    const h = await fullyDrawnGame();
    await Promise.all(h.users.map((user) => h.claim(user.id)));
    await h.drawNext();
    for (const user of h.users) {
      expect(await h.repositories.ledger.getBalance(user.id)).toBe(0n);
      expect(await h.repositories.ledger.listByUser(user.id)).toEqual([]);
    }
  });

  it('retries partial settlement without paying a persisted prize twice', async () => {
    const h = await fullyDrawnGame(9n);
    for (const user of h.users) await h.claim(user.id);
    h.repositories.failNext('games.finalize');
    await expect(h.drawNext()).rejects.toThrow('Injected games.finalize failure');
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'SETTLING' });
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_ENDED')).toEqual([]);
    await h.drawNext();
    for (const user of h.users) {
      expect(await h.repositories.ledger.getBalance(user.id)).toBe(3n);
      expect(await h.repositories.ledger.listByUser(user.id)).toHaveLength(1);
    }
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_ENDED')).toHaveLength(1);
  });

  it('does not count a forged winner without an accepted claim at the latest draw', async () => {
    const h = await fullyDrawnGame(8n);
    await h.claim(h.users[0]!.id);
    const event = await h.settlement.finish(h.game.id, [h.users[1]!.id, h.users[0]!.id, h.users[0]!.id], await h.fence());
    expect(event.payload).toMatchObject({ winnerIds: [h.users[0]!.id] });
    expect(await h.repositories.ledger.getBalance(h.users[0]!.id)).toBe(8n);
    expect(await h.repositories.ledger.getBalance(h.users[1]!.id)).toBe(0n);
  });

  it('rolls back a failed claim/event transaction and safely accepts a retry', async () => {
    const h = await fullyDrawnGame();
    const seq = await h.repositories.events.latestSeq(h.game.id);
    h.repositories.failNext('claims.recordWithEvent');
    await expect(h.claim()).rejects.toThrow('Injected claims.recordWithEvent failure');
    expect(await h.repositories.claims.listByGame(h.game.id)).toEqual([]);
    expect(await h.repositories.events.latestSeq(h.game.id)).toBe(seq);
    expect(await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await h.claim()).toMatchObject({ accepted: true, seq: seq + 1 });
  });

  it('closes the simultaneous window on the next draw tick before a late claim can enter', async () => {
    const h = await fullyDrawnGame();
    await h.claim(h.users[0]!.id);
    const settled = h.drawNext();
    await h.clock.flush();
    await expect(h.claim(h.users[1]!.id)).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect((await settled).payload).toMatchObject({ winnerIds: [h.users[0]!.id] });
    expect(await h.repositories.claims.listByGame(h.game.id)).toHaveLength(1);
  });
});
