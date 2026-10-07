import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { User, UserRole, UserStatus } from '../../domain/entities.js';
import type { TelegramProfileInput, UserRepository } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { isRecordNotFound, isUuid, notFound } from './errors.js';

const profileSchema = z.object({
  telegramId: z.bigint().positive(),
  username: z.string().max(64).nullish(),
  firstName: z.string().min(1).max(256),
  lastName: z.string().max(256).nullish(),
  photoUrl: z.string().max(2048).nullish(),
  languageCode: z.string().max(16).nullish(),
});

export class PrismaUserRepository implements UserRepository {
  private readonly adminTelegramIds: Set<string>;

  constructor(private readonly db: Db, adminTelegramIds: readonly number[] = []) {
    this.adminTelegramIds = new Set(adminTelegramIds.map(String));
  }

  async upsertFromTelegram(input: TelegramProfileInput): Promise<User> {
    const p = profileSchema.parse(input);
    // Raw ON CONFLICT keeps this race-free for concurrent first logins of the same Telegram ID;
    // all values are bound parameters.
    return this.db.$transaction(async (tx) => {
      const role = this.adminTelegramIds.has(p.telegramId.toString()) ? 'ADMIN' : 'PLAYER';
      const rows = await tx.$queryRaw<{ id: string; inserted: boolean }[]>`
        INSERT INTO users (id, telegram_id, username, first_name, last_name, photo_url, language_code, role, updated_at)
        VALUES (${randomUUID()}::uuid, ${p.telegramId}, ${p.username ?? null}, ${p.firstName},
                ${p.lastName ?? null}, ${p.photoUrl ?? null}, ${p.languageCode ?? null}, ${role}::user_role, now())
        ON CONFLICT (telegram_id) DO UPDATE SET
          username = EXCLUDED.username, first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name, photo_url = EXCLUDED.photo_url,
          language_code = EXCLUDED.language_code, updated_at = now()
        RETURNING id::text AS id, (xmax = 0) AS inserted`;
      const id = rows[0]?.id;
      if (!id) throw notFound('User');
      if (rows[0]?.inserted && role === 'ADMIN') {
        await tx.auditLog.create({
          data: {
            action: 'ROLE_BOOTSTRAPPED',
            targetType: 'user',
            targetId: id,
            after: { role },
          },
        });
      }
      await tx.$executeRaw`
        INSERT INTO wallets (user_id, updated_at) VALUES (${id}::uuid, now())
        ON CONFLICT (user_id) DO NOTHING`;
      return tx.user.findUniqueOrThrow({ where: { id } });
    });
  }

  async findById(id: string): Promise<User | null> {
    return isUuid(id) ? this.db.user.findUnique({ where: { id } }) : null;
  }

  findManyByIds(ids: string[]): Promise<User[]> {
    return this.db.user.findMany({ where: { id: { in: ids } } });
  }

  async lockForUpdate(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    return rows.length ? this.findById(id) : null;
  }

  findByTelegramId(telegramId: bigint): Promise<User | null> {
    return this.db.user.findUnique({ where: { telegramId } });
  }

  setRole(id: string, role: UserRole): Promise<User> {
    return this.update(id, { role });
  }

  setStatus(id: string, status: UserStatus): Promise<User> {
    return this.update(id, { status });
  }

  async touchLastSeen(id: string, at: Date = new Date()): Promise<void> {
    await this.update(id, { lastSeenAt: at });
  }

  private async update(
    id: string,
    data: { role?: UserRole; status?: UserStatus; lastSeenAt?: Date },
  ): Promise<User> {
    if (!isUuid(id)) throw notFound('User');
    try {
      return await this.db.user.update({ where: { id }, data });
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('User');
      throw error;
    }
  }
}
