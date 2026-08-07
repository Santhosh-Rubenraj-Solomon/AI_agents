import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { IDEMPOTENCY_OPTIONS, IdempotencyModuleOptions } from './idempotency.types';
import { IdempotencyRedis } from './redis-client.provider';
import { LockService } from './lock.service';
import { IdempotencyLockGuard } from './idempotency-lock.guard';
import { IdempotencyReleaseInterceptor } from './idempotency-release.interceptor';

/**
 * Drop-in distributed idempotency locking for NestJS.
 *
 *   @Module({
 *     imports: [
 *       IdempotencyModule.forRoot({
 *         redis: { host: 'redis', port: 6379 }, // or pass an existing ioredis client
 *         defaultTtlMs: 10_000,
 *         keyPrefix: 'lock:',
 *       }),
 *     ],
 *   })
 *   export class AppModule {}
 *
 * Then decorate any handler with `@IdempotencyLock()`. The guard + interceptor
 * are registered globally but only act on decorated routes. `LockService` is
 * exported for direct use of the raw primitive (`acquire` / `release` / `withLock`).
 */
@Global()
@Module({})
export class IdempotencyModule {
  static forRoot(options: IdempotencyModuleOptions = {}): DynamicModule {
    return {
      module: IdempotencyModule,
      providers: [
        {
          provide: IDEMPOTENCY_OPTIONS,
          useValue: { defaultTtlMs: 10_000, keyPrefix: 'lock:', ...options },
        },
        IdempotencyRedis,
        LockService,
        { provide: APP_GUARD, useClass: IdempotencyLockGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyReleaseInterceptor },
      ],
      exports: [LockService, IdempotencyRedis, IDEMPOTENCY_OPTIONS],
    };
  }
}
