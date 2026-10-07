import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError, ErrorCode } from '@bingo/shared';
import type { LedgerEntry } from '../../domain/entities.js';
import type { LedgerApplyInput, LedgerRepository } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { conflict, isUniqueViolation, isUuid, notFound, requireUuid } from './errors.js';

const MAX_INT64 = 9_223_372_036_854_775_807n;
const applySchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(['STAKE', 'REFUND', 'PRIZE', 'ADMIN_ADJUSTMENT']),
  amountMinor: z.bigint().refine((v) => v !== 0n && v > -MAX_INT64 && v < MAX_INT64, 'Invalid amount'),
  refType: z.string().max(100).nullish(),
  refId: z.string().max(200).nullish(),
  idempotencyKey: z.string().min(1).max(200),
}).superRefine((entry, ctx) => {
  const wrongSign = entry.type === 'STAKE' ? entry.amountMinor > 0n
    : entry.type !== 'ADMIN_ADJUSTMENT' && entry.amountMinor < 0n;
  if (wrongSign) ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'Wrong sign for entry type' });
});

export class PrismaLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Db, private readonly transactional = false) {}

  /**
   * `SELECT ... FOR UPDATE` serialises every ledger write for one wallet, so the balance check,
   * entry insert and wallet update are atomic. The idempotency lookup happens after the lock, so
   * concurrent replays of one key observe the first writer's committed entry and never re-apply.
   */
  async apply(input: LedgerApplyInput): Promise<LedgerEntry> {
    const entry = applySchema.parse(input);
    try {
      const execute = (tx: Prisma.TransactionClient) => this.applyLocked(tx, entry);
      return this.transactional ? await execute(this.db) : await this.db.$transaction(execute);
    } catch (error) {
      // Same key raced across different wallets (no shared lock): the loser is a conflict.
      if (isUniqueViolation(error)) throw conflict('Idempotency key already used');
      throw error;
    }
  }

  private async applyLocked(tx: Prisma.TransactionClient, entry: z.infer<typeof applySchema>) {
        const wallets = await tx.$queryRaw<{ balance_minor: bigint }[]>`
          SELECT balance_minor FROM wallets WHERE user_id = ${entry.userId}::uuid FOR UPDATE`;
        const wallet = wallets[0];
        if (!wallet) throw notFound('Wallet');
        const existing = await tx.ledgerEntry.findUnique({
          where: { idempotencyKey: entry.idempotencyKey },
        });
        if (existing) {
          if (
            existing.userId !== entry.userId || existing.type !== entry.type
            || existing.amountMinor !== entry.amountMinor
            || existing.refType !== (entry.refType ?? null) || existing.refId !== (entry.refId ?? null)
          ) throw conflict('Idempotency key already used with different parameters');
          return existing;
        }
        const balanceAfter = wallet.balance_minor + entry.amountMinor;
        if (balanceAfter < 0n) {
          throw new AppError(ErrorCode.INSUFFICIENT_FUNDS, 409, 'Insufficient funds');
        }
        if (balanceAfter > MAX_INT64) throw conflict('Balance overflow');
        const created = await tx.ledgerEntry.create({
          data: {
            userId: entry.userId, type: entry.type, amountMinor: entry.amountMinor,
            balanceAfterMinor: balanceAfter, refType: entry.refType ?? null,
            refId: entry.refId ?? null, idempotencyKey: entry.idempotencyKey,
          },
        });
        await tx.wallet.update({
          where: { userId: entry.userId },
          data: { balanceMinor: balanceAfter, version: { increment: 1 } },
        });
        return created;
  }

  async getBalance(userId: string): Promise<bigint> {
    requireUuid(userId, 'userId');
    const wallet = await this.db.wallet.findUnique({ where: { userId } });
    if (!wallet) throw notFound('Wallet');
    return wallet.balanceMinor;
  }

  async getWallet(userId: string): Promise<{ balanceMinor: bigint; currency: string; version: number }> {
    requireUuid(userId, 'userId');
    const wallet = await this.db.wallet.findUnique({ where: { userId } });
    if (!wallet) throw notFound('Wallet');
    return { balanceMinor: wallet.balanceMinor, currency: wallet.currency, version: wallet.version };
  }

  async listByUser(
    userId: string,
    options: { limit?: number; before?: Date } = {},
  ): Promise<LedgerEntry[]> {
    if (!isUuid(userId)) return [];
    return this.db.ledgerEntry.findMany({
      where: { userId, ...(options.before ? { createdAt: { lt: options.before } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 200),
    });
  }
}
