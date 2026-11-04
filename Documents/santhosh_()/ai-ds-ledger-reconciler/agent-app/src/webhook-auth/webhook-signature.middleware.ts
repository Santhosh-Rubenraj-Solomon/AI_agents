import { Inject, Injectable, Logger, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_AUTH_OPTIONS,
  WebhookAuthOptions,
  verifySignature,
} from './webhook-signature';

/**
 * Rejects (401) any webhook whose X-Signature is not a valid HMAC-SHA256 of the
 * raw request body under WEBHOOK_SECRET. Middleware runs before every guard, so
 * an unauthenticated request never reaches the idempotency lock or the agent.
 * Requires the app to be created with `{ rawBody: true }` (see main.ts).
 */
@Injectable()
export class WebhookSignatureMiddleware implements NestMiddleware {
  private readonly logger = new Logger('WebhookSignature');

  constructor(@Inject(WEBHOOK_AUTH_OPTIONS) private readonly opts: WebhookAuthOptions) {
    if (!opts.secret) {
      this.logger.error('WEBHOOK_SECRET is not set — all webhooks will be rejected with 401');
    }
  }

  use(req: Request & { rawBody?: Buffer }, _res: Response, next: NextFunction): void {
    const result = verifySignature(
      this.opts,
      req.rawBody,
      headerValue(req.headers[SIGNATURE_HEADER]),
      headerValue(req.headers[TIMESTAMP_HEADER]),
    );
    if (!result.ok) {
      this.logger.warn(`401 ${req.method} ${req.originalUrl}: ${result.reason}`);
      throw new UnauthorizedException('Invalid or missing webhook signature');
    }
    next();
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
