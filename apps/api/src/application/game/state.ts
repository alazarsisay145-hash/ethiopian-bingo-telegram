import type { GameEvent, GamePlayerStatus } from '../../domain/entities.js';

export type ProductGameStatus = 'waiting' | 'starting' | 'active' | 'finished' | 'cancelled';

export interface ProjectedPlayer {
  userId: string;
  status: GamePlayerStatus;
}

export interface GameState {
  gameId: string;
  roomId: string;
  status: ProductGameStatus;
  calledNumbers: number[];
  lastNumber: number | null;
  seq: number;
  players: ProjectedPlayer[];
  winnerIds: string[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function projectGameState(input: {
  gameId: string;
  roomId: string;
  events: readonly GameEvent[];
  players: readonly ProjectedPlayer[];
}): GameState {
  let status: ProductGameStatus = 'waiting';
  let winnerIds: string[] = [];
  const calledNumbers: number[] = [];
  let seq = 0;
  const playerStates = new Map<string, GamePlayerStatus>(
    input.players.map(({ userId }) => [userId, 'ACTIVE']),
  );

  for (const event of input.events) {
    seq = Math.max(seq, event.seq);
    const payload = record(event.payload);
    switch (event.type) {
      case 'GAME_STARTED':
        status = 'active';
        break;
      case 'NUMBER_CALLED':
        if (typeof payload.number === 'number') calledNumbers.push(payload.number);
        break;
      case 'GAME_ENDED':
        status = 'finished';
        winnerIds = Array.isArray(payload.winnerIds)
          ? payload.winnerIds.filter((id): id is string => typeof id === 'string')
          : [];
        winnerIds.forEach((userId) => playerStates.set(userId, 'WINNER'));
        break;
      case 'CLAIM_REJECTED':
        if (typeof payload.userId === 'string') playerStates.set(payload.userId, 'DISQUALIFIED');
        break;
      case 'GAME_CANCELLED':
        status = 'cancelled';
        break;
      default:
        break;
    }
  }

  return {
    gameId: input.gameId,
    roomId: input.roomId,
    status,
    calledNumbers,
    lastNumber: calledNumbers.at(-1) ?? null,
    seq,
    players: [...playerStates].map(([userId, playerStatus]) => ({ userId, status: playerStatus })),
    winnerIds,
  };
}
