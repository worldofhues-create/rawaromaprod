/**
 * ConfigModule — global, so any provider can inject `ConfigService` without re-importing.
 * Validation happens in the service constructor (fail-fast at boot).
 */
import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';

@Global()
@Module({
  providers: [{ provide: ConfigService, useFactory: () => new ConfigService() }],
  exports: [ConfigService],
})
export class ConfigModule {}
