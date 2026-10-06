import { TOTAL_NUMBERS } from '@bingo/shared';
import { seededRandom, shuffled } from './random.js';

export function generateDrawSequence(seed: string): number[] {
  return shuffled(
    Array.from({ length: TOTAL_NUMBERS }, (_, index) => index + 1),
    seededRandom(seed),
  );
}
