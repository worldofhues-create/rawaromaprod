/**
 * RuhController — the Ruh panel's routes, on every console's own origin (through the encrypted /rpc
 * tunnel like every other call; the Vault console reaches them over its main-box channel).
 *
 *   GET  /v1/ruh/insights?since=<rev>&console=   the caller's insights (their roles; owner sees all)  any signed-in person
 *   POST /v1/ruh/insights/:id/snooze {minutes}    snooze one (5 min .. 7 days, default 4 h)            anyone it is for
 *   POST /v1/ruh/insights/:id/done   {note?}      mark it handled                                      anyone it is for
 *   POST /v1/ruh/insights/:id/dismiss {note?}     not relevant                                         anyone it is for
 *   GET  /v1/ruh/settings                         thresholds with defaults                              platform:ruh_setting:read
 *   PUT  /v1/ruh/settings {key: value…}           change thresholds (audited)                           platform:ruh_setting:write
 *   POST /v1/ruh/watch/run                        check now (one watch pass)                            platform:ruh_setting:write
 *   GET  /v1/ruh/status                           the last pass + the ALEMBIC queue at a glance         platform:ruh_setting:read
 *
 * Insight decisions are self-service with an audience check in the service: a person acts only on
 * notes addressed to one of their roles (or as owner), and every decision is audited.
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AnyAuthenticated, CurrentUser, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { RUH_CONSOLES } from './ruh.contract.js';
import { RuhInsightsService } from './ruh-insights.service.js';
import { RuhSettingsService } from './ruh-settings.service.js';
import { RuhSignalService } from './ruh-signal.service.js';
import { RuhWatchService } from './ruh-watch.service.js';

const listQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
  console: z.enum(RUH_CONSOLES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const snoozeBody = z.object({ minutes: z.number().int().min(5).max(7 * 24 * 60).optional(), note: z.string().max(500).optional() }).strict();
const noteBody = z.object({ note: z.string().max(500).optional() }).strict();
const settingsBody = z.record(z.unknown());

@Controller('v1/ruh')
export class RuhController {
  constructor(
    private readonly insights: RuhInsightsService,
    private readonly settings: RuhSettingsService,
    private readonly watch: RuhWatchService,
    private readonly signals: RuhSignalService,
  ) {}

  @AnyAuthenticated('every console shows its Ruh panel; RuhInsightsService.list returns only the notes addressed to the caller\'s roles')
  @Get('insights')
  list(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>, @CurrentUser() principal: AuthPrincipal) {
    return this.insights.list(principal, { since: q.since ?? null, console: q.console ?? null, limit: q.limit });
  }

  @AnyAuthenticated('a person snoozes a Ruh note addressed to one of their roles; the service checks the audience')
  @Post('insights/:id/snooze')
  snooze(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(snoozeBody)) body: z.infer<typeof snoozeBody>, @CurrentUser() principal: AuthPrincipal) {
    return this.insights.act(principal, id, 'snooze', { minutes: body?.minutes, note: body?.note ?? null });
  }

  @AnyAuthenticated('a person marks a Ruh note addressed to one of their roles as done; the service checks the audience')
  @Post('insights/:id/done')
  done(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(noteBody)) body: z.infer<typeof noteBody>, @CurrentUser() principal: AuthPrincipal) {
    return this.insights.act(principal, id, 'done', { note: body?.note ?? null });
  }

  @AnyAuthenticated('a person dismisses a Ruh note addressed to one of their roles; the service checks the audience')
  @Post('insights/:id/dismiss')
  dismiss(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(noteBody)) body: z.infer<typeof noteBody>, @CurrentUser() principal: AuthPrincipal) {
    return this.insights.act(principal, id, 'dismiss', { note: body?.note ?? null });
  }

  @Permissions('platform:ruh_setting:read')
  @Get('settings')
  getSettings() {
    return this.settings.describe();
  }

  @Permissions('platform:ruh_setting:write')
  @Put('settings')
  putSettings(@Body(new ZodValidationPipe(settingsBody)) body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.settings.update(body, principal);
  }

  @Permissions('platform:ruh_setting:write')
  @Post('watch/run')
  runNow() {
    return this.watch.runOnce();
  }

  @Permissions('platform:ruh_setting:read')
  @Get('status')
  async status() {
    return { ...this.watch.status(), signals: await this.signals.counts() };
  }
}
