import { z } from 'zod';
import { errorDtoSchema } from '../errors.js';
import {
  bingoCardSchema,
  calledNumbersSchema,
  claimResultSchema,
  gameStateSchema,
  identifierSchema,
  numberSchema,
  roomSchema,
  seedHashSchema,
  sequenceSchema,
} from './models.js';

const roomIntentSchema = z.object({ roomId: identifierSchema }).strict();
export const clientPayloadSchemas = {
  'room:join': roomIntentSchema,
  'room:leave': roomIntentSchema,
  'card:select': z
    .object({ roomId: identifierSchema, cardNumber: z.number().int().positive().safe() })
    .strict(),
  'card:release': roomIntentSchema,
  'game:ready': roomIntentSchema,
  'game:claim': z.object({ gameId: identifierSchema }).strict(),
  'state:resync': z.object({ gameId: identifierSchema, lastSeq: sequenceSchema }).strict(),
} as const;

export const serverPayloadSchemas = {
  'room:state': z
    .object({
      room: roomSchema,
      playerIds: z.array(identifierSchema),
      takenCardNumbers: z.array(z.number().int().positive().safe()),
      seq: sequenceSchema,
    })
    .strict(),
  'game:started': z
    .object({
      gameId: identifierSchema,
      roomId: identifierSchema,
      seedHash: seedHashSchema,
      yourCard: bingoCardSchema.optional(),
      drawIntervalMs: z.number().int().positive().safe(),
      seq: sequenceSchema,
    })
    .strict(),
  'game:number': z
    .object({
      gameId: identifierSchema,
      number: numberSchema,
      calledNumbers: calledNumbersSchema,
      seq: sequenceSchema,
    })
    .strict()
    .refine((event) => event.calledNumbers.at(-1) === event.number, {
      message: 'Drawn number must be the latest called number',
    }),
  'game:claim_result': claimResultSchema,
  'game:ended': z
    .object({
      gameId: identifierSchema,
      winnerIds: z.array(identifierSchema),
      seedRevealed: z.string().min(1),
      drawSequence: calledNumbersSchema.refine(
        (numbers) => numbers.length === 75,
        'Full draw permutation required',
      ),
      seq: sequenceSchema,
    })
    .strict(),
  'wallet:update': z
    .object({
      balanceMinor: z.number().int().nonnegative().safe(),
      currency: z.literal('ETB'),
      seq: sequenceSchema,
    })
    .strict(),
  'state:snapshot': z
    .object({ game: gameStateSchema, seq: sequenceSchema })
    .strict()
    .refine(
      (snapshot) => snapshot.seq === snapshot.game.seq,
      'Snapshot and game sequences must agree',
    ),
  error: errorDtoSchema,
} as const;
