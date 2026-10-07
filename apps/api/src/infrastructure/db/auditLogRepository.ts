import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuditLog } from '../../domain/entities.js';
import type { AuditLogInput, AuditLogRepository } from '../../domain/repositories.js';
import type { Db } from './prisma.js';

const auditSchema = z.object({
  actorUserId: z.string().uuid().nullish(),
  action: z.string().min(1).max(100),
  targetType: z.string().min(1).max(100),
  targetId: z.string().max(200).nullish(),
  ip: z.string().max(64).nullish(),
  requestId: z.string().max(100).nullish(),
});

const json = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Db) {}

  record(input: AuditLogInput): Promise<AuditLog> {
    const { actorUserId, targetId, ip, requestId, ...required } = auditSchema.parse(input);
    return this.db.auditLog.create({
      data: {
        ...required,
        actorUserId: actorUserId ?? null,
        targetId: targetId ?? null,
        ip: ip ?? null,
        requestId: requestId ?? null,
        before: json(input.before),
        after: json(input.after),
      },
    });
  }

  list(
    options: { targetType?: string; targetId?: string; limit?: number; before?: Date } = {},
  ): Promise<AuditLog[]> {
    return this.db.auditLog.findMany({
      where: {
        ...(options.targetType ? { targetType: options.targetType } : {}),
        ...(options.targetId ? { targetId: options.targetId } : {}),
        ...(options.before ? { createdAt: { lt: options.before } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 200),
    });
  }
}
