import { Module } from '@nestjs/common';
import { LockModule } from '../lock/lock.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ReconcileController } from './reconcile.controller';
import { ReconcileService } from './reconcile.service';

@Module({
  imports: [LockModule, LedgerModule],
  controllers: [ReconcileController],
  providers: [ReconcileService],
})
export class ReconcileModule {}
