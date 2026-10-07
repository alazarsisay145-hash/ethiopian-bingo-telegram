import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createRepositories, type Repositories } from './infrastructure/db/index.js';

export function createTestDb(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url });
}

export interface Fixtures {
  repos: Repositories;
  db: PrismaClient;
  newUser(): Promise<{ id: string }>;
  newGame(): Promise<{ id: string; roomId: string }>;
}

export function createFixtures(url: string): Fixtures {
  const db = createTestDb(url);
  const repos = createRepositories(db);
  return {
    repos,
    db,
    newUser: () => repos.users.upsertFromTelegram({
      telegramId: BigInt(Math.floor(Math.random() * 1e12) + 1),
      firstName: 'Test',
    }),
    newGame: async () => {
      const room = await repos.rooms.create({
        name: `room-${randomUUID()}`, stakeMinor: 10n, minPlayers: 2, maxPlayers: 10,
        drawIntervalMs: 3000, activePatterns: ['row-1'], cardPoolSize: 100,
        cardPoolSeed: randomBytes(16).toString('hex'),
      });
      return repos.games.create({ roomId: room.id });
    },
  };
}

export const cells = (): number[] => Array.from({ length: 25 }, (_, i) => i + 1);
