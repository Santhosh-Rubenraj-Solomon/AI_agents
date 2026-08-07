import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { IDEMPOTENCY_OPTIONS, IdempotencyModuleOptions } from './idempotency.types';

/**
 * Owns the ioredis connection used for locking.
 *  - If the caller passed their own client, we reuse it and DO NOT close it
 *    (they own its lifecycle).
 *  - If we created it from options/env, we quit() it on application shutdown.
 */
@Injectable()
export class IdempotencyRedis implements OnApplicationShutdown {
  private readonly logger = new Logger('IdempotencyRedis');
  readonly client: Redis;
  private readonly owns: boolean;

  constructor(@Inject(IDEMPOTENCY_OPTIONS) opts: IdempotencyModuleOptions) {
    if (opts.redis instanceof Redis) {
      this.client = opts.redis;
      this.owns = false;
    } else {
      this.client = new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: 3,
        ...((opts.redis as RedisOptions) ?? {}),
      });
      this.owns = true;
    }
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err) => this.logger.error(err.message));
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.owns) {
      await this.client.quit().catch(() => undefined);
    }
  }
}
