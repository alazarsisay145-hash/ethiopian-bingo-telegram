import type { GameLease, GameOwnershipLease } from '../../domain/ownership.js';
import type { RedisClient } from './client.js';

/**
 * Redis-backed single-owner lease for a game.
 *
 * Keys (the id is wrapped in braces as a Redis Cluster hash tag so both keys share a slot):
 * - `game:{<id>}:owner` = `<instanceId>:<fencingToken>` with a PX TTL (the lease itself).
 * - `game:{<id>}:fence` = monotonically increasing counter (never expires/deleted).
 *
 * Acquire is `SET owner <instanceId>:<token> NX PX <ttl>` with `token = INCR fence`, executed in
 * one Lua script so a token is only consumed by the instance that wins the lease. This keeps
 * tokens strictly increasing across successive owners. Heartbeat and release are Lua
 * compare-and-extend / compare-and-delete on the full `<instanceId>:<token>` value, so an
 * instance whose lease expired (and was taken over) can neither extend nor delete the new lease.
 *
 * The lease alone is not sufficient for safety (a paused process can outlive its TTL); writers
 * must also present the fencing token to Postgres (`GameFence`) so stale owners are rejected.
 */
const ACQUIRE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local token = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. token, 'NX', 'PX', ARGV[2])
return token`;
const HEARTBEAT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const ownerKey = (gameId: string): string => `game:{${gameId}}:owner`;
const fenceKey = (gameId: string): string => `game:{${gameId}}:fence`;
const ownerValue = (lease: GameLease): string => `${lease.instanceId}:${lease.fencingToken}`;

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive integer');
}

export class RedisGameOwnershipLease implements GameOwnershipLease {
  constructor(private readonly redis: RedisClient) {}

  async acquire(gameId: string, instanceId: string, ttlMs: number): Promise<GameLease | null> {
    assertTtl(ttlMs);
    if (!instanceId) throw new RangeError('instanceId is required');
    const token = Number(await this.redis.eval(
      ACQUIRE, 2, ownerKey(gameId), fenceKey(gameId), instanceId, String(ttlMs),
    ));
    return token > 0 ? { gameId, instanceId, fencingToken: BigInt(token) } : null;
  }

  async heartbeat(lease: GameLease, ttlMs: number): Promise<boolean> {
    assertTtl(ttlMs);
    const result = await this.redis.eval(
      HEARTBEAT, 1, ownerKey(lease.gameId), ownerValue(lease), String(ttlMs),
    );
    return Number(result) === 1;
  }

  async release(lease: GameLease): Promise<boolean> {
    const result = await this.redis.eval(RELEASE, 1, ownerKey(lease.gameId), ownerValue(lease));
    return Number(result) === 1;
  }
}
