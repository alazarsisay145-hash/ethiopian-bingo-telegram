import { createHmac } from 'node:crypto';
import { parseEnv } from './config/env.js';
import type { AuthenticationPort, UserProfile } from './domain/ports.js';
import type { AuthContext } from './domain/entities.js';

export const testBotToken = '123456789:test-only-not-a-real-telegram-token';
export const testEnv = parseEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  BOT_TOKEN: testBotToken,
  JWT_SECRET: 'test-only-not-a-real-signing-secret-32',
});

export function mockAuthentication(
  profile: UserProfile,
  context: Partial<AuthContext> = {},
): AuthenticationPort {
  const verifiedAt = Date.now();
  const authenticated = {
    ...profile,
    userId: profile.id,
    role: 'PLAYER' as const,
    status: 'ACTIVE' as const,
    authDate: Math.floor(verifiedAt / 1000),
    verifiedAt,
    ...context,
  };
  return { authenticate: async () => authenticated };
}

export function signedInitData(fields: Record<string, string> = {}, token = testBotToken): string {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 12345, first_name: 'Test', username: 'tester' }),
    ...fields,
  });
  const dataCheckString = [...data.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  data.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return data.toString();
}
