import type { DependencyProbes } from '../domain/ports.js';

export type DependencyStatus = 'not_configured' | 'unavailable' | 'available';

export async function assessReadiness(
  configured: { database: boolean; redis: boolean },
  probes: DependencyProbes,
): Promise<{ ready: boolean; dependencies: Record<'database' | 'redis', DependencyStatus> }> {
  const inspect = async (name: 'database' | 'redis'): Promise<DependencyStatus> => {
    if (!configured[name]) return 'not_configured';
    const probe = probes[name];
    if (!probe) return 'unavailable';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        probe.check(),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 2000);
          timeout.unref();
        }),
      ]);
      return result === true ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const [database, redis] = await Promise.all([inspect('database'), inspect('redis')]);
  return {
    ready: database === 'available' && redis === 'available',
    dependencies: { database, redis },
  };
}
