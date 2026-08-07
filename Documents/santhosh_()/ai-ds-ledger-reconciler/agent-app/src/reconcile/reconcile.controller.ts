import { Body, Controller, Post } from '@nestjs/common';
import { IdempotencyLock } from '../idempotency/idempotency.decorator';
import { ReconcileDto } from './dto/reconcile.dto';
import { ReconcileService } from './reconcile.service';

@Controller('webhook')
export class ReconcileController {
  constructor(private readonly reconcileService: ReconcileService) {}

  /**
   * POST /webhook/payment-reconcile
   *
   * @IdempotencyLock() acquires a per-txId Redis lock before the handler runs.
   * A duplicate/concurrent webhook for the same txId is rejected with 429 —
   * before the (expensive) AI agent is ever invoked. With the default
   * `release: 'hold'`, the 10s TTL doubles as an idempotency window.
   */
  @Post('payment-reconcile')
  @IdempotencyLock() // key = body.txId, 10s idempotency window
  async paymentReconcile(@Body() dto: ReconcileDto) {
    return this.reconcileService.reconcile(dto);
  }
}
