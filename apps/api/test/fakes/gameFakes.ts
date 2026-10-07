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
  private readonly counters = new Map<string, bigint>();
  private readonly owners = new Map<string, { lease: GameLease; expiresAt: number }>();

  constructor(private readonly clock: Clock = { now: () => new Date(0) }) {}

  inspect(gameId: string): GameLease | null {
    const owner = this.owners.get(gameId);
    if (!owner || owner.expiresAt <= this.clock.now().getTime()) return null;
    return structuredClone(owner.lease);
  }

  isHeld(gameId: string): boolean {
    return this.inspect(gameId) !== null;
  }

  hasOwner(gameId: string): boolean {
    return this.isHeld(gameId);
  }

  current(gameId: string): GameLease | null {
    return this.inspect(gameId);
  }

  invalidate(gameId: string): void {
    this.owners.delete(gameId);
  }

  async acquire(gameId: string, instanceId: string, ttlMs = 10_000): Promise<GameLease | null> {
    this.validateTtl(ttlMs);
    if (this.inspect(gameId)) return null;
    const fencingToken = (this.counters.get(gameId) ?? 0n) + 1n;
    this.counters.set(gameId, fencingToken);
    const lease = { gameId, instanceId, fencingToken };
    this.owners.set(gameId, { lease, expiresAt: this.clock.now().getTime() + ttlMs });
    return structuredClone(lease);
  }

  async heartbeat(lease: GameLease, ttlMs = 10_000): Promise<boolean> {
    this.validateTtl(ttlMs);
    const owner = this.inspect(lease.gameId);
    if (!this.valid || !owner || owner.instanceId !== lease.instanceId ||
      owner.fencingToken !== lease.fencingToken) return false;
    this.owners.get(lease.gameId)!.expiresAt = this.clock.now().getTime() + ttlMs;
    return true;
  }

  async release(lease: GameLease): Promise<boolean> {
    const owner = this.inspect(lease.gameId);
    if (!owner || owner.instanceId !== lease.instanceId || owner.fencingToken !== lease.fencingToken) return false;
    this.owners.delete(lease.gameId);
    return true;
  }

  private validateTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('TTL must be a positive safe integer');
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

  get pendingTasks(): number {
    return this.scheduled.size;
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
    await this.flush();
    while (true) {
      const next = [...this.scheduled.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.scheduled.delete(id);
      this.current = task.due;
      task.operation();
      await this.flush();
    }
    this.current = target;
    await this.flush();
  }

  async flush(): Promise<void> {
    // Runner callbacks intentionally do not return their promise chains.
    for (let index = 0; index < 200; index += 1) await Promise.resolve();
  }
}
