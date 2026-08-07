import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { LockService } from './lock.service';
import { LockedRequest } from './idempotency-lock.guard';

/**
 * Global interceptor. When a handler used `release: 'on-complete'`, it releases
 * the lock after the handler settles (success OR error). For the default
 * 'hold' strategy this is a no-op — the TTL is the idempotency window.
 */
@Injectable()
export class IdempotencyReleaseInterceptor implements NestInterceptor {
  constructor(private readonly lock: LockService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<LockedRequest>();
    return next.handle().pipe(
      finalize(() => {
        const idem = req.__idem;
        if (idem && idem.release === 'on-complete') {
          void this.lock.release(idem.key, idem.token);
        }
      }),
    );
  }
}
