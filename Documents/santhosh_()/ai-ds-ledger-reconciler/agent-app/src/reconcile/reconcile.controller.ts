import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { DistributedLockGuard } from '../lock/distributed-lock.guard';
import { ReconcileDto } from './dto/reconcile.dto';
import { ReconcileService } from './reconcile.service';

@Controller('webhook')
export class ReconcileController {
  constructor(private readonly reconcileService: ReconcileService) {}

  /**
   * POST /webhook/payment-reconcile
   *
   * Guard chain: DistributedLockGuard runs first and acquires a per-txId Redis
   * lock. Duplicate/concurrent calls for the same txId are rejected with 429
   * before the (expensive) AI agent is ever invoked.
   */
  @Post('payment-reconcile')
  @UseGuards(DistributedLockGuard)
  async paymentReconcile(@Body() dto: ReconcileDto) {
    return this.reconcileService.reconcile(dto);
  }
}
