import type { DependencyProbe } from '../../domain/ports.js';
import type { RedisClient } from './client.js';

export class RedisProbe implements DependencyProbe {
  constructor(private readonly redis: RedisClient) {}

  async check(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
