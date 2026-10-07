import type { RateLimiter } from '../../domain/ports.js';
import type { RedisClient } from './client.js';

const INCREMENT_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: RedisClient) {}

  async consume(key: string, max: number, windowMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError('Invalid rate limit');
    }
    const count = Number(await this.redis.eval(
      INCREMENT_WINDOW,
      1,
      `rate-limit:${key}`,
      String(windowMs),
    ));
    return count <= max;
  }
}
