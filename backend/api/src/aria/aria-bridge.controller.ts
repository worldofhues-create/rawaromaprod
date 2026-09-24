/**
 * AriaBridgeController (UX-H) — the RawProd consoles' Aria endpoint, on their OWN origin.
 *
 * Factory, Platform and Vault reach this through the encrypted /rpc tunnel like every other
 * call (so `connect-src 'self'` holds); the answer comes from ALEMBIC, server to server —
 * see `AriaBridgeService`. `@SelfService()`: a caller only ever asks as THEMSELVES — the
 * ALEMBIC identity is read off their own `user_master` row, never from the body — and what
 * they may be told is decided by ALEMBIC against that identity's own ALEMBIC roles.
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, SelfService, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { ARIA_CONSOLES, AriaBridgeService } from './aria-bridge.service.js';

export const ariaAskBody = z.object({
  question: z.string().trim().min(1).max(2000),
  console: z.enum(ARIA_CONSOLES),
  /** The NAME of the view ("Batches"), never its content. Dropped for the Vault. */
  view: z.string().max(80).optional(),
  conversationId: z.string().uuid().optional(),
  persist: z.boolean().optional(),
});
export type AriaAskBody = z.infer<typeof ariaAskBody>;

@Controller('v1/aria')
export class AriaBridgeController {
  constructor(private readonly aria: AriaBridgeService) {}

  @SelfService()
  @Get('status')
  status(@CurrentUser() principal: AuthPrincipal) {
    return this.aria.status(principal);
  }

  @SelfService()
  @Post('ask')
  ask(
    @Body(new ZodValidationPipe(ariaAskBody)) body: AriaAskBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.aria.ask(principal, body);
  }
}
