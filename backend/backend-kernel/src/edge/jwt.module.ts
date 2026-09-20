/**
 * JwtModule — provides the shared `JwtService` (signing for the identity cluster,
 * verification for `JwtAuthGuard`). Global so guards and the auth service share one
 * configured signer.
 */
import { Global, Module } from '@nestjs/common';
import { JwtService } from './jwt.service.js';

@Global()
@Module({
  providers: [JwtService],
  exports: [JwtService],
})
export class JwtModule {}
