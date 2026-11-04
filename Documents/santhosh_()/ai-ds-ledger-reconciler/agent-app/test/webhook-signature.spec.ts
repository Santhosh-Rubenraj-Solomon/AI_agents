import { Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  WebhookAuthOptions,
  computeSignature,
  verifySignature,
  webhookAuthOptionsFromEnv,
} from '../src/webhook-auth/webhook-signature';
import { WebhookSignatureMiddleware } from '../src/webhook-auth/webhook-signature.middleware';

const SECRET = 's3cret';
const opts = (o: Partial<WebhookAuthOptions> = {}): WebhookAuthOptions => ({
  secret: SECRET,
  toleranceSeconds: 300,
  requireTimestamp: false,
  ...o,
});
const raw = Buffer.from('{"txId":"tx_1","amount":1,"vendorStatus":"paid"}');
const NOW = 1_800_000_000_000;

describe('webhookAuthOptionsFromEnv', () => {
  it('reads WEBHOOK_* with safe defaults', () => {
    expect(webhookAuthOptionsFromEnv({})).toEqual({ secret: '', toleranceSeconds: 300, requireTimestamp: false });
    expect(
      webhookAuthOptionsFromEnv({
        WEBHOOK_SECRET: 'x',
        WEBHOOK_TOLERANCE_SECONDS: '60',
        WEBHOOK_REQUIRE_TIMESTAMP: 'true',
      }),
    ).toEqual({ secret: 'x', toleranceSeconds: 60, requireTimestamp: true });
    expect(webhookAuthOptionsFromEnv({ WEBHOOK_TOLERANCE_SECONDS: 'abc' }).toleranceSeconds).toBe(300);
  });
});

describe('computeSignature', () => {
  it('is HMAC-SHA256 hex over the raw body, or "<ts>.<body>" when timestamped', () => {
    expect(computeSignature(SECRET, raw)).toBe(createHmac('sha256', SECRET).update(raw).digest('hex'));
    expect(computeSignature(SECRET, raw, '123')).toBe(
      createHmac('sha256', SECRET).update(`123.${raw}`).digest('hex'),
    );
  });
});

describe('verifySignature', () => {
  const sig = computeSignature(SECRET, raw);

  it('accepts a valid signature with or without the sha256= prefix (case-insensitive)', () => {
    expect(verifySignature(opts(), raw, `sha256=${sig}`, undefined, NOW)).toEqual({ ok: true });
    expect(verifySignature(opts(), raw, sig.toUpperCase(), undefined, NOW)).toEqual({ ok: true });
  });

  it.each([
    ['no secret configured (fail closed)', opts({ secret: '' }), raw, sig, undefined, /not configured/],
    ['missing header', opts(), raw, undefined, undefined, /missing X-Signature/],
    ['missing raw body', opts(), undefined, sig, undefined, /raw body unavailable/],
    ['malformed', opts(), raw, 'sha256=zz', undefined, /malformed/],
    ['wrong length', opts(), raw, sig.slice(2), undefined, /malformed/],
    ['mismatch', opts(), raw, computeSignature('other', raw), undefined, /mismatch/],
    ['timestamp required', opts({ requireTimestamp: true }), raw, sig, undefined, /missing X-Signature-Timestamp/],
    ['non-numeric timestamp', opts(), raw, sig, 'yesterday', /invalid X-Signature-Timestamp/],
  ])('rejects: %s', (_l, o, body, header, ts, reason) => {
    const r = verifySignature(o, body, header, ts, NOW);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(reason);
  });

  it('enforces the timestamp tolerance in both directions and binds it into the MAC', () => {
    const at = (offsetS: number) => String(NOW / 1000 + offsetS);
    const signAt = (ts: string) => computeSignature(SECRET, raw, ts);
    expect(verifySignature(opts(), raw, signAt(at(-300)), at(-300), NOW)).toEqual({ ok: true });
    expect(verifySignature(opts(), raw, signAt(at(-301)), at(-301), NOW)).toMatchObject({ ok: false, reason: /tolerance/ });
    expect(verifySignature(opts(), raw, signAt(at(301)), at(301), NOW)).toMatchObject({ ok: false, reason: /tolerance/ });
    // signature made for one timestamp cannot be reused with another
    expect(verifySignature(opts(), raw, signAt(at(-10)), at(0), NOW)).toMatchObject({ ok: false, reason: /mismatch/ });
    // an un-timestamped signature is not valid once a timestamp is supplied
    expect(verifySignature(opts(), raw, sig, at(0), NOW)).toMatchObject({ ok: false, reason: /mismatch/ });
  });
});

describe('WebhookSignatureMiddleware', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  const req = (headers: Record<string, any>, rawBody: Buffer | undefined = raw) =>
    ({ method: 'POST', originalUrl: '/webhook/payment-reconcile', headers, rawBody }) as any;

  it('calls next() for a valid signature', () => {
    const next = jest.fn();
    new WebhookSignatureMiddleware(opts()).use(req({ 'x-signature': computeSignature(SECRET, raw) }), {} as any, next);
    expect(next).toHaveBeenCalled();
  });

  it('throws 401 and does not call next() otherwise', () => {
    const next = jest.fn();
    const mw = new WebhookSignatureMiddleware(opts());
    expect(() => mw.use(req({}), {} as any, next)).toThrow(UnauthorizedException);
    expect(() => mw.use(req({ 'x-signature': 'sha256=' + '0'.repeat(64) }), {} as any, next)).toThrow(
      UnauthorizedException,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('logs an error at construction when WEBHOOK_SECRET is missing', () => {
    const spy = jest.spyOn(Logger.prototype, 'error');
    new WebhookSignatureMiddleware(opts({ secret: '' }));
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/WEBHOOK_SECRET is not set/));
  });
});
