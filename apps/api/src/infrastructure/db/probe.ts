import type { DependencyProbe } from '../../domain/ports.js';
import type { Db } from './prisma.js';

export class PostgresProbe implements DependencyProbe {
  constructor(private readonly db: Db, private readonly timeoutMs = 1500) {}

  async check(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const query = this.db.$queryRaw`SELECT 1 AS ok`.then(() => true);
      query.catch(() => undefined);
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.timeoutMs);
        timer.unref();
      });
      return await Promise.race([query, timeout]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
