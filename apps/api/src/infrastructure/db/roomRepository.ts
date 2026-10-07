import { z } from 'zod';
import { patternIdSchema, type WinPatternId } from '@bingo/shared';
import type { Room } from '../../domain/entities.js';
import type { CreateRoomInput, RoomRepository, UpdateRoomInput } from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { isForeignKeyViolation, isRecordNotFound, isUuid, notFound } from './errors.js';

const roomFields = {
  name: z.string().trim().min(1).max(100),
  stakeMinor: z.bigint().nonnegative(),
  minPlayers: z.number().int().min(1),
  maxPlayers: z.number().int().min(1),
  drawIntervalMs: z.number().int().positive(),
  activePatterns: z.array(patternIdSchema).min(1),
  cardPoolSize: z.number().int().positive(),
};
const createSchema = z.object({
  ...roomFields,
  cardPoolSeed: z.string().min(16),
  createdById: z.string().uuid().nullish(),
}).refine((room) => room.maxPlayers >= room.minPlayers, 'maxPlayers must be >= minPlayers');
const updateSchema = z.object({ ...roomFields, status: z.enum(['OPEN', 'CLOSED']) }).partial();

// The secret seed is omitted from every query so it can never reach the domain entity.
const omitSecret = { cardPoolSeed: true } as const;

function toRoom(row: Omit<Room, 'activePatterns'> & { activePatterns: string[] }): Room {
  return { ...row, activePatterns: row.activePatterns as WinPatternId[] };
}

export class PrismaRoomRepository implements RoomRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateRoomInput): Promise<Room> {
    const data = createSchema.parse(input);
    try {
      return toRoom(await this.db.room.create({
        data: { ...data, createdById: data.createdById ?? null },
        omit: omitSecret,
      }));
    } catch (error) {
      if (isForeignKeyViolation(error)) throw notFound('User');
      throw error;
    }
  }

  async findById(id: string): Promise<Room | null> {
    if (!isUuid(id)) return null;
    const row = await this.db.room.findUnique({ where: { id }, omit: omitSecret });
    return row ? toRoom(row) : null;
  }

  async listOpen(): Promise<Room[]> {
    const rows = await this.db.room.findMany({
      where: { status: 'OPEN' }, omit: omitSecret, orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRoom);
  }

  async update(id: string, patch: UpdateRoomInput): Promise<Room> {
    if (!isUuid(id)) throw notFound('Room');
    const parsed = updateSchema.parse(patch);
    const data = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));
    try {
      return toRoom(await this.db.$transaction(async (tx) => {
        const updated = await tx.room.update({ where: { id }, data, omit: omitSecret });
        if (updated.maxPlayers < updated.minPlayers) {
          throw new z.ZodError([{
            code: 'custom', path: ['maxPlayers'], message: 'maxPlayers must be >= minPlayers',
          }]);
        }
        return updated;
      }));
    } catch (error) {
      if (isRecordNotFound(error)) throw notFound('Room');
      throw error;
    }
  }

  async getCardPoolSeed(id: string): Promise<string | null> {
    if (!isUuid(id)) return null;
    const row = await this.db.room.findUnique({ where: { id }, select: { cardPoolSeed: true } });
    return row?.cardPoolSeed ?? null;
  }
}
