import { describe, expect, it } from 'vitest';
import { AesGcmSeedVault } from './seedVault.js';

describe('AesGcmSeedVault', () => {
  it('round-trips the seed and rejects tampered ciphertext', async () => {
    const vault = new AesGcmSeedVault(Buffer.alloc(32, 1).toString('hex'));
    const sealed = await vault.seal('game-seed');
    expect(await vault.open(sealed)).toBe('game-seed');
    const tampered = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`;
    await expect(vault.open(tampered)).rejects.toThrow();
  });

  it('requires exactly 32 bytes of key material', () => {
    expect(() => new AesGcmSeedVault('short')).toThrow();
  });
});
