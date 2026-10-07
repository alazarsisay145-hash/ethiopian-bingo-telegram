import { checkWin, generateDrawSequence, verifySeed, WIN_PATTERNS } from '@bingo/engine';
import { AppError, ErrorCode, type ClaimResult } from '@bingo/shared';
import type { Claim, Game } from '../../domain/entities.js';
import type { GameOwnershipLease } from '../../domain/ownership.js';
import type {
  ClaimRepository,
  GameEventRepository,
  GamePlayerRepository,
  GameRepository,
  RoomRepository,
  AuditLogRepository,
} from '../../domain/repositories.js';
import type { GameFence } from '../../domain/repositories.js';
import type { GameLock, SeedVault } from '../../domain/ports.js';

export class ClaimService {
  constructor(
    private readonly games: GameRepository,
    private readonly rooms: RoomRepository,
    private readonly players: GamePlayerRepository,
    private readonly events: GameEventRepository,
    private readonly claims: ClaimRepository,
    private readonly ownership: GameOwnershipLease,
    private readonly lock: GameLock,
    private readonly vault: SeedVault,
    private readonly disqualifyOnFalseClaim = true,
    private readonly auditLogs?: AuditLogRepository,
  ) {}

  claim(input: { gameId: string; userId: string; requestId?: string }, fence: GameFence): Promise<ClaimResult> {
    return this.lock.runExclusive(`game:${input.gameId}:state`, async () => {
      const game = await this.requireGame(input.gameId);
      if (game.status !== 'RUNNING') {
        throw new AppError(
          ErrorCode.INVALID_STATE,
          409,
          'Claims are only allowed while the game is active',
        );
      }
      const [player, room, previous, allEvents] = await Promise.all([
        this.players.findByGameAndUser(input.gameId, input.userId),
        this.rooms.findById(game.roomId),
        this.claims.listByGame(input.gameId),
        this.events.listSince(input.gameId, 0, 1000),
      ]);
      if (!player)
        throw new AppError(ErrorCode.FORBIDDEN, 403, 'Player does not own a card in this game');
      if (player.status === 'DISQUALIFIED') {
        throw new AppError(ErrorCode.CONFLICT, 409, 'Disqualified players cannot claim');
      }
      const prior = previous.find((claim) => claim.userId === input.userId);
      if (prior?.accepted) {
        const priorEvent = allEvents.find(
          (event) =>
            event.type === 'CLAIM_ACCEPTED' &&
            (event.payload as { userId?: string }).userId === input.userId,
        );
        if (priorEvent) return this.toResult(input.gameId, input.userId, prior, allEvents);
        const leaseValid = await this.ownership.heartbeat(
          {
            gameId: input.gameId,
            instanceId: fence.instanceId,
            fencingToken: fence.fencingToken,
          },
          10_000,
        );
        if (!leaseValid) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Game ownership lease was lost');
        }
        const repaired = await this.events.append({
          gameId: input.gameId,
          type: 'CLAIM_ACCEPTED',
          payload: { userId: input.userId, atSeq: prior.atSeq, patterns: prior.patterns },
          fence,
          expectedStatus: 'RUNNING',
        });
        return {
          gameId: input.gameId,
          userId: input.userId,
          accepted: true,
          patterns: prior.patterns as ClaimResult['patterns'],
          seq: repaired.seq,
        };
      }
      if (prior)
        throw new AppError(ErrorCode.CONFLICT, 409, 'A claim was already rejected for this player');
      if (!room) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Room not found');

      const drawEvents = allEvents.filter((event) => event.type === 'NUMBER_CALLED');
      const latestDraw = drawEvents.at(-1);
      const atSeq = latestDraw?.seq ?? 0;
      const card = { cardNumber: player.cardNumber, cells: player.cardCells };
      const called = new Set(
        drawEvents.map((event) => (event.payload as { number: number }).number),
      );
      const enabledPatterns = WIN_PATTERNS.filter(({ id }) => room.activePatterns.includes(id));
      const patterns = checkWin(card, called, enabledPatterns).patterns;
      const accepted = patterns.length > 0;
      const validLease = await this.ownership.heartbeat(
        {
          gameId: input.gameId,
          instanceId: fence.instanceId,
          fencingToken: fence.fencingToken,
        },
        10_000,
      );
      if (!validLease) throw new AppError(ErrorCode.CONFLICT, 409, 'Game ownership lease was lost');
      const { event } = await this.claims.recordWithEvent({
        gameId: input.gameId,
        userId: input.userId,
        atSeq,
        accepted,
        patterns,
        disqualifyOnFalseClaim: this.disqualifyOnFalseClaim,
      }, fence);
      if (!accepted && this.disqualifyOnFalseClaim) {
        await this.auditLogs?.record({
          action: 'FALSE_CLAIM_DISQUALIFIED',
          targetType: 'game',
          targetId: input.gameId,
          requestId: input.requestId,
          after: { userId: input.userId, atSeq },
        });
      }
      return {
        gameId: input.gameId,
        userId: input.userId,
        accepted,
        patterns,
        seq: event.seq,
      };
    });
  }

  async verifyFairness(gameId: string): Promise<boolean> {
    const game = await this.requireGame(gameId);
    if (game.status !== 'ENDED')
      throw new AppError(ErrorCode.INVALID_STATE, 409, 'Only finished games can be verified');
    const commitment = await this.games.getSeedCommitment(gameId);
    if (!commitment) return false;
    const seed = await this.vault.open(commitment.seedEncrypted);
    if (!verifySeed(seed, commitment.seedHash)) return false;
    const end = (await this.events.listSince(gameId, 0, 1000)).find(
      (event) => event.type === 'GAME_ENDED',
    );
    const payload = end?.payload as { seedRevealed?: unknown; drawSequence?: unknown } | undefined;
    return (
      payload?.seedRevealed === seed &&
      Array.isArray(payload.drawSequence) &&
      JSON.stringify(payload.drawSequence) === JSON.stringify(generateDrawSequence(seed))
    );
  }

  private async requireGame(gameId: string): Promise<Game> {
    const game = await this.games.findById(gameId);
    if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
    return game;
  }

  private toResult(
    gameId: string,
    userId: string,
    claim: Claim,
    events: Awaited<ReturnType<GameEventRepository['listSince']>>,
  ): ClaimResult {
    const event = events.find(
      (item) =>
        item.type === 'CLAIM_ACCEPTED' && (item.payload as { userId?: string }).userId === userId,
    );
    return {
      gameId,
      userId,
      accepted: claim.accepted,
      patterns: claim.patterns as ClaimResult['patterns'],
      seq: event?.seq ?? claim.atSeq,
    };
  }
}
