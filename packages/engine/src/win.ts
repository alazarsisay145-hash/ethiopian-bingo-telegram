import { FREE_CELL_INDEX, type BingoCard, type WinPatternId } from '@bingo/shared';
import { WIN_PATTERNS, type WinPattern } from './patterns.js';

export interface WinResult {
  won: boolean;
  patterns: WinPatternId[];
}

export function checkWin(
  card: BingoCard,
  calledNumbers: ReadonlySet<number>,
  patterns: readonly WinPattern[] = WIN_PATTERNS,
): WinResult {
  const completed = patterns
    .filter((candidate) =>
      [...candidate.cells].every((index) => {
        if (index === FREE_CELL_INDEX) return true;
        const number = card.cells[index];
        return number !== undefined && calledNumbers.has(number);
      }),
    )
    .map(({ id }) => id);
  return { won: completed.length > 0, patterns: completed };
}
