import { Prisma } from '@prisma/client';
import { AppError, ErrorCode } from '@bingo/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function requireUuid(value: string, name: string): string {
  if (!isUuid(value)) throw new AppError(ErrorCode.VALIDATION_ERROR, 400, `Invalid ${name}`);
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export const isUniqueViolation = (error: unknown): boolean => hasCode(error, 'P2002');
export const isForeignKeyViolation = (error: unknown): boolean => hasCode(error, 'P2003');
export const isRecordNotFound = (error: unknown): boolean => hasCode(error, 'P2025');

export const notFound = (what: string): AppError =>
  new AppError(ErrorCode.NOT_FOUND, 404, `${what} not found`);
export const conflict = (message: string): AppError =>
  new AppError(ErrorCode.CONFLICT, 409, message);
