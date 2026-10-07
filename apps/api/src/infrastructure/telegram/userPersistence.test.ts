import { describe, expect, it, vi } from 'vitest';
import { PrismaUserRepository } from '../db/userRepository.js';
import type { Db } from '../db/prisma.js';
import type { User } from '../../domain/entities.js';

function fixture(inserted = false) {
  const user = {
    id: 'ac5a3a41-70f0-4b98-ab67-5cdd097f52f6',
    telegramId: 12345n, role: 'SUPER_ADMIN', status: 'SUSPENDED',
    firstName: 'Updated', username: 'retained',
  } as User;
  const tx = {
    $queryRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<{ id: string; inserted: boolean }[]>>()
      .mockResolvedValue([{ id: user.id, inserted }]),
    $executeRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<number>>().mockResolvedValue(0),
    user: { findUniqueOrThrow: vi.fn(async () => user) },
    auditLog: { create: vi.fn() },
  };
  const db = { $transaction: async (operation: (transaction: typeof tx) => Promise<User>) => operation(tx) } as unknown as Db;
  return { tx, user, users: new PrismaUserRepository(db, [12345]) };
}

describe('authentication profile persistence', () => {
  it('atomically upserts lastSeenAt while preserving absent optional fields and existing authority', async () => {
    const { users, tx, user } = fixture();
    expect(await users.upsertFromTelegram({ telegramId: 12345n, firstName: 'Updated' })).toBe(user);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0]!;
    const conflictUpdate = sql.join('?').split('DO UPDATE SET')[1]!.split('RETURNING')[0]!;
    expect(conflictUpdate).toContain('last_seen_at = now()');
    expect(conflictUpdate).toContain('first_name = EXCLUDED.first_name');
    for (const field of ['username', 'last_name', 'photo_url', 'language_code']) {
      expect(conflictUpdate).toContain(`THEN EXCLUDED.${field} ELSE users.${field} END`);
    }
    expect(values.slice(-4)).toEqual([false, false, false, false]);
    expect(conflictUpdate).not.toMatch(/\b(role|status|balance_minor)\s*=/);
    expect(tx.$executeRaw.mock.calls[0]![0].join('?')).toContain('ON CONFLICT (user_id) DO NOTHING');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('updates supplied optional values, including explicit null, using bound parameters', async () => {
    const { users, tx } = fixture();
    const firstName = "name'); DROP TABLE users; --";
    await users.upsertFromTelegram({
      telegramId: 12345n, firstName, username: null,
      lastName: 'Last', photoUrl: 'https://example.test/picture', languageCode: 'am',
    });
    const [sql, ...values] = tx.$queryRaw.mock.calls[0]!;
    expect(sql.join('?')).not.toContain(firstName);
    expect(values).toContain(firstName);
    expect(values.slice(-4)).toEqual([true, true, true, true]);
  });

  it('only bootstraps allowlisted roles for newly inserted accounts with an audit record', async () => {
    const { users, tx } = fixture(true);
    await users.upsertFromTelegram({ telegramId: 12345n, firstName: 'New' });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'ROLE_BOOTSTRAPPED', targetType: 'user',
        targetId: expect.any(String), after: { role: 'ADMIN' },
      },
    });
  });

  it('rejects invalid profile input before any database writes', async () => {
    const { users, tx } = fixture();
    await expect(users.upsertFromTelegram({ telegramId: 0n, firstName: '' })).rejects.toThrow();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
