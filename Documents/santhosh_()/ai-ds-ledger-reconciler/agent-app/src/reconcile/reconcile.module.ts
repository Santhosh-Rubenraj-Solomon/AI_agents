import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WEBHOOK_AUTH_OPTIONS, webhookAuthOptionsFromEnv } from '../webhook-auth/webhook-signature';
import { WebhookSignatureMiddleware } from '../webhook-auth/webhook-signature.middleware';
import { ReconcileController } from './reconcile.controller';
import { ReconcileService } from './reconcile.service';

// IdempotencyModule is @Global (registered in AppModule.forRoot), so the
// @IdempotencyLock() guard/interceptor are available here without importing it.
@Module({
  imports: [LedgerModule],
  controllers: [ReconcileController],
  providers: [
    ReconcileService,
    { provide: WEBHOOK_AUTH_OPTIONS, useFactory: () => webhookAuthOptionsFromEnv() },
  ],
})
export class ReconcileModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware runs before all guards: a webhook without a valid HMAC is
    // rejected (401) before the idempotency lock is touched.
    consumer.apply(WebhookSignatureMiddleware).forRoutes(ReconcileController);
  }
}
