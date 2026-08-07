import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as os from 'os';
import { LockService } from './lock.service';
import {
  IDEMPOTENCY_META,
  IDEMPOTENCY_OPTIONS,
  IdempotencyLockOptions,
  IdempotencyModuleOptions,
} from './idempotency.types';

/** Request augmented with the acquired-lock context (read by the interceptor). */
export interface LockedRequest {
  __idem?: { key: string; token: string; release: 'hold' | 'on-complete' };
  body?: Record<string, unknown>;
}

/**
 * Global guard that only acts on handlers decorated with @IdempotencyLock().
 * Acquires the per-key Redis lock before the handler runs; rejects duplicates
 * with 429. When several replicas receive the same key in the same instant,
 * exactly one wins the `SET NX` — the rest are dropped.
 */
@Injectable()
export class IdempotencyLockGuard implements CanActivate {
  private readonly logger = new Logger('IdempotencyLock');
  private readonly instance = os.hostname();

  constructor(
    private readonly reflector: Reflector,
    private readonly lock: LockService,
    @Inject(IDEMPOTENCY_OPTIONS) private readonly moduleOpts: IdempotencyModuleOptions,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.get<IdempotencyLockOptions | undefined>(
      IDEMPOTENCY_META,
      ctx.getHandler(),
    );
    if (!opts) return true; // route is not idempotency-locked

    const req = ctx.switchToHttp().getRequest<LockedRequest>();
    const key = this.extractKey(opts, req);
    if (!key) {
      throw new BadRequestException(
        'An idempotency key is required but was not present on the request',
      );
    }

    const ttlMs = opts.ttlMs ?? this.moduleOpts.defaultTtlMs ?? 10_000;
    const token = await this.lock.acquire(key, ttlMs);

    if (!token) {
      this.logger.warn(`[${this.instance}] 429 duplicate for key=${key} (held by another node)`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `"${key}" is already being processed`,
          key,
          instance: this.instance,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    req.__idem = { key, token, release: opts.release ?? 'hold' };
    this.logger.log(
      `[${this.instance}] acquired lock key=${key} (token=${token.slice(0, 8)}…, ttl=${ttlMs}ms)`,
    );
    return true;
  }

  private extractKey(opts: IdempotencyLockOptions, req: LockedRequest): string | undefined {
    const k = opts.key ?? 'txId';
    const raw = typeof k === 'function' ? k(req) : req.body?.[k];
    return raw != null && String(raw).length > 0 ? String(raw) : undefined;
  }
}
