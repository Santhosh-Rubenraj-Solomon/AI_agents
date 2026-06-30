import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

/**
 * Atomic distributed lock backed by Redis (Redlock-style, single node).
 *
 *  acquire(): SET lock:<key> <token> PX <ttl> NX
 *    - NX  => only sets if the key does NOT exist (atomic check-and-set)
 *    - PX  => millisecond TTL so a crashed holder can never deadlock the system
 *    - The unique <token> proves ownership, so we never release someone
 *      else's lock after our TTL has lapsed and another node has taken over.
 *
 *  release(): atomic compare-and-delete via Lua (GET == token ? DEL : noop)
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name);

  // Atomic "release only if I still own it" — prevents a slow node from
  // deleting a lock that a different node has since legitimately acquired.
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end`;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Attempts to acquire the lock. Returns an ownership token on success, or
   * null if another instance currently holds it.
   */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(this.k(key), token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /** Releases the lock iff the provided token still owns it. */
  async release(key: string, token: string): Promise<boolean> {
    const deleted = (await this.redis.eval(
      LockService.RELEASE_SCRIPT,
      1,
      this.k(key),
      token,
    )) as number;
    return deleted === 1;
  }

  private k(key: string): string {
    return `lock:tx:${key}`;
  }
}
