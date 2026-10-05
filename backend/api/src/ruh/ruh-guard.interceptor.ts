/**
 * RuhGuardInterceptor — the server half of "Ruh warns, never blocks" (contract C4) for every guarded
 * factory route (RuhGuardsService lists them). Global, so the routes themselves are unchanged:
 *
 *   1. after the guards (the caller is authenticated and holds the route's permission) and BEFORE
 *      the body pipes, it takes `ruhOverride: { reason }` off the body (so a strict DTO never sees
 *      it) and re-checks the action's risks on the server;
 *   2. risks and no reason of ≥ 8 characters → 409 RUH_CONFIRM_REQUIRED, `details.risks`;
 *   3. otherwise the handler runs unchanged; when it SUCCEEDS with risks present, the override is
 *      recorded (audit row, urgent insight for the admins, C3 signal with `override`). A failed
 *      action records nothing — nothing was overridden.
 *
 * A risk check that throws lets the action through untouched: Ruh never becomes the blocker.
 */
import { type CallHandler, type ExecutionContext, Injectable, Logger, type NestInterceptor } from '@nestjs/common';
import { concatMap, from, mergeMap, type Observable } from 'rxjs';
import { DomainError, type RequestWithUser } from '@core/backend-kernel';
import { RUH_REASON_MIN, readOverride, reasonOk, topSeverity } from './ruh.contract.js';
import { RuhGuardsService, type GuardEvaluation } from './ruh-guards.service.js';
import { RuhInsightsService } from './ruh-insights.service.js';

type Req = RequestWithUser & {
  method?: string;
  body?: unknown;
  params?: Record<string, string | undefined>;
  routeOptions?: { url?: string };
  routerPath?: string;
};

@Injectable()
export class RuhGuardInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RuhGuardInterceptor.name);

  constructor(
    private readonly guards: RuhGuardsService,
    private readonly insights: RuhInsightsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Req>();
    const route = req.routeOptions?.url ?? req.routerPath ?? '';
    const guard = this.guards.match(String(req.method ?? 'GET'), route);
    if (!guard || !req.user) return next.handle();

    const override = readOverride(req.body);
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && 'ruhOverride' in (req.body as object)) {
      delete (req.body as Record<string, unknown>).ruhOverride;
    }
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const principal = req.user;

    const evaluation = this.guards.evaluate(guard, { params: req.params ?? {}, body, principal }).catch((err: unknown) => {
      this.logger.warn(`ruh guard ${guard.action} could not check (${(err as Error).message}); the action goes ahead`);
      return null;
    });

    return from(evaluation).pipe(
      mergeMap((ev: GuardEvaluation | null) => {
        if (!ev || ev.risks.length === 0) return next.handle();
        if (!override || !reasonOk(override.reason)) {
          throw new DomainError(
            'RUH_CONFIRM_REQUIRED',
            override ? `Type a reason of at least ${RUH_REASON_MIN} characters to continue.` : 'Ruh has a warning about this. Read it, then type why you are going ahead.',
            409,
            { risks: ev.risks, action: guard.action, actionLabel: ev.actionLabel, severity: topSeverity(ev.risks) },
          );
        }
        return next.handle().pipe(
          concatMap(async (payload) => {
            try {
              await this.insights.recordOverride({
                principal, guard: guard.action, actionLabel: ev.actionLabel, reason: override.reason, risks: ev.risks,
                console: ev.console, deepLink: ev.deepLink, subject: ev.subject, route: `${guard.method} ${guard.route}`,
              });
            } catch (err) {
              // The action already happened; never turn it into an error. Logged loudly instead.
              this.logger.error(`ruh override of ${guard.action} not recorded: ${(err as Error).message}`);
            }
            return payload;
          }),
        );
      }),
    );
  }
}
