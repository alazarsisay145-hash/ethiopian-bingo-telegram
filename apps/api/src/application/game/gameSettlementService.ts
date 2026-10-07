import { generateDrawSequence, verifySeed } from '@bingo/engine';
import { AppError, ErrorCode } from '@bingo/shared';
import type { GameEvent } from '../../domain/entities.js';
import type { GameOwnershipLease } from '../../domain/ownership.js';
import type {
  ClaimRepository,
  GameEventRepository,
  GameFence,
  GamePlayerRepository,
  GameRepository,
  LedgerRepository,
} from '../../domain/repositories.js';
import type { SeedVault } from '../../domain/ports.js';
import type { GameEventPublisher } from '../../domain/ports.js';
import type { AuditLogRepository } from '../../domain/repositories.js';

export interface PrizeSplitPolicy {
  split(
    potMinor: bigint,
    winnerIds: readonly string[],
  ): Array<{ userId: string; amountMinor: bigint }>;
}

export class FirstClaimantRemainderPolicy implements PrizeSplitPolicy {
  split(
    potMinor: bigint,
    winnerIds: readonly string[],
  ): Array<{ userId: string; amountMinor: bigint }> {
    if (potMinor <= 0n || winnerIds.length === 0) return [];
    const share = potMinor / BigInt(winnerIds.length);
    const remainder = potMinor % BigInt(winnerIds.length);
    return winnerIds.map((userId, index) => ({
      userId,
      amountMinor: share + (index === 0 ? remainder : 0n),
    }));
  }
}

export class GameSettlementService {
  constructor(
    private readonly games: GameRepository,
    private readonly events: GameEventRepository,
    private readonly players: GamePlayerRepository,
    private readonly claims: ClaimRepository,
    private readonly ledger: LedgerRepository,
    private readonly ownership: GameOwnershipLease,
    private readonly vault: SeedVault,
    private readonly splitPolicy: PrizeSplitPolicy = new FirstClaimantRemainderPolicy(),
    private readonly leaseTtlMs = 10_000,
    private readonly auditLogs?: AuditLogRepository,
    private readonly publisher?: GameEventPublisher,
  ) {}

  async finish(gameId: string, winnerIds: string[], fence: GameFence): Promise<GameEvent> {
    const game = await this.games.findById(gameId);
    if (!game) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Game not found');
    const alreadyEnded = game.status === 'ENDED';
    if (alreadyEnded) {
      const endEvent = (await this.events.listSince(gameId, 0, 1000)).find(
        (event) => event.type === 'GAME_ENDED',
      );
      if (endEvent) return endEvent;
    }
    if (!alreadyEnded && game.status !== 'RUNNING' && game.status !== 'SETTLING') {
      throw new AppError(ErrorCode.INVALID_STATE, 409, 'Only an active game can be settled');
    }
    const called = (await this.events.listSince(gameId, 0, 1000)).filter(
      (event) => event.type === 'NUMBER_CALLED',
    );
    const lastDrawSeq = called.at(-1)?.seq ?? 0;
    const acceptedClaims = await this.claims.listByGame(gameId);
    const validWinnerIds = acceptedClaims
      .filter((claim) => claim.accepted && claim.atSeq === lastDrawSeq)
      .map((claim) => claim.userId);
    const eligible = [...new Set(winnerIds)].filter((userId) => validWinnerIds.includes(userId));
    const commitment = await this.games.getSeedCommitment(gameId);
    if (!commitment) throw new AppError(ErrorCode.INVALID_STATE, 409, 'Game seed is not committed');
    const seed = await this.vault.open(commitment.seedEncrypted);
    if (!verifySeed(seed, commitment.seedHash)) {
      throw new AppError(
        ErrorCode.INTERNAL,
        500,
        'Stored game seed failed commitment verification',
      );
    }
    const resolvedWinners: string[] = [];
    for (const userId of eligible) {
      if (await this.players.findByGameAndUser(gameId, userId)) resolvedWinners.push(userId);
    }
    await this.assertLease(gameId, fence);
    if (game.status === 'RUNNING') await this.games.updateStatus(gameId, 'SETTLING', fence);
    for (const userId of resolvedWinners) {
      await this.assertLease(gameId, fence);
      await this.players.setStatus(gameId, userId, 'WINNER', fence);
    }
    const pot = game.potMinor;
    const payouts = this.splitPolicy.split(pot, resolvedWinners);
    const winnerSet = new Set(resolvedWinners);
    const payoutUserIds = new Set(payouts.map(({ userId }) => userId));
    const payoutTotal = payouts.reduce((total, payout) => total + payout.amountMinor, 0n);
    if (
      payoutUserIds.size !== payouts.length ||
      payouts.some((payout) => !winnerSet.has(payout.userId) || payout.amountMinor < 0n) ||
      payoutTotal !== (resolvedWinners.length ? pot : 0n)
    ) {
      throw new AppError(ErrorCode.INTERNAL, 500, 'Prize split policy returned an invalid distribution');
    }
    for (const { userId, amountMinor } of payouts) {
      await this.assertLease(gameId, fence);
      if (amountMinor > 0n) {
        await this.ledger.apply({
          userId,
          type: 'PRIZE',
          amountMinor,
          refType: 'GAME',
          refId: gameId,
          idempotencyKey: `game:${gameId}:prize:${userId}`,
        });
        await this.auditLogs?.record({
          action: 'PRIZE_APPLIED',
          targetType: 'game',
          targetId: gameId,
          after: { userId, amountMinor: amountMinor.toString() },
        });
        if (this.publisher) {
          const wallet = await this.ledger.getWallet(userId);
          if (wallet.balanceMinor <= BigInt(Number.MAX_SAFE_INTEGER)) {
            await this.publisher.publishUser(userId, 'wallet:update', {
              balanceMinor: Number(wallet.balanceMinor),
              currency: 'ETB',
              seq: wallet.version,
            });
          }
        }
      }
    }
    await this.assertLease(gameId, fence);
    if (game.status === 'ENDED') {
      throw new AppError(ErrorCode.CONFLICT, 409, 'Finished game is missing its final event');
    }
    const finalEvent = await this.games.finalize(
      gameId,
      {
        winnerIds: resolvedWinners,
        seedRevealed: seed,
        drawSequence: generateDrawSequence(seed),
      },
      fence,
    );
    await this.auditLogs?.record({
      action: 'GAME_FINISHED',
      targetType: 'game',
      targetId: gameId,
      after: { winnerIds: resolvedWinners },
    });
    return finalEvent;
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
