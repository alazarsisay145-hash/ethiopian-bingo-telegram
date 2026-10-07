import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Claim } from '../../domain/entities.js';
import type { ClaimRepository, GameFence } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { conflict, isForeignKeyViolation, isUniqueViolation, isUuid, notFound } from './errors.js';

const claimSchema = z.object({
  gameId: z.string().uuid(),
  userId: z.string().uuid(),
  atSeq: z.number().int().min(0),
  accepted: z.boolean(),
  patterns: z.array(z.string().min(1)),
});
const claimEventSchema = claimSchema.extend({ disqualifyOnFalseClaim: z.boolean() });

export class PrismaClaimRepository implements ClaimRepository {
  constructor(private readonly db: Db) {}

  async record(input: {
    gameId: string;
    userId: string;
    atSeq: number;
    accepted: boolean;
    patterns: string[];
  }, fence?: GameFence): Promise<Claim> {
    const data = claimSchema.parse(input);
    try {
      if (fence) {
        return await this.db.$transaction(async (tx) => {
          const owner = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM games WHERE id = ${data.gameId}::uuid
              AND owner_instance_id = ${fence.instanceId} AND fencing_token = ${fence.fencingToken}
              AND status = 'RUNNING'
            FOR UPDATE`;
          if (!owner.length) throw conflict('Stale game owner');
          return tx.claim.create({ data });
        });
      }
      return await this.db.claim.create({ data });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('Game or user');
      if (isUniqueViolation(error)) throw conflict('Player already claimed in this game');
      throw error;
    }
  }

  async listByGame(gameId: string): Promise<Claim[]> {
    if (!isUuid(gameId)) return [];
    return this.db.claim.findMany({ where: { gameId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  async recordWithEvent(
    input: {
      gameId: string;
      userId: string;
      atSeq: number;
      accepted: boolean;
      patterns: string[];
      disqualifyOnFalseClaim: boolean;
    },
    fence: GameFence,
  ): Promise<{ claim: Claim; event: import('../../domain/entities.js').GameEvent }> {
    const data = claimEventSchema.parse(input);
    try {
      return await this.db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ seq: number }[]>`
          UPDATE games SET current_seq = current_seq + 1, updated_at = now()
          WHERE id = ${data.gameId}::uuid AND owner_instance_id = ${fence.instanceId}
            AND fencing_token = ${fence.fencingToken} AND status = 'RUNNING'
          RETURNING current_seq AS seq`;
        const seq = rows[0]?.seq;
        if (seq === undefined) throw conflict('Game owner or status changed before claim');
        const claim = await tx.claim.create({
          data: {
            gameId: data.gameId,
            userId: data.userId,
            atSeq: data.atSeq,
            accepted: data.accepted,
            patterns: data.patterns,
          },
        });
        if (!data.accepted && data.disqualifyOnFalseClaim) {
          await tx.gamePlayer.update({
            where: { gameId_userId: { gameId: data.gameId, userId: data.userId } },
            data: { status: 'DISQUALIFIED' },
          });
        }
        const event = await tx.gameEvent.create({
          data: {
            gameId: data.gameId,
            seq,
            type: data.accepted ? 'CLAIM_ACCEPTED' : 'CLAIM_REJECTED',
            payload: {
              userId: data.userId,
              atSeq: data.atSeq,
              patterns: data.patterns,
            } as Prisma.InputJsonValue,
          },
        });
        return { claim, event };
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('Game, user or game player');
      if (isUniqueViolation(error)) throw conflict('Player already claimed in this game');
      throw error;
    }
  }
}
