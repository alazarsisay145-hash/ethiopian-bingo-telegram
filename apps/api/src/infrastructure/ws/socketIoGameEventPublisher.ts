import { serverPayloadSchemas, type ServerToClientEvents } from '@bingo/shared';
import type { GameEventPublisher } from '../../domain/ports.js';
import type { BingoSocketServer } from '../../interfaces/ws/socket.js';
import type { RedisClient } from '../redis/client.js';

type ServerEvent = keyof ServerToClientEvents;

export class SocketIoGameEventPublisher implements GameEventPublisher {
  private readonly subscription: Promise<unknown>;

  constructor(
    private readonly io: BingoSocketServer,
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
  ) {
    this.subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) => {
      try {
        const decoded = JSON.parse(message) as {
          userId?: string;
          roomId?: string;
          event: string;
          payload: unknown;
        };
        if (typeof decoded.event !== 'string') return;
        if (typeof decoded.userId === 'string') this.emitLocal(`user:${decoded.userId}`, decoded.event, decoded.payload);
        else if (typeof decoded.roomId === 'string') this.emitLocal(`room:${decoded.roomId}`, decoded.event, decoded.payload);
      } catch {
        return;
      }
    });
    this.subscription = this.subscriber.psubscribe('game:*', 'room:*', 'user:*');
  }

  async publishUser(userId: string, event: string, payload: unknown): Promise<void> {
    const value =
      typeof payload === 'object' && payload !== null
        ? (payload as { gameId?: unknown; game?: { gameId?: unknown } })
        : {};
    await this.subscription;
    const gameId = typeof value.gameId === 'string' ? value.gameId : value.game?.gameId;
    const channel = typeof gameId === 'string' ? `game:{${gameId}}` : `user:${userId}`;
    await this.publisher.publish(channel, JSON.stringify({ userId, event, payload }));
  }

  async publishRoom(roomId: string, event: string, payload: unknown): Promise<void> {
    await this.subscription;
    await this.publisher.publish(`room:${roomId}`, JSON.stringify({ roomId, event, payload }));
  }

  async close(): Promise<void> {
    await this.subscriber.punsubscribe('game:*', 'room:*', 'user:*');
    this.subscriber.removeAllListeners('pmessage');
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  private emitLocal(channel: string, event: string, payload: unknown): void {
    if (!Object.prototype.hasOwnProperty.call(serverPayloadSchemas, event)) return;
    const parsed = serverPayloadSchemas[event as ServerEvent].safeParse(payload);
    if (!parsed.success) return;
    this.io.to(channel).emit(event as ServerEvent, parsed.data as never);
  }
}
