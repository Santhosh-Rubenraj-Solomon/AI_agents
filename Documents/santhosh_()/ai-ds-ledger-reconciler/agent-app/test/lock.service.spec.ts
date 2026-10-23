import { LockService } from '../src/idempotency/lock.service';
import { FakeRedis, fakeIdempotencyRedis } from './helpers/fake-redis';

describe('LockService', () => {
  let redis: FakeRedis;
  let svc: LockService;

  beforeEach(() => {
    redis = new FakeRedis();
    svc = new LockService(fakeIdempotencyRedis(redis) as any, { keyPrefix: 'lock:tx:' });
  });

  afterEach(() => jest.useRealTimers());

  it('acquire() issues SET <prefix><key> <token> PX ttl NX and returns a token', async () => {
    const token = await svc.acquire('tx_1', 5000);
    expect(token).toEqual(expect.any(String));
    expect(redis.set).toHaveBeenCalledWith('lock:tx:tx_1', token, 'PX', 5000, 'NX');
  });

  it('acquire() returns null when the key is already held', async () => {
    expect(await svc.acquire('tx_1', 5000)).not.toBeNull();
    expect(await svc.acquire('tx_1', 5000)).toBeNull();
  });

  it('generates a unique token per acquisition', async () => {
    const a = await svc.acquire('a', 1000);
    const b = await svc.acquire('b', 1000);
    expect(a).not.toEqual(b);
  });

  it('defaults the key prefix to "lock:"', async () => {
    const s = new LockService(fakeIdempotencyRedis(redis) as any, {});
    await s.acquire('k', 100);
    expect(redis.set.mock.calls[0][0]).toBe('lock:k');
  });

  it('lock can be re-acquired after its TTL lapses', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    expect(await svc.acquire('tx_1', 1000)).not.toBeNull();
    jest.setSystemTime(1_000_999);
    expect(await svc.acquire('tx_1', 1000)).toBeNull();
    jest.setSystemTime(1_001_000);
    expect(await svc.acquire('tx_1', 1000)).not.toBeNull();
  });

  it('release() deletes only when the token still owns the lock', async () => {
    const token = (await svc.acquire('tx_1', 5000))!;
    expect(await svc.release('tx_1', 'someone-else')).toBe(false);
    expect(redis.store.has('lock:tx:tx_1')).toBe(true);
    expect(await svc.release('tx_1', token)).toBe(true);
    expect(redis.store.has('lock:tx:tx_1')).toBe(false);
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('redis.call("del"'), 1, 'lock:tx:tx_1', token);
  });

  it('release() returns false for an unknown key', async () => {
    expect(await svc.release('nope', 'tok')).toBe(false);
  });

  describe('withLock()', () => {
    it('runs fn under the lock and releases afterwards', async () => {
      const fn = jest.fn(async () => {
        expect(redis.store.has('lock:tx:k')).toBe(true);
        return 42;
      });
      await expect(svc.withLock('k', 1000, fn)).resolves.toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(redis.store.has('lock:tx:k')).toBe(false);
    });

    it('returns null and does not run fn when the lock is held', async () => {
      await svc.acquire('k', 1000);
      const fn = jest.fn(async () => 1);
      await expect(svc.withLock('k', 1000, fn)).resolves.toBeNull();
      expect(fn).not.toHaveBeenCalled();
    });

    it('releases the lock even when fn throws', async () => {
      await expect(
        svc.withLock('k', 1000, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(redis.store.has('lock:tx:k')).toBe(false);
    });
  });

  it('propagates Redis errors from acquire()', async () => {
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(svc.acquire('k', 1000)).rejects.toThrow('ECONNREFUSED');
  });
});
