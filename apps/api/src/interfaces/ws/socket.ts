import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, clientPayloadSchemas, userProfileSchema } from '@bingo/shared';
import type { ClientToServerEvents, ServerToClientEvents } from '@bingo/shared';
import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import type {
  ApplicationEventHandlers,
  AuthenticationPort,
  ClientEvent,
  ClientPayload,
  EventContext,
  UserProfile,
} from '../../domain/ports.js';
import type { AuthContext } from '../../domain/entities.js';
import type { RateLimiter } from '../../domain/ports.js';
import { mapError, validate } from '../http/errors.js';
import { checkIdentityClaims, checkIdentityHeaders } from '../identityClaims.js';

interface SocketData {
  user: UserProfile & AuthContext;
  auth: AuthContext;
}
export type BingoSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type BingoSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type Ack = (
  result: { ok: true } | { ok: false; error: ReturnType<typeof mapError>['body']['error'] },
) => void;

export function attachSocketServer(
  server: HttpServer,
  options: {
    authentication: AuthenticationPort;
    handlers: ApplicationEventHandlers | ((io: BingoSocketServer) => ApplicationEventHandlers);
    origins: string[];
    logger: Pick<Logger, 'error'>;
    restoreRooms?: (userId: string) => Promise<string[]>;
    authorizeUser?: (userId: string) => Promise<void>;
    rateLimiter?: RateLimiter;
    rateLimitWindowMs?: number;
    authRateLimitMax?: number;
    authRateLimitWindowMs?: number;
    initDataMaxBytes?: number;
  },
): BingoSocketServer {
  const io: BingoSocketServer = new Server(server, {
    cors: { origin: options.origins, credentials: false },
    maxHttpBufferSize: Math.max(16 * 1024, (options.initDataMaxBytes ?? 16_384) + 4096),
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, origin === undefined || options.origins.includes(origin));
    },
  });
  const handlers = typeof options.handlers === 'function' ? options.handlers(io) : options.handlers;
  io.use((socket, next) => {
    const authenticate = async (): Promise<void> => {
      if (
        options.rateLimiter &&
        !(await options.rateLimiter.consume(
          `auth:ws:ip:${socket.handshake.address}`,
          options.authRateLimitMax ?? 100,
          options.authRateLimitWindowMs ?? 60_000,
        ))
      ) {
        throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
      }
      const auth: unknown = socket.handshake.auth;
      if (
        typeof auth !== 'object' ||
        auth === null ||
        !('initData' in auth) ||
        typeof auth.initData !== 'string' ||
        !auth.initData ||
        Buffer.byteLength(auth.initData, 'utf8') > (options.initDataMaxBytes ?? 16_384)
      ) {
        throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
      }
      const verified = await options.authentication.authenticate(auth.initData);
      socket.data.user = {
        ...verified,
        ...userProfileSchema.parse({
          id: verified.id,
          telegramId: verified.telegramId,
          firstName: verified.firstName,
          ...(verified.username ? { username: verified.username } : {}),
        }),
      };
      const user = socket.data.user;
      if (
        options.rateLimiter &&
        !(await options.rateLimiter.consume(
          `auth:ws:user:${user.id}`,
          options.authRateLimitMax ?? 100,
          options.authRateLimitWindowMs ?? 60_000,
        ))
      ) {
        throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
      }
      checkIdentityClaims(auth, socket.data.user, false, ErrorCode.FORBIDDEN);
      checkIdentityClaims(socket.handshake.query, socket.data.user, false, ErrorCode.FORBIDDEN);
      checkIdentityHeaders(socket.handshake.headers, socket.data.user);
      if (user.status !== 'ACTIVE') throw new AppError(ErrorCode.FORBIDDEN, 403, 'Access denied');
      socket.data.auth = {
        userId: user.id,
        telegramId: user.telegramId,
        role: user.role,
        status: user.status,
        authDate: user.authDate,
        verifiedAt: user.verifiedAt,
      };
      await options.authorizeUser?.(user.id);
      if (options.restoreRooms) {
        const rooms = await options.restoreRooms(user.id);
        await Promise.all(rooms.map((room) => socket.join(room)));
      }
    };
    void authenticate()
      .then(() => next())
      .catch((failure: unknown) => {
        const code =
          failure instanceof AppError &&
          [ErrorCode.FORBIDDEN, ErrorCode.RATE_LIMITED, ErrorCode.VALIDATION_ERROR].includes(
            failure.code,
          )
            ? failure.code
            : ErrorCode.UNAUTHORIZED;
        const error = new Error(code) as Error & { data: { code: ErrorCode } };
        error.data = { code };
        next(error);
      });
  });
  io.on('connection', (socket: BingoSocket) => {
    void socket.join(`user:${socket.data.user.id}`);
    // Transport arguments are untrusted even when the shared client interface is typed.
    const transport = socket as Socket;
    const execute = async (
      event: ClientEvent,
      payload: unknown,
      acknowledge: unknown,
    ): Promise<void> => {
      const requestId = randomUUID();
      const ack: Ack | undefined =
        typeof acknowledge === 'function' ? (acknowledge as Ack) : undefined;
      try {
        await options.authorizeUser?.(socket.data.user.id);
        const limits: Partial<Record<ClientEvent, number>> = {
          'game:claim': 5,
          'card:select': 10,
          'state:resync': 10,
          'room:join': 30,
          'room:leave': 30,
          'card:release': 10,
          'game:ready': 10,
        };
        const maximum = limits[event];
        if (
          maximum &&
          options.rateLimiter &&
          !(await options.rateLimiter.consume(
            `ws:${socket.data.user.id}:${event}`,
            maximum,
            options.rateLimitWindowMs ?? 10_000,
          ))
        ) {
          throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
        }
        checkIdentityClaims(payload, socket.data.user, false, ErrorCode.FORBIDDEN);
        const parsed = validate(clientPayloadSchemas[event], payload);
        const handler = handlers[event] as
          | ((input: ClientPayload<ClientEvent>, context: EventContext) => Promise<void>)
          | undefined;
        if (!handler) throw new AppError(ErrorCode.NOT_FOUND, 404, `Unsupported event: ${event}`);
        await handler(parsed, {
          user: socket.data.user,
          auth: socket.data.auth,
          socketId: socket.id,
          requestId,
          joinRoom: async (room) => {
            await socket.join(room);
          },
          leaveRoom: async (room) => {
            await socket.leave(room);
          },
        });
        ack?.({ ok: true });
      } catch (error) {
        const mapped = mapError(error, requestId);
        if (mapped.status === 500) options.logger.error({ requestId }, 'Socket handler failed');
        if (ack) ack({ ok: false, error: mapped.body.error });
        else transport.emit('error', mapped.body);
      }
    };
    for (const event of Object.keys(clientPayloadSchemas) as ClientEvent[]) {
      transport.on(event, (payload: unknown, ack: unknown) => {
        void execute(event, payload, ack);
      });
    }
    transport.onAny((event: string, ...args: unknown[]) => {
      if (Object.prototype.hasOwnProperty.call(clientPayloadSchemas, event)) return;
      const rejectUnsupported = async (): Promise<void> => {
        const requestId = randomUUID();
        try {
          await options.authorizeUser?.(socket.data.auth.userId);
          if (
            options.rateLimiter &&
            !(await options.rateLimiter.consume(
              `ws:${socket.data.auth.userId}:unsupported`,
              30,
              options.rateLimitWindowMs ?? 10_000,
            ))
          ) {
            throw new AppError(ErrorCode.RATE_LIMITED, 429, 'Too many requests');
          }
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Unsupported event');
        } catch (failure) {
          const error = mapError(failure, requestId);
          if (error.status === 500) options.logger.error({ requestId }, 'Socket handler failed');
          const ack = args.at(-1);
          if (typeof ack === 'function') (ack as Ack)({ ok: false, error: error.body.error });
          else transport.emit('error', error.body);
        }
      };
      void rejectUnsupported();
    });
  });
  return io;
}
