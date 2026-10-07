import type { GameOwnershipLease, GameLease } from '../../domain/ownership.js';
import type { GameEventPublisher, Clock, Scheduler } from '../../domain/ports.js';
import type {
  GameEventRepository,
  GameFence,
  GamePlayerRepository,
  GameRepository,
  RoomRepository,
} from '../../domain/repositories.js';
import { DrawService } from './drawService.js';

interface RunnerState {
  lease: GameLease;
  drawIntervalMs: number;
  cancelDraw?: () => void;
  cancelHeartbeat?: () => void;
  running: boolean;
}

export class GameRunner {
  private readonly runners = new Map<string, RunnerState>();
  private cancelRecovery?: () => void;
  private recoveryEnabled = false;
  private shutdownGeneration = 0;

  constructor(
    private readonly instanceId: string,
    private readonly games: GameRepository,
    private readonly rooms: RoomRepository,
    private readonly events: GameEventRepository,
    private readonly players: GamePlayerRepository,
    private readonly ownership: GameOwnershipLease,
    private readonly draws: DrawService,
    private readonly publisher: GameEventPublisher,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly leaseTtlMs = 10_000,
  ) {}

  async start(gameId: string): Promise<boolean> {
    const generation = this.shutdownGeneration;
    if (this.runners.has(gameId)) return true;
    const game = await this.games.findById(gameId);
    if (!game || (game.status !== 'RUNNING' && game.status !== 'SETTLING')) return false;
    const room = await this.rooms.findById(game.roomId);
    if (!room) return false;
    const lease = await this.ownership.acquire(gameId, this.instanceId, this.leaseTtlMs);
    if (
      !lease ||
      generation !== this.shutdownGeneration ||
      !(await this.games.tryAcquireOwnership(gameId, lease.instanceId, lease.fencingToken))
    ) {
      if (lease) await this.ownership.release(lease);
      return false;
    }
    const commitment = await this.games.getSeedCommitment(gameId);
    if (!commitment) {
      await this.ownership.release(lease);
      return false;
    }
    const lastEvent = (await this.events.listSince(gameId, 0, 1000))
      .filter((event) => event.type === 'NUMBER_CALLED')
      .at(-1);
    if (generation !== this.shutdownGeneration) {
      await this.ownership.release(lease);
      return false;
    }
    const lastActivityAt = lastEvent?.createdAt ?? game.startedAt ?? this.clock.now();
    const firstDelay = Math.max(
      0,
      room.drawIntervalMs - (this.clock.now().getTime() - lastActivityAt.getTime()),
    );
    const state: RunnerState = {
      lease,
      drawIntervalMs: room.drawIntervalMs,
      running: true,
    };
    this.runners.set(gameId, state);
    this.scheduleHeartbeat(gameId, state);
    this.scheduleDraw(gameId, state, firstDelay);
    return true;
  }

  async stop(gameId: string): Promise<void> {
    const state = this.runners.get(gameId);
    if (!state) return;
    state.running = false;
    state.cancelDraw?.();
    state.cancelHeartbeat?.();
    this.runners.delete(gameId);
    await this.ownership.release(state.lease);
  }

  async stopAll(): Promise<void> {
    this.shutdownGeneration += 1;
    this.recoveryEnabled = false;
    this.cancelRecovery?.();
    await Promise.all([...this.runners.keys()].map((gameId) => this.stop(gameId)));
  }

  async recover(): Promise<void> {
    const generation = this.shutdownGeneration;
    const games = await this.games.listRunnable();
    if (generation !== this.shutdownGeneration) return;
    await Promise.allSettled(games.map(({ id }) => this.start(id)));
  }

  startRecovery(intervalMs: number): void {
    this.cancelRecovery?.();
    this.recoveryEnabled = true;
    const schedule = (): void => {
      if (!this.recoveryEnabled) return;
      this.cancelRecovery = this.scheduler.schedule(intervalMs, () => {
        void this.recover()
          .catch(() => undefined)
          .finally(() => {
            if (this.recoveryEnabled) schedule();
          });
      });
    };
    schedule();
  }

  private scheduleHeartbeat(gameId: string, state: RunnerState): void {
    state.cancelHeartbeat = this.scheduler.schedule(Math.floor(this.leaseTtlMs / 3), () => {
      void this.ownership
        .heartbeat(state.lease, this.leaseTtlMs)
        .then((alive) => {
          if (!alive || !state.running) {
            void this.stop(gameId);
            return;
          }
          this.scheduleHeartbeat(gameId, state);
        })
        .catch(() => this.stop(gameId));
    });
  }

  private scheduleDraw(gameId: string, state: RunnerState, delay = state.drawIntervalMs): void {
    state.cancelDraw = this.scheduler.schedule(delay, () => {
      void this.draws
        .drawNext(gameId, this.toFence(state.lease))
        .then(async (event) => {
          if (!state.running) return;
          if (event.type === 'GAME_ENDED' || event.type === 'GAME_CANCELLED') {
            await this.publishToPlayers(gameId, 'game:ended', {
              ...(event.payload as object),
              gameId,
              seq: event.seq,
            });
            await this.stop(gameId);
            return;
          }
          const drawn = event.payload as { number: number; calledNumbers: number[] };
          await this.publishToPlayers(gameId, 'game:number', {
            gameId,
            number: drawn.number,
            calledNumbers: drawn.calledNumbers,
            seq: event.seq,
          });
          if (state.running) this.scheduleDraw(gameId, state);
        })
        .catch(async () => {
          await this.stop(gameId);
        });
    });
  }

  private async publishToPlayers(gameId: string, event: string, payload: unknown): Promise<void> {
    const players = await this.players.listByGame(gameId);
    await Promise.all(
      players.map(({ userId }) => this.publisher.publishUser(userId, event, payload)),
    );
  }

  private toFence(lease: GameLease): GameFence {
    return { instanceId: lease.instanceId, fencingToken: lease.fencingToken };
  }
}
