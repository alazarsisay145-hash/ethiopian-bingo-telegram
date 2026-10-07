import { AppError, ErrorCode, gameParamsSchema, roomParamsSchema } from '@bingo/shared';
import type { FastifyRequest } from 'fastify';
import type { AuthContext, User, UserRole } from '../../domain/entities.js';
import type { AuthenticationPort } from '../../domain/ports.js';
import type { RateLimiter } from '../../domain/ports.js';
import type {
  GamePlayerRepository,
  GameRepository,
  UserRepository,
} from '../../domain/repositories.js';
import { checkIdentityClaims, checkIdentityHeaders } from '../identityClaims.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    auth: AuthContext | null;
  }
}

export function requireAuth(
  authentication: AuthenticationPort,
  users: UserRepository,
  rateLimiter?: RateLimiter,
  maxRequests = 100,
  windowMs = 60_000,
  maxInitDataBytes = 16_384,
): (request: FastifyRequest) => Promise<void> {
  return async (request: FastifyRequest): Promise<void> => {
    if (request.auth) return;
    if (
      rateLimiter &&
      !(await rateLimiter.consume(`auth:http:ip:${request.ip}`, maxRequests, windowMs))
    ) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
    }
    const authorization = request.headers.authorization;
    const legacy = request.headers['x-telegram-init-data'];
    const initData =
      authorization === undefined
        ? legacy
        : typeof authorization === 'string' && /^tma \S+$/.test(authorization)
          ? authorization.slice(4)
          : undefined;
    if (
      typeof initData !== 'string' ||
      !initData ||
      Buffer.byteLength(initData, 'utf8') > maxInitDataBytes ||
      (authorization !== undefined && legacy !== undefined && legacy !== initData)
    ) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    }
    let identity;
    try {
      identity = await authentication.authenticate(initData);
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.FORBIDDEN) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Access denied');
      }
      if (error instanceof AppError && error.code === ErrorCode.RATE_LIMITED) {
        throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
      }
      throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    }
    const user = await users.findById(identity.id);
    if (!user || user.telegramId !== BigInt(identity.telegramId)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    }
    if (rateLimiter && !(await rateLimiter.consume(`http:${user.id}`, maxRequests, windowMs))) {
      throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
    }
    request.user = user;
    request.auth = {
      userId: user.id,
      telegramId: identity.telegramId,
      role: user.role,
      status: user.status,
      authDate: identity.authDate,
      verifiedAt: identity.verifiedAt,
    };
    checkIdentityHeaders(request.headers, identity);
  };
}

export function requireActiveUser(): (request: FastifyRequest) => Promise<void> {
  return async (request): Promise<void> => {
    if (!request.user) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    if (request.user.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Access denied');
    }
  };
}

export function requireUser(
  ...args: Parameters<typeof requireAuth>
): (request: FastifyRequest) => Promise<void> {
  const authenticate = requireAuth(...args);
  const active = requireActiveUser();
  return async function (request) {
    await authenticate(request);
    await active(request);
  };
}

export function rejectIdentityClaims(request: FastifyRequest): void {
  if (!request.user) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
  const identity = {
    id: request.user.id,
    telegramId: request.user.telegramId.toString(),
    ...(request.user.username ? { username: request.user.username } : {}),
  };
  checkIdentityClaims(request.body, identity, true);
  checkIdentityClaims(request.query, identity, true, ErrorCode.FORBIDDEN);
}

export function requireRole(...roles: UserRole[]): (request: FastifyRequest) => Promise<void> {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.user) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    if (!roles.includes(request.user.role)) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Insufficient permissions');
    }
  };
}

type ResourceIdResolver = (request: FastifyRequest) => string | Promise<string>;

export function requireGameMembership(
  players: GamePlayerRepository,
  resolveGameId: ResourceIdResolver = (request) => gameParamsSchema.parse(request.params).gameId,
): (request: FastifyRequest) => Promise<void> {
  return async (request): Promise<void> => {
    if (!request.auth) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
    const gameId = await resolveGameId(request);
    if (!(await players.findByGameAndUser(gameId, request.auth.userId))) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Game membership required');
    }
  };
}

export function requireRoomMembership(
  games: GameRepository,
  players: GamePlayerRepository,
  resolveRoomId: ResourceIdResolver = (request) => roomParamsSchema.parse(request.params).roomId,
): (request: FastifyRequest) => Promise<void> {
  return requireGameMembership(players, async (request) => {
    const game = await games.findActiveByRoom(await resolveRoomId(request));
    if (!game) throw new AppError(ErrorCode.FORBIDDEN, 403, 'Room membership required');
    return game.id;
  });
}
