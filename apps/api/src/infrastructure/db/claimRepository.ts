import { z } from 'zod';
import type { Claim } from '../../domain/entities.js';
import type { ClaimRepository } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { isForeignKeyViolation, isUuid, notFound } from './errors.js';

const claimSchema = z.object({
  gameId: z.string().uuid(),
  userId: z.string().uuid(),
  atSeq: z.number().int().min(0),
  accepted: z.boolean(),
  patterns: z.array(z.string().min(1)),
});

export class PrismaClaimRepository implements ClaimRepository {
  constructor(private readonly db: Db) {}

  async record(input: {
    gameId: string;
    userId: string;
    atSeq: number;
    accepted: boolean;
    patterns: string[];
  }): Promise<Claim> {
    const data = claimSchema.parse(input);
    try {
      return await this.db.claim.create({ data });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('Game or user');
      throw error;
    }
  }

  async listByGame(gameId: string): Promise<Claim[]> {
    if (!isUuid(gameId)) return [];
    return this.db.claim.findMany({ where: { gameId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }
}
