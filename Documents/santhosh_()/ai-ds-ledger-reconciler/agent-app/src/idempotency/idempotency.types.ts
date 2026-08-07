import type { Redis, RedisOptions } from 'ioredis';

/** Per-route configuration for the @IdempotencyLock() decorator. */
export interface IdempotencyLockOptions {
  /**
   * How to derive the idempotency key from the request.
   *  - string:   a body field name, read from `req.body[field]` (default: 'txId')
   *  - function: full control; receives the raw request, returns the key
   */
  key?: string | ((req: any) => string | undefined | null);

  /** Lock TTL in ms. Falls back to the module's `defaultTtlMs`. */
  ttlMs?: number;

  /**
   *  - 'hold' (default): the lock is never released on success; its TTL IS the
   *    idempotency window — a duplicate key within the TTL is rejected (429),
   *    not reprocessed. The TTL also guarantees no deadlock if a holder crashes.
   *  - 'on-complete': the lock is released after the handler settles (success OR
   *    error), allowing immediate legitimate reprocessing.
   */
  release?: 'hold' | 'on-complete';
}

/** Configuration passed to IdempotencyModule.forRoot(). */
export interface IdempotencyModuleOptions {
  /** An existing ioredis client to reuse, or connection options to create one. */
  redis?: Redis | RedisOptions;
  /** Default lock TTL in ms when a route doesn't specify one (default 10_000). */
  defaultTtlMs?: number;
  /** Redis key prefix for locks (default 'lock:'). */
  keyPrefix?: string;
}

export const IDEMPOTENCY_OPTIONS = Symbol('IDEMPOTENCY_OPTIONS');
export const IDEMPOTENCY_META = 'idempotency:lock';
