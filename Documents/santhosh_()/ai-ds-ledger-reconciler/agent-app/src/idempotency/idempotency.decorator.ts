import { SetMetadata } from '@nestjs/common';
import { IDEMPOTENCY_META, IdempotencyLockOptions } from './idempotency.types';

/**
 * Marks a route handler as idempotency-locked. A per-key distributed Redis lock
 * is acquired before the handler runs; concurrent/duplicate calls for the same
 * key are rejected with HTTP 429 before the handler executes.
 *
 * @example
 *   // key = body.txId, 10s idempotency window (default 'hold')
 *   @Post('payment-reconcile')
 *   @IdempotencyLock()
 *   reconcile(@Body() dto: ReconcileDto) { ... }
 *
 * @example
 *   // custom key + TTL, released as soon as the handler finishes
 *   @IdempotencyLock({ key: 'orderId', ttlMs: 30_000, release: 'on-complete' })
 *
 * @example
 *   // derive the key any way you like
 *   @IdempotencyLock({ key: (req) => req.headers['idempotency-key'] })
 */
export const IdempotencyLock = (options: IdempotencyLockOptions = {}) =>
  SetMetadata(IDEMPOTENCY_META, options);
