import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { LedgerModule } from './ledger/ledger.module';
import { LedgerRecord } from './ledger/ledger.entity';
import { ReconcileModule } from './reconcile/reconcile.module';

@Module({
  imports: [
    // Durable, SHARED ledger — every replica reads/heals the same Postgres rows.
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5432/ledger',
      entities: [LedgerRecord],
      // Prototype convenience: auto-create the schema on boot. For strict
      // production, set DB_SYNC=false and run TypeORM migrations instead.
      synchronize: process.env.DB_SYNC !== 'false',
      retryAttempts: 10,
      retryDelay: 3000,
    }),
    // Reusable distributed idempotency locking — @IdempotencyLock() on any route.
    IdempotencyModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
      defaultTtlMs: 10_000,
      keyPrefix: 'lock:tx:',
    }),
    LedgerModule,
    ReconcileModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
