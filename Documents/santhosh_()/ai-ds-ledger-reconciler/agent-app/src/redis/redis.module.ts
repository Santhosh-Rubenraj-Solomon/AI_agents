import { Global, Module, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Provides a single shared ioredis connection to the whole app. Marked @Global
 * so any module can inject REDIS_CLIENT without re-importing this module.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        const client = new Redis({
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: 3,
        });
        client.on('connect', () => Logger.log('Connected to Redis', 'RedisModule'));
        client.on('error', (err) => Logger.error(err.message, undefined, 'RedisModule'));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  // Note: ioredis cleanup on shutdown would be wired here via the injected
  // client in a fuller implementation; omitted to keep the prototype lean.
  onApplicationShutdown(): void {}
}
