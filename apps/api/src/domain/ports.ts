import type { z } from 'zod';
import type { clientPayloadSchemas, userProfileSchema } from '@bingo/shared';

export type UserProfile = z.infer<typeof userProfileSchema>;
export type ClientEvent = keyof typeof clientPayloadSchemas;
export type ClientPayload<E extends ClientEvent> = z.infer<(typeof clientPayloadSchemas)[E]>;

export interface AuthenticationPort {
  authenticate(initData: string): Promise<UserProfile>;
}

export interface DependencyProbe {
  check(): Promise<boolean>;
}

export interface DependencyProbes {
  database?: DependencyProbe;
  redis?: DependencyProbe;
}

export interface SecretSource {
  bytes(size: number): Uint8Array;
}

export interface SeedVault {
  seal(seed: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export interface GameLock {
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface Scheduler {
  schedule(delayMs: number, operation: () => void): () => void;
}

export interface GameEventPublisher {
  publishUser(userId: string, event: string, payload: unknown): Promise<void>;
}

export interface EventContext {
  user: UserProfile;
  socketId: string;
  requestId: string;
}

export type ApplicationEventHandlers = {
  [E in ClientEvent]?: (payload: ClientPayload<E>, context: EventContext) => Promise<void>;
};
