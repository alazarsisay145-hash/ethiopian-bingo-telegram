import { z } from 'zod';

export enum ErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  GAME_NOT_RUNNING = 'GAME_NOT_RUNNING',
  CARD_TAKEN = 'CARD_TAKEN',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  INVALID_CLAIM = 'INVALID_CLAIM',
  INTERNAL = 'INTERNAL',
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errorDtoSchema = z
  .object({
    error: z
      .object({
        code: z.nativeEnum(ErrorCode),
        message: z.string(),
        details: jsonValueSchema.optional(),
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ErrorDto = z.infer<typeof errorDtoSchema>;
