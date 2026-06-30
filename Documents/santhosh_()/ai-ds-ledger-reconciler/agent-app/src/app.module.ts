import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { RedisModule } from './redis/redis.module';
import { LockModule } from './lock/lock.module';
import { LedgerModule } from './ledger/ledger.module';
import { ReconcileModule } from './reconcile/reconcile.module';

@Module({
  imports: [RedisModule, LockModule, LedgerModule, ReconcileModule],
  controllers: [AppController],
})
export class AppModule {}
