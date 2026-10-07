/**
 * Single-owner game orchestration lease.
 *
 * Semantics:
 * - At most one instance holds the lease for a game at a time.
 * - Every successful `acquire` returns a strictly increasing `fencingToken`
 *   (per game). Writers pass the token to the database (see `GameFence`) so a
 *   stale owner whose lease expired cannot write after a newer owner started.
 * - A lease is only valid while heartbeated before its TTL elapses.
 */
export interface GameLease {
  gameId: string;
  instanceId: string;
  fencingToken: bigint;
}

export interface GameOwnershipLease {
  /** Returns the lease, or `null` if another instance currently holds it. */
  acquire(gameId: string, instanceId: string, ttlMs: number): Promise<GameLease | null>;
  /** Extends the TTL; `false` means the lease was lost and the caller must stop. */
  heartbeat(lease: GameLease, ttlMs: number): Promise<boolean>;
  /** Releases only if still held by this lease; `false` if it was already lost. */
  release(lease: GameLease): Promise<boolean>;
}
