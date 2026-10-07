import { randomUUID } from 'node:crypto';
import { generateCard } from '@bingo/engine';
import { ErrorCode } from '@bingo/shared';
import { describe, expect, it } from 'vitest';
import { createGameTestHarness, RecordingGameEventPublisher } from '../../../test/helpers/createGameTestHarness.js';

describe('in-memory repository contract invariants', () => {
  it('creates one user/wallet atomically and updates only Telegram profile fields on replay', async () => {
    const h = await createGameTestHarness();
    const user = h.users[0]!;
    await h.repositories.users.setRole(user.id, 'ADMIN');
    await h.repositories.users.setStatus(user.id, 'BANNED');
    await h.repositories.ledger.apply({
      userId: user.id, type: 'ADMIN_ADJUSTMENT', amountMinor: 15n, idempotencyKey: 'fund',
    });
    const profiles = await Promise.all(Array.from({ length: 8 }, () =>
      h.repositories.users.upsertFromTelegram({ telegramId: user.telegramId, firstName: 'Updated' })));
    expect(new Set(profiles.map(({ id }) => id)).size).toBe(1);
    expect(profiles[0]).toMatchObject({ id: user.id, firstName: 'Updated', role: 'ADMIN', status: 'BANNED' });
    expect(h.repositories.getWallet(user.id)).toMatchObject({ balanceMinor: 15n, version: 1 });
  });

  it('guards foreign keys and unique nonterminal game per room under concurrent creation', async () => {
    const h = await createGameTestHarness();
    await expect(h.repositories.games.create({ roomId: randomUUID() })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await h.lifecycle.cancelGame(h.game.id, 'done', h.initialFence);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      h.repositories.games.create({ roomId: h.room.id })));
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(7);
  });

  it('does not expose secrets or permit mutation through returned entities/events', async () => {
    const h = await createGameTestHarness();
    await h.start();
    const room = (await h.repositories.rooms.findById(h.room.id))!;
    expect(room).not.toHaveProperty('cardPoolSeed');
    room.activePatterns.length = 0;
    expect((await h.repositories.rooms.findById(h.room.id))!.activePatterns).toEqual(['row-1']);
    const game = (await h.repositories.games.findById(h.game.id))!;
    expect(game).not.toHaveProperty('seedEncrypted');
    game.status = 'CANCELLED';
    expect((await h.repositories.games.findById(h.game.id))!.status).toBe('RUNNING');
    const event = (await h.allEvents())[0]!;
    (event.payload as { activePatterns: string[] }).activePatterns.length = 0;
    expect((await h.allEvents())[0]!.payload).toMatchObject({ activePatterns: ['row-1'] });
    const player = (await h.repositories.players.listByGame(h.game.id))[0]!;
    player.cardCells.fill(75);
    expect((await h.repositories.players.findByGameAndUser(h.game.id, player.userId))!.cardCells)
      .toEqual(generateCard('deterministic-test-card-pool', player.cardNumber).cells);
  });

  it('checks atomic card ownership and exact card shape independently of application checks', async () => {
    const h = await createGameTestHarness();
    const card = generateCard('deterministic-test-card-pool', 1);
    const results = await Promise.all(h.users.map((user) => h.repositories.players.reserveCard({
      gameId: h.game.id, userId: user.id, cardNumber: 1, cardCells: card.cells,
    })));
    expect(results.map(({ kind }) => kind)).toEqual(['reserved', 'card_taken']);
    expect(await h.repositories.players.reserveCard({
      gameId: h.game.id, userId: h.users[0]!.id, cardNumber: 2, cardCells: card.cells,
    })).toMatchObject({ kind: 'already_joined', player: { cardNumber: 1 } });
    await expect(h.repositories.players.reserveCard({
      gameId: h.game.id, userId: h.users[1]!.id, cardNumber: 3, cardCells: [1],
    })).rejects.toThrow();
    await expect(h.repositories.players.reserveCard({
      gameId: h.game.id, userId: randomUUID(), cardNumber: 3, cardCells: card.cells,
    })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('enforces transition table and monotonic fencing without mutating on rejected writes', async () => {
    const h = await createGameTestHarness();
    await expect(h.repositories.games.updateStatus(h.game.id, 'ENDED', h.initialFence)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.repositories.games.tryAcquireOwnership(h.game.id, 'new-owner', 2n)).toBe(true);
    expect(await h.repositories.games.tryAcquireOwnership(h.game.id, 'stale-owner', 1n)).toBe(false);
    await expect(h.repositories.games.updateStatus(h.game.id, 'STARTING', h.initialFence)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'LOBBY', ownerInstanceId: 'new-owner', fencingToken: 2n });
    expect(await h.allEvents()).toEqual([]);
  });

  it('stores a commitment once and reveals only terminal committed games', async () => {
    const h = await createGameTestHarness();
    await h.repositories.games.setSeedCommitment(h.game.id, { seedHash: 'hash', seedEncrypted: 'sealed' });
    await expect(h.repositories.games.setSeedCommitment(h.game.id, { seedHash: 'new', seedEncrypted: 'new' })).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    await expect(h.repositories.games.revealSeed(h.game.id)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    await h.lifecycle.cancelGame(h.game.id, 'done', h.initialFence);
    const revealed = await h.repositories.games.revealSeed(h.game.id);
    expect(await h.repositories.games.revealSeed(h.game.id)).toEqual(revealed);
  });

  it('serializes sequence allocation, checks expected index/status, and leaves no gaps after failure', async () => {
    const h = await createGameTestHarness();
    await h.start();
    const events = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      h.repositories.events.append({ gameId: h.game.id, type: 'AUDIT', payload: { index }, fence: h.initialFence })));
    expect(events.map(({ seq }) => seq)).toEqual(Array.from({ length: 10 }, (_, index) => index + 2));
    const before = await h.repositories.events.latestSeq(h.game.id);
    for (const input of [
      { expectedStatus: 'LOBBY' as const },
      { expectedDrawIndex: 1 },
      { fence: { instanceId: 'stale', fencingToken: 0n } },
    ]) {
      await expect(h.repositories.events.append({
        gameId: h.game.id, type: 'NUMBER_CALLED', payload: { number: 1 },
        fence: h.initialFence, ...input,
      })).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    }
    h.repositories.failNext('events.append');
    await expect(h.drawNext()).rejects.toThrow('Injected events.append failure');
    expect(await h.repositories.events.latestSeq(h.game.id)).toBe(before);
    expect((await h.drawNext()).seq).toBe(before + 1);
  });

  it('rolls back duplicate claim/event/disqualification together without burning a sequence', async () => {
    const h = await createGameTestHarness();
    await h.start();
    const input = {
      gameId: h.game.id, userId: h.users[0]!.id, atSeq: 0,
      accepted: true, patterns: ['row-1'], disqualifyOnFalseClaim: false,
    };
    await h.repositories.claims.recordWithEvent(input, h.initialFence);
    const seq = await h.repositories.events.latestSeq(h.game.id);
    await expect(h.repositories.claims.recordWithEvent({
      ...input, accepted: false, disqualifyOnFalseClaim: true,
    }, h.initialFence)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.repositories.events.latestSeq(h.game.id)).toBe(seq);
    expect(await h.repositories.claims.listByGame(h.game.id)).toHaveLength(1);
    expect(await h.repositories.players.findByGameAndUser(h.game.id, input.userId)).toMatchObject({ status: 'ACTIVE' });
  });

  it('finalizes status, seed reveal, and end event atomically and only once', async () => {
    const h = await createGameTestHarness();
    await h.start();
    await h.repositories.games.updateStatus(h.game.id, 'SETTLING', h.initialFence);
    h.repositories.failNext('games.finalize');
    await expect(h.repositories.games.finalize(h.game.id, { winnerIds: [] }, h.initialFence)).rejects.toThrow();
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'SETTLING', seedRevealedAt: null, currentSeq: 1 });
    const ended = await h.repositories.games.finalize(h.game.id, { winnerIds: [] }, h.initialFence);
    expect(await h.repositories.games.finalize(h.game.id, { winnerIds: ['changed'] }, h.initialFence)).toEqual(ended);
    expect(await h.repositories.games.findById(h.game.id)).toMatchObject({ status: 'ENDED', currentSeq: 2 });
    expect((await h.allEvents()).filter(({ type }) => type === 'GAME_ENDED')).toHaveLength(1);
  });

  it('applies concurrent ledger replays once, preserves append-only records, and rejects changed replay', async () => {
    const h = await createGameTestHarness();
    const input = { userId: h.users[0]!.id, type: 'PRIZE' as const, amountMinor: 10n, idempotencyKey: 'prize' };
    const entries = await Promise.all(Array.from({ length: 10 }, () => h.repositories.ledger.apply(input)));
    expect(new Set(entries.map(({ id }) => id)).size).toBe(1);
    expect(h.repositories.getWallet(input.userId)).toMatchObject({ balanceMinor: 10n, version: 1 });
    entries[0]!.amountMinor = 999n;
    expect((await h.repositories.ledger.listByUser(input.userId))[0]!.amountMinor).toBe(10n);
    await expect(h.repositories.ledger.apply({ ...input, amountMinor: 11n })).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    await expect(h.repositories.ledger.apply({ ...input, userId: h.users[1]!.id })).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(await h.repositories.ledger.getBalance(h.users[1]!.id)).toBe(0n);
  });

  it('validates ledger signs and atomically rejects overdrafts and int64 overflow', async () => {
    const h = await createGameTestHarness();
    const userId = h.users[0]!.id;
    for (const [type, amountMinor] of [['STAKE', 1n], ['PRIZE', -1n], ['REFUND', -1n], ['ADMIN_ADJUSTMENT', 0n]] as const) {
      await expect(h.repositories.ledger.apply({ userId, type, amountMinor, idempotencyKey: `${type}:invalid` })).rejects.toThrow();
    }
    await expect(h.repositories.ledger.apply({ userId, type: 'STAKE', amountMinor: -1n, idempotencyKey: 'overdraft' }))
      .rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_FUNDS });
    const max = 9_223_372_036_854_775_807n;
    await h.repositories.ledger.apply({ userId, type: 'PRIZE', amountMinor: max - 1n, idempotencyKey: 'near-max' });
    await expect(h.repositories.ledger.apply({ userId, type: 'PRIZE', amountMinor: 2n, idempotencyKey: 'overflow' }))
      .rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    expect(h.repositories.getWallet(userId)).toMatchObject({ balanceMinor: max - 1n, version: 1 });
    expect(await h.repositories.ledger.listByUser(userId)).toHaveLength(1);
  });

  it('rejects invalid facts through the recording publisher instead of silently recording them', async () => {
    const publisher = new RecordingGameEventPublisher();
    await expect(publisher.publishUser('user', 'unknown:event', {})).rejects.toThrow('Unknown server event');
    await expect(publisher.publishUser('user', 'game:number', { gameId: 'game', number: 0, calledNumbers: [0], seq: 1 })).rejects.toThrow();
    expect(publisher.messages).toEqual([]);
  });

  it('records validated immutable audit JSON and supports ordered filtered pagination', async () => {
    const h = await createGameTestHarness();
    const input = {
      actorUserId: randomUUID(), action: 'GAME_CREATED', targetType: 'GAME', targetId: h.game.id,
      before: { status: 'none' }, after: { status: 'LOBBY' }, requestId: 'request',
    };
    const first = await h.repositories.auditLogs.record(input);
    input.after.status = 'tampered';
    first.after = { status: 'tampered' };
    await h.clock.advanceBy(1);
    await h.repositories.auditLogs.record({ action: 'ROOM_UPDATED', targetType: 'ROOM', targetId: h.room.id });
    await h.clock.advanceBy(1);
    const last = await h.repositories.auditLogs.record({
      action: 'GAME_UPDATED', targetType: 'GAME', targetId: h.game.id, after: { status: 'STARTING' },
    });
    expect(last).toMatchObject({ actorUserId: null, before: null, ip: null, requestId: null });
    expect(await h.repositories.auditLogs.list({ limit: 1 })).toMatchObject([{ id: last.id }]);
    expect(await h.repositories.auditLogs.list({ targetType: 'GAME', targetId: h.game.id }))
      .toMatchObject([{ action: 'GAME_UPDATED' }, { action: 'GAME_CREATED', after: { status: 'LOBBY' } }]);
    expect(await h.repositories.auditLogs.list({ targetType: 'GAME', before: new Date(2) }))
      .toMatchObject([{ action: 'GAME_CREATED' }]);
    expect(await h.repositories.auditLogs.list({ targetId: 'missing' })).toEqual([]);
  });

  it('rejects malformed audit fields and does not commit an injected audit failure', async () => {
    const h = await createGameTestHarness();
    for (const input of [
      { action: '', targetType: 'GAME' },
      { action: 'VALID', targetType: '' },
      { action: 'VALID', targetType: 'GAME', actorUserId: 'invalid' },
      { action: 'VALID', targetType: 'GAME', requestId: 'x'.repeat(101) },
    ]) await expect(h.repositories.auditLogs.record(input)).rejects.toThrow();
    h.repositories.failNext('auditLogs.record');
    await expect(h.repositories.auditLogs.record({ action: 'VALID', targetType: 'GAME' })).rejects.toThrow();
    expect(await h.repositories.auditLogs.list()).toEqual([]);
  });

  it('models exclusive expiring leases, strictly increasing tokens and compare-and-release', async () => {
    const h = await createGameTestHarness();
    expect(await h.lease.acquire(h.game.id, 'other', 10_000)).toBeNull();
    expect(await h.lease.release({ ...h.initialLease, instanceId: 'other' })).toBe(false);
    await h.clock.advanceBy(10_000);
    expect(await h.lease.heartbeat(h.initialLease, 10_000)).toBe(false);
    const newLease = (await h.lease.acquire(h.game.id, 'other', 10_000))!;
    expect(newLease.fencingToken).toBe(2n);
    expect(await h.lease.release(h.initialLease)).toBe(false);
    expect(await h.lease.heartbeat(newLease, 10_000)).toBe(true);
  });

  it('invalidates one game without releasing another and rejects stale release after failover', async () => {
    const h = await createGameTestHarness();
    const otherId = randomUUID();
    const other = (await h.lease.acquire(otherId, 'other-owner', 10_000))!;
    expect(h.lease.inspect(h.game.id)).toEqual(h.initialLease);
    expect(h.lease.isHeld(h.game.id)).toBe(true);
    expect(h.lease.hasOwner(h.game.id)).toBe(true);
    expect(h.lease.current(h.game.id)).toEqual(h.initialLease);
    const inspected = h.lease.inspect(h.game.id)!;
    inspected.instanceId = 'tampered';
    expect(h.lease.inspect(h.game.id)).toEqual(h.initialLease);
    h.lease.invalidate(h.game.id);
    expect(h.lease.inspect(h.game.id)).toBeNull();
    expect(h.lease.isHeld(h.game.id)).toBe(false);
    expect(h.lease.hasOwner(h.game.id)).toBe(false);
    expect(h.lease.current(h.game.id)).toBeNull();
    expect(await h.lease.heartbeat(h.initialLease, 10_000)).toBe(false);
    expect(await h.lease.heartbeat(other, 10_000)).toBe(true);
    const takeover = (await h.lease.acquire(h.game.id, 'takeover', 10_000))!;
    expect(takeover.fencingToken).toBe(2n);
    expect(await h.lease.release(h.initialLease)).toBe(false);
    expect(h.lease.inspect(h.game.id)).toEqual(takeover);
  });

  it('preserves valid=false lease-loss simulation and rejects invalid lease durations', async () => {
    const h = await createGameTestHarness();
    h.lease.valid = false;
    expect(await h.lease.heartbeat(h.initialLease, 10_000)).toBe(false);
    h.lease.valid = true;
    expect(await h.lease.heartbeat(h.initialLease, 10_000)).toBe(true);
    for (const ttlMs of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(h.lease.acquire('invalid', 'owner', ttlMs)).rejects.toThrow(RangeError);
      await expect(h.lease.heartbeat(h.initialLease, ttlMs)).rejects.toThrow(RangeError);
    }
  });

  it('flushes asynchronous scheduled chains before advancing the next virtual clock tick', async () => {
    const h = await createGameTestHarness();
    const completed: number[] = [];
    const tick = () => {
      void (async () => {
        for (let index = 0; index < 50; index += 1) await Promise.resolve();
        completed.push(h.clock.now().getTime());
        if (completed.length < 3) h.clock.schedule(100, tick);
      })();
    };
    h.clock.schedule(100, tick);
    await h.clock.advanceBy(300);
    expect(completed).toEqual([100, 200, 300]);
    expect(h.clock.pendingTasks).toBe(0);
  });
});
