import type { z } from 'zod';
import type { clientPayloadSchemas, userProfileSchema } from '@bingo/shared';
import type { TransactionRepositories } from './repositories.js';

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
  publishRoom?(roomId: string, event: string, payload: unknown): Promise<void>;
}

export interface UnitOfWork {
  withTransaction<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
}

export interface RateLimiter {
  consume(key: string, max: number, windowMs: number): Promise<boolean>;
}

export interface EventContext {
  user: UserProfile;
  socketId: string;
  requestId: string;
  joinRoom?(room: string): Promise<void>;
  leaveRoom?(room: string): Promise<void>;
}

export type ApplicationEventHandlers = {
  [E in ClientEvent]?: (payload: ClientPayload<E>, context: EventContext) => Promise<void>;
};
