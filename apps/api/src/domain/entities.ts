/**
 * Plain domain types for persisted state. These intentionally mirror the
 * database but never import Prisma. Secrets (`cardPoolSeed`, `seedEncrypted`)
 * are deliberately absent from the entities below; they are only reachable
 * through dedicated server-side repository methods.
 *
 * Monetary values are integer minor units (e.g. cents) held as `bigint`.
 */
import type { WinPatternId } from '@bingo/shared';

export type UserRole = 'PLAYER' | 'ADMIN' | 'SUPER_ADMIN';
export type UserStatus = 'ACTIVE' | 'BANNED';
export type LedgerEntryType = 'STAKE' | 'REFUND' | 'PRIZE' | 'ADMIN_ADJUSTMENT';
export type RoomStatus = 'OPEN' | 'CLOSED';
export type GameStatus = 'LOBBY' | 'STARTING' | 'RUNNING' | 'SETTLING' | 'ENDED' | 'CANCELLED';
export type GamePlayerStatus = 'ACTIVE' | 'DISQUALIFIED' | 'WINNER';

/** Allowed game status transitions; terminal states have none. */
export const GAME_STATUS_TRANSITIONS: Readonly<Record<GameStatus, readonly GameStatus[]>> = {
  LOBBY: ['STARTING', 'CANCELLED'],
  STARTING: ['LOBBY', 'RUNNING', 'CANCELLED'],
  RUNNING: ['SETTLING', 'CANCELLED'],
  SETTLING: ['ENDED', 'CANCELLED'],
  ENDED: [],
  CANCELLED: [],
};

export interface User {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  photoUrl: string | null;
  languageCode: string | null;
  role: UserRole;
  status: UserStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Wallet {
  userId: string;
  balanceMinor: bigint;
  currency: string;
  version: number;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  type: LedgerEntryType;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  refType: string | null;
  refId: string | null;
  idempotencyKey: string;
  createdAt: Date;
}

export interface Room {
  id: string;
  name: string;
  stakeMinor: bigint;
  minPlayers: number;
  maxPlayers: number;
  drawIntervalMs: number;
  activePatterns: WinPatternId[];
  cardPoolSize: number;
  startCountdownMs?: number;
  status: RoomStatus;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Game {
  id: string;
  roomId: string;
  status: GameStatus;
  seedHash: string | null;
  seedRevealedAt: Date | null;
  startedAt: Date | null;
  startingAt?: Date | null;
  endedAt: Date | null;
  ownerInstanceId: string | null;
  fencingToken: bigint;
  currentSeq: number;
  potMinor: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface GamePlayer {
  gameId: string;
  userId: string;
  cardNumber: number;
  cardCells: number[];
  status: GamePlayerStatus;
  joinedAt: Date;
}

export interface GameEvent {
  gameId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface Claim {
  id: string;
  gameId: string;
  userId: string;
  atSeq: number;
  accepted: boolean;
  patterns: string[];
  createdAt: Date;
}

export interface AuditLog {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  requestId: string | null;
  createdAt: Date;
}
