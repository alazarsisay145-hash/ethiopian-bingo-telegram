import { AppError, ErrorCode, errorDtoSchema } from '@bingo/shared';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export function validate<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  return schema.parse(input);
}

export function mapError(error: unknown, requestId: string): {
  status: number;
  body: z.infer<typeof errorDtoSchema>;
} {
  if (error instanceof AppError) {
    return {
      status: error.httpStatus,
      body: errorDtoSchema.parse({ error: {
        code: error.code, message: error.message, details: error.details, requestId,
      } }),
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: errorDtoSchema.parse({ error: {
        code: ErrorCode.VALIDATION_ERROR, message: 'Invalid request',
        details: error.flatten(), requestId,
      } }),
    };
  }
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? error.statusCode : undefined;
  if (status === 429) {
    return { status, body: errorDtoSchema.parse({ error: {
      code: ErrorCode.RATE_LIMITED, message: 'Too many requests', requestId,
    } }) };
  }
  if (status === 400 || status === 413 || status === 415) {
    return { status, body: errorDtoSchema.parse({ error: {
      code: ErrorCode.VALIDATION_ERROR, message: 'Invalid request', requestId,
    } }) };
  }
  return {
    status: 500,
    body: errorDtoSchema.parse({ error: {
      code: ErrorCode.INTERNAL, message: 'Internal server error', requestId,
    } }),
  };
}
