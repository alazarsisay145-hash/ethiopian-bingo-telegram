import { Prisma } from '@prisma/client';
import type { GameEvent, GameStatus } from '../../domain/entities.js';
import type { GameEventRepository, GameFence } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { conflict, isUuid, notFound, requireUuid } from './errors.js';

const MAX_PAGE = 1000;

export class PrismaGameEventRepository implements GameEventRepository {
  constructor(private readonly db: Db, private readonly transactional = false) {}

  /**
   * The `UPDATE games ... RETURNING current_seq` takes the game row lock, so concurrent
   * appenders serialise and each obtains a distinct, consecutive `seq`. The event insert shares
   * the transaction: if it fails the counter increment rolls back, leaving no gaps. When a fence
   * is supplied the UPDATE only matches for the current owner/token, so stale owners cannot write.
   */
  async append(input: {
    gameId: string;
    type: string;
    payload: unknown;
    fence?: GameFence;
    expectedDrawIndex?: number;
    expectedStatus?: GameStatus;
  }): Promise<GameEvent> {
    const { gameId, type, fence, expectedDrawIndex, expectedStatus } = input;
    requireUuid(gameId, 'gameId');
    if (!type || type.length > 100) throw conflict('Invalid event type');
    if (input.payload === undefined) throw conflict('Event payload is required');
    const payload =
      input.payload === null ? Prisma.JsonNull : (input.payload as Prisma.InputJsonValue);
    const execute = async (tx: Prisma.TransactionClient): Promise<GameEvent> => {
      const rows = fence
        ? await tx.$queryRaw<{ seq: number }[]>`
            UPDATE games SET current_seq = current_seq + 1, updated_at = now()
            WHERE id = ${gameId}::uuid AND owner_instance_id = ${fence.instanceId}
              AND fencing_token = ${fence.fencingToken}
              AND (${expectedStatus ?? null}::game_status IS NULL OR status = ${expectedStatus ?? null}::game_status)
            RETURNING current_seq AS seq`
        : await tx.$queryRaw<{ seq: number }[]>`
            UPDATE games SET current_seq = current_seq + 1, updated_at = now()
            WHERE id = ${gameId}::uuid
              AND (${expectedStatus ?? null}::game_status IS NULL OR status = ${expectedStatus ?? null}::game_status)
            RETURNING current_seq AS seq`;
      const seq = rows[0]?.seq;
      if (seq === undefined) {
        if (!(await tx.game.count({ where: { id: gameId } }))) throw notFound('Game');
        throw conflict('Stale game owner');
      }
      if (expectedDrawIndex !== undefined) {
        const drawCount = await tx.gameEvent.count({ where: { gameId, type: 'NUMBER_CALLED' } });
        if (type !== 'NUMBER_CALLED' || drawCount !== expectedDrawIndex) {
          throw conflict('Draw sequence advanced concurrently');
        }
      }
      return tx.gameEvent.create({ data: { gameId, seq, type, payload } });
    };
    return this.transactional ? execute(this.db) : this.db.$transaction(execute);
  }

  async listSince(gameId: string, afterSeq: number, limit: number): Promise<GameEvent[]> {
    if (!isUuid(gameId)) return [];
    return this.db.gameEvent.findMany({
      where: { gameId, seq: { gt: Math.max(0, Math.trunc(afterSeq)) } },
      orderBy: { seq: 'asc' },
      take: Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE),
    });
  }

  async latestSeq(gameId: string): Promise<number> {
    requireUuid(gameId, 'gameId');
    const game = await this.db.game.findUnique({
      where: { id: gameId },
      select: { currentSeq: true },
    });
    if (!game) throw notFound('Game');
    return game.currentSeq;
  }
}
