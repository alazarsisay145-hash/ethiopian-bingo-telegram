import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, errorDtoSchema } from '../errors.js';
import {
  bingoCardSchema,
  claimResultSchema,
  gameStateSchema,
  roomSchema,
  userProfileSchema,
} from './models.js';
import { clientPayloadSchemas, serverPayloadSchemas } from './socket.js';
import {
  createRoomBodySchema,
  gameParamsSchema,
  joinGameBodySchema,
} from './http.js';

const card = {
  cardNumber: 1,
  cells: [
    1, 16, 31, 46, 61, 2, 17, 32, 47, 62, 3, 18, 0, 48, 63, 4, 19, 34, 49, 64, 5, 20, 35, 50, 65,
  ],
};
const seedHash = 'a'.repeat(64);
const room = { id: 'room-1', name: 'Room', stakeMinor: 100, cardPoolSize: 200, status: 'open' };
const game = {
  gameId: 'game-1',
  roomId: 'room-1',
  status: 'active',
  seq: 1,
  calledNumbers: [1],
  seedHash,
  yourCard: card,
};
const error = {
  error: {
    code: ErrorCode.UNAUTHORIZED,
    message: 'Authentication required',
    requestId: 'request-1',
  },
};

describe('public model contracts', () => {
  it('retains typed application error metadata', () => {
    const failure = new AppError(ErrorCode.CONFLICT, 409, 'Conflict', { resource: 'card' });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe('AppError');
    expect(failure.code).toBe(ErrorCode.CONFLICT);
    expect(failure.httpStatus).toBe(409);
    expect(failure.message).toBe('Conflict');
    expect(failure.details).toEqual({ resource: 'card' });
  });
  it('accepts valid profile, room, card, game and claim', () => {
    expect(
      userProfileSchema.safeParse({ id: 'user-1', telegramId: 123, firstName: 'Player' }).success,
    ).toBe(true);
    expect(roomSchema.safeParse(room).success).toBe(true);
    expect(bingoCardSchema.safeParse(card).success).toBe(true);
    expect(gameStateSchema.safeParse(game).success).toBe(true);
    expect(
      claimResultSchema.safeParse({
        gameId: 'game-1',
        userId: 'user-1',
        accepted: true,
        patterns: ['row-1'],
        seq: 2,
      }).success,
    ).toBe(true);
  });
  it('accepts product game statuses and rejects persisted enum names', () => {
    for (const status of ['waiting', 'starting', 'active', 'finished', 'cancelled']) {
      expect(gameStateSchema.safeParse({ ...game, status }).success).toBe(true);
    }
    expect(gameStateSchema.safeParse({ ...game, status: 'running' }).success).toBe(false);
  });
  it('rejects invalid identity, negative stake and internal game secrets', () => {
    expect(userProfileSchema.safeParse({ id: 'u', telegramId: -1, firstName: 'P' }).success).toBe(
      false,
    );
    expect(roomSchema.safeParse({ ...room, stakeMinor: -1 }).success).toBe(false);
    expect(gameStateSchema.safeParse({ ...game, seed: 'secret' }).success).toBe(false);
    expect(gameStateSchema.safeParse({ ...game, calledNumbers: [1, 1] }).success).toBe(false);
  });
  it.each([
    { ...card, cells: card.cells.slice(1) },
    { ...card, cells: card.cells.map((n, i) => (i === 12 ? 33 : n)) },
    { ...card, cells: card.cells.map((n, i) => (i === 0 ? 16 : n)) },
    { ...card, cells: card.cells.map((n, i) => (i === 5 ? 1 : n)) },
    { ...card, cardNumber: 0 },
  ])('rejects invalid card %#', (invalid) => {
    expect(bingoCardSchema.safeParse(invalid).success).toBe(false);
  });
  it('rejects inconsistent claims', () => {
    expect(
      claimResultSchema.safeParse({
        gameId: 'g',
        userId: 'u',
        accepted: true,
        patterns: [],
        seq: 1,
      }).success,
    ).toBe(false);
  });
  it('validates strict HTTP parameters, joins, and room configuration', () => {
    const id = '8cc0a286-5246-4e6f-8cf9-44ce57b8ec1c';
    expect(gameParamsSchema.safeParse({ gameId: id }).success).toBe(true);
    expect(gameParamsSchema.safeParse({ gameId: 'not-a-uuid' }).success).toBe(false);
    expect(gameParamsSchema.safeParse({ gameId: id, userId: 'forged' }).success).toBe(false);
    expect(joinGameBodySchema.safeParse({ cardNumber: 2 }).success).toBe(true);
    expect(joinGameBodySchema.safeParse({ cardNumber: 2, userId: 'forged' }).success).toBe(false);
    const roomInput = {
      name: 'Room',
      stakeMinor: 0,
      minPlayers: 2,
      maxPlayers: 4,
      drawIntervalMs: 5000,
      activePatterns: ['row-1'],
      cardPoolSize: 4,
    };
    expect(createRoomBodySchema.safeParse(roomInput).success).toBe(true);
    expect(createRoomBodySchema.safeParse({ ...roomInput, maxPlayers: 5 }).success).toBe(false);
    expect(createRoomBodySchema.safeParse({ ...roomInput, drawIntervalMs: 999 }).success).toBe(false);
    expect(createRoomBodySchema.safeParse({ ...roomInput, extra: true }).success).toBe(false);
  });
  it('accepts only serializable structured errors', () => {
    expect(errorDtoSchema.safeParse(error).success).toBe(true);
    expect(
      errorDtoSchema.safeParse({ error: { ...error.error, details: { issues: ['bad'] } } }).success,
    ).toBe(true);
    expect(errorDtoSchema.safeParse({ error: { ...error.error, code: 'OTHER' } }).success).toBe(
      false,
    );
    expect(
      errorDtoSchema.safeParse({ error: { ...error.error, details: () => undefined } }).success,
    ).toBe(false);
  });
});

const intents = {
  'room:join': { roomId: 'room-1' },
  'room:leave': { roomId: 'room-1' },
  'card:select': { roomId: 'room-1', cardNumber: 1 },
  'card:release': { roomId: 'room-1' },
  'game:ready': { roomId: 'room-1' },
  'game:claim': { gameId: 'game-1' },
  'state:resync': { gameId: 'game-1', lastSeq: 0 },
};
describe('socket intent catalogue', () => {
  for (const event of Object.keys(clientPayloadSchemas) as (keyof typeof clientPayloadSchemas)[]) {
    it(`validates ${event} and rejects forged authoritative fields`, () => {
      expect(clientPayloadSchemas[event].safeParse(intents[event]).success).toBe(true);
      expect(
        clientPayloadSchemas[event].safeParse({ ...intents[event], userId: 'forged' }).success,
      ).toBe(false);
      expect(clientPayloadSchemas[event].safeParse({}).success).toBe(event === 'state:resync');
    });
  }
});
const facts = {
  'room:state': { room, playerIds: ['user-1'], takenCardNumbers: [1], seq: 1 },
  'game:started': {
    gameId: 'game-1',
    roomId: 'room-1',
    seedHash,
    yourCard: card,
    drawIntervalMs: 3000,
    seq: 1,
  },
  'game:starting': {
    gameId: 'game-1',
    startsAt: '2026-01-01T00:00:00.000Z',
    seq: 1,
  },
  'game:number': { gameId: 'game-1', number: 1, calledNumbers: [1], seq: 2 },
  'game:claim_result': {
    gameId: 'game-1',
    userId: 'user-1',
    accepted: false,
    patterns: [],
    seq: 3,
  },
  'game:ended': {
    gameId: 'game-1',
    winnerIds: ['user-1'],
    seedRevealed: 'revealed',
    drawSequence: Array.from({ length: 75 }, (_, i) => i + 1),
    seq: 4,
  },
  'wallet:update': { balanceMinor: 0, currency: 'ETB', seq: 1 },
  'state:snapshot': { game, seq: 1 },
  error,
};
describe('socket fact catalogue', () => {
  for (const event of Object.keys(serverPayloadSchemas) as (keyof typeof serverPayloadSchemas)[]) {
    it(`validates ${event} and rejects invalid facts`, () => {
      expect(serverPayloadSchemas[event].safeParse(facts[event]).success).toBe(true);
      expect(serverPayloadSchemas[event].safeParse({}).success).toBe(false);
      if (event !== 'error') {
        expect(
          serverPayloadSchemas[event].safeParse({ ...facts[event], seq: undefined }).success,
        ).toBe(false);
        expect(serverPayloadSchemas[event].safeParse({ ...facts[event], seq: -1 }).success).toBe(
          false,
        );
      }
    });
  }
  it('rejects inconsistent snapshot and draw facts', () => {
    expect(serverPayloadSchemas['state:snapshot'].safeParse({ game, seq: 2 }).success).toBe(false);
    expect(
      serverPayloadSchemas['game:number'].safeParse({
        gameId: 'g',
        number: 2,
        calledNumbers: [1],
        seq: 2,
      }).success,
    ).toBe(false);
  });
});
