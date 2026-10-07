import { CARD_SIZE, type WinPatternId } from '@bingo/shared';

export type { WinPatternId } from '@bingo/shared';

export interface WinPattern {
  readonly id: WinPatternId;
  readonly cells: ReadonlySet<number>;
}

function pattern(id: WinPatternId, cells: readonly number[]): WinPattern {
  return { id, cells: new Set(cells) };
}

const offsets = Array.from({ length: CARD_SIZE }, (_, index) => index);

export const WIN_PATTERNS: readonly WinPattern[] = [
  ...(['row-1', 'row-2', 'row-3', 'row-4', 'row-5'] as const).map((id, row) =>
    pattern(
      id,
      offsets.map((column) => row * CARD_SIZE + column),
    ),
  ),
  ...(['column-B', 'column-I', 'column-N', 'column-G', 'column-O'] as const).map((id, column) =>
    pattern(
      id,
      offsets.map((row) => row * CARD_SIZE + column),
    ),
  ),
  pattern(
    'diagonal-main',
    offsets.map((index) => index * CARD_SIZE + index),
  ),
  pattern(
    'diagonal-anti',
    offsets.map((index) => index * CARD_SIZE + CARD_SIZE - 1 - index),
  ),
  pattern('four-corners', [0, CARD_SIZE - 1, CARD_SIZE * (CARD_SIZE - 1), CARD_SIZE ** 2 - 1]),
  pattern(
    'full-house',
    Array.from({ length: CARD_SIZE ** 2 }, (_, index) => index),
  ),
];
