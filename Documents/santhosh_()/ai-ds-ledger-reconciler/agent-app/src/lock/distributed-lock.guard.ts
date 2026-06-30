import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import * as os from 'os';
import { LockService } from './lock.service';

/**
 * DistributedLockGuard
 * --------------------
 * Runs BEFORE the route handler. It reads `txId` from the request body and
 * tries to acquire a Redis lock for that transaction.
 *
 *   - Lock acquired      -> request proceeds, handler runs.
 *   - Lock NOT acquired  -> 429 Too Many Requests; the concurrent execution is
 *                           dropped and logged.
 *
 * This is exactly the guarantee asked for: when the same webhook is retried
 * rapidly and lands on replica #1 and replica #2 in the same millisecond, only
 * one of them wins the `SET NX` and the other is rejected with 429.
 *
 * TTL / release strategy
 * ----------------------
 * We acquire with a 10s TTL and DO NOT release on success. The lock simply
 * expires, which turns it into a 10-second idempotency window: a duplicate of
 * the same txId within 10s is rejected, not reprocessed. The TTL guarantees no
 * deadlock if a holder crashes mid-flight. (If you'd rather allow legitimate
 * reprocessing immediately after completion, call `lock.release(txId, token)`
 * in the handler/service `finally` block using `req.lockToken`.)
 */
const LOCK_TTL_MS = 10_000;

@Injectable()
export class DistributedLockGuard implements CanActivate {
  private readonly logger = new Logger(DistributedLockGuard.name);
  private readonly instance = os.hostname();

  constructor(private readonly lock: LockService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { lockToken?: string }>();
    const txId = req.body?.txId;

    if (!txId || typeof txId !== 'string') {
      throw new BadRequestException('txId is required to acquire a processing lock');
    }

    const token = await this.lock.acquire(txId, LOCK_TTL_MS);

    if (!token) {
      this.logger.warn(
        `[${this.instance}] DROPPED concurrent execution for txId=${txId} — lock held by another instance`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Transaction ${txId} is already being processed by another node`,
          txId,
          instance: this.instance,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.logger.log(
      `[${this.instance}] acquired lock for txId=${txId} (token=${token.slice(0, 8)}…, ttl=${LOCK_TTL_MS}ms)`,
    );
    // Expose the token to the handler in case it wants to release early.
    req.lockToken = token;
    return true;
  }
}
