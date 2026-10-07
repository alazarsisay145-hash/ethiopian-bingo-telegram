import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, ErrorCode, patternIdSchema } from '@bingo/shared';
import { GAME_STATUS_TRANSITIONS } from '../../src/domain/entities.js';
import type { AuditLog, Claim, Game, GameEvent, GamePlayer, LedgerEntry, Room, User, Wallet } from '../../src/domain/entities.js';
import type {
  AuditLogRepository, ClaimRepository, GameEventRepository, GameFence, GamePlayerRepository, GameRepository,
  LedgerRepository, RoomRepository, UserRepository,
} from '../../src/domain/repositories.js';
import type { Clock } from '../../src/domain/ports.js';

const clone = <T>(value: T): T => structuredClone(value);
const conflict = (message: string): never => { throw new AppError(ErrorCode.CONFLICT, 409, message); };
const missing = (message: string): never => { throw new AppError(ErrorCode.NOT_FOUND, 404, message); };
const uuid = z.string().uuid();
const roomFields = {
  name: z.string().trim().min(1).max(100),
  stakeMinor: z.bigint().nonnegative(),
  minPlayers: z.number().int().positive(),
  maxPlayers: z.number().int().positive(),
  drawIntervalMs: z.number().int().positive(),
  activePatterns: z.array(patternIdSchema).min(1),
  cardPoolSize: z.number().int().positive(),
};
const roomSchema = z.object({
  ...roomFields, cardPoolSeed: z.string().min(16), createdById: uuid.nullish(),
}).refine((room) => room.maxPlayers >= room.minPlayers);
const claimSchema = z.object({
  gameId: uuid, userId: uuid, atSeq: z.number().int().nonnegative(),
  accepted: z.boolean(), patterns: z.array(z.string().min(1)),
});
const MAX_INT64 = 9_223_372_036_854_775_807n;

/**
 * Each write validates all transaction preconditions before mutating private storage.
 * There are deliberately no awaits between checks and commit: concurrent callers cannot
 * interleave a uniqueness check, fence check, sequence allocation or wallet update.
 */
export function createInMemoryRepositories(clock: Clock = { now: () => new Date(0) }) {
  const userRows = new Map<string, User>();
  const wallets = new Map<string, Wallet>();
  const roomRows = new Map<string, Room>();
  const poolSeeds = new Map<string, string>();
  const gameRows = new Map<string, Game>();
  const commitments = new Map<string, { seedHash: string; seedEncrypted: string }>();
  const playerRows = new Map<string, GamePlayer>();
  const eventRows = new Map<string, GameEvent[]>();
  const claimRows = new Map<string, Claim>();
  const ledgerRows = new Map<string, LedgerEntry>();
  const auditRows = new Map<string, AuditLog>();
  const failures = new Map<string, Error>();
  const key = (gameId: string, userId: string) => `${gameId}:${userId}`;
  const game = (id: string): Game => gameRows.get(uuid.parse(id)) ?? missing('Game not found');
  const user = (id: string): User => userRows.get(uuid.parse(id)) ?? missing('User not found');
  const room = (id: string): Room => roomRows.get(uuid.parse(id)) ?? missing('Room not found');
  const checkFence = (row: Game, fence?: GameFence) => {
    if (fence && (row.ownerInstanceId !== fence.instanceId || row.fencingToken !== fence.fencingToken)) {
      conflict('Stale game owner');
    }
  };
  const fail = (operation: string) => {
    const error = failures.get(operation);
    if (error) { failures.delete(operation); throw error; }
  };
  const append = (row: Game, type: string, payload: unknown): GameEvent => {
    const event: GameEvent = {
      gameId: row.id, seq: row.currentSeq + 1, type, payload: clone(payload), createdAt: clock.now(),
    };
    eventRows.get(row.id)!.push(event);
    row.currentSeq = event.seq;
    row.updatedAt = clock.now();
    return clone(event);
  };

  const users: UserRepository = {
    async upsertFromTelegram(input) {
      const parsed = z.object({
        telegramId: z.bigint().positive(), firstName: z.string().min(1).max(256),
        username: z.string().max(64).nullish(), lastName: z.string().max(256).nullish(),
        photoUrl: z.string().max(2048).nullish(), languageCode: z.string().max(16).nullish(),
      }).parse(input);
      const existing = [...userRows.values()].find((row) => row.telegramId === parsed.telegramId);
      const profile = {
        ...parsed, username: parsed.username ?? null, lastName: parsed.lastName ?? null,
        photoUrl: parsed.photoUrl ?? null, languageCode: parsed.languageCode ?? null,
      };
      if (existing) { Object.assign(existing, profile, { updatedAt: clock.now() }); return clone(existing); }
      const row: User = {
        ...profile, id: randomUUID(), role: 'PLAYER', status: 'ACTIVE',
        lastSeenAt: null, createdAt: clock.now(), updatedAt: clock.now(),
      };
      userRows.set(row.id, row);
      wallets.set(row.id, { userId: row.id, balanceMinor: 0n, currency: 'ETB', version: 0 });
      return clone(row);
    },
    async findById(id) { return clone(userRows.get(id) ?? null); },
    async findByTelegramId(id) { return clone([...userRows.values()].find((row) => row.telegramId === id) ?? null); },
    async setRole(id, role) { const row = user(id); row.role = role; row.updatedAt = clock.now(); return clone(row); },
    async setStatus(id, status) { const row = user(id); row.status = status; row.updatedAt = clock.now(); return clone(row); },
    async touchLastSeen(id, at = clock.now()) { const row = user(id); row.lastSeenAt = clone(at); },
  };
  const rooms: RoomRepository = {
    async create(input) {
      const { cardPoolSeed, ...parsed } = roomSchema.parse(input);
      if (parsed.createdById) user(parsed.createdById);
      const row: Room = {
        ...parsed, id: randomUUID(), createdById: parsed.createdById ?? null,
        status: 'OPEN', createdAt: clock.now(), updatedAt: clock.now(),
      };
      roomRows.set(row.id, row); poolSeeds.set(row.id, cardPoolSeed);
      return clone(row);
    },
    async findById(id) { return clone(roomRows.get(id) ?? null); },
    async listOpen() { return clone([...roomRows.values()].filter((row) => row.status === 'OPEN')); },
    async update(id, patch) {
      const row = room(id);
      const parsed = z.object({ ...roomFields, status: z.enum(['OPEN', 'CLOSED']) }).partial().parse(patch);
      const next = { ...row, ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) };
      roomSchema.parse({ ...next, cardPoolSeed: poolSeeds.get(id) });
      Object.assign(row, next, { updatedAt: clock.now() });
      return clone(row);
    },
    async getCardPoolSeed(id) { return poolSeeds.get(id) ?? null; },
  };
  const games: GameRepository = {
    async create({ roomId }) {
      room(roomId);
      if ([...gameRows.values()].some((row) => row.roomId === roomId && !['ENDED', 'CANCELLED'].includes(row.status))) {
        conflict('Room already has an active game');
      }
      const row: Game = {
        id: randomUUID(), roomId, status: 'LOBBY', seedHash: null, seedRevealedAt: null,
        startedAt: null, endedAt: null, ownerInstanceId: null, fencingToken: 0n,
        currentSeq: 0, potMinor: 0n, createdAt: clock.now(), updatedAt: clock.now(),
      };
      gameRows.set(row.id, row); eventRows.set(row.id, []);
      return clone(row);
    },
    async findById(id) { return clone(gameRows.get(id) ?? null); },
    async findActiveByRoom(id) {
      return clone([...gameRows.values()].find((row) => row.roomId === id && !['ENDED', 'CANCELLED'].includes(row.status)) ?? null);
    },
    async listRunnable() { return clone([...gameRows.values()].filter((row) => ['RUNNING', 'SETTLING'].includes(row.status))); },
    async updateStatus(id, status, fence) {
      const row = game(id); checkFence(row, fence);
      if (!GAME_STATUS_TRANSITIONS[row.status].includes(status)) conflict(`Cannot move game from ${row.status} to ${status}`);
      fail('games.updateStatus');
      row.status = status; row.updatedAt = clock.now();
      if (status === 'RUNNING') row.startedAt = clock.now();
      if (status === 'ENDED' || status === 'CANCELLED') row.endedAt = clock.now();
      return clone(row);
    },
    async setSeedCommitment(id, input) {
      const row = game(id);
      const parsed = z.object({ seedHash: z.string().min(1).max(256), seedEncrypted: z.string().min(1).max(4096) }).parse(input);
      if (row.seedHash || !['LOBBY', 'STARTING'].includes(row.status)) conflict('Seed commitment already set or game already started');
      fail('games.setSeedCommitment');
      commitments.set(id, parsed); row.seedHash = parsed.seedHash;
    },
    async getSeedCommitment(id) { uuid.parse(id); return clone(commitments.get(id) ?? null); },
    async finalize(id, payload, fence) {
      const row = game(id); checkFence(row, fence);
      if (payload === undefined) conflict('Final event payload is required');
      const existing = eventRows.get(id)!.find((event) => event.type === 'GAME_ENDED');
      if (row.status === 'ENDED' && existing) return clone(existing);
      if (row.status !== 'SETTLING') conflict(`Cannot finalize game from ${row.status}`);
      clone(payload); fail('games.finalize');
      row.status = 'ENDED'; row.endedAt = clock.now(); row.seedRevealedAt ??= clock.now();
      return append(row, 'GAME_ENDED', payload);
    },
    async revealSeed(id) {
      const row = game(id);
      if (!['ENDED', 'CANCELLED'].includes(row.status)) conflict('Seed can only be revealed after the game has finished');
      const commitment = commitments.get(id) ?? conflict('Game has no seed commitment');
      row.seedRevealedAt ??= clock.now();
      return clone({ ...commitment, seedRevealedAt: row.seedRevealedAt });
    },
    async tryAcquireOwnership(id, instanceId, fencingToken) {
      uuid.parse(id);
      if (!instanceId || fencingToken < 1n) conflict('Invalid ownership request');
      const row = gameRows.get(id);
      if (!row || row.fencingToken >= fencingToken) return false;
      row.ownerInstanceId = instanceId; row.fencingToken = fencingToken;
      return true;
    },
    async verifyFence(id, fence) {
      const row = gameRows.get(id);
      return !!row && row.ownerInstanceId === fence.instanceId && row.fencingToken === fence.fencingToken;
    },
  };
  const players: GamePlayerRepository = {
    async reserveCard(input) {
      const parsed = z.object({
        gameId: uuid, userId: uuid, cardNumber: z.number().int().positive(),
        cardCells: z.array(z.number().int().nonnegative()).length(25),
      }).parse(input);
      game(parsed.gameId); user(parsed.userId);
      const existing = playerRows.get(key(parsed.gameId, parsed.userId));
      if (existing) return { kind: 'already_joined', player: clone(existing) };
      if ([...playerRows.values()].some((row) => row.gameId === parsed.gameId && row.cardNumber === parsed.cardNumber)) return { kind: 'card_taken' };
      const row: GamePlayer = { ...clone(parsed), status: 'ACTIVE', joinedAt: clock.now() };
      playerRows.set(key(row.gameId, row.userId), row);
      return { kind: 'reserved', player: clone(row) };
    },
    async listByGame(id) { return clone([...playerRows.values()].filter((row) => row.gameId === id).sort((a, b) => a.cardNumber - b.cardNumber)); },
    async findByGameAndUser(id, userId) { return clone(playerRows.get(key(id, userId)) ?? null); },
    async remove(id, userId) {
      uuid.parse(id); uuid.parse(userId);
      if (!playerRows.delete(key(id, userId))) missing('Game player not found');
    },
    async setStatus(id, userId, status, fence) {
      checkFence(game(id), fence);
      const row = playerRows.get(key(id, uuid.parse(userId))) ?? missing('Game player not found');
      fail('players.setStatus'); row.status = status; return clone(row);
    },
  };
  const events: GameEventRepository = {
    async append(input) {
      const row = game(input.gameId); checkFence(row, input.fence);
      if (!input.type || input.type.length > 100 || input.payload === undefined) conflict('Invalid event');
      if (input.expectedStatus && row.status !== input.expectedStatus) conflict('Stale game owner');
      const count = eventRows.get(row.id)!.filter((event) => event.type === 'NUMBER_CALLED').length;
      if (input.expectedDrawIndex !== undefined && (input.type !== 'NUMBER_CALLED' || input.expectedDrawIndex !== count)) conflict('Draw sequence advanced concurrently');
      clone(input.payload); fail('events.append');
      return append(row, input.type, input.payload);
    },
    async listSince(id, afterSeq, limit) {
      return clone((eventRows.get(id) ?? []).filter((event) => event.seq > Math.max(0, Math.trunc(afterSeq))).slice(0, Math.min(1000, Math.max(1, Math.trunc(limit)))));
    },
    async latestSeq(id) { return game(id).currentSeq; },
  };
  const prepareClaim = (input: Parameters<ClaimRepository['record']>[0], fence?: GameFence) => {
    const parsed = claimSchema.parse(input);
    const row = game(parsed.gameId); user(parsed.userId); checkFence(row, fence);
    if (fence && row.status !== 'RUNNING') conflict('Stale game owner or status');
    if (claimRows.has(key(parsed.gameId, parsed.userId))) conflict('Player already claimed in this game');
    return { row, claim: { ...clone(parsed), id: randomUUID(), createdAt: clock.now() } };
  };
  const claims: ClaimRepository = {
    async record(input, fence) {
      const { claim } = prepareClaim(input, fence);
      fail('claims.record'); claimRows.set(key(claim.gameId, claim.userId), claim);
      return clone(claim);
    },
    async recordWithEvent(input, fence) {
      z.boolean().parse(input.disqualifyOnFalseClaim);
      const { row, claim } = prepareClaim(input, fence);
      const player = playerRows.get(key(input.gameId, input.userId));
      if (!claim.accepted && input.disqualifyOnFalseClaim && !player) missing('Game player not found');
      fail('claims.recordWithEvent');
      claimRows.set(key(claim.gameId, claim.userId), claim);
      if (!claim.accepted && input.disqualifyOnFalseClaim) player!.status = 'DISQUALIFIED';
      const event = append(row, claim.accepted ? 'CLAIM_ACCEPTED' : 'CLAIM_REJECTED', {
        userId: claim.userId, atSeq: claim.atSeq, patterns: claim.patterns,
      });
      return { claim: clone(claim), event };
    },
    async listByGame(id) { return clone([...claimRows.values()].filter((row) => row.gameId === id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))); },
  };
  const ledger: LedgerRepository = {
    async apply(input) {
      const parsed = z.object({
        userId: uuid, type: z.enum(['STAKE', 'REFUND', 'PRIZE', 'ADMIN_ADJUSTMENT']),
        amountMinor: z.bigint().refine((amount) => amount !== 0n && amount > -MAX_INT64 && amount < MAX_INT64),
        refType: z.string().max(100).nullish(), refId: z.string().max(200).nullish(),
        idempotencyKey: z.string().min(1).max(200),
      }).refine((entry) => entry.type === 'STAKE' ? entry.amountMinor < 0n : entry.type === 'ADMIN_ADJUSTMENT' || entry.amountMinor > 0n).parse(input);
      const wallet = wallets.get(parsed.userId) ?? missing('Wallet not found');
      const existing = ledgerRows.get(parsed.idempotencyKey);
      if (existing) {
        if (existing.userId !== parsed.userId || existing.type !== parsed.type || existing.amountMinor !== parsed.amountMinor ||
          existing.refType !== (parsed.refType ?? null) || existing.refId !== (parsed.refId ?? null)) conflict('Idempotency key already used with different parameters');
        return clone(existing);
      }
      const balanceAfterMinor = wallet.balanceMinor + parsed.amountMinor;
      if (balanceAfterMinor < 0n) throw new AppError(ErrorCode.INSUFFICIENT_FUNDS, 409, 'Insufficient funds');
      if (balanceAfterMinor > MAX_INT64) conflict('Balance overflow');
      fail('ledger.apply');
      const entry: LedgerEntry = {
        ...parsed, id: randomUUID(), refType: parsed.refType ?? null, refId: parsed.refId ?? null,
        balanceAfterMinor, createdAt: clock.now(),
      };
      ledgerRows.set(entry.idempotencyKey, entry); wallet.balanceMinor = balanceAfterMinor; wallet.version += 1;
      return clone(entry);
    },
    async getBalance(id) { uuid.parse(id); return (wallets.get(id) ?? missing('Wallet not found')).balanceMinor; },
    async listByUser(id, options = {}) {
      return clone([...ledgerRows.values()].filter((row) => row.userId === id && (!options.before || row.createdAt < options.before))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))));
    },
  };
  const auditLogs: AuditLogRepository = {
    async record(input) {
      const parsed = z.object({
        actorUserId: uuid.nullish(), action: z.string().min(1).max(100),
        targetType: z.string().min(1).max(100), targetId: z.string().max(200).nullish(),
        ip: z.string().max(64).nullish(), requestId: z.string().max(100).nullish(),
      }).parse(input);
      const row: AuditLog = {
        ...parsed, id: randomUUID(), actorUserId: parsed.actorUserId ?? null,
        targetId: parsed.targetId ?? null, ip: parsed.ip ?? null, requestId: parsed.requestId ?? null,
        before: clone(input.before ?? null), after: clone(input.after ?? null), createdAt: clock.now(),
      };
      fail('auditLogs.record');
      auditRows.set(row.id, row);
      return clone(row);
    },
    async list(options = {}) {
      return clone([...auditRows.values()].filter((row) =>
        (!options.targetType || row.targetType === options.targetType) &&
        (!options.targetId || row.targetId === options.targetId) &&
        (!options.before || row.createdAt < options.before))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))));
    },
  };
  return {
    users, rooms, games, players, events, claims, ledger, auditLogs,
    gamePlayers: players, gameEvents: events,
    failNext(operation: string, error = new Error(`Injected ${operation} failure`)) { failures.set(operation, error); },
    setPotMinor(id: string, potMinor: bigint) { z.bigint().nonnegative().max(MAX_INT64).parse(potMinor); game(id).potMinor = potMinor; },
    getWallet(id: string) { return clone(wallets.get(id) ?? null); },
  };
}
