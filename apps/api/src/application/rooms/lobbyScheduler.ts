import { AppError, ErrorCode } from '@bingo/shared';
import type { GameOwnershipLease } from '../../domain/ownership.js';
import type { Clock, GameEventPublisher, Scheduler } from '../../domain/ports.js';
import type {
  AuditLogRepository,
  GamePlayerRepository,
  GameRepository,
  RoomRepository,
} from '../../domain/repositories.js';
import type { GameLifecycleService } from '../game/gameLifecycleService.js';
import type { GameRunner } from '../game/gameRunner.js';

export class LobbyScheduler {
  private cancel?: () => void;
  private running = false;

  constructor(
    private readonly instanceId: string,
    private readonly games: GameRepository,
    private readonly rooms: RoomRepository,
    private readonly players: GamePlayerRepository,
    private readonly ownership: GameOwnershipLease,
    private readonly lifecycle: GameLifecycleService,
    private readonly runner: GameRunner,
    private readonly publisher: GameEventPublisher,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly auditLogs: AuditLogRepository,
    private readonly scanIntervalMs = 500,
  ) {}

  start(): void {
    this.running = true;
    this.scheduleScan(0);
  }

  stop(): void {
    this.running = false;
    this.cancel?.();
    this.cancel = undefined;
  }

  async recover(): Promise<void> {
    const lobbies = await this.games.listByStatus(['LOBBY', 'STARTING']);
    await Promise.allSettled(lobbies.map((game) => this.reconcile(game.id)));
  }

  private scheduleScan(delayMs: number): void {
    this.cancel = this.scheduler.schedule(delayMs, () => {
      void this.recover().catch(() => undefined).finally(() => {
        if (this.running) this.scheduleScan(this.scanIntervalMs);
      });
    });
  }

  private async reconcile(gameId: string): Promise<void> {
    const game = await this.games.findById(gameId);
    if (!game || (game.status !== 'LOBBY' && game.status !== 'STARTING')) return;
    const [room, players] = await Promise.all([
      this.rooms.findById(game.roomId),
      this.players.listByGame(gameId),
    ]);
    if (!room) return;
    if (players.length < room.minPlayers) {
      if (game.startingAt) {
        await this.games.setStartingAt(gameId, null);
        await this.publishRoomState(gameId, players.map(({ userId }) => userId));
      }
      return;
    }
    if (!game.startingAt && game.status === 'LOBBY') {
      const startsAt = new Date(this.clock.now().getTime() + (room.startCountdownMs ?? 15_000));
      const updated = await this.games.setStartingAt(gameId, startsAt);
      if (updated) {
        await Promise.all(players.map(({ userId }) =>
          this.publisher.publishUser(userId, 'game:starting', {
            gameId,
            startsAt: startsAt.toISOString(),
            seq: updated.currentSeq,
          }),
        ));
      }
      return;
    }
    if (!game.startingAt) return;
    if (game.startingAt.getTime() > this.clock.now().getTime()) return;
    await this.startWaitingGame(gameId, room.minPlayers);
  }

  private async startWaitingGame(gameId: string, minPlayers: number): Promise<void> {
    const lease = await this.ownership.acquire(gameId, this.instanceId, 10_000);
    if (!lease) return;
    let started = false;
    try {
      if (!(await this.games.tryAcquireOwnership(gameId, lease.instanceId, lease.fencingToken))) return;
      const players = await this.players.listByGame(gameId);
      if (players.length < minPlayers) {
        await this.games.setStartingAt(gameId, null);
        await this.publishRoomState(gameId, players.map(({ userId }) => userId));
        return;
      }
      await this.lifecycle.startGame(gameId, {
        instanceId: lease.instanceId,
        fencingToken: lease.fencingToken,
      });
      await this.auditLogs.record({
        action: 'GAME_STARTED',
        targetType: 'game',
        targetId: gameId,
      });
      started = true;
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.INVALID_STATE) {
        await this.games.setStartingAt(gameId, null);
      } else if (!(error instanceof AppError && error.code === ErrorCode.CONFLICT)) {
        throw error;
      }
    } finally {
      await this.ownership.release(lease);
    }
    if (started) await this.runner.start(gameId);
  }

  private async publishRoomState(gameId: string, userIds: string[]): Promise<void> {
    const game = await this.games.findById(gameId);
    const room = game ? await this.rooms.findById(game.roomId) : null;
    if (!game || !room) return;
    const players = await this.players.listByGame(gameId);
    const stakeMinor = Number(room.stakeMinor);
    const payload = {
      room: {
        id: room.id,
        name: room.name,
        stakeMinor,
        cardPoolSize: room.cardPoolSize,
        status: room.status.toLowerCase(),
      },
      playerIds: players.map(({ userId }) => userId),
      takenCardNumbers: players.map(({ cardNumber }) => cardNumber),
      seq: game.currentSeq,
    };
    await this.publisher.publishRoom?.(room.id, 'room:state', payload);
    await Promise.all(userIds.map((userId) => this.publisher.publishUser(userId, 'room:state', payload)));
  }
}
