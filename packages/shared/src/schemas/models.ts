import { z } from 'zod';
import { BINGO_COLUMNS, COLUMN_RANGES, FREE_CELL_INDEX, TOTAL_NUMBERS } from '../constants.js';

export const identifierSchema = z.string().min(1).max(128);
export const sequenceSchema = z.number().int().nonnegative().safe();
export const numberSchema = z.number().int().min(1).max(TOTAL_NUMBERS);
export const seedHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const patternIdSchema = z.enum([
  'row-1',
  'row-2',
  'row-3',
  'row-4',
  'row-5',
  'column-B',
  'column-I',
  'column-N',
  'column-G',
  'column-O',
  'diagonal-main',
  'diagonal-anti',
  'four-corners',
  'full-house',
]);
export type WinPatternId = z.infer<typeof patternIdSchema>;

export const telegramUserSchema = z.object({
  id: z.number().int().positive().safe(),
  first_name: z.string().min(1),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  photo_url: z.string().url().optional(),
  is_premium: z.boolean().optional(),
  allows_write_to_pm: z.boolean().optional(),
});
export type TelegramUser = z.infer<typeof telegramUserSchema>;
export const userProfileSchema = z
  .object({
    id: identifierSchema,
    telegramId: z.number().int().positive().safe(),
    firstName: z.string().min(1),
    username: z.string().optional(),
  })
  .strict();
export type UserProfile = z.infer<typeof userProfileSchema>;

export const roomSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(100),
    stakeMinor: z.number().int().nonnegative().safe(),
    cardPoolSize: z.number().int().positive().safe(),
    status: z.enum(['open', 'closed']),
  })
  .strict();
export type Room = z.infer<typeof roomSchema>;

export const bingoCardSchema = z
  .object({
    cardNumber: z.number().int().positive().safe(),
    cells: z.array(z.number().int().min(0).max(TOTAL_NUMBERS)).length(25),
  })
  .strict()
  .superRefine((card, ctx) => {
    const seen = new Set<number>();
    card.cells.forEach((value, index) => {
      if (index === FREE_CELL_INDEX) {
        if (value !== 0)
          ctx.addIssue({
            code: 'custom',
            path: ['cells', index],
            message: 'Center must be free (0)',
          });
        return;
      }
      const column = BINGO_COLUMNS[index % 5];
      if (column === undefined) return;
      const [min, max] = COLUMN_RANGES[column];
      if (value < min || value > max)
        ctx.addIssue({
          code: 'custom',
          path: ['cells', index],
          message: 'Number outside column range',
        });
      if (seen.has(value))
        ctx.addIssue({ code: 'custom', path: ['cells', index], message: 'Duplicate number' });
      seen.add(value);
    });
  });
export type BingoCard = z.infer<typeof bingoCardSchema>;

export const calledNumbersSchema = z
  .array(numberSchema)
  .max(TOTAL_NUMBERS)
  .refine((values) => new Set(values).size === values.length, 'Numbers must be unique');
export const gameStateSchema = z
  .object({
    gameId: identifierSchema,
    roomId: identifierSchema,
    status: z.enum(['waiting', 'running', 'ended']),
    seq: sequenceSchema,
    calledNumbers: calledNumbersSchema,
    seedHash: seedHashSchema,
    yourCard: bingoCardSchema.optional(),
  })
  .strict();
export type GameState = z.infer<typeof gameStateSchema>;

export const claimResultSchema = z
  .object({
    gameId: identifierSchema,
    userId: identifierSchema,
    accepted: z.boolean(),
    patterns: z.array(patternIdSchema),
    seq: sequenceSchema,
  })
  .strict()
  .refine((result) => result.accepted === result.patterns.length > 0, {
    message: 'Accepted claims require winning patterns; rejected claims cannot have them',
  });
export type ClaimResult = z.infer<typeof claimResultSchema>;
