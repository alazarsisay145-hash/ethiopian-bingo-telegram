/**
 * Persistence ports. Implementations must enforce server authority through
 * database constraints and transactions, never through read-then-write checks.
 */
import type { WinPatternId } from '@bingo/shared';
import type {
  AuditLog, Claim, Game, GameEvent, GamePlayer, GamePlayerStatus, GameStatus, LedgerEntry,
  LedgerEntryType, Room, RoomStatus, User, UserRole, UserStatus,
} from './entities.js';

/** Proof of game ownership; writes carrying a stale fence are rejected. */
export interface GameFence {
  instanceId: string;
  fencingToken: bigint;
}

export interface TransactionRepositories {
  users: UserRepository;
  rooms: RoomRepository;
  games: GameRepository;
  gamePlayers: GamePlayerRepository;
  gameEvents: GameEventRepository;
  claims: ClaimRepository;
  ledger: LedgerRepository;
  auditLogs: AuditLogRepository;
}

export interface TelegramProfileInput {
  telegramId: bigint;
  username?: string | null;
  firstName: string;
  lastName?: string | null;
  photoUrl?: string | null;
  languageCode?: string | null;
}

export interface UserRepository {
  /** Creates user + zero-balance wallet atomically; on conflict updates profile fields only. */
  upsertFromTelegram(input: TelegramProfileInput): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByTelegramId(telegramId: bigint): Promise<User | null>;
  setRole(id: string, role: UserRole): Promise<User>;
  setStatus(id: string, status: UserStatus): Promise<User>;
  touchLastSeen(id: string, at?: Date): Promise<void>;
  findManyByIds(ids: string[]): Promise<User[]>;
  lockForUpdate(id: string): Promise<User | null>;
}

export interface CreateRoomInput {
  name: string;
  stakeMinor: bigint;
  minPlayers: number;
  maxPlayers: number;
  drawIntervalMs: number;
  activePatterns: WinPatternId[];
  cardPoolSize: number;
  startCountdownMs?: number;
  /** Server secret; never exposed through any DTO. */
  cardPoolSeed: string;
  createdById?: string | null;
}

export type UpdateRoomInput = Partial<Omit<CreateRoomInput, 'cardPoolSeed' | 'createdById'>> & {
  status?: RoomStatus;
};

export interface RoomRepository {
  create(input: CreateRoomInput): Promise<Room>;
  findById(id: string): Promise<Room | null>;
  listOpen(): Promise<Room[]>;
  update(id: string, patch: UpdateRoomInput): Promise<Room>;
  /** Server-side only: the seed that deterministically generates the card pool. */
  getCardPoolSeed(id: string): Promise<string | null>;
}

export interface RevealedSeed {
  seedHash: string;
  seedEncrypted: string;
  seedRevealedAt: Date;
}

export interface GameRepository {
  create(input: { roomId: string }): Promise<Game>;
  findById(id: string): Promise<Game | null>;
  /** Latest non-terminal (LOBBY/STARTING/RUNNING/SETTLING) game of the room. */
  findActiveByRoom(roomId: string): Promise<Game | null>;
  listByStatus(statuses: GameStatus[]): Promise<Game[]>;
  lockForUpdate(gameId: string): Promise<Game | null>;
  adjustPotMinor(gameId: string, deltaMinor: bigint): Promise<Game>;
  setStartingAt(gameId: string, startingAt: Date | null): Promise<Game | null>;
  listRunnable(): Promise<Game[]>;
  /** Validates the transition atomically; stale fences throw `CONFLICT`. */
  updateStatus(gameId: string, status: GameStatus, fence?: GameFence): Promise<Game>;
  /** Stores the commitment once (before the game starts); later calls throw `CONFLICT`. */
  setSeedCommitment(
    gameId: string,
    input: { seedHash: string; seedEncrypted: string },
  ): Promise<void>;
  getSeedCommitment(gameId: string): Promise<{ seedHash: string; seedEncrypted: string } | null>;
  /** Atomically transitions SETTLING to ENDED, reveals the seed, and appends GAME_ENDED. */
  finalize(gameId: string, payload: unknown, fence: GameFence): Promise<GameEvent>;
  /** Marks the seed revealed; only allowed for ENDED/CANCELLED games. Idempotent. */
  revealSeed(gameId: string): Promise<RevealedSeed>;
  /**
   * Records `instanceId` as owner when `fencingToken` is strictly greater than the stored
   * token (tokens come from `GameOwnershipLease`). Returns `false` for stale tokens.
   */
  tryAcquireOwnership(gameId: string, instanceId: string, fencingToken: bigint): Promise<boolean>;
  /** `true` while `fence` is still the recorded owner. */
  verifyFence(gameId: string, fence: GameFence): Promise<boolean>;
}

export type ReserveCardResult =
  | { kind: 'reserved'; player: GamePlayer }
  | { kind: 'card_taken' }
  | { kind: 'already_joined'; player: GamePlayer };

export interface GamePlayerRepository {
  /** Atomic: relies on unique `(gameId, cardNumber)` and `(gameId, userId)` constraints. */
  reserveCard(input: {
    gameId: string;
    userId: string;
    cardNumber: number;
    cardCells: number[];
  }): Promise<ReserveCardResult>;
  listByGame(gameId: string): Promise<GamePlayer[]>;
  listByUser(userId: string, statuses?: GameStatus[]): Promise<GamePlayer[]>;
  findByGameAndUser(gameId: string, userId: string): Promise<GamePlayer | null>;
  remove(gameId: string, userId: string): Promise<void>;
  setStatus(gameId: string, userId: string, status: GamePlayerStatus, fence?: GameFence): Promise<GamePlayer>;
}

export interface GameEventRepository {
  /** Atomically allocates the next gap-free `seq` and inserts the event. */
  append(input: {
    gameId: string;
    type: string;
    payload: unknown;
    fence?: GameFence;
    expectedDrawIndex?: number;
    expectedStatus?: GameStatus;
  }): Promise<GameEvent>;
  listSince(gameId: string, afterSeq: number, limit: number): Promise<GameEvent[]>;
  latestSeq(gameId: string): Promise<number>;
}

export interface ClaimRepository {
  record(input: {
    gameId: string;
    userId: string;
    atSeq: number;
    accepted: boolean;
    patterns: string[];
  }, fence?: GameFence): Promise<Claim>;
  recordWithEvent(input: {
    gameId: string;
    userId: string;
    atSeq: number;
    accepted: boolean;
    patterns: string[];
    disqualifyOnFalseClaim: boolean;
  }, fence: GameFence): Promise<{ claim: Claim; event: GameEvent }>;
  listByGame(gameId: string): Promise<Claim[]>;
}

export interface LedgerApplyInput {
  userId: string;
  type: LedgerEntryType;
  /** Signed: STAKE < 0, REFUND/PRIZE > 0, ADMIN_ADJUSTMENT any non-zero. */
  amountMinor: bigint;
  refType?: string | null;
  refId?: string | null;
  idempotencyKey: string;
}

export interface LedgerRepository {
  /**
   * Locks the wallet row, rejects negative balances (`INSUFFICIENT_FUNDS`), appends the
   * entry and updates balance/version atomically. Replaying an `idempotencyKey` returns the
   * original entry; reusing it with different parameters throws `CONFLICT`.
   */
  apply(input: LedgerApplyInput): Promise<LedgerEntry>;
  getBalance(userId: string): Promise<bigint>;
  getWallet(userId: string): Promise<{ balanceMinor: bigint; currency: string; version: number }>;
  listByUser(userId: string, options?: { limit?: number; before?: Date }): Promise<LedgerEntry[]>;
}

export interface AuditLogInput {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

export interface AuditLogRepository {
  record(input: AuditLogInput): Promise<AuditLog>;
  list(options?: { targetType?: string; targetId?: string; limit?: number; before?: Date }): Promise<AuditLog[]>;
}
