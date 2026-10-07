import { serverPayloadSchemas, type ServerEventName, type UserProfile } from '@bingo/shared';
import type { User } from '../../src/domain/entities.js';
import type { EventContext, GameEventPublisher } from '../../src/domain/ports.js';
import type { CreateRoomInput, GameFence } from '../../src/domain/repositories.js';
import { ClaimService } from '../../src/application/game/claimService.js';
import { DrawService } from '../../src/application/game/drawService.js';
import { createGameEventHandlers } from '../../src/application/game/gameEventHandlers.js';
import { GameLifecycleService } from '../../src/application/game/gameLifecycleService.js';
import { GameRunner } from '../../src/application/game/gameRunner.js';
import { GameSettlementService } from '../../src/application/game/gameSettlementService.js';
import { GameStateProjector } from '../../src/application/game/gameStateProjector.js';
import {
  DeterministicSecretSource, InMemoryGameLock, InMemoryGameOwnershipLease, InMemorySeedVault, ManualClock,
} from '../fakes/gameFakes.js';
import { createInMemoryRepositories } from '../fakes/inMemoryRepositories.js';

export class RecordingGameEventPublisher implements GameEventPublisher {
  readonly messages: Array<{ userId: string; event: ServerEventName; payload: unknown }> = [];

  async publishUser(userId: string, event: string, payload: unknown): Promise<void> {
    if (!Object.hasOwn(serverPayloadSchemas, event)) throw new Error(`Unknown server event: ${event}`);
    serverPayloadSchemas[event as ServerEventName].parse(payload);
    this.messages.push({ userId, event: event as ServerEventName, payload: structuredClone(payload) });
  }

  forUser(userId: string, event?: ServerEventName) {
    return structuredClone(this.messages.filter((message) => message.userId === userId && (!event || message.event === event)));
  }

  clear(): void { this.messages.length = 0; }
}

export async function createGameTestHarness(options: {
  room?: Partial<CreateRoomInput>;
  playerCount?: number;
  potMinor?: bigint;
  disqualifyOnFalseClaim?: boolean;
} = {}) {
  const clock = new ManualClock();
  const repositories = createInMemoryRepositories(clock);
  const { users: userRepository, rooms, games, players, events, claims, ledger } = repositories;
  const lock = new InMemoryGameLock();
  const lease = new InMemoryGameOwnershipLease(clock);
  const vault = new InMemorySeedVault();
  const secrets = new DeterministicSecretSource();
  const publisher = new RecordingGameEventPublisher();
  const room = await rooms.create({
    name: 'Test room', stakeMinor: 10n, minPlayers: 2, maxPlayers: 20, drawIntervalMs: 1000,
    activePatterns: ['row-1'], cardPoolSize: 100, cardPoolSeed: 'deterministic-test-card-pool',
    ...options.room,
  });
  const users: User[] = [];
  for (let index = 0; index < (options.playerCount ?? 2); index += 1) {
    users.push(await userRepository.upsertFromTelegram({ telegramId: BigInt(index + 1), firstName: `Player ${index + 1}` }));
  }
  const lifecycle = new GameLifecycleService(rooms, games, players, userRepository, events, secrets, vault, lock, publisher);
  const settlement = new GameSettlementService(games, events, players, claims, ledger, lease, vault);
  const drawService = new DrawService(games, events, claims, lease, vault, lock, settlement);
  const claimService = new ClaimService(games, rooms, players, events, claims, lease, lock, vault, options.disqualifyOnFalseClaim);
  const projector = new GameStateProjector(events, players);
  const runner = new GameRunner('test-runner', games, rooms, events, players, lease, drawService, publisher, clock, clock);
  const game = await lifecycle.createGame(room.id);
  repositories.setPotMinor(game.id, options.potMinor ?? 0n);
  const initialLease = (await lease.acquire(game.id, 'test-owner', 10_000))!;
  const initialFence: GameFence = { instanceId: initialLease.instanceId, fencingToken: initialLease.fencingToken };
  await games.tryAcquireOwnership(game.id, initialFence.instanceId, initialFence.fencingToken);
  const fence = async (): Promise<GameFence> => {
    const row = (await games.findById(game.id))!;
    return { instanceId: row.ownerInstanceId!, fencingToken: row.fencingToken };
  };
  const handlers = createGameEventHandlers({
    games, players, events, claims: claimService, projector, publisher,
    membership: { isMember: async (id, userId) => !!(await players.findByGameAndUser(id, userId)) },
    fences: { current: async (id) => {
      const row = (await games.findById(id))!;
      return { instanceId: row.ownerInstanceId!, fencingToken: row.fencingToken };
    } },
  });
  const context = (user: User | UserProfile = users[0]!): EventContext => ({
    user: { id: user.id, telegramId: Number(user.telegramId), firstName: user.firstName },
    auth: {
      userId: user.id, telegramId: Number(user.telegramId),
      role: 'role' in user ? user.role : 'PLAYER',
      status: 'status' in user ? user.status : 'ACTIVE',
      authDate: Math.floor(clock.now().getTime() / 1000), verifiedAt: clock.now().getTime(),
    },
    socketId: `socket:${user.id}`, requestId: `request:${user.id}`,
  });
  const join = async () => {
    for (const [index, user] of users.entries()) {
      await lifecycle.joinGame({ gameId: game.id, userId: user.id, cardNumber: index + 1 });
    }
  };
  const start = async () => { await join(); return lifecycle.startGame(game.id, await fence()); };
  const startRunner = async () => {
    await lease.release(initialLease);
    return runner.start(game.id);
  };
  return {
    repositories, lifecycle, claimService, drawService, settlement, projector, runner, handlers,
    publisher, clock, lease, vault, secrets, lock, room, users, game, initialFence, initialLease,
    context, fence, join, start, startRunner,
    drawNext: async () => drawService.drawNext(game.id, await fence()),
    claim: async (userId = users[0]!.id) => claimService.claim({ gameId: game.id, userId }, await fence()),
    allEvents: async () => events.listSince(game.id, 0, 1000),
  };
}
