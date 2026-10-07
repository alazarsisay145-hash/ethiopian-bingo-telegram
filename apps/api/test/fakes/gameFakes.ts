import { AppError, ErrorCode } from '@bingo/shared';
import type {
  Clock,
  GameLock,
  Scheduler,
  SecretSource,
  SeedVault,
} from '../../src/domain/ports.js';
import type { GameLease, GameOwnershipLease } from '../../src/domain/ownership.js';

export class InMemoryGameLock implements GameLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class InMemoryGameOwnershipLease implements GameOwnershipLease {
  valid = true;

  async acquire(gameId: string, instanceId: string): Promise<GameLease> {
    return { gameId, instanceId, fencingToken: 1n };
  }

  async heartbeat(): Promise<boolean> {
    return this.valid;
  }

  async release(): Promise<boolean> {
    return true;
  }
}

export class DeterministicSecretSource implements SecretSource {
  private counter = 0;

  bytes(size: number): Uint8Array {
    const result = new Uint8Array(size);
    result.fill(++this.counter);
    return result;
  }
}

export class InMemorySeedVault implements SeedVault {
  async seal(seed: string): Promise<string> {
    return Buffer.from(seed).toString('base64url');
  }

  async open(sealed: string): Promise<string> {
    try {
      return Buffer.from(sealed, 'base64url').toString();
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Invalid fake seed');
    }
  }
}

export class ManualClock implements Clock, Scheduler {
  private current = 0;
  private nextId = 0;
  private readonly scheduled = new Map<number, { due: number; operation: () => void }>();

  now(): Date {
    return new Date(this.current);
  }

  schedule(delayMs: number, operation: () => void): () => void {
    const id = ++this.nextId;
    this.scheduled.set(id, { due: this.current + delayMs, operation });
    return () => {
      this.scheduled.delete(id);
    };
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.current + delayMs;
    while (true) {
      const next = [...this.scheduled.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.scheduled.delete(id);
      this.current = task.due;
      task.operation();
      await Promise.resolve();
    }
    this.current = target;
  }
}
