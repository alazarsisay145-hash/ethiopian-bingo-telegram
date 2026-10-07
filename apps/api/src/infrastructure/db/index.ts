import type {
  AuditLogRepository, ClaimRepository, GameEventRepository, GamePlayerRepository, GameRepository,
  LedgerRepository, RoomRepository, UserRepository,
} from '../../domain/repositories.js';
import type { Db } from './prisma.js';
import { PrismaAuditLogRepository } from './auditLogRepository.js';
import { PrismaClaimRepository } from './claimRepository.js';
import { PrismaGameEventRepository } from './gameEventRepository.js';
import { PrismaGamePlayerRepository } from './gamePlayerRepository.js';
import { PrismaGameRepository } from './gameRepository.js';
import { PrismaLedgerRepository } from './ledgerRepository.js';
import { PrismaRoomRepository } from './roomRepository.js';
import { PrismaUserRepository } from './userRepository.js';

export interface Repositories {
  users: UserRepository;
  rooms: RoomRepository;
  games: GameRepository;
  gamePlayers: GamePlayerRepository;
  gameEvents: GameEventRepository;
  claims: ClaimRepository;
  ledger: LedgerRepository;
  auditLogs: AuditLogRepository;
}

export function createRepositories(
  db: Db,
  transactional = false,
  adminTelegramIds: readonly number[] = [],
): Repositories {
  return {
    users: new PrismaUserRepository(db, adminTelegramIds),
    rooms: new PrismaRoomRepository(db),
    games: new PrismaGameRepository(db),
    gamePlayers: new PrismaGamePlayerRepository(db),
    gameEvents: new PrismaGameEventRepository(db, transactional),
    claims: new PrismaClaimRepository(db),
    ledger: new PrismaLedgerRepository(db, transactional),
    auditLogs: new PrismaAuditLogRepository(db),
  };
}

export { createPrismaClient, type Db } from './prisma.js';
export { PostgresProbe } from './probe.js';
export { PrismaUnitOfWork } from './unitOfWork.js';
