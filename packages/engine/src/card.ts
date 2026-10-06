import {
  BINGO_COLUMNS,
  CARD_SIZE,
  COLUMN_RANGES,
  FREE_CELL_INDEX,
  bingoCardSchema,
  type BingoCard,
} from '@bingo/shared';
import { createRng, shuffled } from './rng.js';

export type CardValidationResult =
  | { valid: true; card: BingoCard }
  | {
      valid: false;
      issues: readonly { path: readonly PropertyKey[]; message: string; code: string }[];
    };

export function validateCard(card: unknown): CardValidationResult {
  const result = bingoCardSchema.safeParse(card);
  return result.success
    ? { valid: true, card: result.data }
    : {
        valid: false,
        issues: result.error.issues.map(({ path, message, code }) => ({ path, message, code })),
      };
}

export function generateCard(roomSeed: string, cardNumber: number): BingoCard {
  if (!Number.isSafeInteger(cardNumber) || cardNumber <= 0) {
    throw new RangeError('cardNumber must be a positive safe integer');
  }
  const random = createRng(JSON.stringify([roomSeed, cardNumber]));
  const cells = Array<number>(CARD_SIZE * CARD_SIZE).fill(0);
  for (const [columnIndex, column] of BINGO_COLUMNS.entries()) {
    const [minimum, maximum] = COLUMN_RANGES[column];
    const numbers = shuffled(
      Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index),
      random,
    );
    for (let row = 0; row < CARD_SIZE; row += 1) {
      const cellIndex = row * CARD_SIZE + columnIndex;
      if (cellIndex === FREE_CELL_INDEX) continue;
      const number = numbers[row];
      if (number === undefined) throw new Error('Column has insufficient numbers');
      cells[cellIndex] = number;
    }
  }
  return { cardNumber, cells };
}
