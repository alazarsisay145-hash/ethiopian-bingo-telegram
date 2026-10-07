import { describe, expect, it, vi } from 'vitest';
import type { BingoSocketServer } from '../../interfaces/ws/socket.js';
import type { RedisClient } from '../redis/client.js';
import { SocketIoGameEventPublisher } from './socketIoGameEventPublisher.js';

describe('SocketIoGameEventPublisher', () => {
  it('publishes on the game channel and delivers only to the target user room', async () => {
    let onMessage: ((pattern: string, channel: string, message: string) => void) | undefined;
    const localEmit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit: localEmit })),
    } as unknown as BingoSocketServer;
    const publisher = {
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => 'OK'),
    } as unknown as RedisClient;
    const subscriber = {
      psubscribe: vi.fn(async () => 1),
      on: vi.fn((_event: string, callback: typeof onMessage) => {
        onMessage = callback;
      }),
      punsubscribe: vi.fn(async () => 1),
      removeAllListeners: vi.fn(),
      quit: vi.fn(async () => 'OK'),
    } as unknown as RedisClient;
    const events = new SocketIoGameEventPublisher(io, publisher, subscriber);
    const payload = { gameId: 'game-1', number: 12, calledNumbers: [12], seq: 2 };

    await events.publishUser('user-1', 'game:number', payload);
    expect(publisher.publish).toHaveBeenCalledWith(
      'game:{game-1}',
      JSON.stringify({ userId: 'user-1', event: 'game:number', payload }),
    );

    onMessage?.(
      'game:*',
      'game:{game-1}',
      JSON.stringify({ userId: 'user-1', event: 'game:number', payload }),
    );
    expect(io.to).toHaveBeenCalledWith('user:user-1');
    expect(localEmit).toHaveBeenCalledWith('game:number', payload);
    await events.close();
    expect(publisher.quit).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
  });
});
