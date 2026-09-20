/** NotifyModule — the email-notifier sink (Module 12). Imported by the worker so it runs alongside
 * the outbox publisher. EventBus + PG_CLIENT come from the kernel (global). */
import { Module } from '@nestjs/common';
import { EmailTransport } from './email-transport.service.js';
import { EmailNotifierService } from './email-notifier.service.js';

@Module({
  providers: [EmailTransport, EmailNotifierService],
})
export class NotifyModule {}
