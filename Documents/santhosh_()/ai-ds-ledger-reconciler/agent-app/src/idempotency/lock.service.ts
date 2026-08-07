import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IdempotencyRedis } from './redis-client.provider';
import { IDEMPOTENCY_OPTIONS, IdempotencyModuleOptions } from './idempotency.types';

/**
 * Atomic distributed lock backed by Redis (Redlock-style, single node).
 *
 *  acquire(): SET <prefix><key> <token> PX <ttl> NX
 *    - NX  => only sets if the key does NOT exist (atomic check-and-set)
 *    - PX  => millisecond TTL so a crashed holder can never deadlock the system
 *    - the unique <token> proves ownership, so we never release someone else's
 *      lock after our TTL has lapsed and another node has legitimately taken it.
 *
 *  release(): atomic compare-and-delete via Lua (GET == token ? DEL : noop)
 *
 * Exported directly so you can use the raw primitive without the guard/decorator.
 */
@Injectable()
export class LockService {
  // "Release only if I still own it" — prevents a slow node from deleting a
  // lock that a different node has since legitimately acquired.
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end`;

  private readonly prefix: string;

  constructor(
    private readonly redis: IdempotencyRedis,
    @Inject(IDEMPOTENCY_OPTIONS) opts: IdempotencyModuleOptions,
  ) {
    this.prefix = opts.keyPrefix ?? 'lock:';
  }

  /** Acquire the lock; returns an ownership token, or null if already held. */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.client.set(this.k(key), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /** Release the lock iff the provided token still owns it. */
  async release(key: string, token: string): Promise<boolean> {
    const deleted = (await this.redis.client.eval(
      LockService.RELEASE_SCRIPT,
      1,
      this.k(key),
      token,
    )) as number;
    return deleted === 1;
  }

  /** Run `fn` under the lock, releasing when it settles. Returns null if held. */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
    const token = await this.acquire(key, ttlMs);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.release(key, token);
    }
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }
}
