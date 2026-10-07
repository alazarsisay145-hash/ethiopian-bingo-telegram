import { z } from 'zod';
import { AppError, ErrorCode } from '@bingo/shared';
import type { GamePlayer, GamePlayerStatus } from '../../domain/entities.js';
import type { GameFence, GamePlayerRepository, ReserveCardResult } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import {
  isForeignKeyViolation, isRecordNotFound, isUniqueViolation, isUuid, notFound, requireUuid,
} from './errors.js';

const reserveSchema = z.object({
  gameId: z.string().uuid(),
  userId: z.string().uuid(),
  cardNumber: z.number().int().min(1),
  cardCells: z.array(z.number().int().min(0)).length(25),
});

export class PrismaGamePlayerRepository implements GamePlayerRepository {
  constructor(private readonly db: Db) {}

  async reserveCard(input: {
    gameId: string;
    userId: string;
    cardNumber: number;
    cardCells: number[];
  }): Promise<ReserveCardResult> {
    const data = reserveSchema.parse(input);
    try {
      const player = await this.db.gamePlayer.create({ data });
      return { kind: 'reserved', player };
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('Game or user');
      if (!isUniqueViolation(error)) throw error;
    }
    // A unique constraint rejected the insert: either this user already holds a card
    // in the game, or somebody else holds the requested card number.
    const existing = await this.findByGameAndUser(data.gameId, data.userId);
    return existing ? { kind: 'already_joined', player: existing } : { kind: 'card_taken' };
  }

  listByGame(gameId: string): Promise<GamePlayer[]> {
    if (!isUuid(gameId)) return Promise.resolve([]);
    return this.db.gamePlayer.findMany({ where: { gameId }, orderBy: { cardNumber: 'asc' } });
  }

  async findByGameAndUser(gameId: string, userId: string): Promise<GamePlayer | null> {
    if (!isUuid(gameId) || !isUuid(userId)) return null;
    return this.db.gamePlayer.findUnique({ where: { gameId_userId: { gameId, userId } } });
  }

  async setStatus(
    gameId: string,
    userId: string,
    status: GamePlayerStatus,
    fence?: GameFence,
  ): Promise<GamePlayer> {
    requireUuid(gameId, 'gameId');
    requireUuid(userId, 'userId');
    try {
      return await this.db.$transaction(async (tx) => {
        if (fence) {
          const owner = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM games WHERE id = ${gameId}::uuid
              AND owner_instance_id = ${fence.instanceId} AND fencing_token = ${fence.fencingToken}
            FOR UPDATE`;
          if (!owner.length) throw new AppError(ErrorCode.CONFLICT, 409, 'Stale game owner');
        }
        return tx.gamePlayer.update({
          where: { gameId_userId: { gameId, userId } }, data: { status },
        });
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('Game player');
      throw error;
    }
  }

  async remove(gameId: string, userId: string): Promise<void> {
    requireUuid(gameId, 'gameId');
    requireUuid(userId, 'userId');
    try {
      await this.db.gamePlayer.delete({ where: { gameId_userId: { gameId, userId } } });
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('Game player');
      throw error;
    }
  }
}
