import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode, telegramUserSchema } from '@bingo/shared';
import type { z } from 'zod';
import type { AuthenticationPort, UserProfile } from '../../domain/ports.js';
import type { UserRepository } from '../../domain/repositories.js';
import type { AuthContext } from '../../domain/entities.js';

export interface InitDataOptions {
  maxAgeSeconds?: number;
  /** Injectable clock returning Unix milliseconds. */
  now?: () => number;
  futureSkewSeconds?: number;
  maxBytes?: number;
}

const unauthorized = () => new AppError(ErrorCode.UNAUTHORIZED, 401, 'Invalid Telegram authentication');

export type VerifiedIdentityHook = (telegramId: number) => Promise<void>;

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: InitDataOptions = {},
): z.infer<typeof telegramUserSchema> {
  return verify(initData, botToken, options).user;
}

function assertFreshness(authDate: number, verifiedAt: number, options: InitDataOptions): void {
  const nowSeconds = Math.floor(verifiedAt / 1000);
  if (authDate > nowSeconds + (options.futureSkewSeconds ?? 30) ||
      nowSeconds - authDate > (options.maxAgeSeconds ?? 3600)) {
    throw unauthorized();
  }
}

function verify(initData: string, botToken: string, options: InitDataOptions, checkFreshness = true) {
  const maxAge = options.maxAgeSeconds ?? 3600;
  const futureSkew = options.futureSkewSeconds ?? 30;
  const maxBytes = options.maxBytes ?? 16384;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0 ||
      !Number.isSafeInteger(futureSkew) || futureSkew < 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !botToken.trim()) {
    throw new Error('Invalid Telegram verification configuration');
  }
  if (typeof initData !== 'string' || !initData || Buffer.byteLength(initData, 'utf8') > maxBytes) {
    throw unauthorized();
  }
  const params = new Map<string, string>();
  for (const field of initData.split('&')) {
    const delimiter = field.indexOf('=');
    if (delimiter <= 0) throw unauthorized();
    const components = [field.slice(0, delimiter), field.slice(delimiter + 1)];
    if (components.some((part) => !/^[a-z\d_.~*%+-]*$/i.test(part))) throw unauthorized();
    let key: string;
    let value: string;
    try {
      [key, value] = components.map((part) => decodeURIComponent(part.replace(/\+/g, ' '))) as [string, string];
    } catch {
      throw unauthorized();
    }
    if (!key || /[\r\n=]/.test(key) || params.has(key)) throw unauthorized();
    params.set(key, value);
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-f\d]{64}$/.test(hash)) throw unauthorized();
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  const actual = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw unauthorized();
  const authDateText = params.get('auth_date');
  if (!authDateText || !/^\d+$/.test(authDateText)) throw unauthorized();
  const authDate = Number(authDateText);
  const verifiedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(authDate) || !Number.isSafeInteger(verifiedAt) || verifiedAt < 0) {
    throw unauthorized();
  }
  if (checkFreshness) assertFreshness(authDate, verifiedAt, options);
  const userText = params.get('user');
  if (!userText) throw unauthorized();
  try {
    return { user: telegramUserSchema.parse(JSON.parse(userText)), authDate, verifiedAt };
  } catch {
    throw unauthorized();
  }
}

export class TelegramAuthentication implements AuthenticationPort {
  constructor(
    private readonly botToken: string,
    private readonly options: InitDataOptions = {},
    private readonly users?: UserRepository,
    private readonly onVerifiedIdentity?: VerifiedIdentityHook,
  ) {}

  async authenticate(initData: string): Promise<UserProfile & AuthContext> {
    const { user, authDate, verifiedAt } = verify(initData, this.botToken, this.options, false);
    // Rate limiting must use a signed identity, including stale proofs and inactive accounts.
    await this.onVerifiedIdentity?.(user.id);
    assertFreshness(authDate, verifiedAt, this.options);
    if (!this.users) throw unauthorized();
    const profile = await this.users.upsertFromTelegram({
      telegramId: BigInt(user.id),
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      photoUrl: user.photo_url,
      languageCode: user.language_code,
    });
    if (profile.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'User is not active');
    }
    return {
      id: profile.id,
      userId: profile.id,
      telegramId: user.id,
      role: profile.role,
      status: profile.status,
      authDate,
      verifiedAt,
      firstName: profile.firstName,
      ...(profile.username ? { username: profile.username } : {}),
    };
  }
}
