/**
 * IdentityModule — the identity cluster (iam schema). Owns `/v1/auth/*` + `/v1/me`,
 * argon2id credentials, JWT session issuance, and RBAC resolution. Depends on the
 * (global) BackendKernelModule for `IAM_DB` + `JwtService`. Exports the `UserLookup`
 * public port (under `USER_LOOKUP`) for the sanctioned cross-cluster sync path.
 */
import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { UserLookupService } from './auth/user-lookup.service.js';
import { USER_LOOKUP } from './public-api.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    UserLookupService,
    { provide: USER_LOOKUP, useExisting: UserLookupService },
  ],
  exports: [USER_LOOKUP],
})
export class IdentityModule {}
