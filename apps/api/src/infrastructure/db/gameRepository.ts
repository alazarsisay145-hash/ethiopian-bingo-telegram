import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { Game, GameEvent, GameStatus } from '../../domain/entities.js';
import { GAME_STATUS_TRANSITIONS } from '../../domain/entities.js';
import type { GameFence, GameRepository, RevealedSeed } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { conflict, isForeignKeyViolation, isUniqueViolation, isUuid, notFound, requireUuid } from './errors.js';

const ACTIVE: GameStatus[] = ['LOBBY', 'STARTING', 'RUNNING', 'SETTLING'];
// The secret seed is omitted from every query that returns a `Game`.
const omitSecret = { seedEncrypted: true } as const;
const commitmentSchema = z.object({
  seedHash: z.string().min(1).max(256),
  seedEncrypted: z.string().min(1).max(4096),
});

function sourcesOf(next: GameStatus): GameStatus[] {
  return (Object.keys(GAME_STATUS_TRANSITIONS) as GameStatus[])
    .filter((from) => GAME_STATUS_TRANSITIONS[from].includes(next));
}

export class PrismaGameRepository implements GameRepository {
  constructor(private readonly db: Db) {}

  async create(input: { roomId: string }): Promise<Game> {
    requireUuid(input.roomId, 'roomId');
    try {
      return await this.db.game.create({ data: { roomId: input.roomId }, omit: omitSecret });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('Room');
      if (isUniqueViolation(error)) throw conflict('Room already has an active game');
      throw error;
    }
  }

  async findById(id: string): Promise<Game | null> {
    return isUuid(id) ? this.db.game.findUnique({ where: { id }, omit: omitSecret }) : null;
  }

  async findActiveByRoom(roomId: string): Promise<Game | null> {
    if (!isUuid(roomId)) return null;
    return this.db.game.findFirst({
      where: { roomId, status: { in: ACTIVE } }, orderBy: { createdAt: 'desc' }, omit: omitSecret,
    });
  }

  listByStatus(statuses: GameStatus[]): Promise<Game[]> {
    return this.db.game.findMany({
      where: { status: { in: statuses } },
      orderBy: { createdAt: 'asc' },
      omit: omitSecret,
    });
  }

  async lockForUpdate(gameId: string): Promise<Game | null> {
    requireUuid(gameId, 'gameId');
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM games WHERE id = ${gameId}::uuid FOR UPDATE`;
    return rows.length ? this.findById(gameId) : null;
  }

  async adjustPotMinor(gameId: string, deltaMinor: bigint): Promise<Game> {
    requireUuid(gameId, 'gameId');
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE games SET pot_minor = pot_minor + ${deltaMinor}, updated_at = now()
      WHERE id = ${gameId}::uuid AND status IN ('LOBBY', 'STARTING', 'CANCELLED')
        AND pot_minor + ${deltaMinor} >= 0
      RETURNING id::text AS id`;
    if (!rows.length) {
      if (!(await this.db.game.count({ where: { id: gameId } }))) throw notFound('Game');
      throw conflict('Game pot cannot be changed in its current state');
    }
    return this.db.game.findUniqueOrThrow({ where: { id: gameId }, omit: omitSecret });
  }

  async setStartingAt(gameId: string, startingAt: Date | null): Promise<Game | null> {
    requireUuid(gameId, 'gameId');
    const result = await this.db.game.updateMany({
      where: {
        id: gameId,
        status: startingAt ? 'LOBBY' : 'STARTING',
        startingAt: startingAt ? null : { not: null },
      },
      data: startingAt
        ? { status: 'STARTING', startingAt }
        : { status: 'LOBBY', startingAt: null },
    });
    if (!result.count) return null;
    return this.db.game.findUnique({ where: { id: gameId }, omit: omitSecret });
  }

  async listRunnable(): Promise<Game[]> {
    return this.db.game.findMany({
      where: { status: { in: ['RUNNING', 'SETTLING'] } },
      orderBy: { createdAt: 'asc' },
      omit: omitSecret,
    });
  }

  async updateStatus(gameId: string, status: GameStatus, fence?: GameFence): Promise<Game> {
    requireUuid(gameId, 'gameId');
    const now = new Date();
    const result = await this.db.game.updateMany({
      where: {
        id: gameId,
        status: { in: sourcesOf(status) },
        ...(fence ? { ownerInstanceId: fence.instanceId, fencingToken: fence.fencingToken } : {}),
      },
      data: {
        status,
        ...(status === 'RUNNING' ? { startedAt: now, startingAt: null } : {}),
        ...(status === 'ENDED' || status === 'CANCELLED' ? { endedAt: now, startingAt: null } : {}),
      },
    });
    if (result.count === 0) {
      const current = await this.db.game.findUnique({ where: { id: gameId }, omit: omitSecret });
      if (!current) throw notFound('Game');
      if (fence && !(await this.verifyFence(gameId, fence))) throw conflict('Stale game owner');
      throw conflict(`Cannot move game from ${current.status} to ${status}`);
    }
    return this.db.game.findUniqueOrThrow({ where: { id: gameId }, omit: omitSecret });
  }

  async setSeedCommitment(
    gameId: string,
    input: { seedHash: string; seedEncrypted: string },
  ): Promise<void> {
    requireUuid(gameId, 'gameId');
    const data = commitmentSchema.parse(input);
    const result = await this.db.game.updateMany({
      where: { id: gameId, seedHash: null, status: { in: ['LOBBY', 'STARTING'] } },
      data,
    });
    if (result.count === 0) {
      if (!(await this.db.game.count({ where: { id: gameId } }))) throw notFound('Game');
      throw conflict('Seed commitment already set or game already started');
    }
  }

  async getSeedCommitment(gameId: string): Promise<{ seedHash: string; seedEncrypted: string } | null> {
    requireUuid(gameId, 'gameId');
    const game = await this.db.game.findUnique({
      where: { id: gameId },
      select: { seedHash: true, seedEncrypted: true },
    });
    return game?.seedHash && game.seedEncrypted
      ? { seedHash: game.seedHash, seedEncrypted: game.seedEncrypted }
      : null;
  }

  async finalize(gameId: string, payload: unknown, fence: GameFence): Promise<GameEvent> {
    requireUuid(gameId, 'gameId');
    if (payload === undefined) throw conflict('Final event payload is required');
    const eventPayload = payload === null ? Prisma.JsonNull : (payload as Prisma.InputJsonValue);
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ seq: number }[]>`
        UPDATE games SET status = 'ENDED', ended_at = now(),
          seed_revealed_at = COALESCE(seed_revealed_at, now()),
          current_seq = current_seq + 1, updated_at = now()
        WHERE id = ${gameId}::uuid AND status = 'SETTLING'
          AND owner_instance_id = ${fence.instanceId} AND fencing_token = ${fence.fencingToken}
        RETURNING current_seq AS seq`;
      const seq = rows[0]?.seq;
      if (seq === undefined) {
        const current = await tx.game.findUnique({
          where: { id: gameId },
          select: { status: true, ownerInstanceId: true, fencingToken: true },
        });
        if (!current) throw notFound('Game');
        if (current.ownerInstanceId !== fence.instanceId || current.fencingToken !== fence.fencingToken) {
          throw conflict('Stale game owner');
        }
        if (current.status === 'ENDED') {
          const existing = await tx.gameEvent.findFirst({
            where: { gameId, type: 'GAME_ENDED' },
            orderBy: { seq: 'desc' },
          });
          if (existing) return existing;
        }
        throw conflict(`Cannot finalize game from ${current.status}`);
      }
      return tx.gameEvent.create({
        data: { gameId, seq, type: 'GAME_ENDED', payload: eventPayload },
      });
    });
  }

  async revealSeed(gameId: string): Promise<RevealedSeed> {
    requireUuid(gameId, 'gameId');
    const game = await this.db.game.findUnique({ where: { id: gameId } });
    if (!game) throw notFound('Game');
    if (game.status !== 'ENDED' && game.status !== 'CANCELLED') {
      throw conflict('Seed can only be revealed after the game has finished');
    }
    if (!game.seedHash || !game.seedEncrypted) throw conflict('Game has no seed commitment');
    const revealedAt = game.seedRevealedAt ?? new Date();
    if (!game.seedRevealedAt) {
      await this.db.game.updateMany({
        where: { id: gameId, seedRevealedAt: null }, data: { seedRevealedAt: revealedAt },
      });
    }
    const fresh = await this.db.game.findUniqueOrThrow({
      where: { id: gameId }, select: { seedRevealedAt: true },
    });
    return {
      seedHash: game.seedHash,
      seedEncrypted: game.seedEncrypted,
      seedRevealedAt: fresh.seedRevealedAt ?? revealedAt,
    };
  }

  async tryAcquireOwnership(
    gameId: string,
    instanceId: string,
    fencingToken: bigint,
  ): Promise<boolean> {
    requireUuid(gameId, 'gameId');
    if (!instanceId || fencingToken < 1n) throw conflict('Invalid ownership request');
    const result = await this.db.game.updateMany({
      where: { id: gameId, fencingToken: { lt: fencingToken } },
      data: { ownerInstanceId: instanceId, fencingToken },
    });
    return result.count === 1;
  }

  async verifyFence(gameId: string, fence: GameFence): Promise<boolean> {
    if (!isUuid(gameId)) return false;
    const count = await this.db.game.count({
      where: { id: gameId, ownerInstanceId: fence.instanceId, fencingToken: fence.fencingToken },
    });
    return count === 1;
  }
}
