import { AppError, ErrorCode } from '@bingo/shared';

export function checkIdentityClaims(
  value: unknown,
  identity: { id: string; telegramId: number | string; username?: string },
  removeMatching = false,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const claims = value as Record<string, unknown>;
  const expected = {
    userId: identity.id,
    telegramId: identity.telegramId,
    username: identity.username,
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (!Object.prototype.hasOwnProperty.call(claims, key)) continue;
    if (
      (typeof claims[key] !== 'string' && typeof claims[key] !== 'number') ||
      String(claims[key]) !== String(expected[key])
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        'Identity claim does not match authenticated user',
      );
    }
    if (removeMatching) delete claims[key];
  }
}
