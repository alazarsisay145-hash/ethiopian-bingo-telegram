import { WIN_PATTERNS, checkWin, generateDrawSequence } from '@bingo/engine';
import { ErrorCode } from '@bingo/shared';
import { describe, expect, it } from 'vitest';
import { createGameTestHarness } from '../../../test/helpers/createGameTestHarness.js';

describe('ClaimService server-authoritative configured patterns', () => {
  it.each(WIN_PATTERNS.map((pattern) => ({ id: pattern.id, cells: [...pattern.cells] })))(
    'excludes completed disabled $id while honoring any other completed enabled pattern',
    async ({ id, cells }) => {
      const cardNumber = ['row-2', 'column-G', 'diagonal-anti'].includes(id) ? 3 : 1;
      const h = await createGameTestHarness({
        room: { activePatterns: [id === 'full-house' ? 'row-1' : 'full-house'] },
      });
      const enabled = await createGameTestHarness({ room: { activePatterns: [id] } });
      for (const harness of [enabled, h]) {
        await harness.lifecycle.joinGame({
          gameId: harness.game.id, userId: harness.users[0]!.id, cardNumber,
        });
        await harness.start();
      }
      const commitment = (await h.repositories.games.getSeedCommitment(h.game.id))!;
      const drawSequence = generateDrawSequence(await h.vault.open(commitment.seedEncrypted));
      const enabledCommitment = (await enabled.repositories.games.getSeedCommitment(enabled.game.id))!;
      expect(generateDrawSequence(await enabled.vault.open(enabledCommitment.seedEncrypted))).toEqual(drawSequence);
      const drawIndices = new Map(drawSequence.map((number, index) => [number, index]));
      const player = (await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))!;
      expect(player.cardNumber).toBe(cardNumber);
      const completionIndex = Math.max(...cells.map((index) => player.cardCells[index]!)
        .filter((number) => number !== 0).map((number) => drawIndices.get(number)!));
      const houseIndex = Math.max(...player.cardCells.filter((number) => number !== 0)
        .map((number) => drawIndices.get(number)!));
      if (id !== 'full-house') expect(completionIndex).toBeLessThan(houseIndex);
      for (const harness of [enabled, h]) {
        for (let index = 0; index <= completionIndex; index += 1) await harness.drawNext();
      }
      const called = (await h.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')
        .map(({ payload }) => (payload as { number: number }).number);
      expect(called).toEqual(drawSequence.slice(0, completionIndex + 1));
      expect((await enabled.allEvents()).filter(({ type }) => type === 'NUMBER_CALLED')
        .map(({ payload }) => (payload as { number: number }).number)).toEqual(called);
      expect(await enabled.claim()).toMatchObject({ accepted: true, patterns: [id] });
      const result = await h.claim();
      expect(result.patterns).not.toContain(id);
      if (id === 'full-house') {
        // A full house necessarily completes all smaller patterns; disabling it
        // must not reject an independently valid, enabled row.
        expect(result).toMatchObject({ accepted: true, patterns: ['row-1'] });
      } else {
        expect(result).toMatchObject({ accepted: false, patterns: [] });
        expect(await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))
          .toMatchObject({ status: 'DISQUALIFIED' });
      }
    },
  );

  it.each(WIN_PATTERNS.map((pattern) => ({ id: pattern.id, cells: [...pattern.cells] })))(
    'accepts $id from persisted cards and called events (free center needs no draw)',
    async ({ id, cells }) => {
      const h = await createGameTestHarness({ room: { activePatterns: [id] } });
      await h.start();
      const player = (await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))!;
      const required = new Set(cells.map((index) => player.cardCells[index]!).filter((number) => number !== 0));
      const called = new Set<number>();
      while (![...required].every((number) => called.has(number))) {
        const event = await h.drawNext();
        called.add((event.payload as { number: number }).number);
      }
      const result = await h.claim();
      expect(result).toMatchObject({ accepted: true, patterns: [id] });
      expect(called.has(0)).toBe(false);
      expect(await h.repositories.claims.listByGame(h.game.id)).toMatchObject([{ patterns: [id], accepted: true }]);
    },
  );

  it.each(WIN_PATTERNS.map((pattern) => ({ id: pattern.id, cells: [...pattern.cells] })))(
    'rejects $id while at least one required non-free number is still missing',
    async ({ id, cells }) => {
      const h = await createGameTestHarness({ room: { activePatterns: [id] } });
      await h.start();
      const player = (await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))!;
      const required = cells.map((index) => player.cardCells[index]!).filter((number) => number !== 0);
      const called = new Set<number>();
      // Stop one required number short; never manufacture client-supplied draws.
      while (required.filter((number) => called.has(number)).length < required.length - 1) {
        called.add(((await h.drawNext()).payload as { number: number }).number);
      }
      expect(await h.claim()).toMatchObject({ accepted: false, patterns: [] });
      expect(await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))
        .toMatchObject({ status: 'DISQUALIFIED' });
      await expect(h.claim()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    },
  );

  it('returns every completed enabled pattern, not only the first match', async () => {
    const activePatterns = WIN_PATTERNS.map(({ id }) => id);
    const h = await createGameTestHarness({ room: { activePatterns } });
    await h.start();
    for (let index = 0; index < 75; index += 1) await h.drawNext();
    expect((await h.claim()).patterns).toEqual(activePatterns);
  });

  it('rejects a completed disabled pattern with no cosmetic client state involved', async () => {
    const h = await createGameTestHarness({ room: { activePatterns: ['full-house'] } });
    await h.start();
    const player = (await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id))!;
    const card = { cardNumber: player.cardNumber, cells: player.cardCells };
    const called = new Set<number>();
    while (!checkWin(card, called, WIN_PATTERNS.filter(({ id }) => id === 'row-1')).won) {
      called.add(((await h.drawNext()).payload as { number: number }).number);
    }
    expect(checkWin(card, called, WIN_PATTERNS.filter(({ id }) => id === 'full-house')).won).toBe(false);
    expect(await h.claim()).toMatchObject({ accepted: false, patterns: [] });
  });

  it('can retain an active player after a false claim but never permits a second verdict', async () => {
    const h = await createGameTestHarness({ disqualifyOnFalseClaim: false });
    await h.start();
    expect(await h.claim()).toMatchObject({ accepted: false });
    expect(await h.repositories.players.findByGameAndUser(h.game.id, h.users[0]!.id)).toMatchObject({ status: 'ACTIVE' });
    await expect(h.claim()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect((await h.allEvents()).filter(({ type }) => type === 'CLAIM_REJECTED')).toHaveLength(1);
  });
});
