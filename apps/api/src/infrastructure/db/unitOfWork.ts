import type { UnitOfWork } from '../../domain/ports.js';
import type { TransactionRepositories } from '../../domain/repositories.js';
import { createRepositories } from './index.js';
import type { Db } from './prisma.js';

export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Db) {}

  withTransaction<T>(
    operation: (repositories: TransactionRepositories) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction((tx) =>
      operation(createRepositories(tx as unknown as Db, true)),
    );
  }
}
