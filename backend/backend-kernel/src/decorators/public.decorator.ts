/**
 * `@Public()` — opt a route out of `JwtAuthGuard`. Use sparingly (register, login,
 * refresh, health, flag snapshot). Everything is authenticated by default.
 */
import { SetMetadata } from '@nestjs/common';
import { META_PUBLIC } from './metadata.keys.js';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(META_PUBLIC, true);
