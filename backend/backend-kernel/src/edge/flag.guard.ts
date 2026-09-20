/**
 * FlagGuard — the kill-switch enforcement gate. Reads `@RequiredFlag('portal.module.feature')`
 * and consults the in-memory `FlagsService` snapshot (sub-ms, no DB). When the flag is
 * `off`, the route 503s with `FEATURE_DISABLED` — this is the "kill module → routes 503"
 * cascade from doc 01 §5. Unknown/`on`/`degraded` flags pass (the handler decides how to
 * degrade). Stateless + global-snapshot, so it's cheap on every request.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { META_FLAG } from '../decorators/metadata.keys.js';
import { FlagsService } from '../flags/flags.service.js';
import { DomainError } from './domain-error.js';

@Injectable()
export class FlagGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FlagsService) private readonly flags: FlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const flagKey = this.reflector.getAllAndOverride<string>(META_FLAG, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flagKey) return true;
    if (!this.flags.isEnabled(flagKey)) {
      throw DomainError.featureDisabled(`Feature "${flagKey}" is currently disabled`);
    }
    return true;
  }
}
