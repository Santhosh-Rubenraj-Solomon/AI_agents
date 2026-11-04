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
import { WEBHOOK_AUTH_OPTIONS, computeSignature } from '../src/webhook-auth/webhook-signature';

const mockedGenerateText = generateText as jest.MockedFunction<typeof generateText>;
const SECRET = 'test-webhook-secret';

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

  /** POSTs `body` as JSON with a valid HMAC-SHA256 X-Signature over the exact bytes sent. */
  const post = (body: unknown, opts: { timestamp?: string; secret?: string } = {}) => {
    const raw = JSON.stringify(body);
    const req = request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Signature', `sha256=${computeSignature(opts.secret ?? SECRET, raw, opts.timestamp)}`);
    if (opts.timestamp !== undefined) req.set('X-Signature-Timestamp', opts.timestamp);
    return req.send(raw);
  };

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
      .overrideProvider(WEBHOOK_AUTH_OPTIONS)
      .useValue({ secret: SECRET, toleranceSeconds: 300, requireTimestamp: false })
      .compile();

    // rawBody: true, as in src/main.ts — the signature is checked over the raw bytes.
    app = mod.createNestApplication({ logger: false, rawBody: true });
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
    const res = await post({ txId: 'tx_1001', amount: 100.0, vendorStatus: 'paid' })
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
    const res = await post({ txId: 'tx_1002', amount: 9999, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body.finalLedgerState.status).toBe('FAILED');
  });

  it('no-ops on an already settled transaction', async () => {
    const res = await post({ txId: 'tx_1003', amount: 999, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body.toolInvocations).toHaveLength(1);
    expect(repo.update).not.toHaveBeenCalled();
    expect(res.body.finalLedgerState.status).toBe('SUCCESS');
  });

  it('reports unknown transactions with a null final state', async () => {
    const res = await post({ txId: 'tx_9999', amount: 1, vendorStatus: 'paid' })
      .expect(201);
    expect(res.body.finalLedgerState ?? null).toBeNull();
  });

  describe('idempotency lock', () => {
    it('rejects a duplicate txId within the TTL window with 429 before invoking the agent', async () => {
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      await post(body).expect(201);
      const dup = await post(body).expect(429);
      expect(dup.body).toMatchObject({ statusCode: 429, key: 'tx_1001' });
      expect(mockedGenerateText).toHaveBeenCalledTimes(1);
    });

    it('lets exactly one of N concurrent identical webhooks through', async () => {
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      const codes = await Promise.all(
        Array.from({ length: 10 }, () =>
          post(body).then((r) => r.status),
        ),
      );
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 429)).toHaveLength(9);
    });

    it('different txIds do not block each other', async () => {
      await post({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' }).expect(201);
      await post({ txId: 'tx_1002', amount: 250, vendorStatus: 'paid' }).expect(201);
    });

    it('allows reprocessing once the TTL has elapsed', async () => {
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      await post(body).expect(201);
      // Expire the stored lock instead of waiting 10s.
      redis.store.get('lock:tx:tx_1001')!.expiresAt = Date.now() - 1;
      await post(body).expect(201);
    });

    it('returns 500 when Redis is unavailable (fails closed)', async () => {
      redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await post({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' })
        .expect(500);
      expect(mockedGenerateText).not.toHaveBeenCalled();
    });

    it("with 'hold', a failed agent run keeps the lock for the TTL (documented behaviour)", async () => {
      mockedGenerateText.mockRejectedValueOnce(new Error('OpenAI 503'));
      const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
      await post(body).expect(500);
      await post(body).expect(429);
    });

    // Regression: Nest runs guards BEFORE pipes, so the lock on body.txId used to
    // be acquired before the ValidationPipe rejected a malformed payload, and with
    // 'hold' the vendor's corrected retry got 429 for the whole TTL. The guard now
    // validates the body (@IdempotencyLock({ validate: ReconcileDto })) first.
    it('a rejected (400) malformed webhook does not block a valid retry', async () => {
      await post({ txId: 'tx_1001', amount: 'one hundred', vendorStatus: 'paid' })
        .expect(400);
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.store.has('lock:tx:tx_1001')).toBe(false);
      await post({ txId: 'tx_1001', amount: 100, vendorStatus: 'paid' })
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
      const res = await post(body).expect(400);
      expect(res.body.statusCode).toBe(400);
      expect(mockedGenerateText).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled(); // never takes the idempotency lock
    });

    it('rejects a body without txId with 400 (guard: idempotency key required)', async () => {
      const res = await post({ amount: 100, vendorStatus: 'paid' })
        .expect(400);
      expect(res.body.message).toMatch(/idempotency key is required/);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('rejects an empty JSON body with 400', async () => {
      await post({}).expect(400);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('rejects a non-JSON body (raw body unavailable for signature check) with 401', async () => {
      await request(app.getHttpServer())
        .post(url)
        .set('Content-Type', 'text/plain')
        .set('X-Signature', `sha256=${computeSignature(SECRET, 'hello')}`)
        .send('hello')
        .expect(401);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('only accepts POST', async () => {
      await request(app.getHttpServer()).get(url).expect(404);
    });
  });

  describe('webhook authenticity', () => {
    // Security regression: the endpoint used to accept any JSON body, so anyone
    // who could reach it could make the agent mark ledger rows SUCCESS.
    const body = { txId: 'tx_1001', amount: 100, vendorStatus: 'paid' };
    const expectRejectedBeforeLock = () => {
      expect(redis.set).not.toHaveBeenCalled();
      expect(mockedGenerateText).not.toHaveBeenCalled();
    };

    it('rejects an unsigned webhook with 401 before taking the lock', async () => {
      const res = await request(app.getHttpServer()).post(url).send(body).expect(401);
      expect(res.body).toMatchObject({ statusCode: 401, message: 'Invalid or missing webhook signature' });
      expectRejectedBeforeLock();
      // ...and it did not poison the txId for the signed retry
      await post(body).expect(201);
    });

    it.each([
      ['wrong secret', { 'X-Signature': `sha256=${computeSignature('other', JSON.stringify(body))}` }],
      ['garbage signature', { 'X-Signature': 'sha256=not-hex' }],
      ['truncated signature', { 'X-Signature': computeSignature(SECRET, JSON.stringify(body)).slice(0, 32) }],
    ])('rejects a %s with 401', async (_l, headers) => {
      await request(app.getHttpServer())
        .post(url)
        .set('Content-Type', 'application/json')
        .set(headers)
        .send(JSON.stringify(body))
        .expect(401);
      expectRejectedBeforeLock();
    });

    it('rejects a body tampered with after signing', async () => {
      const sig = computeSignature(SECRET, JSON.stringify(body));
      await request(app.getHttpServer())
        .post(url)
        .set('Content-Type', 'application/json')
        .set('X-Signature', `sha256=${sig}`)
        .send(JSON.stringify({ ...body, amount: 1 }))
        .expect(401);
      expectRejectedBeforeLock();
    });

    it('verifies over the exact raw bytes (whitespace/key order preserved)', async () => {
      const raw = '{ "vendorStatus": "paid",\n  "amount": 100.0, "txId": "tx_1001" }';
      await request(app.getHttpServer())
        .post(url)
        .set('Content-Type', 'application/json')
        .set('X-Signature', computeSignature(SECRET, raw)) // bare hex is accepted too
        .send(raw)
        .expect(201);
    });

    it('accepts a fresh timestamped signature and rejects a stale or re-dated one', async () => {
      const now = String(Math.floor(Date.now() / 1000));
      const stale = String(Math.floor(Date.now() / 1000) - 301);
      await post(body, { timestamp: stale }).expect(401);
      // replaying the signature with a fresh timestamp header fails the MAC
      const sig = computeSignature(SECRET, JSON.stringify(body), stale);
      await request(app.getHttpServer())
        .post(url)
        .set('Content-Type', 'application/json')
        .set('X-Signature', `sha256=${sig}`)
        .set('X-Signature-Timestamp', now)
        .send(JSON.stringify(body))
        .expect(401);
      expectRejectedBeforeLock();
      await post(body, { timestamp: now }).expect(201);
    });
  });

  it('surfaces agent/LLM failures as 500', async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error('boom'));
    const res = await post({ txId: 'tx_1002', amount: 250, vendorStatus: 'paid' })
      .expect(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
