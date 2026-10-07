import { afterAll, describe, expect, inject, it } from 'vitest';
import { AppError, ErrorCode } from '@bingo/shared';
import { cells, createFixtures } from '../../integration-support.js';
import { PrismaUnitOfWork } from './unitOfWork.js';
import { PrismaUserRepository } from './userRepository.js';

const enabled = inject('dockerAvailable');
if (!enabled) console.warn('[integration] Docker unavailable: skipping repository tests');

describe.skipIf(!enabled)('Postgres repositories', () => {
  const fx = createFixtures(inject('postgresUrl'));
  const { repos, db } = fx;
  afterAll(async () => { await db.$disconnect(); });

  const rejects = async (promise: Promise<unknown>, code: ErrorCode): Promise<void> => {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  };

  describe('users', () => {
    it('creates one zero-balance wallet; a second upsert only updates profile fields', async () => {
      const telegramId = BigInt(Date.now()) * 1000n + 7n;
      const first = await repos.users.upsertFromTelegram({ telegramId, firstName: 'Abebe', username: 'abe' });
      await repos.users.setRole(first.id, 'ADMIN');
      await repos.ledger.apply({
        userId: first.id, type: 'ADMIN_ADJUSTMENT', amountMinor: 500n, idempotencyKey: `seed-${first.id}`,
      });
      const second = await repos.users.upsertFromTelegram({ telegramId, firstName: 'Abebe B', lastName: 'K' });
      expect(second.id).toBe(first.id);
      expect(second.firstName).toBe('Abebe B');
      expect(second.lastName).toBe('K');
      expect(second.username).toBe('abe');
      expect(second.role).toBe('ADMIN');
      expect(second.createdAt).toEqual(first.createdAt);
      expect(await db.wallet.count({ where: { userId: first.id } })).toBe(1);
      expect(await repos.ledger.getBalance(first.id)).toBe(500n);
      expect((await repos.users.findByTelegramId(telegramId))?.id).toBe(first.id);
    });

    it('creates a single user and wallet under concurrent first logins', async () => {
      const telegramId = BigInt(Date.now()) * 1000n + 8n;
      const users = await Promise.all(Array.from({ length: 10 }, () =>
        repos.users.upsertFromTelegram({ telegramId, firstName: 'Race' })));
      expect(new Set(users.map((u) => u.id)).size).toBe(1);
      expect(await db.wallet.count({ where: { userId: users[0]?.id } })).toBe(1);
    });

    it('bootstraps an allowlisted admin once and writes an audit entry', async () => {
      const telegramId = BigInt(Date.now()) * 1000n + 9n;
      const users = new PrismaUserRepository(db, [Number(telegramId)]);
      const first = await users.upsertFromTelegram({ telegramId, firstName: 'Initial admin' });
      expect(first.role).toBe('ADMIN');
      const second = await new PrismaUserRepository(db).upsertFromTelegram({
        telegramId,
        firstName: 'Updated profile',
      });
      expect(second.role).toBe('ADMIN');
      expect(await db.auditLog.count({
        where: { action: 'ROLE_BOOTSTRAPPED', targetId: first.id },
      })).toBe(1);
    });

    it('handles status, last seen and unknown ids', async () => {
      const user = await fx.newUser();
      expect((await repos.users.setStatus(user.id, 'BANNED')).status).toBe('BANNED');
      await repos.users.touchLastSeen(user.id);
      expect((await repos.users.findById(user.id))?.lastSeenAt).not.toBeNull();
      expect(await repos.users.findById('not-a-uuid')).toBeNull();
      await rejects(repos.users.setRole('00000000-0000-4000-8000-000000000000', 'ADMIN'), ErrorCode.NOT_FOUND);
    });
  });

  describe('rooms and games', () => {
    it('enforces one non-terminal game per room in the database', async () => {
      const game = await fx.newGame();
      await rejects(repos.games.create({ roomId: game.roomId }), ErrorCode.CONFLICT);
      await repos.games.updateStatus(game.id, 'CANCELLED');
      const replacement = await repos.games.create({ roomId: game.roomId });
      expect(replacement.status).toBe('LOBBY');
    });

    describe('transactional game-room joins', () => {
      it('reserves a contested card and debits exactly one stake in the same transaction', async () => {
        const game = await fx.newGame();
        const [first, second] = await Promise.all([fx.newUser(), fx.newUser()]);
        for (const user of [first, second]) {
          await repos.ledger.apply({
            userId: user.id,
            type: 'ADMIN_ADJUSTMENT',
            amountMinor: 100n,
            idempotencyKey: `test-wallet:${user.id}`,
          });
        }
        const unitOfWork = new PrismaUnitOfWork(db);
        const join = (userId: string) => unitOfWork.withTransaction(async (transaction) => {
          const locked = await transaction.games.lockForUpdate(game.id);
          if (!locked || locked.status !== 'LOBBY') throw new Error('Game not waiting');
          const result = await transaction.gamePlayers.reserveCard({
            gameId: game.id,
            userId,
            cardNumber: 1,
            cardCells: cells(),
          });
          if (result.kind !== 'reserved') {
            throw new AppError(
              result.kind === 'card_taken' ? ErrorCode.CARD_TAKEN : ErrorCode.CONFLICT,
              409,
              'Card unavailable',
            );
          }
          await transaction.ledger.apply({
            userId,
            type: 'STAKE',
            amountMinor: -10n,
            refType: 'game',
            refId: game.id,
            idempotencyKey: `game:${game.id}:stake:${userId}`,
          });
          await transaction.games.adjustPotMinor(game.id, 10n);
          await transaction.gameEvents.append({
            gameId: game.id,
            type: 'PLAYER_JOINED',
            payload: { userId },
          });
        });
        const results = await Promise.allSettled([join(first.id), join(second.id)]);
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        expect(await repos.gamePlayers.listByGame(game.id)).toHaveLength(1);
        expect((await repos.games.findById(game.id))?.potMinor).toBe(10n);
        expect(await repos.ledger.getBalance(first.id) + await repos.ledger.getBalance(second.id)).toBe(190n);
        expect(await repos.gameEvents.latestSeq(game.id)).toBe(1);
      });

      it('rolls back the card reservation if a stake debit fails', async () => {
        const game = await fx.newGame();
        const user = await fx.newUser();
        const unitOfWork = new PrismaUnitOfWork(db);
        await expect(unitOfWork.withTransaction(async (transaction) => {
          await transaction.gamePlayers.reserveCard({
            gameId: game.id,
            userId: user.id,
            cardNumber: 1,
            cardCells: cells(),
          });
          await transaction.ledger.apply({
            userId: user.id,
            type: 'STAKE',
            amountMinor: -10n,
            refType: 'game',
            refId: game.id,
            idempotencyKey: `game:${game.id}:stake:${user.id}`,
          });
        })).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_FUNDS });
        expect(await repos.gamePlayers.findByGameAndUser(game.id, user.id)).toBeNull();
        expect((await repos.games.findById(game.id))?.potMinor).toBe(0n);
      });
    });

    it('never exposes secrets and enforces the game state machine and seed lifecycle', async () => {
      const game = await fx.newGame();
      const room = await repos.rooms.findById(game.roomId);
      expect(room).not.toBeNull();
      expect(room).not.toHaveProperty('cardPoolSeed');
      expect(await repos.rooms.getCardPoolSeed(game.roomId)).toMatch(/^[0-9a-f]{32}$/);
      expect((await repos.rooms.listOpen()).some((r) => r.id === game.roomId)).toBe(true);
      expect((await repos.rooms.update(game.roomId, { status: 'CLOSED' })).status).toBe('CLOSED');
      await expect(repos.rooms.update(game.roomId, { minPlayers: 20 })).rejects.toThrow();
      expect((await repos.rooms.findById(game.roomId))?.minPlayers).toBe(2);

      const lobby = await repos.games.findById(game.id);
      expect(lobby).not.toHaveProperty('seedEncrypted');
      await repos.games.setSeedCommitment(game.id, { seedHash: 'h', seedEncrypted: 'enc' });
      await rejects(repos.games.setSeedCommitment(game.id, { seedHash: 'h2', seedEncrypted: 'e2' }), ErrorCode.CONFLICT);
      await rejects(repos.games.revealSeed(game.id), ErrorCode.CONFLICT);
      await rejects(repos.games.updateStatus(game.id, 'RUNNING'), ErrorCode.CONFLICT);
      expect((await repos.games.findActiveByRoom(game.roomId))?.id).toBe(game.id);
      await repos.games.updateStatus(game.id, 'STARTING');
      const running = await repos.games.updateStatus(game.id, 'RUNNING');
      expect(running.startedAt).not.toBeNull();
      await repos.games.updateStatus(game.id, 'SETTLING');
      const ended = await repos.games.updateStatus(game.id, 'ENDED');
      expect(ended.endedAt).not.toBeNull();
      expect(await repos.games.findActiveByRoom(game.roomId)).toBeNull();
      const revealed = await repos.games.revealSeed(game.id);
      expect(revealed.seedEncrypted).toBe('enc');
      expect((await repos.games.revealSeed(game.id)).seedRevealedAt).toEqual(revealed.seedRevealedAt);
      await rejects(repos.games.updateStatus(game.id, 'RUNNING'), ErrorCode.CONFLICT);
    });

    it('rejects writes from stale owners via fencing tokens', async () => {
      const game = await fx.newGame();
      expect(await repos.games.tryAcquireOwnership(game.id, 'a', 1n)).toBe(true);
      expect(await repos.games.tryAcquireOwnership(game.id, 'b', 1n)).toBe(false);
      expect(await repos.games.tryAcquireOwnership(game.id, 'b', 2n)).toBe(true);
      const stale = { instanceId: 'a', fencingToken: 1n };
      const current = { instanceId: 'b', fencingToken: 2n };
      expect(await repos.games.verifyFence(game.id, stale)).toBe(false);
      expect(await repos.games.verifyFence(game.id, current)).toBe(true);
      await rejects(repos.gameEvents.append({ gameId: game.id, type: 'x', payload: {}, fence: stale }), ErrorCode.CONFLICT);
      await rejects(repos.games.updateStatus(game.id, 'STARTING', stale), ErrorCode.CONFLICT);
      expect((await repos.gameEvents.append({ gameId: game.id, type: 'x', payload: {}, fence: current })).seq).toBe(1);
      expect((await repos.games.updateStatus(game.id, 'STARTING', current)).status).toBe('STARTING');
      expect(await repos.gameEvents.latestSeq(game.id)).toBe(1);
    });

    it('atomically finalizes the game and appends exactly one GAME_ENDED event', async () => {
      const game = await fx.newGame();
      const owner = { instanceId: 'settlement-owner', fencingToken: 1n };
      await repos.games.tryAcquireOwnership(game.id, owner.instanceId, owner.fencingToken);
      await repos.games.setSeedCommitment(game.id, { seedHash: 'hash', seedEncrypted: 'encrypted' });
      await repos.games.updateStatus(game.id, 'STARTING', owner);
      await repos.games.updateStatus(game.id, 'RUNNING', owner);
      await repos.games.updateStatus(game.id, 'SETTLING', owner);

      const payload = { winnerIds: [], seedRevealed: 'seed', drawSequence: [4, 7, 2] };
      const events = await Promise.all([
        repos.games.finalize(game.id, payload, owner),
        repos.games.finalize(game.id, payload, owner),
      ]);

      expect(events[0]).toEqual(events[1]);
      expect(events[0]?.type).toBe('GAME_ENDED');
      expect(events[0]?.seq).toBe(1);
      expect((await repos.games.findById(game.id))?.status).toBe('ENDED');
      expect(await repos.gameEvents.latestSeq(game.id)).toBe(1);
      expect(await db.gameEvent.count({ where: { gameId: game.id, type: 'GAME_ENDED' } })).toBe(1);
      expect((await repos.games.revealSeed(game.id)).seedRevealedAt).not.toBeNull();
    });
  });

  describe('reserveCard', () => {
    it('lets exactly one of N concurrent users reserve the same card', async () => {
      const game = await fx.newGame();
      const users = await Promise.all(Array.from({ length: 12 }, () => fx.newUser()));
      const results = await Promise.all(users.map((u) => repos.gamePlayers.reserveCard({
        gameId: game.id, userId: u.id, cardNumber: 7, cardCells: cells(),
      })));
      expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'card_taken')).toHaveLength(11);
      expect(await repos.gamePlayers.listByGame(game.id)).toHaveLength(1);
    });

    it('returns already_joined when the same user joins twice, even concurrently', async () => {
      const game = await fx.newGame();
      const user = await fx.newUser();
      const results = await Promise.all([1, 2, 3, 4, 5].map((cardNumber) => repos.gamePlayers.reserveCard({
        gameId: game.id, userId: user.id, cardNumber, cardCells: cells(),
      })));
      expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'already_joined')).toHaveLength(4);
      const again = await repos.gamePlayers.reserveCard({
        gameId: game.id, userId: user.id, cardNumber: 99, cardCells: cells(),
      });
      expect(again.kind).toBe('already_joined');
      const player = await repos.gamePlayers.findByGameAndUser(game.id, user.id);
      expect((await repos.gamePlayers.setStatus(game.id, user.id, 'WINNER')).status).toBe('WINNER');
      expect(player?.cardCells).toHaveLength(25);
    });

    it('rejects malformed cards before touching the database', async () => {
      const game = await fx.newGame();
      const user = await fx.newUser();
      await expect(repos.gamePlayers.reserveCard({
        gameId: game.id, userId: user.id, cardNumber: 1, cardCells: [1, 2, 3],
      })).rejects.toThrow();
      await expect(db.$executeRaw`
        INSERT INTO game_players (game_id, user_id, card_number, card_cells)
        VALUES (${game.id}::uuid, ${user.id}::uuid, 3, ARRAY[1,2,3])`).rejects.toThrow(/game_players_card_cells_length/);
    });
  });

  describe('game events', () => {
    it('allocates a gap-free, strictly increasing seq under concurrency', async () => {
      const game = await fx.newGame();
      const events = await Promise.all(Array.from({ length: 40 }, (_, i) =>
        repos.gameEvents.append({ gameId: game.id, type: 'number_drawn', payload: { i } })));
      const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(await repos.gameEvents.latestSeq(game.id)).toBe(40);
      const page = await repos.gameEvents.listSince(game.id, 35, 100);
      expect(page.map((e) => e.seq)).toEqual([36, 37, 38, 39, 40]);
      expect(await repos.gameEvents.listSince(game.id, 0, 3)).toHaveLength(3);
      await rejects(repos.gameEvents.append({ gameId: '00000000-0000-4000-8000-000000000000', type: 'x', payload: {} }), ErrorCode.NOT_FOUND);
    });

    it('allows only one concurrent append for the same expected draw index', async () => {
      const game = await fx.newGame();
      const owner = { instanceId: 'draw-owner', fencingToken: 1n };
      expect(await repos.games.tryAcquireOwnership(game.id, owner.instanceId, owner.fencingToken)).toBe(true);
      await repos.games.updateStatus(game.id, 'STARTING', owner);
      await repos.games.updateStatus(game.id, 'RUNNING', owner);
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
        repos.gameEvents.append({
          gameId: game.id,
          type: 'NUMBER_CALLED',
          payload: { number: index + 1, index: 0 },
          fence: owner,
          expectedDrawIndex: 0,
          expectedStatus: 'RUNNING',
        })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(11);
      expect(await db.gameEvent.count({ where: { gameId: game.id, type: 'NUMBER_CALLED' } })).toBe(1);
      expect(await repos.gameEvents.latestSeq(game.id)).toBe(1);
    });

    it('is append-only at the database level', async () => {
      const game = await fx.newGame();
      await repos.gameEvents.append({ gameId: game.id, type: 'a', payload: null });
      await expect(db.gameEvent.updateMany({ where: { gameId: game.id }, data: { type: 'b' } })).rejects.toThrow(/append-only/);
      await expect(db.gameEvent.deleteMany({ where: { gameId: game.id } })).rejects.toThrow(/append-only/);
    });
  });

  describe('claims and audit log', () => {
    it('atomically stores one fenced claim, disqualification, and claim event', async () => {
      const game = await fx.newGame();
      const user = await fx.newUser();
      const owner = { instanceId: 'claim-owner', fencingToken: 1n };
      await repos.games.tryAcquireOwnership(game.id, owner.instanceId, owner.fencingToken);
      await repos.games.updateStatus(game.id, 'STARTING', owner);
      await repos.games.updateStatus(game.id, 'RUNNING', owner);
      await repos.gamePlayers.reserveCard({
        gameId: game.id, userId: user.id, cardNumber: 1, cardCells: cells(),
      });
      const stored = await repos.claims.recordWithEvent({
        gameId: game.id, userId: user.id, atSeq: 0, accepted: false, patterns: [],
        disqualifyOnFalseClaim: true,
      }, owner);
      expect(stored.event.seq).toBe(1);
      expect((await repos.gamePlayers.findByGameAndUser(game.id, user.id))?.status).toBe('DISQUALIFIED');
      await rejects(repos.claims.recordWithEvent({
        gameId: game.id, userId: user.id, atSeq: 0, accepted: false, patterns: [],
        disqualifyOnFalseClaim: true,
      }, owner), ErrorCode.CONFLICT);
      expect(await repos.gameEvents.latestSeq(game.id)).toBe(1);
      expect(await repos.claims.listByGame(game.id)).toHaveLength(1);
      await rejects(repos.claims.recordWithEvent({
        gameId: game.id, userId: user.id, atSeq: 0, accepted: true, patterns: ['row-1'],
        disqualifyOnFalseClaim: true,
      }, { instanceId: owner.instanceId, fencingToken: 0n }), ErrorCode.CONFLICT);
      expect(await repos.gameEvents.latestSeq(game.id)).toBe(1);
    });

    it('records claims and audit entries', async () => {
      const game = await fx.newGame();
      const user = await fx.newUser();
      await repos.claims.record({ gameId: game.id, userId: user.id, atSeq: 5, accepted: false, patterns: [] });
      await rejects(
        repos.claims.record({ gameId: game.id, userId: user.id, atSeq: 9, accepted: true, patterns: ['row-1'] }),
        ErrorCode.CONFLICT,
      );
      expect((await repos.claims.listByGame(game.id)).map((c) => c.atSeq)).toEqual([5]);
      const audit = await repos.auditLogs.record({
        actorUserId: user.id, action: 'room.update', targetType: 'room', targetId: game.roomId,
        before: { a: 1 }, after: { a: 2 }, requestId: 'req-1',
      });
      expect(audit.after).toEqual({ a: 2 });
      expect((await repos.auditLogs.list({ targetType: 'room', targetId: game.roomId }))).toHaveLength(1);
    });
  });

  describe('ledger', () => {
    const fund = (userId: string, amount: bigint) => repos.ledger.apply({
      userId, type: 'ADMIN_ADJUSTMENT', amountMinor: amount, idempotencyKey: `fund-${userId}-${amount}`,
    });

    it('does not double-apply a replayed idempotency key', async () => {
      const user = await fx.newUser();
      await fund(user.id, 100n);
      const input = { userId: user.id, type: 'STAKE' as const, amountMinor: -30n, refType: 'game', refId: 'g1', idempotencyKey: `stake-${user.id}` };
      const first = await repos.ledger.apply(input);
      const replay = await repos.ledger.apply(input);
      expect(replay.id).toBe(first.id);
      expect(await repos.ledger.getBalance(user.id)).toBe(70n);
      await rejects(repos.ledger.apply({ ...input, amountMinor: -31n }), ErrorCode.CONFLICT);
      const concurrent = await Promise.all(Array.from({ length: 5 }, () => repos.ledger.apply({
        ...input, idempotencyKey: `same-${user.id}`,
      })));
      expect(new Set(concurrent.map((e) => e.id)).size).toBe(1);
      expect(await repos.ledger.getBalance(user.id)).toBe(40n);
      expect((await repos.ledger.listByUser(user.id)).map((e) => e.balanceAfterMinor)).toEqual([40n, 70n, 100n]);
    });

    it('rejects insufficient funds and wrong signs without changing state', async () => {
      const user = await fx.newUser();
      await fund(user.id, 50n);
      await rejects(repos.ledger.apply({
        userId: user.id, type: 'STAKE', amountMinor: -51n, idempotencyKey: `big-${user.id}`,
      }), ErrorCode.INSUFFICIENT_FUNDS);
      await expect(repos.ledger.apply({
        userId: user.id, type: 'STAKE', amountMinor: 5n, idempotencyKey: `sign-${user.id}`,
      })).rejects.toThrow();
      expect(await repos.ledger.getBalance(user.id)).toBe(50n);
      await rejects(repos.ledger.apply({
        userId: '00000000-0000-4000-8000-000000000000', type: 'PRIZE', amountMinor: 1n, idempotencyKey: `nw-${user.id}`,
      }), ErrorCode.NOT_FOUND);
      expect(await db.ledgerEntry.count({ where: { userId: user.id } })).toBe(1);
    });

    it('serialises concurrent stakes so the final balance is exact', async () => {
      const user = await fx.newUser();
      await fund(user.id, 1000n);
      const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => repos.ledger.apply({
        userId: user.id, type: 'STAKE', amountMinor: -50n, idempotencyKey: `c-${user.id}-${i}`,
      })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(10);
      expect(await repos.ledger.getBalance(user.id)).toBe(0n);
      const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
      expect(wallet.version).toBe(21);
      const entries = await db.ledgerEntry.findMany({ where: { userId: user.id } });
      expect(entries.reduce((sum, e) => sum + e.amountMinor, 0n)).toBe(wallet.balanceMinor);
    });

    it('enforces a non-negative wallet and an append-only ledger in the database', async () => {
      const user = await fx.newUser();
      await fund(user.id, 10n);
      await expect(db.wallet.update({ where: { userId: user.id }, data: { balanceMinor: -1n } })).rejects.toThrow(/wallets_balance_non_negative/);
      await expect(db.ledgerEntry.deleteMany({ where: { userId: user.id } })).rejects.toThrow(/append-only/);
    });
  });
});
