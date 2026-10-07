import { z } from 'zod';
import { patternIdSchema, productGameStatusSchema } from './models.js';

export const uuidSchema = z.string().uuid();
export const gameParamsSchema = z.object({ gameId: uuidSchema }).strict();
export const roomParamsSchema = z.object({ roomId: uuidSchema }).strict();
export const cardParamsSchema = roomParamsSchema.extend({
  cardNumber: z.coerce.number().int().positive().safe(),
}).strict();
export const joinGameBodySchema = z.object({
  cardNumber: z.number().int().positive().safe(),
}).strict();
export const gameListQuerySchema = z.object({
  status: z.enum(['waiting', 'active']).optional(),
}).strict();
export const historyQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
}).strict();
const roomFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  stakeMinor: z.number().int().nonnegative().safe(),
  minPlayers: z.number().int().min(2).safe(),
  maxPlayers: z.number().int().min(2).safe(),
  drawIntervalMs: z.number().int().min(1000).max(15000),
  startCountdownMs: z.number().int().min(1000).max(60000).default(15000),
  activePatterns: z.array(patternIdSchema).min(1),
  cardPoolSize: z.number().int().positive().safe(),
}).strict();
export const createRoomBodySchema = roomFieldsSchema.superRefine((room, context) => {
  if (room.maxPlayers < room.minPlayers || room.maxPlayers > room.cardPoolSize) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxPlayers'],
      message: 'Require minPlayers <= maxPlayers <= cardPoolSize',
    });
  }
});
export const updateRoomBodySchema = roomFieldsSchema.partial().strict();
export const cancelGameBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();
export const gameStatusSchema = productGameStatusSchema;
