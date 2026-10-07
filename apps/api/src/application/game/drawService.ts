import { generateDrawSequence, verifySeed } from '@bingo/engine';
import { AppError, ErrorCode } from '@bingo/shared';
import type { GameEvent } from '../../domain/entities.js';
import type { GameOwnershipLease } from '../../domain/ownership.js';
import type {
  ClaimRepository,
  GameFence,
  GameEventRepository,
  GameRepository,
} from '../../domain/repositories.js';
import type { GameLock, SeedVault } from '../../domain/ports.js';
import { GameSettlementService } from './gameSettlementService.js';

export class DrawService {
  private readonly inFlight = new Map<string, { fence: GameFence; promise: Promise<GameEvent> }>();

  constructor(
    private readonly games: GameRepository,
    private readonly events: GameEventRepository,
    private readonly claims: ClaimRepository,
    private readonly ownership: GameOwnershipLease,
    private readonly vault: SeedVault,
    private readonly lock: GameLock,
    private readonly settlement: GameSettlementService,
    private readonly leaseTtlMs = 10_000,
  ) {}

  drawNext(gameId: string, fence: GameFence): Promise<GameEvent> {
    const inProgress = this.inFlight.get(gameId);
    if (inProgress) {
      if (
        inProgress.fence.instanceId !== fence.instanceId ||
        inProgress.fence.fencingToken !== fence.fencingToken
      )
        throw new AppError(ErrorCode.CONFLICT, 409, 'Stale game owner');
      return inProgress.promise;
    }
    const pending = this.lock.runExclusive(`game:${gameId}:state`, async () => {
      const game = await this.games.findById(gameId);
      if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
      if (game.status !== 'RUNNING' && game.status !== 'SETTLING') {
        throw new AppError(
          ErrorCode.INVALID_STATE,
          409,
          'Numbers can only be drawn while the game is active',
        );
      }
      const commitment = await this.games.getSeedCommitment(gameId);
      if (!commitment)
        throw new AppError(ErrorCode.INVALID_STATE, 409, 'Game seed is not committed');
      const seed = await this.vault.open(commitment.seedEncrypted);
      if (!verifySeed(seed, commitment.seedHash)) {
        throw new AppError(
          ErrorCode.INTERNAL,
          500,
          'Stored game seed failed commitment verification',
        );
      }
      const draws = generateDrawSequence(seed);
      const existing = await this.events.listSince(gameId, 0, 1000);
      const numberEvents = existing.filter((event) => event.type === 'NUMBER_CALLED');
      const lastDraw = numberEvents.at(-1);
      const claimRows = lastDraw
        ? (await this.claims.listByGame(gameId)).filter(
            (claim) => claim.accepted && claim.atSeq === lastDraw.seq,
          )
        : [];
      const acceptedUserIds = new Set(claimRows.map((claim) => claim.userId));
      const acceptedClaims = lastDraw
        ? existing
            .filter(
              (event) =>
                event.type === 'CLAIM_ACCEPTED' &&
                (event.payload as { atSeq?: number }).atSeq === lastDraw.seq,
            )
            .map((event) => (event.payload as { userId: string }).userId)
            .filter((userId) => acceptedUserIds.has(userId))
            .map((userId) => claimRows.find((claim) => claim.userId === userId))
            .filter((claim): claim is NonNullable<typeof claim> => claim !== undefined)
        : [];
      if (game.status === 'SETTLING') {
        await this.assertLease(gameId, fence);
        return this.settlement.finish(
          gameId,
          acceptedClaims.map((claim) => claim.userId),
          fence,
        );
      }
      if (acceptedClaims.length) {
        await this.assertLease(gameId, fence);
        return this.settlement.finish(
          gameId,
          acceptedClaims.map((claim) => claim.userId),
          fence,
        );
      }
      const drawn = numberEvents.length;
      if (drawn >= draws.length) {
        await this.assertLease(gameId, fence);
        return this.settlement.finish(gameId, [], fence);
      }
      const number = draws[drawn];
      if (number === undefined)
        throw new AppError(ErrorCode.INTERNAL, 500, 'Draw sequence is incomplete');
      await this.assertLease(gameId, fence);
      const calledNumbers = [
        ...existing
          .filter((event) => event.type === 'NUMBER_CALLED')
          .map((event) => (event.payload as { number: number }).number),
        number,
      ];
      return this.events.append({
        gameId,
        type: 'NUMBER_CALLED',
        payload: { number, index: drawn, calledNumbers },
        fence,
        expectedDrawIndex: drawn,
        expectedStatus: 'RUNNING',
      });
    });
    const flight = { fence, promise: pending };
    this.inFlight.set(gameId, flight);
    void pending
      .finally(() => {
        if (this.inFlight.get(gameId) === flight) this.inFlight.delete(gameId);
      })
      .catch(() => {});
    return pending;
  }

  private async assertLease(gameId: string, fence: GameFence): Promise<void> {
    const valid = await this.ownership.heartbeat(
      {
        gameId,
        instanceId: fence.instanceId,
        fencingToken: fence.fencingToken,
      },
      this.leaseTtlMs,
    );
    if (!valid) throw new AppError(ErrorCode.CONFLICT, 409, 'Game ownership lease was lost');
  }
}
