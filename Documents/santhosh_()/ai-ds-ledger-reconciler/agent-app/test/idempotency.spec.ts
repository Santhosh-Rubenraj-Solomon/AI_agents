import { BadRequestException, Logger, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import Redis from 'ioredis';
import { IdempotencyLock } from '../src/idempotency/idempotency.decorator';
import { IdempotencyLockGuard, LockedRequest } from '../src/idempotency/idempotency-lock.guard';
import { IdempotencyReleaseInterceptor } from '../src/idempotency/idempotency-release.interceptor';
import { IdempotencyRedis } from '../src/idempotency/redis-client.provider';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { LockService } from '../src/idempotency/lock.service';
import { IDEMPOTENCY_META, IDEMPOTENCY_OPTIONS } from '../src/idempotency/idempotency.types';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

function ctxFor(handler: Function, req: LockedRequest & Record<string, any>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => undefined }),
  } as unknown as ExecutionContext;
}

describe('@IdempotencyLock decorator', () => {
  it('stores the options (default {}) as route metadata', () => {
    class C {
      @IdempotencyLock()
      a() {}
      @IdempotencyLock({ key: 'orderId', ttlMs: 30_000, release: 'on-complete' })
      b() {}
    }
    const r = new Reflector();
    expect(r.get(IDEMPOTENCY_META, C.prototype.a)).toEqual({});
    expect(r.get(IDEMPOTENCY_META, C.prototype.b)).toEqual({
      key: 'orderId',
      ttlMs: 30_000,
      release: 'on-complete',
    });
  });
});

describe('IdempotencyLockGuard', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());
  let lock: { acquire: jest.Mock; release: jest.Mock };
  let guard: IdempotencyLockGuard;

  class Handlers {
    plain() {}
    @IdempotencyLock()
    defaults() {}
    @IdempotencyLock({ key: 'orderId', ttlMs: 1234, release: 'on-complete' })
    custom() {}
    @IdempotencyLock({ key: (req: any) => req.headers?.['idempotency-key'] })
    fnKey() {}
  }
  const h = Handlers.prototype;

  beforeEach(() => {
    lock = { acquire: jest.fn().mockResolvedValue('token-1234567890'), release: jest.fn() };
    guard = new IdempotencyLockGuard(new Reflector(), lock as unknown as LockService, {
      defaultTtlMs: 10_000,
    });
  });

  it('allows undecorated routes without touching Redis', async () => {
    await expect(guard.canActivate(ctxFor(h.plain, { body: {} }))).resolves.toBe(true);
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it('acquires the lock on body.txId with the module default TTL and records hold context', async () => {
    const req: LockedRequest = { body: { txId: 'tx_1001' } };
    await expect(guard.canActivate(ctxFor(h.defaults, req))).resolves.toBe(true);
    expect(lock.acquire).toHaveBeenCalledWith('tx_1001', 10_000);
    expect(req.__idem).toEqual({ key: 'tx_1001', token: 'token-1234567890', release: 'hold' });
  });

  it('falls back to a 10s TTL when neither route nor module set one', async () => {
    const g = new IdempotencyLockGuard(new Reflector(), lock as any, {});
    await g.canActivate(ctxFor(h.defaults, { body: { txId: 'x' } }));
    expect(lock.acquire).toHaveBeenCalledWith('x', 10_000);
  });

  it('honours a custom body field, route TTL and on-complete release', async () => {
    const req: LockedRequest = { body: { orderId: 77 } };
    await guard.canActivate(ctxFor(h.custom, req));
    expect(lock.acquire).toHaveBeenCalledWith('77', 1234);
    expect(req.__idem?.release).toBe('on-complete');
  });

  it('supports a function key extractor', async () => {
    const req: any = { headers: { 'idempotency-key': 'abc' }, body: {} };
    await guard.canActivate(ctxFor(h.fnKey, req));
    expect(lock.acquire).toHaveBeenCalledWith('abc', 10_000);
  });

  it.each([
    ['missing body', undefined],
    ['missing txId', {}],
    ['null txId', { txId: null }],
    ['empty txId', { txId: '' }],
  ])('rejects with 400 when the key is absent (%s)', async (_label, body) => {
    await expect(guard.canActivate(ctxFor(h.defaults, { body: body as any }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it('rejects duplicates with 429 when the lock is already held', async () => {
    lock.acquire.mockResolvedValue(null);
    const err = await guard.canActivate(ctxFor(h.defaults, { body: { txId: 'tx_1' } })).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.getResponse()).toMatchObject({ statusCode: 429, key: 'tx_1' });
  });

  it('propagates Redis failures (no silent fail-open)', async () => {
    lock.acquire.mockRejectedValue(new Error('redis down'));
    await expect(guard.canActivate(ctxFor(h.defaults, { body: { txId: 't' } }))).rejects.toThrow('redis down');
  });
});

describe('IdempotencyReleaseInterceptor', () => {
  let lock: { release: jest.Mock };
  let interceptor: IdempotencyReleaseInterceptor;
  beforeEach(() => {
    lock = { release: jest.fn().mockResolvedValue(true) };
    interceptor = new IdempotencyReleaseInterceptor(lock as any);
  });

  it('releases on-complete locks after success', async () => {
    const req: LockedRequest = { __idem: { key: 'k', token: 't', release: 'on-complete' } };
    await lastValueFrom(interceptor.intercept(ctxFor(() => {}, req), { handle: () => of('ok') }));
    expect(lock.release).toHaveBeenCalledWith('k', 't');
  });

  it('releases on-complete locks after an error too', async () => {
    const req: LockedRequest = { __idem: { key: 'k', token: 't', release: 'on-complete' } };
    await expect(
      lastValueFrom(
        interceptor.intercept(ctxFor(() => {}, req), { handle: () => throwError(() => new Error('x')) }),
      ),
    ).rejects.toThrow('x');
    expect(lock.release).toHaveBeenCalledWith('k', 't');
  });

  it('does not release "hold" locks or unlocked requests', async () => {
    await lastValueFrom(
      interceptor.intercept(ctxFor(() => {}, { __idem: { key: 'k', token: 't', release: 'hold' } }), {
        handle: () => of(1),
      }),
    );
    await lastValueFrom(interceptor.intercept(ctxFor(() => {}, {}), { handle: () => of(1) }));
    expect(lock.release).not.toHaveBeenCalled();
  });
});

describe('IdempotencyRedis', () => {
  it('reuses a caller-provided client and never quits it', async () => {
    const client = new Redis({ lazyConnect: true });
    const quit = jest.spyOn(client, 'quit').mockResolvedValue('OK');
    const p = new IdempotencyRedis({ redis: client });
    expect(p.client).toBe(client);
    await p.onApplicationShutdown();
    expect(quit).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('creates and owns a client from options, quitting it on shutdown', async () => {
    const p = new IdempotencyRedis({ redis: { lazyConnect: true, host: 'example.invalid', port: 1234 } });
    expect(p.client).toBeInstanceOf(Redis);
    expect(p.client.options.host).toBe('example.invalid');
    expect(p.client.options.port).toBe(1234);
    expect(p.client.options.maxRetriesPerRequest).toBe(3);
    const quit = jest.spyOn(p.client, 'quit').mockResolvedValue('OK');
    await p.onApplicationShutdown();
    expect(quit).toHaveBeenCalled();
    p.client.disconnect();
  });

  it('swallows quit() errors on shutdown', async () => {
    const p = new IdempotencyRedis({ redis: { lazyConnect: true } });
    jest.spyOn(p.client, 'quit').mockRejectedValue(new Error('already closed'));
    await expect(p.onApplicationShutdown()).resolves.toBeUndefined();
    p.client.disconnect();
  });
});

describe('IdempotencyModule.forRoot', () => {
  it('merges defaults, registers global guard/interceptor and exports LockService', () => {
    const mod = IdempotencyModule.forRoot({ keyPrefix: 'x:' });
    const opts = (mod.providers as any[]).find((p) => p.provide === IDEMPOTENCY_OPTIONS);
    expect(opts.useValue).toEqual({ defaultTtlMs: 10_000, keyPrefix: 'x:' });
    expect(mod.providers).toEqual(
      expect.arrayContaining([
        { provide: APP_GUARD, useClass: IdempotencyLockGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyReleaseInterceptor },
      ]),
    );
    expect(mod.exports).toEqual(expect.arrayContaining([LockService, IdempotencyRedis, IDEMPOTENCY_OPTIONS]));
  });

  it('uses defaults when called with no options', () => {
    const mod = IdempotencyModule.forRoot();
    const opts = (mod.providers as any[]).find((p) => p.provide === IDEMPOTENCY_OPTIONS);
    expect(opts.useValue).toEqual({ defaultTtlMs: 10_000, keyPrefix: 'lock:' });
  });
});
