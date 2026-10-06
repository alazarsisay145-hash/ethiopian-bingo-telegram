import { createHash } from 'node:crypto';
import { BINGO_COLUMNS, COLUMN_RANGES, FREE_CELL_INDEX, type BingoCard } from '@bingo/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  WIN_PATTERNS,
  checkWin,
  commitSeed,
  createRng,
  generateCard,
  generateDrawSequence,
  sha256Hex,
  validateCard,
  verifySeed,
} from '../src/index.js';

const seedAndCard = fc.tuple(fc.string(), fc.integer({ min: 1, max: 1_000_000 }));

describe('randomness', () => {
  it('hashes the known SHA-256 UTF-8 vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('keeps SHA-256 little-endian seeded mulberry32 output stable', () => {
    const rng = createRng('room-seed');
    expect(Array.from({ length: 5 }, () => rng())).toEqual([
      0.9243903183378279, 0.710203340742737, 0.438829475780949, 0.1502860877662897,
      0.25408773962408304,
    ]);
  });

  it('creates independent reproducible generators with values in [0, 1)', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const first = createRng(seed);
        const second = createRng(seed);
        for (let index = 0; index < 100; index += 1) {
          const value = first();
          expect(value).toBe(second());
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
    );
  });
});

describe('cards', () => {
  it('keeps the SHA-256 / mulberry32 card vector stable', () => {
    expect(generateCard('room-seed', 7)).toEqual({
      cardNumber: 7,
      cells: [
        11, 27, 38, 53, 63, 12, 28, 43, 47, 61, 3, 22, 0, 57, 64, 5, 18, 36, 46, 62, 9, 19, 42, 52,
        74,
      ],
    });
  });

  it('generates deterministic cards with column ranges, unique numbers and a free center', () => {
    fc.assert(
      fc.property(seedAndCard, ([seed, cardNumber]) => {
        const card = generateCard(seed, cardNumber);
        expect(card).toEqual(generateCard(seed, cardNumber));
        expect(card.cardNumber).toBe(cardNumber);
        expect(card.cells).toHaveLength(25);
        expect(card.cells[FREE_CELL_INDEX]).toBe(0);
        expect(new Set(card.cells).size).toBe(25);
        for (const [index, value] of card.cells.entries()) {
          if (index === FREE_CELL_INDEX) continue;
          const column = BINGO_COLUMNS[index % 5];
          if (column === undefined) throw new Error('Invalid column');
          const [min, max] = COLUMN_RANGES[column];
          expect(value).toBeGreaterThanOrEqual(min);
          expect(value).toBeLessThanOrEqual(max);
        }
        expect(validateCard(card)).toEqual({ valid: true, card });
      }),
    );
  });

  it('does not depend on generation order and returns independent arrays', () => {
    const first = generateCard('room', 1);
    generateCard('other room', 88);
    expect(generateCard('room', 1)).toEqual(first);
    expect(generateCard('room', 2)).not.toEqual(first);
    first.cells[0] = -1;
    expect(generateCard('room', 1).cells[0]).not.toBe(-1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid card number %s',
    (cardNumber) => {
      expect(() => generateCard('room', cardNumber)).toThrow(RangeError);
    },
  );

  it.each([null, {}, { cardNumber: 0, cells: [] }])('reports structured issues for %j', (card) => {
    const result = validateCard(card);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toHaveProperty('path');
      expect(result.issues[0]).toHaveProperty('message');
      expect(result.issues[0]).toHaveProperty('code');
    }
  });

  it('rejects invalid centers, ranges and duplicate cells', () => {
    const card = generateCard('room', 1);
    for (const cells of [
      card.cells.map((value, index) => (index === 12 ? 33 : value)),
      card.cells.map((value, index) => (index === 0 ? 75 : value)),
      card.cells.map((value, index) => (index === 5 ? (card.cells[0] ?? 0) : value)),
    ]) {
      expect(validateCard({ ...card, cells }).valid).toBe(false);
    }
  });
});

describe('draws and commitments', () => {
  it('keeps the SHA-256 / mulberry32 draw vector stable', () => {
    expect(generateDrawSequence('room-seed').slice(0, 10)).toEqual([
      14, 57, 21, 75, 30, 6, 34, 13, 55, 73,
    ]);
  });

  it('produces deterministic permutations of 1 through 75', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const draws = generateDrawSequence(seed);
        expect(draws).toEqual(generateDrawSequence(seed));
        expect([...draws].sort((a, b) => a - b)).toEqual(
          Array.from({ length: 75 }, (_, index) => index + 1),
        );
        draws[0] = 0;
        expect(generateDrawSequence(seed)).not.toContain(0);
      }),
    );
  });

  it('commits the exact UTF-8 seed using SHA-256', () => {
    const seed = 'ኢትዮጵያ bingo';
    expect(commitSeed(seed)).toBe(createHash('sha256').update(seed, 'utf8').digest('hex'));
    expect(commitSeed('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('verifies valid commitments and rejects tampered seeds and commitments', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const commitment = commitSeed(seed);
        expect(verifySeed(seed, commitment)).toBe(true);
        expect(verifySeed(`${seed}!`, commitment)).toBe(false);
        expect(verifySeed(seed, `${commitment.slice(0, -1)}x`)).toBe(false);
      }),
    );
  });
});

describe('wins', () => {
  const card = generateCard('winning room', 1);

  it('defines five rows, five columns, two diagonals, corners and full house', () => {
    expect(WIN_PATTERNS).toHaveLength(14);
    expect(new Set(WIN_PATTERNS.map(({ id }) => id)).size).toBe(14);
    expect(WIN_PATTERNS.map(({ cells }) => cells.size)).toEqual([
      5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 25,
    ]);
  });

  for (const pattern of WIN_PATTERNS) {
    it(`recognizes ${pattern.id} and rejects every missing non-free cell`, () => {
      const values = [...pattern.cells]
        .filter((index) => index !== FREE_CELL_INDEX)
        .map((index) => card.cells[index] ?? -1);
      const called = new Set(values);
      expect(checkWin(card, called, [pattern])).toEqual({ won: true, patterns: [pattern.id] });
      expect(checkWin(card, called).patterns).toContain(pattern.id);
      for (const number of values) {
        const incomplete = new Set(called);
        incomplete.delete(number);
        expect(checkWin(card, incomplete, [pattern])).toEqual({ won: false, patterns: [] });
      }
    });
  }

  it('always covers the center without requiring zero to be called', () => {
    const centerRow = WIN_PATTERNS.find(({ id }) => id === 'row-3');
    if (centerRow === undefined) throw new Error('Missing center row');
    const altered: BingoCard = { ...card, cells: [...card.cells] };
    altered.cells[FREE_CELL_INDEX] = 99;
    const called = new Set(
      [...centerRow.cells]
        .filter((index) => index !== FREE_CELL_INDEX)
        .map((index) => card.cells[index] ?? -1),
    );
    expect(checkWin(altered, called, [centerRow]).won).toBe(true);
  });

  it('all called numbers win full house while no called numbers never win', () => {
    fc.assert(
      fc.property(seedAndCard, ([seed, cardNumber]) => {
        const generated = generateCard(seed, cardNumber);
        const all = new Set(Array.from({ length: 75 }, (_, index) => index + 1));
        const result = checkWin(generated, all);
        expect(result.won).toBe(true);
        expect(result.patterns).toContain('full-house');
        expect(result.patterns).toHaveLength(14);
        expect(checkWin(generated, new Set())).toEqual({ won: false, patterns: [] });
      }),
    );
  });

  it('does not modify input cards or calls and respects the enabled pattern list', () => {
    const before = [...card.cells];
    const called = new Set(card.cells);
    const beforeCalls = [...called];
    expect(checkWin(card, called, [])).toEqual({ won: false, patterns: [] });
    checkWin(card, called);
    expect(card.cells).toEqual(before);
    expect([...called]).toEqual(beforeCalls);
  });
});
