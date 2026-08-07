import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { ReconcileController } from './reconcile.controller';
import { ReconcileService } from './reconcile.service';

// IdempotencyModule is @Global (registered in AppModule.forRoot), so the
// @IdempotencyLock() guard/interceptor are available here without importing it.
@Module({
  imports: [LedgerModule],
  controllers: [ReconcileController],
  providers: [ReconcileService],
})
export class ReconcileModule {}
