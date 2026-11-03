/**
 * ResponseEnvelopeInterceptor — wraps every successful handler return in the universal
 * `{ data, meta, error }` envelope (doc 06 §11, the `envelope()` shape in @core/contracts).
 *
 * Handlers return plain DTOs (or a `{ items, nextCursor }` page); the interceptor lifts a
 * page's `nextCursor` into `meta.cursor` and stamps `meta.requestId`. Errors never reach
 * here — `AllExceptionsFilter` owns the `error` branch. One interceptor → every response
 * shape is consistent without per-handler boilerplate.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { ApiMeta, Envelope } from '@core/contracts';
import type { RequestWithUser } from './principal.js';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<Envelope<unknown>> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const requestId = request.requestId ?? '';

    return next.handle().pipe(
      map((payload: unknown): Envelope<unknown> => {
        const meta: ApiMeta = { requestId };
        let data = payload;

        // Convention: a handler returning `{ items, nextCursor }` is a cursor page —
        // hoist the cursor into meta and return the items as data.
        if (isCursorPage(payload)) {
          meta.cursor = payload.nextCursor;
          // A page that counted its matches says so beside the cursor (SWEEP-VAULT-3), so a
          // screen can headline the true total instead of what one page happened to hold.
          const total = (payload as { total?: unknown }).total;
          if (typeof total === 'number') meta.total = total;
          data = payload.items;
        }

        return { data: data ?? null, meta, error: null };
      }),
    );
  }
}

function isCursorPage(
  value: unknown,
): value is { items: unknown[]; nextCursor: string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'items' in value &&
    'nextCursor' in value &&
    Array.isArray((value as { items: unknown }).items)
  );
}
