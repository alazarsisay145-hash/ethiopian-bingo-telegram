import { TOTAL_NUMBERS } from '@bingo/shared';
import { createRng, sha256Hex, shuffled } from './rng.js';

export function generateDrawSequence(seed: string): number[] {
  return shuffled(
    Array.from({ length: TOTAL_NUMBERS }, (_, index) => index + 1),
    createRng(seed),
  );
}

export function commitSeed(seed: string): string {
  return sha256Hex(seed);
}

export function verifySeed(seed: string, commitment: string): boolean {
  return commitSeed(seed) === commitment;
}
