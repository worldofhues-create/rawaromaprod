/**
 * CryptoModule — the encrypted transport tunnel (handshake + /rpc). Domain-free edge concern,
 * wired into AppModule. The SessionKeysService holds the in-memory channel keys.
 */
import { Module } from '@nestjs/common';
import { CryptoController } from './crypto.controller.js';
import { SessionKeysService } from './session-keys.service.js';

@Module({
  controllers: [CryptoController],
  providers: [SessionKeysService],
})
export class CryptoModule {}
