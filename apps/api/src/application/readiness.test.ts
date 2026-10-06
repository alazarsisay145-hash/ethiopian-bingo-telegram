import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessReadiness } from './readiness.js';

afterEach(() => vi.useRealTimers());

describe('dependency readiness', () => {
  it('bounds the time spent waiting on an unavailable probe', async () => {
    vi.useFakeTimers();
    const result = assessReadiness({ database: true, redis: true }, {
      database: { check: () => new Promise<boolean>(() => undefined) },
      redis: { check: async () => true },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({
      ready: false, dependencies: { database: 'unavailable', redis: 'available' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never probes unconfigured services', async () => {
    const check = vi.fn(async () => true);
    expect(await assessReadiness({ database: false, redis: false }, {
      database: { check }, redis: { check },
    })).toEqual({
      ready: false, dependencies: { database: 'not_configured', redis: 'not_configured' },
    });
    expect(check).not.toHaveBeenCalled();
  });
});
