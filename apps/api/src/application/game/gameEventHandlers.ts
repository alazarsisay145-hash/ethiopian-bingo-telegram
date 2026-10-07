import { AppError, ErrorCode } from '@bingo/shared';
import type {
  ApplicationEventHandlers,
  EventContext,
  GameEventPublisher,
} from '../../domain/ports.js';
import type {
  GameEventRepository,
  GamePlayerRepository,
  GameRepository,
} from '../../domain/repositories.js';
import { GameStateProjector } from './gameStateProjector.js';
import { ClaimService } from './claimService.js';

export interface GameMembership {
  isMember(gameId: string, userId: string): Promise<boolean>;
}

export interface GameFenceProvider {
  current(gameId: string): Promise<{ instanceId: string; fencingToken: bigint }>;
}

export function createGameEventHandlers(options: {
  games: GameRepository;
  players: GamePlayerRepository;
  events: GameEventRepository;
  claims: ClaimService;
  projector: GameStateProjector;
  membership: GameMembership;
  fences: GameFenceProvider;
  publisher: GameEventPublisher;
}): ApplicationEventHandlers {
  const ensureMember = async (gameId: string, context: EventContext): Promise<void> => {
    if (!(await options.membership.isMember(gameId, context.user.id))) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, 'Game membership required');
    }
  };

  return {
    'game:ready': async () => {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room start service is not available');
    },
    'game:claim': async ({ gameId }, context) => {
      await ensureMember(gameId, context);
      const result = await options.claims.claim(
        { gameId, userId: context.user.id },
        await options.fences.current(gameId),
      );
      const players = await options.players.listByGame(gameId);
      await Promise.all(
        players.map(({ userId }) =>
          options.publisher.publishUser(userId, 'game:claim_result', result),
        ),
      );
    },
    'state:resync': async ({ gameId, lastSeq }, context) => {
      await ensureMember(gameId, context);
      const game = await options.games.findById(gameId);
      if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
      const ownCard = await options.players.findByGameAndUser(gameId, context.user.id);
      const projection = await options.projector.project(game);
      const payload = {
        game: {
          gameId,
          roomId: game.roomId,
          status: projection.status,
          seq: projection.seq,
          calledNumbers: projection.calledNumbers,
          ...(game.seedHash ? { seedHash: game.seedHash } : {}),
          ...(ownCard
            ? {
                yourCard: { cardNumber: ownCard.cardNumber, cells: ownCard.cardCells },
              }
            : {}),
          players: projection.players.map(({ userId, status }) => ({
            userId,
            status: status.toLowerCase(),
          })),
          winnerIds: projection.winnerIds,
        },
        seq: projection.seq,
      };
      if (lastSeq >= projection.seq || lastSeq < 0 || projection.seq - lastSeq > 100) {
        await options.publisher.publishUser(context.user.id, 'state:snapshot', payload);
        return;
      }
      const replay = await options.events.listSince(gameId, lastSeq, 100);
      if (replay.length !== projection.seq - lastSeq) {
        await options.publisher.publishUser(context.user.id, 'state:snapshot', payload);
        return;
      }
      if (
        replay.some(
          ({ type }) =>
            ![
              'GAME_STARTED',
              'NUMBER_CALLED',
              'CLAIM_ACCEPTED',
              'CLAIM_REJECTED',
              'GAME_ENDED',
            ].includes(type),
        )
      ) {
        await options.publisher.publishUser(context.user.id, 'state:snapshot', payload);
        return;
      }
      const before = await options.events.listSince(gameId, 0, 1000);
      let calledNumbers = before
        .filter((event) => event.type === 'NUMBER_CALLED' && event.seq <= lastSeq)
        .map((event) => (event.payload as { number: number }).number);
      for (const event of replay) {
        const eventData = event.payload as Record<string, unknown>;
        if (event.type === 'NUMBER_CALLED') {
          const number = eventData.number as number;
          calledNumbers = [...calledNumbers, number];
          await options.publisher.publishUser(context.user.id, 'game:number', {
            gameId,
            number,
            calledNumbers,
            seq: event.seq,
          });
        } else if (event.type === 'GAME_STARTED') {
          await options.publisher.publishUser(context.user.id, 'game:started', {
            gameId,
            roomId: game.roomId,
            seedHash: eventData.seedHash,
            drawIntervalMs: eventData.drawIntervalMs,
            seq: event.seq,
            ...(ownCard
              ? { yourCard: { cardNumber: ownCard.cardNumber, cells: ownCard.cardCells } }
              : {}),
          });
        } else if (event.type === 'GAME_ENDED') {
          await options.publisher.publishUser(context.user.id, 'game:ended', {
            gameId,
            winnerIds: eventData.winnerIds,
            seedRevealed: eventData.seedRevealed,
            drawSequence: eventData.drawSequence,
            seq: event.seq,
          });
        } else if (event.type === 'CLAIM_ACCEPTED' || event.type === 'CLAIM_REJECTED') {
          const userId = eventData.userId;
          const claimResult = {
            gameId,
            userId,
            accepted: event.type === 'CLAIM_ACCEPTED',
            patterns: eventData.patterns,
            seq: event.seq,
          };
          await options.publisher.publishUser(context.user.id, 'game:claim_result', claimResult);
        }
      }
    },
  };
}
