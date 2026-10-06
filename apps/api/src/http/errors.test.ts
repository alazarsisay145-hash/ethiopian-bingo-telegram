import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, ErrorCode, errorDtoSchema } from '@bingo/shared';
import { mapError, validate } from './errors.js';

describe('error mapping', () => {
  it('preserves typed application failures', () => {
    const mapped = mapError(new AppError(ErrorCode.NOT_FOUND, 404, 'Unavailable', { feature: 'game' }), 'req-1');
    expect(mapped.status).toBe(404);
    expect(mapped.body.error).toEqual({
      code: ErrorCode.NOT_FOUND, message: 'Unavailable', details: { feature: 'game' }, requestId: 'req-1',
    });
    expect(errorDtoSchema.safeParse(mapped.body).success).toBe(true);
  });
  it('validates input with shared error shape', () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
    if (parsed.success) throw new Error('Expected validation error');
    expect(mapError(parsed.error, 'req-2')).toMatchObject({
      status: 400, body: { error: { code: ErrorCode.VALIDATION_ERROR, requestId: 'req-2' } },
    });
    expect(validate(z.string(), 'test')).toBe('test');
  });
  it.each([new Error('secret password'), null, 'secret', { statusCode: 500, message: 'private' }])(
    'does not leak unknown failures %#', (error) => {
      const mapped = mapError(error, 'req-3');
      expect(mapped.status).toBe(500);
      expect(mapped.body.error.message).toBe('Internal server error');
      expect(mapped.body.error.code).toBe(ErrorCode.INTERNAL);
    },
  );
  it.each([400, 413, 415, 429])('maps HTTP transport error %i safely', (statusCode) => {
    const mapped = mapError({ statusCode, message: 'private' }, 'req-4');
    expect(mapped.status).toBe(statusCode);
    expect(mapped.body.error.message).not.toBe('private');
  });
});
