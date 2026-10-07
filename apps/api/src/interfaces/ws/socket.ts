import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, clientPayloadSchemas, userProfileSchema } from '@bingo/shared';
import type { ClientToServerEvents, ServerToClientEvents } from '@bingo/shared';
import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import type {
  ApplicationEventHandlers, AuthenticationPort, ClientEvent,
  ClientPayload, EventContext, UserProfile,
} from '../../domain/ports.js';
import type { RateLimiter } from '../../domain/ports.js';
import { mapError, validate } from '../http/errors.js';

interface SocketData { user: UserProfile }
export type BingoSocketServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type BingoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Ack = (result: { ok: true } | { ok: false; error: ReturnType<typeof mapError>['body']['error'] }) => void;

export function attachSocketServer(
  server: HttpServer,
  options: {
    authentication: AuthenticationPort;
    handlers: ApplicationEventHandlers | ((io: BingoSocketServer) => ApplicationEventHandlers);
    origins: string[];
    logger: Pick<Logger, 'error'>;
    restoreRooms?: (userId: string) => Promise<string[]>;
    rateLimiter?: RateLimiter;
    rateLimitWindowMs?: number;
  },
): BingoSocketServer {
  const io: BingoSocketServer = new Server(server, {
    cors: { origin: options.origins, credentials: false },
    maxHttpBufferSize: 16 * 1024,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, origin === undefined || options.origins.includes(origin));
    },
  });
  const handlers = typeof options.handlers === 'function' ? options.handlers(io) : options.handlers;
  io.use((socket, next) => {
    const authenticate = async (): Promise<void> => {
      const auth: unknown = socket.handshake.auth;
      if (typeof auth !== 'object' || auth === null || !('initData' in auth) ||
          typeof auth.initData !== 'string' || !auth.initData || auth.initData.length > 16384) {
        throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required');
      }
      socket.data.user = userProfileSchema.parse(await options.authentication.authenticate(auth.initData));
    };
    void authenticate().then(() => next()).catch(() => {
      const error = new Error('UNAUTHORIZED') as Error & { data: { code: ErrorCode } };
      error.data = { code: ErrorCode.UNAUTHORIZED };
      next(error);
    });
  });
  io.on('connection', (socket: BingoSocket) => {
    void socket.join(`user:${socket.data.user.id}`);
    if (options.restoreRooms) {
      void options.restoreRooms(socket.data.user.id)
        .then((rooms) => Promise.all(rooms.map((room) => socket.join(room))))
        .catch(() => options.logger.error({ userId: socket.data.user.id }, 'Socket room restore failed'));
    }
    // Transport arguments are untrusted even when the shared client interface is typed.
    const transport = socket as Socket;
    const execute = async (event: ClientEvent, payload: unknown, acknowledge: unknown): Promise<void> => {
      const requestId = randomUUID();
      const ack: Ack | undefined = typeof acknowledge === 'function' ? acknowledge as Ack : undefined;
      try {
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
        const parsed = validate(clientPayloadSchemas[event], payload);
        const handler = handlers[event] as
          ((input: ClientPayload<ClientEvent>, context: EventContext) => Promise<void>) | undefined;
        if (!handler) throw new AppError(ErrorCode.NOT_FOUND, 404, `Unsupported event: ${event}`);
        await handler(parsed, {
          user: socket.data.user,
          socketId: socket.id,
          requestId,
          joinRoom: async (room) => { await socket.join(room); },
          leaveRoom: async (room) => { await socket.leave(room); },
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
      transport.on(event, (payload: unknown, ack: unknown) => { void execute(event, payload, ack); });
    }
    transport.onAny((event: string, ...args: unknown[]) => {
      if (Object.prototype.hasOwnProperty.call(clientPayloadSchemas, event)) return;
      const error = mapError(new AppError(ErrorCode.NOT_FOUND, 404, `Unsupported event: ${event}`), randomUUID());
      const ack = args.at(-1);
      if (typeof ack === 'function') (ack as Ack)({ ok: false, error: error.body.error });
      else transport.emit('error', error.body);
    });
  });
  return io;
}
