import type { Clock, Scheduler } from '../../domain/ports.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SystemScheduler implements Scheduler {
  schedule(delayMs: number, operation: () => void): () => void {
    const timer = setTimeout(operation, delayMs);
    return () => clearTimeout(timer);
  }
}
