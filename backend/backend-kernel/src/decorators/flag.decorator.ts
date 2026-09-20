/**
 * `@RequiredFlag('owner.listings.submit')` — gate a route behind a kill-switch. The
 * `FlagGuard` 503s (`FEATURE_DISABLED`) when the in-memory snapshot has the flag `off`.
 * The cascade in doc 01 §5 ("kill module → routes 503") is exactly this guard.
 */
import { SetMetadata } from '@nestjs/common';
import type { FlagKey } from '@core/contracts';
import { META_FLAG } from './metadata.keys.js';

export const RequiredFlag = (
  flag: FlagKey,
): MethodDecorator & ClassDecorator => SetMetadata(META_FLAG, flag);
