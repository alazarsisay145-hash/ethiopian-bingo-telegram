export const CARD_SIZE = 5;
export const TOTAL_NUMBERS = 75;
export const FREE_CELL_INDEX = 12;
export const BINGO_COLUMNS = ['B', 'I', 'N', 'G', 'O'] as const;
export const COLUMN_RANGES = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75],
} as const;
