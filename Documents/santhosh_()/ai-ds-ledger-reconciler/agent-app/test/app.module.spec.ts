import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { AppController } from '../src/app.controller';
import { LedgerModule } from '../src/ledger/ledger.module';
import { ReconcileModule } from '../src/reconcile/reconcile.module';
import { ReconcileController } from '../src/reconcile/reconcile.controller';
import { ReconcileService } from '../src/reconcile/reconcile.service';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';

// Static wiring checks only — compiling AppModule would open real Postgres/Redis
// connections, so the HTTP behaviour is exercised in the e2e spec instead.
describe('module wiring', () => {
  it('AppModule registers AppController and imports ledger, reconcile and idempotency modules', () => {
    const imports: any[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule)).toEqual([AppController]);
    expect(imports).toEqual(expect.arrayContaining([LedgerModule, ReconcileModule]));
    const idem = imports.find((i) => i?.module === IdempotencyModule);
    expect(idem).toBeDefined();
    const opts = idem.providers.find((p: any) => typeof p === 'object' && p.useValue?.keyPrefix);
    expect(opts.useValue).toMatchObject({ defaultTtlMs: 10_000, keyPrefix: 'lock:tx:' });
  });

  it('ReconcileModule exposes the webhook controller and service', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReconcileModule)).toEqual([ReconcileController]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ReconcileModule)).toEqual([ReconcileService]);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ReconcileModule)).toEqual([LedgerModule]);
  });
});
