import { randomBytes, randomUUID } from 'node:crypto';
import { checkWin, commitSeed, generateCard, generateDrawSequence, WIN_PATTERNS } from '@bingo/engine';
import { ErrorCode, serverPayloadSchemas } from '@bingo/shared';
import { afterEach, describe, expect, inject, it } from 'vitest';
import type { EventContext, GameEventPublisher } from '../../domain/ports.js';
import type { GameFence } from '../../domain/repositories.js';
import { createFixtures } from '../../integration-support.js';
/* eslint-disable no-restricted-imports -- Integration tests compose the real application adapters. */
import { AesGcmSeedVault, NodeSecretSource } from '../../infrastructure/crypto/seedVault.js';
import { createLogger } from '../../infrastructure/logging/logger.js';
import { createRedisClient } from '../../infrastructure/redis/client.js';
import { RedisGameLock } from '../../infrastructure/redis/gameLock.js';
import { RedisGameOwnershipLease } from '../../infrastructure/redis/gameOwnershipLease.js';
import { SystemClock, SystemScheduler } from '../../infrastructure/time/systemScheduler.js';
/* eslint-enable no-restricted-imports */
import { testEnv } from '../../test-support.js';
import { ClaimService } from './claimService.js';
import { DrawService } from './drawService.js';
import { createGameEventHandlers } from './gameEventHandlers.js';
import { GameLifecycleService } from './gameLifecycleService.js';
import { GameRunner } from './gameRunner.js';
import { GameSettlementService } from './gameSettlementService.js';
import { GameStateProjector } from './gameStateProjector.js';

const enabled = inject('dockerAvailable');
if (!enabled) console.warn('[integration] Docker unavailable: skipping game application tests');

type ServerEvent = keyof typeof serverPayloadSchemas;
const drawIntervalMs = 100;

class RecordingPublisher implements GameEventPublisher {
  readonly messages: Array<{ userId: string; event: ServerEvent; payload: unknown }> = [];
  private drawGate?: { count: number; promise: Promise<void>; release: () => void };
  private drawAction?: { count: number; operation: () => Promise<void>; promise?: Promise<void> };

  async publishUser(userId: string, event: string, payload: unknown): Promise<void> {
    if (!Object.hasOwn(serverPayloadSchemas, event)) throw new Error(`Unknown event: ${event}`);
    const name = event as ServerEvent;
    this.messages.push({ userId, event: name, payload: serverPayloadSchemas[name].parse(payload) });
    if (name === 'game:number') {
      const number = serverPayloadSchemas['game:number'].parse(payload);
      if (number.calledNumbers.length === this.drawAction?.count) {
        this.drawAction.promise ??= this.drawAction.operation();
        await this.drawAction.promise;
      }
      if (number.calledNumbers.length === this.drawGate?.count) await this.drawGate.promise;
    }
  }

  onDraw(count: number, operation: () => Promise<void>): void {
    this.drawAction = { count, operation };
  }

  async waitForDrawAction(): Promise<void> {
    if (!this.drawAction?.promise) throw new Error('Draw action was not triggered');
    await this.drawAction.promise;
  }

  // Transport backpressure pauses publication while ownership is handed off.
  holdAtDraw(count: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.drawGate = { count, promise, release };
  }

  resume(): void {
    this.drawGate?.release();
    this.drawGate = undefined;
  }

  forUser(userId: string, event: ServerEvent): unknown[] {
    return this.messages
      .filter((message) => message.userId === userId && message.event === event)
      .map(({ payload }) => payload);
  }
}

function createHarness() {
  const fx = createFixtures(inject('postgresUrl'));
  const { repos, db } = fx;
  const redis = createRedisClient(inject('redisUrl'), createLogger(testEnv));
  const ownership = new RedisGameOwnershipLease(redis);
  const clock = new SystemClock();
  const scheduler = new SystemScheduler();
  const lock = new RedisGameLock(redis, clock, scheduler);
  const vault = new AesGcmSeedVault(randomBytes(32).toString('hex'));
  const publisher = new RecordingPublisher();
  const newLifecycle = () => new GameLifecycleService(
    repos.rooms, repos.games, repos.gamePlayers, repos.users, repos.gameEvents,
    new NodeSecretSource(), vault, new RedisGameLock(redis, clock, scheduler), publisher,
  );
  const lifecycle = newLifecycle();
  const claims = new ClaimService(
    repos.games, repos.rooms, repos.gamePlayers, repos.gameEvents, repos.claims,
    ownership, lock, vault,
  );
  const settlement = new GameSettlementService(
    repos.games, repos.gameEvents, repos.gamePlayers, repos.claims, repos.ledger, ownership, vault,
  );
  const projector = new GameStateProjector(repos.gameEvents, repos.gamePlayers);
  const handlers = createGameEventHandlers({
    games: repos.games, players: repos.gamePlayers, events: repos.gameEvents,
    claims, projector, publisher,
    membership: {
      isMember: async (gameId, userId) =>
        (await repos.gamePlayers.findByGameAndUser(gameId, userId)) !== null,
    },
    fences: {
      current: async (gameId) => {
        const game = await repos.games.findById(gameId);
        if (!game?.ownerInstanceId) throw new Error('Game has no owner');
        return { instanceId: game.ownerInstanceId, fencingToken: game.fencingToken };
      },
    },
  });
  const runners: GameRunner[] = [];
  const gameIds: string[] = [];

  const newRunner = (instanceId: string) => {
    const draws = new DrawService(
      repos.games, repos.gameEvents, repos.claims, ownership, vault,
      new RedisGameLock(redis, clock, scheduler), settlement,
    );
    const runner = new GameRunner(
      instanceId, repos.games, repos.rooms, repos.gameEvents, repos.gamePlayers,
      ownership, draws, publisher, clock, scheduler, 60_000,
    );
    runners.push(runner);
    return { runner };
  };

  const createGame = async (playerCount: number) => {
    const room = await repos.rooms.create({
      name: `integration-${randomUUID()}`, stakeMinor: 10n,
      minPlayers: 5, maxPlayers: 10, drawIntervalMs,
      activePatterns: ['row-1'], cardPoolSize: 100,
      cardPoolSeed: randomBytes(16).toString('hex'),
    });
    const game = await lifecycle.createGame(room.id);
    gameIds.push(game.id);
    const users = await Promise.all(Array.from({ length: playerCount }, () => fx.newUser()));
    return { game, room, users };
  };

  const startGame = async (gameId: string) => {
    const lease = await ownership.acquire(gameId, `starter-${randomUUID()}`, 60_000);
    if (!lease) throw new Error('Unable to acquire start lease');
    try {
      expect(await repos.games.tryAcquireOwnership(gameId, lease.instanceId, lease.fencingToken))
        .toBe(true);
      await lifecycle.startGame(gameId, lease);
    } finally {
      await ownership.release(lease);
    }
    const commitment = await repos.games.getSeedCommitment(gameId);
    if (!commitment) throw new Error('Missing commitment');
    const seed = await vault.open(commitment.seedEncrypted);
    return { seed, commitment, sequence: generateDrawSequence(seed) };
  };

  const context = (userId: string): EventContext => ({
    user: { id: userId, telegramId: 1, firstName: 'Integration' },
    auth: {
      userId, telegramId: 1, role: 'PLAYER', status: 'ACTIVE',
      authDate: Math.floor(Date.now() / 1000), verifiedAt: Date.now(),
    },
    socketId: `socket-${userId}`, requestId: randomUUID(),
  });

  const waitForNumbers = async (recipient: string, count: number) => {
    await expect.poll(
      () => publisher.forUser(recipient, 'game:number').length,
      { interval: 10, timeout: 30_000 },
    ).toBe(count);
  };
  const waitForEnd = async (gameId: string, recipient: string) => {
    await expect.poll(
      () => publisher.forUser(recipient, 'game:ended').length,
      { interval: 10, timeout: 30_000 },
    ).toBe(1);
    await expect.poll(
      () => redis.get(`game:{${gameId}}:owner`),
      { interval: 10, timeout: 5000 },
    ).toBeNull();
  };

  return {
    ...fx, redis, ownership, vault, publisher, lifecycle, claims, settlement,
    projector, handlers, newLifecycle, newRunner, createGame, startGame, context,
    waitForNumbers, waitForEnd,
    close: async () => {
      try {
        publisher.resume();
        await Promise.all(runners.map((runner) => runner.stopAll()));
        for (const gameId of gameIds) {
          await redis.del(`game:{${gameId}}:owner`, `game:{${gameId}}:fence`, `lock:{game:${gameId}:state}`);
        }
      } finally {
        await Promise.all([redis.quit(), db.$disconnect()]);
      }
    },
  };
}

describe.skipIf(!enabled)('game application with Postgres and Redis', () => {
  let harness: ReturnType<typeof createHarness> | undefined;
  afterEach(async () => { await harness?.close(); harness = undefined; });

  it('runs a five-player game through private cards, draws, claims and one fair winner end', async () => {
    const h = harness = createHarness();
    const { game, room, users } = await h.createGame(5);
    for (const [index, user] of users.entries()) {
      expect(await h.lifecycle.joinGame({
        gameId: game.id, userId: user.id, cardNumber: index + 1,
      })).toBe('reserved');
    }
    await h.db.game.update({ where: { id: game.id }, data: { potMinor: 11n } });
    const { seed, commitment, sequence } = await h.startGame(game.id);
    const players = await h.repos.gamePlayers.listByGame(game.id);
    expect(players).toHaveLength(5);
    expect(commitment.seedHash).toBe(commitSeed(seed));
    expect(commitment.seedEncrypted).not.toBe(seed);
    const poolSeed = await h.repos.rooms.getCardPoolSeed(room.id);
    for (const player of players) {
      expect(player.cardCells).toEqual(generateCard(poolSeed!, player.cardNumber).cells);
      expect(h.publisher.forUser(player.userId, 'game:started')).toEqual([{
        gameId: game.id, roomId: room.id, seedHash: commitment.seedHash,
        yourCard: { cardNumber: player.cardNumber, cells: player.cardCells },
        drawIntervalMs, seq: 1,
      }]);
    }
    expect(await h.repos.games.findById(game.id)).not.toHaveProperty('seedEncrypted');
    await expect(h.repos.games.revealSeed(game.id)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });

    const rejected = players[0]!;
    const winner = players[1]!;
    const winningDrawCount = Math.max(...winner.cardCells.slice(0, 5)
      .map((number) => sequence.indexOf(number) + 1));
    h.publisher.onDraw(winningDrawCount, async () => {
      await h.handlers['game:claim']!({ gameId: game.id }, h.context(winner.userId));
      const claimSeq = await h.repos.gameEvents.latestSeq(game.id);
      await h.handlers['game:claim']!({ gameId: game.id }, h.context(winner.userId));
      expect(await h.repos.gameEvents.latestSeq(game.id)).toBe(claimSeq);
      expect((await h.repos.games.findById(game.id))?.status).toBe('RUNNING');
    });
    const { runner } = h.newRunner('lifecycle-owner');
    expect(await runner.start(game.id)).toBe(true);
    await h.handlers['game:claim']!({ gameId: game.id }, h.context(rejected.userId));
    expect((await h.repos.gamePlayers.findByGameAndUser(game.id, rejected.userId))?.status)
      .toBe('DISQUALIFIED');
    expect(h.publisher.forUser(rejected.userId, 'game:claim_result')[0])
      .toMatchObject({ accepted: false, patterns: [] });

    await h.waitForNumbers(winner.userId, winningDrawCount);
    expect(checkWin(
      { cardNumber: winner.cardNumber, cells: winner.cardCells },
      new Set(sequence.slice(0, winningDrawCount)),
      WIN_PATTERNS.filter(({ id }) => id === 'row-1'),
    ).patterns).toEqual(['row-1']);
    await h.publisher.waitForDrawAction();
    await h.waitForEnd(game.id, winner.userId);

    const ended = await h.repos.games.findById(game.id);
    expect(ended).toMatchObject({ status: 'ENDED', potMinor: 11n });
    expect(ended?.endedAt).toBeInstanceOf(Date);
    expect(ended?.seedRevealedAt).toBeInstanceOf(Date);
    expect(await h.claims.verifyFairness(game.id)).toBe(true);
    const projection = await h.projector.project(ended!);
    expect(projection).toMatchObject({
      status: 'finished', winnerIds: [winner.userId],
      calledNumbers: sequence.slice(0, winningDrawCount),
    });
    expect(projection.players.find(({ userId }) => userId === winner.userId)?.status).toBe('WINNER');
    expect(projection.players.find(({ userId }) => userId === rejected.userId)?.status)
      .toBe('DISQUALIFIED');
    await h.handlers['state:resync']!(
      { gameId: game.id, lastSeq: ended!.currentSeq }, h.context(winner.userId),
    );
    expect(h.publisher.forUser(winner.userId, 'state:snapshot')[0]).toMatchObject({
      game: { status: 'finished', winnerIds: [winner.userId], yourCard: { cells: winner.cardCells } },
      seq: ended!.currentSeq,
    });
    const repeatedSettlements = await Promise.all(Array.from({ length: 3 }, () =>
      h.settlement.finish(game.id, [winner.userId], {
        instanceId: ended!.ownerInstanceId!, fencingToken: ended!.fencingToken,
      })));
    expect(repeatedSettlements.every(({ seq }) => seq === ended!.currentSeq)).toBe(true);
    for (const player of players) {
      const numbers = h.publisher.forUser(player.userId, 'game:number')
        .map((payload) => serverPayloadSchemas['game:number'].parse(payload));
      expect(numbers.map(({ number }) => number)).toEqual(sequence.slice(0, winningDrawCount));
      numbers.forEach((payload, index) => {
        expect(payload.calledNumbers).toEqual(sequence.slice(0, index + 1));
      });
      expect(h.publisher.forUser(player.userId, 'game:ended')).toEqual([{
        gameId: game.id, winnerIds: [winner.userId], seedRevealed: seed,
        drawSequence: sequence, seq: ended!.currentSeq,
      }]);
      const won = player.userId === winner.userId;
      expect(await h.repos.ledger.getBalance(player.userId)).toBe(won ? 11n : 0n);
      const entries = await h.repos.ledger.listByUser(player.userId);
      expect(entries).toHaveLength(won ? 1 : 0);
      if (won) {
        expect(entries[0]).toMatchObject({
          userId: winner.userId, type: 'PRIZE', amountMinor: 11n, balanceAfterMinor: 11n,
          refType: 'GAME', refId: game.id,
          idempotencyKey: `game:${game.id}:prize:${winner.userId}`,
        });
      }
    }
    const events = await h.repos.gameEvents.listSince(game.id, 0, 1000);
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter(({ type }) => type === 'GAME_ENDED')).toHaveLength(1);
    expect(await h.db.ledgerEntry.count({ where: { refId: game.id, type: 'PRIZE' } })).toBe(1);
  });

  it('accepts simultaneous valid claims at one draw and settles all winners exactly once', async () => {
    const h = harness = createHarness();
    const { game, users } = await h.createGame(5);
    for (const [index, user] of users.entries()) {
      await h.lifecycle.joinGame({ gameId: game.id, userId: user.id, cardNumber: index + 1 });
    }
    await h.db.game.update({ where: { id: game.id }, data: { potMinor: 11n } });
    const { sequence } = await h.startGame(game.id);
    const players = (await h.repos.gamePlayers.listByGame(game.id)).slice(0, 3);
    const winningDrawCount = Math.max(...players.flatMap(({ cardCells }) =>
      cardCells.slice(0, 5).map((number) => sequence.indexOf(number) + 1)));
    h.publisher.onDraw(winningDrawCount, async () => {
      const drawSeq = await h.repos.gameEvents.latestSeq(game.id);
      await Promise.all(players.map(({ userId }) =>
        h.handlers['game:claim']!({ gameId: game.id }, h.context(userId))));
      const claims = await h.repos.claims.listByGame(game.id);
      expect(claims).toHaveLength(3);
      expect(claims.every(({ accepted, atSeq }) => accepted && atSeq === drawSeq)).toBe(true);
      expect((await h.repos.games.findById(game.id))?.status).toBe('RUNNING');
    });
    const { runner } = h.newRunner('simultaneous-owner');
    expect(await runner.start(game.id)).toBe(true);
    const fence = await h.repos.games.findById(game.id);
    const owner: GameFence = {
      instanceId: fence!.ownerInstanceId!, fencingToken: fence!.fencingToken,
    };
    await h.waitForNumbers(users[0]!.id, winningDrawCount);
    await h.publisher.waitForDrawAction();
    await h.waitForEnd(game.id, users[0]!.id);
    const events = await h.repos.gameEvents.listSince(game.id, 0, 1000);
    const end = events.find(({ type }) => type === 'GAME_ENDED')!;
    const winnerIds = players.map(({ userId }) => userId);
    expect(serverPayloadSchemas['game:ended'].parse({
      ...(end.payload as object), gameId: game.id, seq: end.seq,
    }).winnerIds.sort()).toEqual([...winnerIds].sort());
    const repeats = await Promise.all(Array.from({ length: 5 }, () =>
      h.settlement.finish(game.id, winnerIds, owner)));
    expect(repeats.every(({ seq }) => seq === end.seq)).toBe(true);
    expect(await h.db.gameEvent.count({ where: { gameId: game.id, type: 'GAME_ENDED' } })).toBe(1);
    expect(events.filter(({ type }) => type === 'NUMBER_CALLED')).toHaveLength(winningDrawCount);
    for (const user of users) expect(h.publisher.forUser(user.id, 'game:ended')).toHaveLength(1);
    const acceptedOrder = events.filter(({ type }) => type === 'CLAIM_ACCEPTED')
      .map(({ payload }) => (payload as { userId: string }).userId);
    for (const [index, userId] of acceptedOrder.entries()) {
      expect((await h.repos.gamePlayers.findByGameAndUser(game.id, userId))?.status).toBe('WINNER');
      expect(await h.repos.ledger.getBalance(userId)).toBe(index === 0 ? 5n : 3n);
      expect(await h.repos.ledger.listByUser(userId)).toHaveLength(1);
    }
    expect(await h.db.ledgerEntry.count({ where: { refId: game.id, type: 'PRIZE' } })).toBe(3);
  });

  it('fences contending runners and resumes after Redis lease deletion without skipped or duplicate draws', async () => {
    const h = harness = createHarness();
    const { game, users } = await h.createGame(5);
    for (const [index, user] of users.entries()) {
      await h.lifecycle.joinGame({ gameId: game.id, userId: user.id, cardNumber: index + 1 });
    }
    const { sequence } = await h.startGame(game.id);
    h.publisher.holdAtDraw(3);
    const candidates = [h.newRunner('runner-a'), h.newRunner('runner-b')];
    const starts = await Promise.all(candidates.map(({ runner }) => runner.start(game.id)));
    expect(starts.filter(Boolean)).toHaveLength(1);
    const active = candidates[starts.indexOf(true)]!;
    const standby = candidates[starts.indexOf(false)]!;
    const before = await h.repos.games.findById(game.id);
    const stale = { instanceId: before!.ownerInstanceId!, fencingToken: before!.fencingToken };
    await h.waitForNumbers(users[0]!.id, 3);
    expect(await h.redis.del(`game:{${game.id}}:owner`)).toBe(1);
    expect(await standby.runner.start(game.id)).toBe(true);
    const after = await h.repos.games.findById(game.id);
    expect(after!.fencingToken).toBeGreaterThan(stale.fencingToken);
    expect(after!.ownerInstanceId).not.toBe(stale.instanceId);
    await expect(h.repos.gameEvents.append({
      gameId: game.id, type: 'NUMBER_CALLED', payload: { number: 1 },
      fence: stale, expectedStatus: 'RUNNING', expectedDrawIndex: 3,
    })).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    h.publisher.resume();
    await expect.poll(
      () => active.runner.start(game.id), { interval: 10, timeout: 5000 },
    ).toBe(false);
    await active.runner.stopAll();
    expect(await h.redis.get(`game:{${game.id}}:owner`))
      .toBe(`${after!.ownerInstanceId}:${after!.fencingToken}`);
    await h.waitForEnd(game.id, users[0]!.id);
    const events = await h.repos.gameEvents.listSince(game.id, 0, 1000);
    const draws = events.filter(({ type }) => type === 'NUMBER_CALLED');
    expect(draws.map(({ payload }) => (payload as { number: number }).number)).toEqual(sequence);
    expect(draws.map(({ payload }) => (payload as { index: number }).index))
      .toEqual(Array.from({ length: 75 }, (_, index) => index));
    expect(new Set(draws.map(({ payload }) => (payload as { number: number }).number)).size).toBe(75);
    expect(events.map(({ seq }) => seq)).toEqual(Array.from({ length: 77 }, (_, index) => index + 1));
    expect(events.filter(({ type }) => type === 'GAME_ENDED')).toHaveLength(1);
    for (const user of users) {
      expect(h.publisher.forUser(user.id, 'game:number')
        .map((payload) => serverPayloadSchemas['game:number'].parse(payload).number)).toEqual(sequence);
      expect(h.publisher.forUser(user.id, 'game:ended')[0]).toMatchObject({ winnerIds: [] });
    }
    expect(await h.claims.verifyFairness(game.id)).toBe(true);
  });

  it('reserves one persisted server-generated card for ten concurrent joins', async () => {
    const h = harness = createHarness();
    const { game, room, users } = await h.createGame(10);
    const results = await Promise.all(users.map(({ id }) =>
      h.newLifecycle().joinGame({ gameId: game.id, userId: id, cardNumber: 7 })));
    expect(results.filter((result) => result === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result === 'card_taken')).toHaveLength(9);
    const players = await h.repos.gamePlayers.listByGame(game.id);
    expect(players).toHaveLength(1);
    expect(await h.db.gamePlayer.count({ where: { gameId: game.id, cardNumber: 7 } })).toBe(1);
    const poolSeed = await h.repos.rooms.getCardPoolSeed(room.id);
    expect(players[0]!.cardCells).toEqual(generateCard(poolSeed!, 7).cells);
    expect(players[0]!.userId).toBe(users[results.indexOf('reserved')]!.id);
    expect((await h.repos.games.findById(game.id))?.status).toBe('LOBBY');
    expect(await h.repos.gameEvents.latestSeq(game.id)).toBe(0);
  });
});
