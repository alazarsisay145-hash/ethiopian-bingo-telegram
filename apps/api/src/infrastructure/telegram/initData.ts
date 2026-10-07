import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode, telegramUserSchema } from '@bingo/shared';
import type { z } from 'zod';
import type { AuthenticationPort, UserProfile } from '../../domain/ports.js';
import type { UserRepository } from '../../domain/repositories.js';

export interface InitDataOptions {
  maxAgeSeconds?: number;
  now?: () => number;
  futureSkewSeconds?: number;
}

const unauthorized = () => new AppError(ErrorCode.UNAUTHORIZED, 401, 'Invalid Telegram authentication');

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: InitDataOptions = {},
): z.infer<typeof telegramUserSchema> {
  const maxAge = options.maxAgeSeconds ?? 3600;
  const futureSkew = options.futureSkewSeconds ?? 30;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0 ||
      !Number.isSafeInteger(futureSkew) || futureSkew < 0 || !botToken) {
    throw new Error('Invalid Telegram verification configuration');
  }
  if (!initData || initData.length > 16384 || /%(?![a-f\d]{2})/i.test(initData)) {
    throw unauthorized();
  }
  const params = new URLSearchParams(initData);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw unauthorized();
  const hash = params.get('hash');
  if (!hash || !/^[a-f\d]{64}$/i.test(hash)) throw unauthorized();
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw unauthorized();
  const authDateText = params.get('auth_date');
  if (!authDateText || !/^\d+$/.test(authDateText)) throw unauthorized();
  const authDate = Number(authDateText);
  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  if (!Number.isSafeInteger(authDate) || !Number.isFinite(nowSeconds) ||
      authDate > nowSeconds + futureSkew || nowSeconds - authDate > maxAge) {
    throw unauthorized();
  }
  const userText = params.get('user');
  if (!userText) throw unauthorized();
  try {
    return telegramUserSchema.parse(JSON.parse(userText));
  } catch {
    throw unauthorized();
  }
}

export class TelegramAuthentication implements AuthenticationPort {
  constructor(
    private readonly botToken: string,
    private readonly options: InitDataOptions = {},
    private readonly users?: UserRepository,
  ) {}

  async authenticate(initData: string): Promise<UserProfile> {
    const user = verifyTelegramInitData(initData, this.botToken, this.options);
    if (this.users) {
      const profile = await this.users.upsertFromTelegram({
        telegramId: BigInt(user.id),
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        photoUrl: user.photo_url,
        languageCode: user.language_code,
      });
      if (profile.status === 'BANNED') {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'User is banned');
      }
      return {
        id: profile.id,
        telegramId: user.id,
        firstName: profile.firstName,
        ...(profile.username ? { username: profile.username } : {}),
      };
    }
    return {
      id: `telegram:${user.id}`,
      telegramId: user.id,
      firstName: user.first_name,
      ...(user.username ? { username: user.username } : {}),
    };
  }
}
