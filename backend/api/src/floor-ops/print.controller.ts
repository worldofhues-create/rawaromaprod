/**
 * PrintController (lane pf-c, plan section 2 + 12.4).
 *
 *   GET  /v1/print-jobs?station=&subjectRef=&status=   history (reprints included)       platform:print_job:read
 *   POST /v1/print-jobs {station,labelKind,subjectRef,content,size?}  queue a label         platform:print_job:write
 *   POST /v1/print-jobs/:id/reprint {reason}           REPRINT, logged with the person      platform:print_job:write
 *   POST /v1/print-jobs/bin-sheet {binCodes,reason?}    FLOOR-3: the A4 bin-label sheet, logged; again = REPRINT + reason
 *   POST /v1/print-jobs/:id/retry                      send a parked/failed job again        platform:print_job:write
 *   POST /v1/print-jobs/:id/browser-printed            printed with the browser fallback     platform:print_job:write
 *   GET  /v1/label-sizes                               the plan 12.4 sizes                   any signed-in person
 *
 * Print agent (X-Device-Token of a paired label printer):
 *   POST /v1/device-agent/print-jobs/next              the next job, rendered for this printer
 *   POST /v1/device-agent/print-jobs/:id/result {ok, error?}
 */
import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AnyAuthenticated, CurrentUser, Permissions, Public, type AuthPrincipal } from '@core/backend-kernel';
import { DevicesService } from './devices.service.js';
import { label, type LabelContent } from './label-render.js';
import { PrintService } from './print.service.js';

function content(raw: unknown): LabelContent {
  if (!raw || typeof raw !== 'object') throw new BadRequestException('content is required.');
  const c = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (v === undefined || v === null ? undefined : String(v).slice(0, max));
  const lines = Array.isArray(c.lines) ? c.lines : [];
  if (lines.length > 20) throw new BadRequestException('At most 20 lines on a label.');
  return {
    brand: str(c.brand, 60),
    title: str(c.title, 60),
    footer: str(c.footer, 120),
    code: str(c.code, 60),
    lines: lines.map((l) => {
      if (!Array.isArray(l) || l.length !== 2) throw new BadRequestException('Each line is [label, value].');
      return [String(l[0]).slice(0, 30), l[1] === null ? null : String(l[1]).slice(0, 120)] as [string, string | null];
    }),
  };
}

@Controller('v1')
export class PrintController {
  constructor(private readonly print: PrintService) {}

  @Permissions('platform:print_job:read')
  @Get('print-jobs')
  list(@Query('station') station?: string, @Query('subjectRef') subjectRef?: string, @Query('status') status?: string) {
    return this.print.list({ station: station || null, subjectRef: subjectRef || null, status: status || null }).then((items) => ({ items }));
  }

  @Permissions('platform:print_job:write')
  @Post('print-jobs')
  enqueue(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    const station = typeof body?.station === 'string' ? body.station.trim().slice(0, 80) : '';
    const labelKind = typeof body?.labelKind === 'string' ? body.labelKind.trim().slice(0, 30) : '';
    if (!station || !labelKind) throw new BadRequestException('station and labelKind are required.');
    return this.print.enqueue({
      station, labelKind,
      subjectRef: typeof body.subjectRef === 'string' ? body.subjectRef.slice(0, 120) : null,
      content: content(body.content),
      size: typeof body.size === 'string' ? body.size : undefined,
    }, principal);
  }

  @Permissions('platform:print_job:write')
  @Post('print-jobs/bin-sheet')
  binSheet(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.print.binSheet({ binCodes: body?.binCodes, station: body?.station, reason: body?.reason }, principal);
  }

  @Permissions('platform:print_job:write')
  @Post('print-jobs/:id/reprint')
  reprint(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.print.reprint(id, body?.reason, principal);
  }

  @Permissions('platform:print_job:write')
  @Post('print-jobs/:id/retry')
  retry(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.print.retry(id, principal);
  }

  @Permissions('platform:print_job:write')
  @Post('print-jobs/:id/browser-printed')
  browserPrinted(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.print.markBrowserPrinted(id, principal);
  }

  @AnyAuthenticated('the label sizes a station can choose; reference data, no record')
  @Get('label-sizes')
  sizes() {
    const S = label().SIZES;
    return { items: Object.keys(S).map((k) => ({ key: k, ...S[k] })), languages: label().LANGUAGES };
  }
}

@Controller('v1/device-agent/print-jobs')
export class PrintAgentController {
  constructor(private readonly print: PrintService, private readonly devices: DevicesService) {}

  /** Public to the user guard; the print agent authenticates with its station-scoped device token. */
  @Public()
  @Post('next')
  async next(@Headers('x-device-token') token: string) {
    const job = await this.print.claimNext(await this.devices.authenticate(token));
    if (!job) return { job: null };
    return { job: { printJobId: job.printJobId, labelKind: job.labelKind, subjectRef: job.subjectRef, language: job.language, template: job.template, rendered: job.rendered, attempts: job.attempts } };
  }

  @Public()
  @Post(':id/result')
  async result(@Headers('x-device-token') token: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: Record<string, unknown>) {
    const j = await this.print.report(await this.devices.authenticate(token), id, body ?? {});
    return { printJobId: j.printJobId, status: j.status, nextAttemptAt: j.nextAttemptAt };
  }
}
