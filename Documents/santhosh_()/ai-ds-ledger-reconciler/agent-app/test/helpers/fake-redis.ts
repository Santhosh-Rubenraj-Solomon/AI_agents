/**
 * Minimal in-memory stand-in for the subset of the ioredis API used by
 * LockService: `SET key val PX ttl NX` and the compare-and-delete Lua `EVAL`.
 * TTLs are honoured against Date.now() so tests can use jest fake timers.
 */
export class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number }>();
  set = jest.fn(async (key: string, value: string, px: string, ttl: number, nx: string) => {
    expect(px).toBe('PX');
    expect(nx).toBe('NX');
    this.evictExpired(key);
    if (this.store.has(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    return 'OK';
  });
  eval = jest.fn(async (_script: string, numKeys: number, key: string, token: string) => {
    expect(numKeys).toBe(1);
    this.evictExpired(key);
    const entry = this.store.get(key);
    if (entry && entry.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  });
  quit = jest.fn(async () => 'OK');
  on = jest.fn();

  private evictExpired(key: string) {
    const e = this.store.get(key);
    if (e && e.expiresAt <= Date.now()) this.store.delete(key);
  }
}

/** Wraps a FakeRedis in the shape of the IdempotencyRedis provider. */
export const fakeIdempotencyRedis = (client = new FakeRedis()) => ({ client });
