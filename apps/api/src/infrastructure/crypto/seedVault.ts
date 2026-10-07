import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SeedVault, SecretSource } from '../../domain/ports.js';

export class NodeSecretSource implements SecretSource {
  bytes(size: number): Uint8Array {
    return randomBytes(size);
  }
}

export class AesGcmSeedVault implements SeedVault {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    if (!/^[a-f\d]{64}$/i.test(keyHex)) throw new Error('Seed encryption key must be 32-byte hex');
    this.key = Buffer.from(keyHex, 'hex');
  }

  async seal(seed: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(seed, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  async open(sealed: string): Promise<string> {
    const data = Buffer.from(sealed, 'base64url');
    if (data.length < 29) throw new Error('Invalid encrypted game seed');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
