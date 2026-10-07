import { AppError, ErrorCode } from '@bingo/shared';
import type { Game, GameEvent } from '../../domain/entities.js';
import type { GameEventRepository, GamePlayerRepository } from '../../domain/repositories.js';
import { projectGameState, type GameState } from './state.js';

export class GameStateProjector {
  constructor(
    private readonly events: GameEventRepository,
    private readonly players: GamePlayerRepository,
  ) {}

  async project(game: Game): Promise<GameState> {
    const latestSeq = await this.events.latestSeq(game.id);
    const allEvents: GameEvent[] = [];
    let cursor = 0;
    while (cursor < latestSeq) {
      const page = await this.events.listSince(game.id, cursor, 1000);
      if (!page.length || page[0]?.seq !== cursor + 1) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Game event stream is incomplete');
      }
      allEvents.push(...page);
      cursor = page.at(-1)?.seq ?? cursor;
    }
    const players = await this.players.listByGame(game.id);
    const playerStates = players.map(({ userId }) => ({ userId, status: 'ACTIVE' as const }));
    const state = projectGameState({
      gameId: game.id,
      roomId: game.roomId,
      events: allEvents,
      players: playerStates,
    });
    if (allEvents.length === 0) {
      state.seq = latestSeq;
      state.status =
        game.status === 'LOBBY'
          ? 'waiting'
          : game.status === 'STARTING'
            ? 'starting'
            : game.status === 'RUNNING' || game.status === 'SETTLING'
              ? 'active'
              : game.status === 'ENDED'
                ? 'finished'
                : 'cancelled';
    }
    if (game.status === 'LOBBY' && game.startingAt) state.status = 'starting';
    return state;
  }
}
