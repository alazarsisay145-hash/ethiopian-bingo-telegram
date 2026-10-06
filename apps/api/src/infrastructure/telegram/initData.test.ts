import { describe, expect, it } from 'vitest';
import { AppError } from '@bingo/shared';
import { signedInitData, testBotToken } from '../../test-support.js';
import { TelegramAuthentication, verifyTelegramInitData } from './initData.js';

describe('Telegram initData verification', () => {
  it('authenticates actual HMAC signed data and derives a user profile', async () => {
    const data = signedInitData();
    expect(verifyTelegramInitData(data, testBotToken).id).toBe(12345);
    expect(await new TelegramAuthentication(testBotToken).authenticate(data)).toEqual({
      id: 'telegram:12345', telegramId: 12345, firstName: 'Test', username: 'tester',
    });
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
  });
});
