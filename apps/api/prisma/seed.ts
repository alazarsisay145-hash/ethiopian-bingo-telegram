import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The development room seed is disabled in production');
}

const db = new PrismaClient();

try {
  const rooms = [
    {
      name: 'Development · Free',
      stakeMinor: 0n,
      minPlayers: 2,
      maxPlayers: 10,
      drawIntervalMs: 5000,
      activePatterns: ['row-1', 'column-B', 'diagonal-main'],
      cardPoolSize: 100,
    },
    {
      name: 'Development · Practice',
      stakeMinor: 0n,
      minPlayers: 2,
      maxPlayers: 20,
      drawIntervalMs: 7000,
      activePatterns: ['row-1', 'row-2', 'four-corners', 'full-house'],
      cardPoolSize: 200,
    },
  ];
  for (const room of rooms) {
    const exists = await db.room.findFirst({ where: { name: room.name } });
    if (exists) continue;
    await db.room.create({
      data: {
        ...room,
        startCountdownMs: 15000,
        cardPoolSeed: randomBytes(32).toString('base64url'),
      },
    });
  }
  console.log('Development rooms seeded');
} finally {
  await db.$disconnect();
}
