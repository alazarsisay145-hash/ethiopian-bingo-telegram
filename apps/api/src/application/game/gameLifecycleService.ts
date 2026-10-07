import { commitSeed, generateCard } from '@bingo/engine';
import { AppError, ErrorCode } from '@bingo/shared';
import type { Game, GamePlayer } from '../../domain/entities.js';
import type {
  GameFence,
  GameRepository,
  GameEventRepository,
  GamePlayerRepository,
  RoomRepository,
  UserRepository,
} from '../../domain/repositories.js';
import type { GameEventPublisher, GameLock, SeedVault, SecretSource } from '../../domain/ports.js';
import { projectGameState } from './state.js';

export class GameLifecycleService {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly games: GameRepository,
    private readonly players: GamePlayerRepository,
    private readonly users: UserRepository,
    private readonly events: GameEventRepository,
    private readonly secrets: SecretSource,
    private readonly vault: SeedVault,
    private readonly lock: GameLock,
    private readonly publisher?: GameEventPublisher,
  ) {}

  async createGame(roomId: string): Promise<Game> {
    const room = await this.rooms.findById(roomId);
    if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
    if (room.status !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE, 409, 'Room is closed');
    if (await this.games.findActiveByRoom(roomId)) {
      throw new AppError(ErrorCode.CONFLICT, 409, 'Room already has an active game');
    }
    return this.games.create({ roomId });
  }

  async joinGame(input: {
    gameId: string;
    userId: string;
    cardNumber: number;
  }): Promise<'reserved' | 'card_taken' | 'already_joined'> {
    return this.lock.runExclusive(`game:${input.gameId}:state`, async () => {
      const game = await this.requireGame(input.gameId);
      if (game.status !== 'LOBBY')
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Game is not waiting');
      const [room, user, cardPoolSeed] = await Promise.all([
        this.rooms.findById(game.roomId),
        this.users.findById(input.userId),
        this.rooms.getCardPoolSeed(game.roomId),
      ]);
      if (!room || cardPoolSeed === null)
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
      if (room.status !== 'OPEN')
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Room is closed');
      if (!user) throw new AppError(ErrorCode.NOT_FOUND, 404, 'User not found');
      if (user.status === 'BANNED')
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Banned users cannot join');
      if (
        !Number.isSafeInteger(input.cardNumber) ||
        input.cardNumber < 1 ||
        input.cardNumber > room.cardPoolSize
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          'Card number is outside this room’s pool',
        );
      }
      const existing = await this.players.findByGameAndUser(input.gameId, input.userId);
      if (!existing && (await this.players.listByGame(input.gameId)).length >= room.maxPlayers) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Game is full');
      }
      const result = await this.players.reserveCard({
        ...input,
        cardCells: generateCard(cardPoolSeed, input.cardNumber).cells,
      });
      return result.kind;
    });
  }

  async leaveGame(gameId: string, userId: string): Promise<void> {
    return this.lock.runExclusive(`game:${gameId}:state`, async () => {
      const game = await this.requireGame(gameId);
      if (game.status !== 'LOBBY')
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Players may only leave while waiting');
      const player = await this.players.findByGameAndUser(gameId, userId);
      if (!player) return;
      await this.players.remove(gameId, userId);
    });
  }

  async startGame(
    gameId: string,
    fence: GameFence,
  ): Promise<{ game: Game; players: GamePlayer[] }> {
    return this.lock.runExclusive(`game:${gameId}:state`, async () => {
      const game = await this.requireGame(gameId);
      if (game.status !== 'LOBBY' && game.status !== 'STARTING')
        throw new AppError(ErrorCode.CONFLICT, 409, 'Game has already started');
      const room = await this.rooms.findById(game.roomId);
      if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
      const players = await this.players.listByGame(gameId);
      if (players.length < room.minPlayers) {
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Not enough players to start');
      }

      if (game.status === 'LOBBY') await this.games.updateStatus(gameId, 'STARTING', fence);
      const secretBytes = this.secrets.bytes(32);
      if (secretBytes.length !== 32) {
        throw new AppError(
          ErrorCode.INTERNAL,
          500,
          'Secret source returned an invalid seed length',
        );
      }
      const seed = Buffer.from(secretBytes).toString('base64url');
      const seedHash = commitSeed(seed);
      await this.games.setSeedCommitment(gameId, {
        seedHash,
        seedEncrypted: await this.vault.seal(seed),
      });
      const active = await this.games.updateStatus(gameId, 'RUNNING', fence);
      const startedEvent = await this.events.append({
        gameId,
        type: 'GAME_STARTED',
        payload: {
          seedHash,
          playerCount: players.length,
          drawIntervalMs: room.drawIntervalMs,
          activePatterns: room.activePatterns,
        },
        fence,
        expectedStatus: 'RUNNING',
      });
      if (this.publisher) {
        await Promise.all(
          players.map(({ userId, cardNumber, cardCells }) =>
            this.publisher!.publishUser(userId, 'game:started', {
              gameId,
              roomId: game.roomId,
              seedHash,
              yourCard: { cardNumber, cells: cardCells },
              drawIntervalMs: room.drawIntervalMs,
              seq: startedEvent.seq,
            }),
          ),
        );
      }
      return { game: { ...active, currentSeq: startedEvent.seq }, players };
    });
  }

  async cancelGame(gameId: string, reason: string, fence: GameFence): Promise<void> {
    return this.lock.runExclusive(`game:${gameId}:state`, async () => {
      const game = await this.requireGame(gameId);
      if (!['LOBBY', 'STARTING', 'RUNNING'].includes(game.status)) {
        throw new AppError(ErrorCode.INVALID_STATE, 409, `Cannot cancel a ${game.status} game`);
      }
      await this.games.updateStatus(gameId, 'CANCELLED', fence);
      const event = await this.events.append({
        gameId,
        type: 'GAME_CANCELLED',
        payload: { reason: reason.slice(0, 500) },
        fence,
        expectedStatus: 'CANCELLED',
      });
      if (this.publisher) {
        const [allEvents, players] = await Promise.all([
          this.events.listSince(gameId, 0, 1000),
          this.players.listByGame(gameId),
        ]);
        const state = projectGameState({
          gameId,
          roomId: game.roomId,
          events: allEvents,
          players: players.map(({ userId, status }) => ({ userId, status })),
        });
        state.seq = event.seq;
        await Promise.all(
          players.map(({ userId, cardNumber, cardCells }) =>
            this.publisher!.publishUser(userId, 'state:snapshot', {
              game: {
                gameId: state.gameId,
                roomId: state.roomId,
                status: state.status,
                seq: state.seq,
                calledNumbers: state.calledNumbers,
                winnerIds: state.winnerIds,
                ...(game.seedHash ? { seedHash: game.seedHash } : {}),
                yourCard: { cardNumber, cells: cardCells },
                players: state.players.map((player) => ({
                  userId: player.userId,
                  status: player.status.toLowerCase(),
                })),
              },
              seq: event.seq,
            }),
          ),
        );
      }
    });
  }

  private async requireGame(gameId: string): Promise<Game> {
    const game = await this.games.findById(gameId);
    if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
    return game;
  }
}
