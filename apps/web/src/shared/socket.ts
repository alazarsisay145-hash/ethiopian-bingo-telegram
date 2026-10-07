import {
  clientPayloadSchemas,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@bingo/shared';
import { io, type Socket } from 'socket.io-client';
import type { z } from 'zod';
import { logger } from './logger';
import type { SessionStore, ServerEvent } from './store';

export type BingoSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ClientSchemas = typeof clientPayloadSchemas;
export type Command = keyof ClientSchemas;
export type CommandPayload<K extends Command> = z.infer<ClientSchemas[K]>;

export function createBingoSocket(
  url: string,
  initData: string,
  session: SessionStore,
): BingoSocket {
  if (!initData) throw new Error('Telegram authentication is required');
  const socket: BingoSocket = io(url, {
    autoConnect: false,
    auth: { initData },
    transports: ['websocket'],
  });
  const pendingResyncs = new Set<string>();
  const requestResync = (gameId: string, lastSeq: number) => {
    if (pendingResyncs.has(gameId)) return;
    pendingResyncs.add(gameId);
    socket.emit('state:resync', { gameId, lastSeq });
  };
  const receive = (event: ServerEvent, payload: unknown) => {
    const accepted = session.ingest(event, payload);
    if (!accepted) logger.error('invalid-server-event');
    const state = session.store.getState();
    if (event === 'state:snapshot' && accepted && state.game)
      pendingResyncs.delete(state.game.gameId);
    for (const [key, syncing] of Object.entries(state.syncing)) {
      if (syncing && key.startsWith('game:')) {
        requestResync(key.slice(5), state.sequences[key] ?? 0);
      }
    }
  };
  socket.on('room:state', (payload) => receive('room:state', payload));
  socket.on('game:started', (payload) => receive('game:started', payload));
  socket.on('game:number', (payload) => receive('game:number', payload));
  socket.on('game:claim_result', (payload) => receive('game:claim_result', payload));
  socket.on('game:ended', (payload) => receive('game:ended', payload));
  socket.on('wallet:update', (payload) => receive('wallet:update', payload));
  socket.on('state:snapshot', (payload) => receive('state:snapshot', payload));
  socket.on('error', (payload) => receive('error', payload));
  socket.on('connect_error', () => logger.error('connection-failed'));
  socket.on('connect', () => {
    pendingResyncs.clear();
    const state = session.store.getState();
    for (const [key, syncing] of Object.entries(state.syncing)) {
      if (syncing && key.startsWith('game:'))
        requestResync(key.slice(5), state.sequences[key] ?? 0);
    }
    const game = state.game;
    if (game && !state.syncing[`game:${game.gameId}`]) {
      socket.emit('state:resync', { gameId: game.gameId, lastSeq: game.seq });
    }
  });
  return socket;
}

export function sendCommand<K extends Command>(
  socket: BingoSocket,
  command: K,
  payload: CommandPayload<K>,
): void {
  const parsed = clientPayloadSchemas[command].parse(payload);
  switch (command) {
    case 'room:join':
      socket.emit('room:join', parsed as CommandPayload<'room:join'>);
      break;
    case 'room:leave':
      socket.emit('room:leave', parsed as CommandPayload<'room:leave'>);
      break;
    case 'card:select':
      socket.emit('card:select', parsed as CommandPayload<'card:select'>);
      break;
    case 'card:release':
      socket.emit('card:release', parsed as CommandPayload<'card:release'>);
      break;
    case 'game:ready':
      socket.emit('game:ready', parsed as CommandPayload<'game:ready'>);
      break;
    case 'game:claim':
      socket.emit('game:claim', parsed as CommandPayload<'game:claim'>);
      break;
    case 'state:resync':
      socket.emit('state:resync', parsed as CommandPayload<'state:resync'>);
      break;
  }
}
