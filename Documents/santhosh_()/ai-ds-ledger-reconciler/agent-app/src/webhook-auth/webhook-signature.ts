import { createHmac, timingSafeEqual } from 'crypto';

/** Header carrying the HMAC: `sha256=<hex>` (a bare hex digest is also accepted). */
export const SIGNATURE_HEADER = 'x-signature';
/** Optional header carrying the signing time as Unix seconds (replay protection). */
export const TIMESTAMP_HEADER = 'x-signature-timestamp';

export const WEBHOOK_AUTH_OPTIONS = Symbol('WEBHOOK_AUTH_OPTIONS');

export interface WebhookAuthOptions {
  /** Shared secret (WEBHOOK_SECRET). When empty, every webhook is rejected (fail closed). */
  secret: string;
  /** Max allowed |now - timestamp| in seconds (WEBHOOK_TOLERANCE_SECONDS, default 300). */
  toleranceSeconds: number;
  /** Require the timestamp header (WEBHOOK_REQUIRE_TIMESTAMP=true). Default false. */
  requireTimestamp: boolean;
}

export function webhookAuthOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookAuthOptions {
  const tolerance = Number(env.WEBHOOK_TOLERANCE_SECONDS ?? 300);
  return {
    secret: env.WEBHOOK_SECRET ?? '',
    toleranceSeconds: Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 300,
    requireTimestamp: /^(1|true|yes)$/i.test(env.WEBHOOK_REQUIRE_TIMESTAMP ?? ''),
  };
}

/**
 * Hex HMAC-SHA256 of the raw body. When a timestamp is used it is bound into
 * the MAC as `${timestamp}.${rawBody}` so it cannot be swapped on replay.
 */
export function computeSignature(secret: string, rawBody: Buffer | string, timestamp?: string): string {
  const mac = createHmac('sha256', secret);
  if (timestamp !== undefined) mac.update(`${timestamp}.`);
  mac.update(rawBody);
  return mac.digest('hex');
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifySignature(
  opts: WebhookAuthOptions,
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  nowMs: number = Date.now(),
): VerifyResult {
  if (!opts.secret) return { ok: false, reason: 'webhook signing secret is not configured' };
  if (!signatureHeader) return { ok: false, reason: 'missing X-Signature header' };
  if (!rawBody) return { ok: false, reason: 'unable to verify signature: raw body unavailable' };

  if (timestampHeader === undefined) {
    if (opts.requireTimestamp) return { ok: false, reason: 'missing X-Signature-Timestamp header' };
  } else {
    if (!/^\d{1,15}$/.test(timestampHeader)) return { ok: false, reason: 'invalid X-Signature-Timestamp header' };
    const skew = Math.abs(nowMs / 1000 - Number(timestampHeader));
    if (skew > opts.toleranceSeconds) return { ok: false, reason: 'signature timestamp outside tolerance' };
  }

  const provided = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: 'malformed signature' };

  const expected = Buffer.from(computeSignature(opts.secret, rawBody, timestampHeader), 'hex');
  const actual = Buffer.from(provided, 'hex');
  // Both are 32 bytes here (format checked above), as timingSafeEqual requires.
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}
