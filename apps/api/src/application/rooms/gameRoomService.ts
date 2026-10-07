import { generateCard } from '@bingo/engine';
import { AppError, ErrorCode } from '@bingo/shared';
import type { Game, GamePlayer, Room } from '../../domain/entities.js';
import type { GameEventPublisher, UnitOfWork } from '../../domain/ports.js';
import type {
  AuditLogRepository,
  GameEventRepository,
  GamePlayerRepository,
  GameRepository,
  LedgerRepository,
  RoomRepository,
  UserRepository,
} from '../../domain/repositories.js';
import type { GameLifecycleService } from '../game/gameLifecycleService.js';
import { GameStateProjector } from '../game/gameStateProjector.js';

export class GameRoomService {
  private readonly projector: GameStateProjector;

  constructor(
    private readonly rooms: RoomRepository,
    private readonly games: GameRepository,
    private readonly players: GamePlayerRepository,
    private readonly users: UserRepository,
    private readonly events: GameEventRepository,
    private readonly ledger: LedgerRepository,
    private readonly auditLogs: AuditLogRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly lifecycle: Pick<GameLifecycleService, 'createGame'>,
    private readonly publisher?: GameEventPublisher,
    private readonly maxActiveGamesPerUser = 3,
  ) {
    this.projector = new GameStateProjector(events, players);
  }

  async getOrCreateWaitingGame(roomId: string): Promise<Game> {
    const room = await this.rooms.findById(roomId);
    if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
    if (room.status !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE, 409, 'Room is closed');
    const current = await this.games.findActiveByRoom(roomId);
    if (current) {
      if (current.status === 'LOBBY' || current.status === 'STARTING') return current;
      throw new AppError(ErrorCode.CONFLICT, 409, 'Room already has a game in progress');
    }
    try {
      return await this.lifecycle.createGame(roomId);
    } catch (error) {
      const raced = await this.games.findActiveByRoom(roomId);
      if (raced?.status === 'LOBBY') return raced;
      throw error;
    }
  }

  async joinGame(input: {
    gameId: string;
    userId: string;
    cardNumber: number;
    requestId?: string;
  }): Promise<GamePlayer> {
    const joined = await this.unitOfWork.withTransaction(async (repositories) => {
      const game = await repositories.games.lockForUpdate(input.gameId);
      if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
      if (game.status !== 'LOBBY' && game.status !== 'STARTING') {
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Game is not waiting');
      }
      const [room, user, existing, currentPlayers, seed] = await Promise.all([
        repositories.rooms.findById(game.roomId),
        repositories.users.lockForUpdate(input.userId),
        repositories.gamePlayers.findByGameAndUser(input.gameId, input.userId),
        repositories.gamePlayers.listByGame(input.gameId),
        repositories.rooms.getCardPoolSeed(game.roomId),
      ]);
      if (!room || seed === null) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
      if (room.status !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE, 409, 'Room is closed');
      if (!user) throw new AppError(ErrorCode.NOT_FOUND, 404, 'User not found');
      if (user.status !== 'ACTIVE') throw new AppError(ErrorCode.FORBIDDEN, 403, 'Inactive users cannot join');
      if (existing) throw new AppError(ErrorCode.CONFLICT, 409, 'Already joined this game');
      const activeMemberships = await repositories.gamePlayers.listByUser(input.userId);
      if (activeMemberships.length >= this.maxActiveGamesPerUser) {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Active game limit reached');
      }
      if (currentPlayers.length >= room.maxPlayers) throw new AppError(ErrorCode.CONFLICT, 409, 'Game is full');
      if (!Number.isSafeInteger(input.cardNumber) || input.cardNumber < 1 || input.cardNumber > room.cardPoolSize) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Card number is outside this room’s pool');
      }
      const cardCells = generateCard(seed, input.cardNumber).cells;
      const reserved = await repositories.gamePlayers.reserveCard({
        gameId: game.id,
        userId: user.id,
        cardNumber: input.cardNumber,
        cardCells,
      });
      if (reserved.kind !== 'reserved') {
        throw new AppError(
          reserved.kind === 'card_taken' ? ErrorCode.CARD_TAKEN : ErrorCode.CONFLICT,
          409,
          reserved.kind === 'card_taken' ? 'Card is already taken' : 'Already joined this game',
        );
      }
      if (room.stakeMinor > 0n) {
        await repositories.ledger.apply({
          userId: user.id,
          type: 'STAKE',
          amountMinor: -room.stakeMinor,
          refType: 'game',
          refId: game.id,
          idempotencyKey: `game:${game.id}:stake:${user.id}`,
        });
      }
      await repositories.games.adjustPotMinor(game.id, room.stakeMinor);
      await repositories.gameEvents.append({
        gameId: game.id,
        type: 'PLAYER_JOINED',
        payload: { userId: user.id },
      });
      await repositories.auditLogs.record({
        action: 'STAKE_APPLIED',
        targetType: 'game',
        targetId: game.id,
        requestId: input.requestId,
        after: { userId: user.id, amountMinor: room.stakeMinor.toString() },
      });
      return reserved.player;
    });
    await this.notifyRoom(input.gameId);
    await this.notifyWallet(input.userId);
    return joined;
  }

  async leaveGame(gameId: string, userId: string, requestId?: string): Promise<void> {
    await this.unitOfWork.withTransaction(async (repositories) => {
      const game = await repositories.games.lockForUpdate(gameId);
      if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
      if (game.status !== 'LOBBY' && game.status !== 'STARTING') {
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Players may only leave while waiting');
      }
      const player = await repositories.gamePlayers.findByGameAndUser(gameId, userId);
      if (!player) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game membership not found');
      const room = await repositories.rooms.findById(game.roomId);
      if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
      if (room.stakeMinor > 0n) {
        await repositories.ledger.apply({
          userId,
          type: 'REFUND',
          amountMinor: room.stakeMinor,
          refType: 'game',
          refId: game.id,
          idempotencyKey: `game:${game.id}:refund:${userId}`,
        });
      }
      await repositories.gamePlayers.remove(gameId, userId);
      await repositories.games.adjustPotMinor(gameId, -room.stakeMinor);
      await repositories.gameEvents.append({
        gameId,
        type: 'PLAYER_LEFT',
        payload: { userId },
      });
      await repositories.auditLogs.record({
        action: 'STAKE_REFUNDED',
        targetType: 'game',
        targetId: gameId,
        requestId,
        after: { userId, amountMinor: room.stakeMinor.toString() },
      });
    });
    await this.notifyRoom(gameId);
    await this.notifyWallet(userId);
  }

  async cancelGame(gameId: string, reason: string, requestId?: string): Promise<void> {
    const cancelled = await this.unitOfWork.withTransaction(async (repositories) => {
      const game = await repositories.games.lockForUpdate(gameId);
      if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
      if (game.status === 'CANCELLED') return false;
      if (!['LOBBY', 'STARTING', 'RUNNING'].includes(game.status)) {
        throw new AppError(ErrorCode.INVALID_STATE, 409, `Cannot cancel a ${game.status} game`);
      }
      const room = await repositories.rooms.findById(game.roomId);
      if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
      const players = await repositories.gamePlayers.listByGame(gameId);
      await repositories.games.updateStatus(gameId, 'CANCELLED');
      for (const player of players) {
        if (room.stakeMinor > 0n) {
          await repositories.ledger.apply({
            userId: player.userId,
            type: 'REFUND',
            amountMinor: room.stakeMinor,
            refType: 'game',
            refId: gameId,
            idempotencyKey: `game:${gameId}:refund:${player.userId}`,
          });
        }
        await repositories.auditLogs.record({
          action: 'STAKE_REFUNDED',
          targetType: 'game',
          targetId: gameId,
          requestId,
          after: { userId: player.userId, amountMinor: room.stakeMinor.toString() },
        });
      }
      if (game.potMinor > 0n) await repositories.games.adjustPotMinor(gameId, -game.potMinor);
      await repositories.gameEvents.append({
        gameId,
        type: 'GAME_CANCELLED',
        payload: { reason: reason.slice(0, 500) },
        expectedStatus: 'CANCELLED',
      });
      await repositories.auditLogs.record({
        action: 'GAME_CANCELLED',
        targetType: 'game',
        targetId: gameId,
        requestId,
        after: { reason: reason.slice(0, 500) },
      });
      return true;
    });
    if (cancelled) await this.notifyRoom(gameId);
  }

  async getGameState(gameId: string, userId: string): Promise<Record<string, unknown>> {
    const game = await this.requireGame(gameId);
    const room = await this.requireRoom(game.roomId);
    const member = await this.players.findByGameAndUser(gameId, userId);
    const gamePlayers = await this.players.listByGame(gameId);
    if (!member) {
      if (game.status !== 'LOBBY' && game.status !== 'STARTING') {
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Game membership required');
      }
      return {
        gameId,
        roomId: game.roomId,
        status: game.status === 'STARTING' ? 'starting' : 'waiting',
        playerCount: gamePlayers.length,
        takenCardNumbers: gamePlayers.map(({ cardNumber }) => cardNumber),
        room: this.publicRoom(room),
      };
    }
    const state = await this.projector.project(game);
    return { ...state, yourCard: { cardNumber: member.cardNumber, cells: member.cardCells } };
  }

  async getMyCard(gameId: string, userId: string): Promise<{ cardNumber: number; cells: number[] }> {
    const player = await this.players.findByGameAndUser(gameId, userId);
    if (!player) throw new AppError(ErrorCode.FORBIDDEN, 403, 'Game membership required');
    return { cardNumber: player.cardNumber, cells: player.cardCells };
  }

  async listPlayers(gameId: string, userId: string): Promise<Array<{ id: string; firstName: string; username: string | null }>> {
    await this.requireMembership(gameId, userId);
    const gamePlayers = await this.players.listByGame(gameId);
    const users = await this.users.findManyByIds(gamePlayers.map(({ userId: id }) => id));
    return users.map(({ id, firstName, username }) => ({ id, firstName, username }));
  }

  private async notifyRoom(gameId: string): Promise<void> {
    if (!this.publisher) return;
    const game = await this.games.findById(gameId);
    if (!game) return;
    const [room, players] = await Promise.all([
      this.rooms.findById(game.roomId),
      this.players.listByGame(gameId),
    ]);
    if (!room) return;
    const payload = {
      room: this.publicRoom(room),
      playerIds: players.map(({ userId }) => userId),
      takenCardNumbers: players.map(({ cardNumber }) => cardNumber),
      seq: game.currentSeq,
    };
    await this.publisher.publishRoom?.(game.roomId, 'room:state', payload);
    await Promise.all(players.map(({ userId }) => this.publisher!.publishUser(userId, 'room:state', payload)));
  }

  async publishRoomState(gameId: string): Promise<void> {
    await this.notifyRoom(gameId);
  }

  private async notifyWallet(userId: string): Promise<void> {
    if (!this.publisher) return;
    const wallet = await this.ledger.getWallet(userId);
    if (wallet.balanceMinor > BigInt(Number.MAX_SAFE_INTEGER)) return;
    await this.publisher.publishUser(userId, 'wallet:update', {
      balanceMinor: Number(wallet.balanceMinor),
      currency: 'ETB',
      seq: wallet.version,
    });
  }

  private async requireMembership(gameId: string, userId: string): Promise<GamePlayer> {
    const player = await this.players.findByGameAndUser(gameId, userId);
    if (!player) throw new AppError(ErrorCode.FORBIDDEN, 403, 'Game membership required');
    return player;
  }

  private async requireGame(gameId: string): Promise<Game> {
    const game = await this.games.findById(gameId);
    if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
    return game;
  }

  private async requireRoom(roomId: string): Promise<Room> {
    const room = await this.rooms.findById(roomId);
    if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');
    return room;
  }

  private publicRoom(room: Room) {
    return {
      id: room.id,
      name: room.name,
      stakeMinor: Number(room.stakeMinor),
      cardPoolSize: room.cardPoolSize,
      status: room.status.toLowerCase(),
    };
  }
}
