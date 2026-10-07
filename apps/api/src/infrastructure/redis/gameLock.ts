import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '@bingo/shared';
import type { Clock, GameLock, Scheduler } from '../../domain/ports.js';
import type { RedisClient } from './client.js';

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`;

export class RedisGameLock implements GameLock {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly ttlMs = 10_000,
  ) {}

  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    return previous.then(async () => {
      try {
        return await this.withRedisLock(key, operation);
      } finally {
        releaseLocal();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    });
  }

  private async withRedisLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const lockKey = `lock:{${key}}`;
    const deadline = this.clock.now().getTime() + this.ttlMs;
    while ((await this.redis.set(lockKey, token, 'PX', this.ttlMs, 'NX')) !== 'OK') {
      if (this.clock.now().getTime() >= deadline) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Timed out waiting for game operation lock');
      }
      await new Promise<void>((resolve) => {
        this.scheduler.schedule(25, resolve);
      });
    }
    let held = true;
    let lost = false;
    let cancelHeartbeat: (() => void) | undefined;
    const heartbeat = (): void => {
      cancelHeartbeat = this.scheduler.schedule(Math.floor(this.ttlMs / 3), () => {
        void this.redis
          .eval(RENEW, 1, lockKey, token, String(this.ttlMs))
          .then((result) => {
            if (!held) return;
            if (Number(result) !== 1) {
              lost = true;
              return;
            }
            heartbeat();
          })
          .catch(() => {
            lost = true;
          });
      });
    };
    heartbeat();
    try {
      const result = await operation();
      if (lost) throw new AppError(ErrorCode.CONFLICT, 409, 'Game operation lock was lost');
      return result;
    } finally {
      held = false;
      cancelHeartbeat?.();
      await this.redis.eval(RELEASE, 1, lockKey, token);
    }
  }
}
