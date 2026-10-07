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
        const decoded = JSON.parse(message) as { userId: string; event: string; payload: unknown };
        if (typeof decoded.userId !== 'string' || typeof decoded.event !== 'string') return;
        this.emitLocal(decoded.userId, decoded.event, decoded.payload);
      } catch {
        return;
      }
    });
    this.subscription = this.subscriber.psubscribe('game:*');
  }

  async publishUser(userId: string, event: string, payload: unknown): Promise<void> {
    const value =
      typeof payload === 'object' && payload !== null
        ? (payload as { gameId?: unknown; game?: { gameId?: unknown } })
        : {};
    const gameId = typeof value.gameId === 'string' ? value.gameId : value.game?.gameId;
    if (typeof gameId !== 'string') throw new Error('Game event payload is missing gameId');
    await this.subscription;
    await this.publisher.publish(`game:{${gameId}}`, JSON.stringify({ userId, event, payload }));
  }

  async close(): Promise<void> {
    await this.subscriber.punsubscribe('game:*');
    this.subscriber.removeAllListeners('pmessage');
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  private emitLocal(userId: string, event: string, payload: unknown): void {
    if (!Object.prototype.hasOwnProperty.call(serverPayloadSchemas, event)) return;
    const parsed = serverPayloadSchemas[event as ServerEvent].safeParse(payload);
    if (!parsed.success) return;
    this.io.to(`user:${userId}`).emit(event as ServerEvent, parsed.data as never);
  }
}
