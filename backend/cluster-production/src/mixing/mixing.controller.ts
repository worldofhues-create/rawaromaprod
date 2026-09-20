/**
 * MixingController — REST over the secure mixing session + step log. Reads require
 * `production:<table>:read`, writes `:write`. The flow is POST actions under the session:
 * `/steps` appends a step log, `/end` closes the session. Per-arg ZodValidationPipe; principal
 * from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { MixingService } from './mixing.service.js';
import {
  createMixingSession,
  endMixingSession,
  listQuery,
  logStep,
  type CreateMixingSession,
  type EndMixingSession,
  type ListQuery,
  type LogStep,
} from '../production.dtos.js';

@Controller()
export class MixingController {
  constructor(private readonly mixing: MixingService) {}

  /* ── secure mixing session ───────────────────────────────────────── */

  @Permissions('production:secure_mixing_session:read')
  @Get('v1/mixing-sessions')
  listSessions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.mixing.listSessions(query);
  }

  @Permissions('production:secure_mixing_session:read')
  @Get('v1/mixing-sessions/:id')
  getSession(@Param('id') id: string) {
    return this.mixing.getSession(id);
  }

  @Permissions('production:secure_mixing_session:write')
  @Post('v1/mixing-sessions')
  startSession(
    @Body(new ZodValidationPipe(createMixingSession)) body: CreateMixingSession,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.mixing.startSession(body, principal);
  }

  /* ── flow: log step ──────────────────────────────────────────────── */

  @Permissions('production:mixing_step_log:write')
  @Post('v1/mixing-sessions/:id/steps')
  logStep(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(logStep)) body: LogStep,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.mixing.logStep(id, body, principal);
  }

  /* ── flow: end session ───────────────────────────────────────────── */

  @Permissions('production:secure_mixing_session:write')
  @Post('v1/mixing-sessions/:id/end')
  endSession(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(endMixingSession)) body: EndMixingSession,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.mixing.endSession(id, body, principal);
  }

  /* ── mixing step log (reads) ─────────────────────────────────────── */

  @Permissions('production:mixing_step_log:read')
  @Get('v1/mixing-step-logs')
  listStepLogs(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.mixing.listStepLogs(query);
  }

  @Permissions('production:mixing_step_log:read')
  @Get('v1/mixing-step-logs/:id')
  getStepLog(@Param('id') id: string) {
    return this.mixing.getStepLog(id);
  }
}
