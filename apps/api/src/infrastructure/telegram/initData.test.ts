import { describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode } from '@bingo/shared';
import { signedInitData, testBotToken, testEnv } from '../../test-support.js';
import type { UserRepository } from '../../domain/repositories.js';
import { TelegramAuthentication, verifyTelegramInitData } from './initData.js';
import type { User } from '../../domain/entities.js';
import { createTelegramAuthentication } from '../bootstrap.js';

const persistedUser = {
  id: 'user-database-id', telegramId: 12345n, firstName: 'Test', username: 'tester',
  role: 'PLAYER', status: 'ACTIVE',
} as User;

function repository(user = persistedUser) {
  return { upsertFromTelegram: vi.fn(async () => user) } as unknown as UserRepository;
}

describe('Telegram initData verification', () => {
  it('authenticates actual HMAC signed data and derives a user profile', async () => {
    const data = signedInitData();
    expect(verifyTelegramInitData(data, testBotToken).id).toBe(12345);
    expect(await new TelegramAuthentication(testBotToken, {}, repository()).authenticate(data)).toEqual({
      id: 'user-database-id', userId: 'user-database-id',
      telegramId: 12345, firstName: 'Test', username: 'tester', role: 'PLAYER', status: 'ACTIVE',
      authDate: Number(new URLSearchParams(data).get('auth_date')), verifiedAt: expect.any(Number),
    });
  });
  it('maps authenticated Telegram identity to its persisted server-side user id', async () => {
    let persistedTelegramId: bigint | undefined;
    const users = {
      upsertFromTelegram: async (input: { telegramId: bigint; firstName: string; username?: string }) => {
        persistedTelegramId = input.telegramId;
        return { ...persistedUser, firstName: input.firstName, username: input.username ?? null };
      },
    } as unknown as UserRepository;
    const profile = await new TelegramAuthentication(testBotToken, {}, users).authenticate(signedInitData());
    expect(persistedTelegramId).toBe(12345n);
    expect(profile).toMatchObject({ id: 'user-database-id', telegramId: 12345 });
  });
  it.each(['BANNED', 'SUSPENDED'] as const)('rejects persisted %s users after verification', async (status) => {
    const users = repository({ ...persistedUser, status });
    await expect(new TelegramAuthentication(testBotToken, {}, users).authenticate(signedInitData()))
      .rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });
  it('fails closed without a persisted user repository', async () => {
    await expect(new TelegramAuthentication(testBotToken).authenticate(signedInitData()))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });
  });
  it('only persists verified profiles and never trusts client role/status/balance', async () => {
    const users = repository({ ...persistedUser, role: 'ADMIN' });
    const authentication = new TelegramAuthentication(testBotToken, {}, users);
    await expect(authentication.authenticate(signedInitData({}, 'wrong-token'))).rejects.toThrow();
    expect(users.upsertFromTelegram).not.toHaveBeenCalled();
    const context = await authentication.authenticate(signedInitData({
      user: JSON.stringify({
        id: 12345, first_name: 'Test', role: 'SUPER_ADMIN', status: 'ACTIVE', balanceMinor: 99999,
      }),
    }));
    expect(context.role).toBe('ADMIN');
    expect(users.upsertFromTelegram).toHaveBeenCalledWith({
      telegramId: 12345n, firstName: 'Test', username: undefined,
      lastName: undefined, photoUrl: undefined, languageCode: undefined,
    });
  });
  it('propagates persistence failures without creating a synthetic identity', async () => {
    const users = { upsertFromTelegram: vi.fn().mockRejectedValue(new Error('Database unavailable')) } as unknown as UserRepository;
    await expect(new TelegramAuthentication(testBotToken, {}, users).authenticate(signedInitData()))
      .rejects.toThrow('Database unavailable');
  });
  it('counts only signed, valid identities before stale or inactive authentication failures', async () => {
    const now = () => 2_000_000_000_000;
    const hook = vi.fn(async () => undefined);
    const users = repository({ ...persistedUser, status: 'SUSPENDED' });
    const authentication = new TelegramAuthentication(testBotToken, { now }, users, hook);
    await expect(authentication.authenticate(signedInitData({ auth_date: '1999996399' })))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(hook).toHaveBeenCalledWith(12345);
    expect(users.upsertFromTelegram).not.toHaveBeenCalled();
    await expect(authentication.authenticate(signedInitData({ auth_date: '2000000000' })))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(hook).toHaveBeenCalledTimes(2);
    await expect(authentication.authenticate(signedInitData({ auth_date: '2000000000' }, 'wrong-token')))
      .rejects.toThrow();
    await expect(authentication.authenticate(signedInitData({ user: '{"id":0}' }))).rejects.toThrow();
    expect(hook).toHaveBeenCalledTimes(2);
  });
  it('stops before database persistence when the verified-identity limiter rejects', async () => {
    const users = repository();
    const hook = vi.fn(async () => { throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many attempts'); });
    await expect(new TelegramAuthentication(testBotToken, {}, users, hook).authenticate(signedInitData()))
      .rejects.toMatchObject({ httpStatus: 429 });
    expect(users.upsertFromTelegram).not.toHaveBeenCalled();
  });
  it('wires the canonical token and configured verifier limits through bootstrap', async () => {
    const token = 'test-only-canonical-token';
    const authentication = createTelegramAuthentication({
      ...testEnv, TELEGRAM_BOT_TOKEN: token, TELEGRAM_INITDATA_MAX_AGE_SECONDS: 1,
      TELEGRAM_INITDATA_CLOCK_SKEW_SECONDS: 0,
    }, repository());
    await expect(authentication.authenticate(signedInitData({}, token))).resolves.toMatchObject({
      userId: persistedUser.id,
    });
    await expect(authentication.authenticate(signedInitData())).rejects.toThrow(AppError);
    await expect(authentication.authenticate(signedInitData({
      auth_date: String(Math.floor(Date.now() / 1000) - 10),
    }, token))).rejects.toThrow(AppError);
    await expect(authentication.authenticate(signedInitData({
      auth_date: String(Math.floor(Date.now() / 1000) + 10),
    }, token))).rejects.toThrow(AppError);
    await expect(createTelegramAuthentication({
      ...testEnv, TELEGRAM_INITDATA_MAX_BYTES: 1,
    }, repository()).authenticate(signedInitData())).rejects.toThrow(AppError);
  });
  it('verifies decoded values, plus signs, Unicode, and arbitrary key ordering', () => {
    const data = signedInitData({ user: JSON.stringify({ id: 123, first_name: 'ሰላም + Test' }), query_id: 'a+b=c' });
    const reversed = [...new URLSearchParams(data).entries()].reverse();
    expect(verifyTelegramInitData(new URLSearchParams(reversed).toString(), testBotToken).first_name)
      .toBe('ሰላም + Test');
  });
  it('rejects payload tampering', () => {
    expect(() => verifyTelegramInitData(signedInitData().replace('12345', '54321'), testBotToken)).toThrow(AppError);
  });
  it('rejects a signature generated with a different token', () => {
    expect(() => verifyTelegramInitData(signedInitData(), 'wrong-token')).toThrow(AppError);
  });
  it('rejects expired and future timestamps while accepting the max-age boundary', () => {
    const now = () => 2_000_000_000_000;
    expect(() => verifyTelegramInitData(signedInitData({ auth_date: '1999996399' }), testBotToken, { now })).toThrow(AppError);
    expect(() => verifyTelegramInitData(signedInitData({ auth_date: '2000000031' }), testBotToken, { now })).toThrow(AppError);
    expect(verifyTelegramInitData(signedInitData({ auth_date: '1999996400' }), testBotToken, { now }).id).toBe(12345);
    expect(verifyTelegramInitData(signedInitData({ auth_date: '2000000030' }), testBotToken, { now }).id).toBe(12345);
    expect(verifyTelegramInitData(signedInitData({ auth_date: '2000000000' }), testBotToken, { now }).id).toBe(12345);
  });
  it('uses configurable freshness, byte limits, skew and a single injected clock read', async () => {
    const now = vi.fn(() => 2_000_000_000_123);
    const data = signedInitData({ auth_date: '1999999940' });
    const options = { now, maxAgeSeconds: 60, futureSkewSeconds: 0, maxBytes: Buffer.byteLength(data) };
    const context = await new TelegramAuthentication(testBotToken, options, repository()).authenticate(data);
    expect(context).toMatchObject({ authDate: 1999999940, verifiedAt: 2_000_000_000_123 });
    expect(now).toHaveBeenCalledTimes(1);
    expect(() => verifyTelegramInitData(data, testBotToken, { ...options, maxAgeSeconds: 59 })).toThrow(AppError);
    expect(() => verifyTelegramInitData(data, testBotToken, { ...options, maxBytes: Buffer.byteLength(data) - 1 })).toThrow(AppError);
    expect(() => verifyTelegramInitData(signedInitData({ auth_date: '2000000001' }), testBotToken, options)).toThrow(AppError);
  });
  it('rejects uppercase, non-hex, odd-length, truncated and overlong hashes', () => {
    const data = signedInitData();
    const hash = new URLSearchParams(data).get('hash')!;
    for (const invalid of [hash.toUpperCase(), hash.slice(1), hash + 'a', 'g'.repeat(64), '00', '']) {
      const params = new URLSearchParams(data);
      params.set('hash', invalid);
      expect(() => verifyTelegramInitData(params.toString(), testBotToken)).toThrow(AppError);
    }
  });
  it.each([
    'user={"id":12345,"first_name":"Test"}', '%GG=x', 'a=%FF', 'a=%C0%AF', 'a=%ED%A0%80',
    'a=%', 'a=%2', '=x', 'a', 'a=b&', 'a=b=c', '?a=b', 'a%0A=x', 'a%3D=x',
  ])('rejects noncanonical form encoding %s', (data) => {
    expect(() => verifyTelegramInitData(data, testBotToken)).toThrow(AppError);
  });
  it('rejects raw JSON even with an otherwise correct signature', () => {
    const data = signedInitData();
    const params = new URLSearchParams(data);
    const raw = data.replace(/user=[^&]+/, `user=${params.get('user')!}`);
    expect(() => verifyTelegramInitData(raw, testBotToken)).toThrow(AppError);
    expect(() => verifyTelegramInitData(data + '&%61uth_date=1', testBotToken)).toThrow(AppError);
  });
  it.each(['', 'hash=short', 'hash=' + 'z'.repeat(64), '%GG', 'a'.repeat(16385)])(
    'rejects malformed initData %#', (data) => {
      expect(() => verifyTelegramInitData(data, testBotToken)).toThrow(AppError);
    },
  );
  it.each(['-1', '1.5', 'Infinity', '9007199254740992', ''])('rejects invalid auth_date %s', (auth_date) => {
    expect(() => verifyTelegramInitData(signedInitData({ auth_date }), testBotToken)).toThrow(AppError);
  });
  it.each(['invalid-json', '{}', '{"id":0,"first_name":"Test"}', '{"id":9007199254740992,"first_name":"Test"}'])(
    'rejects invalid signed user %#', (user) => {
      expect(() => verifyTelegramInitData(signedInitData({ user }), testBotToken)).toThrow(AppError);
    },
  );
  it('rejects missing user and duplicate keys', () => {
    expect(() => verifyTelegramInitData(signedInitData() + '&auth_date=1', testBotToken)).toThrow(AppError);
    expect(() => verifyTelegramInitData(signedInitData() + '&hash=' + 'a'.repeat(64), testBotToken)).toThrow(AppError);
    const params = new URLSearchParams(signedInitData());
    params.delete('user');
    expect(() => verifyTelegramInitData(params.toString(), testBotToken)).toThrow(AppError);
  });
  it('rejects invalid verifier configuration', () => {
    expect(() => verifyTelegramInitData(signedInitData(), testBotToken, { maxAgeSeconds: 0 })).toThrow();
    expect(() => verifyTelegramInitData(signedInitData(), '', {})).toThrow();
    expect(() => verifyTelegramInitData(signedInitData(), ' ', {})).toThrow();
    expect(() => verifyTelegramInitData(signedInitData(), testBotToken, { futureSkewSeconds: -1 })).toThrow();
    expect(() => verifyTelegramInitData(signedInitData(), testBotToken, { maxBytes: 0 })).toThrow();
    expect(() => verifyTelegramInitData(signedInitData(), testBotToken, { now: () => NaN })).toThrow(AppError);
    expect(() => verifyTelegramInitData(signedInitData(), testBotToken, { now: () => -1 })).toThrow(AppError);
  });
});
