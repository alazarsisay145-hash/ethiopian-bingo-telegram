import { AppError, ErrorCode } from '@bingo/shared';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { User, UserRole } from '../../domain/entities.js';
import type { AuthenticationPort } from '../../domain/ports.js';
import type { RateLimiter } from '../../domain/ports.js';
import type { UserRepository } from '../../domain/repositories.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export function requireUser(
  authentication: AuthenticationPort,
  users: UserRepository,
  rateLimiter?: RateLimiter,
  maxRequests = 100,
  windowMs = 60_000,
): preHandlerHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    const initData = request.headers['x-telegram-init-data'];
    if (typeof initData !== 'string' || !initData || initData.length > 16_384) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    }
    const identity = await authentication.authenticate(initData);
    const user = await users.findById(identity.id);
    if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    if (user.status === 'BANNED') {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'User is banned');
    }
    if (rateLimiter && !(await rateLimiter.consume(`http:${user.id}`, maxRequests, windowMs))) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
    }
    request.user = user;
  };
}

export function requireRole(...roles: UserRole[]): preHandlerHookHandler {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.user) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    if (!roles.includes(request.user.role)) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Insufficient permissions');
    }
  };
}
