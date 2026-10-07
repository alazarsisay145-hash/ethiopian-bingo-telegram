import { AppError, ErrorCode } from '@bingo/shared';
import type {
  GameFenceProvider,
  GameMembership,
} from '../../application/game/gameEventHandlers.js';
import type { GamePlayerRepository, GameRepository } from '../../domain/repositories.js';

export class RepositoryGameMembership implements GameMembership {
  constructor(private readonly players: GamePlayerRepository) {}

  async isMember(gameId: string, userId: string): Promise<boolean> {
    return (await this.players.findByGameAndUser(gameId, userId)) !== null;
  }
}

export class RepositoryGameFenceProvider implements GameFenceProvider {
  constructor(private readonly games: GameRepository) {}

  async current(gameId: string): Promise<{ instanceId: string; fencingToken: bigint }> {
    const game = await this.games.findById(gameId);
    if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
    if (!game.ownerInstanceId || game.fencingToken < 1n) {
      throw new AppError(ErrorCode.CONFLICT, 409, 'Game has no active owner');
    }
    return { instanceId: game.ownerInstanceId, fencingToken: game.fencingToken };
  }
}
