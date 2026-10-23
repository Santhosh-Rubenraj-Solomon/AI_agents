jest.mock('ai', () => ({ ...jest.requireActual('ai'), generateText: jest.fn() }));
jest.mock('@ai-sdk/openai', () => ({ openai: jest.fn(() => ({ __model: 'gpt-4o-mini' })) }));

import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { generateText } from 'ai';
import request from 'supertest';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { IdempotencyRedis } from '../src/idempotency/redis-client.provider';
import { LedgerRecord } from '../src/ledger/ledger.entity';
import { ReconcileModule } from '../src/reconcile/reconcile.module';
import { FakeRedis } from './helpers/fake-redis';

const mockedGenerateText = generateText as jest.MockedFunction<typeof generateText>;

/** In-memory replacement for the TypeORM Repository<LedgerRecord>. */
function makeRepo() {
  const rows = new Map<string, any>();
  return {
    rows,
    count: jest.fn(async () => rows.size),
    insert: jest.fn(async (list: any[]) => list.forEach((r) => rows.set(r.txId, { ...r }))),
    findOne: jest.fn(async ({ where: { txId } }: any) => (rows.has(txId) ? { ...rows.get(txId) } : null)),
    update: jest.fn(async ({ txId }: any, patch: any) => {
      if (!rows.has(txId)) return { affected: 0 };
      rows.set(txId, { ...rows.get(txId), ...patch });
      return { affected: 1 };
    }),
  };
}

/**
 * Simulates a well-behaved agent: reads the ledger, then heals the row to
 * SUCCESS when the amounts match and the vendor settled, else FAILED.
 */
function simulateAgent() {
  mockedGenerateText.mockImplementation(async (args: any) => {
    const dto = JSON.parse(args.prompt.match(/\{[\s\S]*\}/)[0]);
    const rec: any = await args.tools.checkInternalLedger.execute({ txId: dto.txId }, {});
    const steps: any[] = [{ toolCalls: [{ toolName: 'checkInternalLedger', args: { txId: dto.txId } }] }];
    if (rec.found && rec.status === 'PENDING') {
      const ok = Math.abs(rec.amount - dto.amount) <= 0.01 && dto.vendorStatus === 'paid';
      const a = { txId: dto.txId, status: ok ? 'SUCCESS' : 'FAILED', reason: 'sim' };
      await args.tools.updateInternalLedger.execute(a, {});
      steps.push({ toolCalls: [{ toolName: 'updateInternalLedger', args: a }] });
    }
    return { text: 'done', steps } as any;
  });
}

describe('POST /webhook/payment-reconcile (e2e)', () => {
  let app: INestApplication;
  let redis: FakeRedis;
  let repo: ReturnType<typeof makeRepo>;
  const url = '/webhook/payment-reconcile';

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedGenerateText.mockReset();
    simulateAgent();
    redis = new FakeRedis();
    repo = makeRepo();

    const mod = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ defaultTtlMs: 10_000, keyPrefix: 'lock:tx:' }), ReconcileModule],
    })
      .overrideProvider(IdempotencyRedis)
      .useValue({ client: redis })
      .overrideProvider(getRepositoryToken(LedgerRecord))
      .useValue(repo)
      .compile();

    app = mod.createNestApplication({ logger: false });
    // Same global pipe configuration as src/main.ts (verified in main.spec.ts).
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0); // init + bind once (avoids per-request listen in supertest); runs LedgerService.onModuleInit -> seeds the 3 demo rows
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('seeds the demo ledger on boot', () => {
    expect([...repo.rows.keys()]).toEqual(['tx_1001', 'tx_1002', 'tx_1003']);
  });

  it('reconciles a matching, settled payment to SUCCESS', async () => {
    const res = await request(app.getHttpServer())
      .post(url)
      .send({ txId: 'tx_1001', amount: 100.0, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body).toMatchObject({
      txId: 'tx_1001',
      summary: 'done',
      stepsUsed: 2,
      toolInvocations: [
        { tool: 'checkInternalLedger', args: { txId: 'tx_1001' } },
        { tool: 'updateInternalLedger', args: { txId: 'tx_1001', status: 'SUCCESS' } },
      ],
      finalLedgerState: { txId: 'tx_1001', status: 'SUCCESS', amount: 100 },
    });
    expect(repo.rows.get('tx_1001').status).toBe('SUCCESS');
    expect(redis.store.has('lock:tx:tx_1001')).toBe(true); // 'hold' strategy
  });

  it('marks an amount mismatch as FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post(url)
      .send({ txId: 'tx_1002', amount: 9999, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body.finalLedgerState.status).toBe('FAILED');
  });

  it('no-ops on an already settled transaction', async () => {
    const res = await request(app.getHttpServer())
      .post(url)
      .send({ txId: 'tx_1003', amount: 999, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body.toolInvocations).toHaveLength(1);
    expect(repo.update).not.toHaveBeenCalled();
    expect(res.body.finalLedgerState.status).toBe('SUCCESS');
  });

  it('reports unknown transactions with a null final state', async () => {
    const res = await request(app.getHttpServer())
      .post(url)
      .send({ txId: 'tx_9999', amount: 1, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body.finalLedgerState ?? null).toBeNull();
  });

  describe('idempotency lock', () => {
    it('rejects a duplicate txId within the TTL window with 429 before invoking the agent', async () => {
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      await request(app.getHttpServer()).post(url).send(body).expect(201);
      const dup = await request(app.getHttpServer()).post(url).send(body).expect(429);
      expect(dup.body).toMatchObject({ statusCode: 429, key: 'tx_1001' });
      expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    });

    it('lets exactly one of N concurrent identical webhooks through', async () => {
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      const codes = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app.getHttpServer()).post(url).send(body).then((r) => r.status),
        ),
      );
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 429)).toHaveLength(9);
    });

    it('different txIds do not block each other', async () => {
      await request(app.getHttpServer()).post(url).send({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' }).expect(201);
      await request(app.getHttpServer()).post(url).send({ txId: 'tx_1002', amount: 250, vendorStatus: 'paid' }).expect(201);
    });

    it('allows reprocessing once the TTL has elapsed', async () => {
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      await request(app.getHttpServer()).post(url).send(body).expect(201);
      // Expire the stored lock instead of waiting 10s.
      redis.store.get('lock:tx:tx_1001')!.expiresAt = Date.now() - 1;
      await request(app.getHttpServer()).post(url).send(body).expect(201);
    });

    it('returns 500 when Redis is unavailable (fails closed)', async () => {
      redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await request(app.getHttpServer())
        .post(url)
        .send({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' })
        .expect(500);
      expect(mockedGenerateText).not.toHaveBeenCalled();
    });

    it("with 'hold', a failed agent run keeps the lock for the TTL (documented behaviour)", async () => {
      mockedGenerateText.mockRejectedValueOnce(new Error('OpenAI 503'));
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      await request(app.getHttpServer()).post(url).send(body).expect(500);
      await request(app.getHttpServer()).post(url).send(body).expect(429);
    });

    // BUG (src/idempotency/idempotency-lock.guard.ts:51-79 + src/main.ts:18-24):
    // Nest runs guards BEFORE pipes, so the lock on body.txId is acquired before
    // the ValidationPipe rejects a malformed payload. With the default 'hold'
    // strategy a single malformed webhook (e.g. amount sent as a string) poisons
    // the txId for the whole 10s TTL: the vendor's corrected retry gets 429
    // instead of being processed. `it.failing` = expected failure (xfail);
    // it will start "failing" (i.e. alert) once the bug is fixed.
    it.failing('a rejected (400) malformed webhook should not block a valid retry', async () => {
      await request(app.getHttpServer())
        .post(url)
        .send({ txId: 'tx_1001', amount: 'one hundred', vendorStatus: 'paid' })
        .expect(400);
      await request(app.getHttpServer())
        .post(url)
        .send({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' })
        .expect(201);
    });
  });

  describe('payload validation', () => {
    it.each([
      ['amount as string', { txId: 'tx_1001', amount: '100', vendorStatus: 'paid' }],
      ['missing amount', { txId: 'tx_1001', vendorStatus: 'paid' }],
      ['missing vendorStatus', { txId: 'tx_1001', amount: 100 }],
      ['empty vendorStatus', { txId: 'tx_1001', amount: 100, vendorStatus: '' }],
      ['numeric txId', { txId: 1001, amount: 100, vendorStatus: 'paid' }],
      ['unknown extra field', { txId: 'tx_1001', amount: 100, vendorStatus: 'paid', hack: true }],
    ])('rejects %s with 400 and never calls the agent', async (_l, body) => {
      const res = await request(app.getHttpServer()).post(url).send(body).expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(mockedGenerateText).not.toHaveBeenCalled();
    });

    it('rejects a body without txId with 400 (guard: idempotency key required)', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .send({ amount: 100, vendorStatus: 'paid' })
        .expect(400);
      expect(res.body.message).toMatch(/idempotency key is required/);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('rejects an empty/non-JSON body with 400', async () => {
      await request(app.getHttpServer()).post(url).set('Content-Type', 'text/plain').send('hello').expect(400);
    });

    it('only accepts POST', async () => {
      await request(app.getHttpServer()).get(url).expect(404);
    });
  });

  describe('webhook authenticity', () => {
    // SECURITY GAP: there is no webhook signature / shared-secret verification
    // anywhere in src/ (reconcile.controller.ts accepts any JSON body). Anyone
    // who can reach the endpoint can make the agent mark ledger rows SUCCESS.
    // Documented as an expected failure until signature checking is added.
    it.failing('rejects an unsigned webhook', async () => {
      await request(app.getHttpServer())
        .post(url)
        .send({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' })
        .expect(401);
    });
  });

  it('surfaces agent/LLM failures as 500', async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app.getHttpServer())
      .post(url)
      .send({ txId: 'tx_1002', amount: 250, vendorStatus: 'paid' })
      .expect(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
