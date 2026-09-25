/**
 * BridgeController — the ALEMBIC-facing edge of the channel.
 *
 *   POST /v1/bridge/alembic/events   — ALEMBIC's signed webhook lands here (no auth
 *     guard beyond the HMAC itself: the caller is a machine on the other side of the
 *     internet, same posture as `RelayController`'s air-gap endpoints, except this one's
 *     signature IS its authentication rather than a bearer permission).
 *   PUT  /v1/bridge/config           — admin-only, self-service: set the outbound webhook
 *     URL and rotate the shared HMAC secret. No `.env`, no redeploy, per the lane brief —
 *     the same requirement ALEMBIC's own connector console satisfies on its side.
 *     Security review R1 #4/#5: the body is now zod-validated (@core/contracts'
 *     `bridge.configureBridgeRequest` — https required, loopback/private/link-local/metadata/
 *     localhost hosts refused, an SSRF guard on webhookUrl), and `configuredBy` is the real
 *     authenticated principal, not the hardcoded string 'admin'.
 *
 * `@Body() rawBody` is a plain string, not a parsed object: the whole point of §26's
 * transport rule is that the signature covers the exact bytes sent, and re-serializing
 * a Nest-parsed body would compute the signature over different bytes than the sender
 * signed. The route reads the raw body itself (see bridge.module.ts's raw-body config).
 */
import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, Permissions, Public, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { bridge as bridgeContracts } from '@core/contracts';
import { z } from 'zod';
import { ImporterService } from './importer.service.js';
import { ConfigAdminService } from './config-admin.service.js';
import { RequirementsQueueService, type RequirementsPage } from './requirements-queue.service.js';
import { OutboxAdminService } from './outbox-admin.service.js';

type ConfigureBridgeBody = z.infer<typeof bridgeContracts.configureBridgeRequest>;

/** GET /v1/bridge/requirements. `unlinked` keeps its old reading (only the string 'true' narrows);
 * `limit` is clamped to 1..200 by the service, as before (default 50). */
export const requirementsQuery = z.object({
  unlinked: z.string().optional(),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().optional()),
  cursor: z.string().uuid().optional(),
  orderRef: z.string().trim().min(1).max(100).optional(),
  alembicRequirementId: z.string().uuid().optional(),
});
export type RequirementsQueryParams = z.infer<typeof requirementsQuery>;

@Controller()
export class BridgeController {
  constructor(
    private readonly importer: ImporterService,
    private readonly configAdmin: ConfigAdminService,
    private readonly queue: RequirementsQueueService,
    private readonly outboxAdmin: OutboxAdminService,
  ) {}

  /* lane/j2 — the planner's incoming-requirements queue (see requirements-queue.service.ts).
   * `?unlinked=true` narrows to requirements no production order has claimed yet. RC7: a cursor
   * page like every other list (`meta.cursor` -> `?cursor=`), and `?orderRef=` /
   * `?alembicRequirementId=` narrow it to one ALEMBIC order / one requirement. */
  @Permissions('production:production_order:read')
  @Get('v1/bridge/requirements')
  listRequirements(@Query(new ZodValidationPipe(requirementsQuery)) query: RequirementsQueryParams): Promise<RequirementsPage> {
    return this.queue.page({
      unlinkedOnly: query.unlinked === 'true',
      limit: query.limit,
      cursor: query.cursor,
      orderRef: query.orderRef,
      alembicRequirementId: query.alembicRequirementId,
    });
  }

  /* PUBLIC per the JwtAuthGuard's own meaning of the word (backend-kernel/src/
   * edge/jwt-auth.guard.ts): ALEMBIC holds no bearer token this API issued —
   * it is a second deployment, not a signed-in user — so the HMAC signature
   * verified inside `handleAlembicEvent` is the entire authentication, the
   * same shape the payment/shipping webhooks use one repo over. */
  /* NO `@HttpCode`: the status is dynamic (200 applied/parked/duplicate, 400 malformed,
   * 401 unsigned/wrong-signature) and `handleAlembicEvent` decides it — a static decorator
   * here would silently force every outcome, including a rejected signature, to 200, which
   * is exactly the bug a duplicate/tampered-signature test is supposed to catch. */
  @Public()
  @Post('v1/bridge/alembic/events')
  async receive(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('x-bridge-signature') signature: string | undefined,
  ) {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const result = await this.importer.handleAlembicEvent(rawBody, signature ?? null);
    reply.status(result.status);
    return result.body;
  }

  @Permissions('platform:flag:write')
  @Put('v1/bridge/config')
  async configure(
    @Body(new ZodValidationPipe(bridgeContracts.configureBridgeRequest)) body: ConfigureBridgeBody,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    // Security review R1 #5: the real authenticated principal, never the hardcoded 'admin'.
    return this.configAdmin.configure(body, principal.userId);
  }

  /* OPS_GREEN §17 (P1 poison event) — the RawProd → ALEMBIC dead-letter list and the operator's
   * two actions. Same permission as the connector config above (bridge admin); replay and
   * discard are guarded state transitions (a repeat is 409, never a second effect) and are
   * audited in bridge.audit_events by OutboxAdminService. */
  @Permissions('platform:flag:write')
  @Get('v1/bridge/outbox/parked')
  listParked(@Query('limit') limit?: string) {
    return this.outboxAdmin.listParked(limit ? Number(limit) : undefined);
  }

  @Permissions('platform:flag:write')
  @Post('v1/bridge/outbox/:id/replay')
  replayParked(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.outboxAdmin.replay(id, principal.userId);
  }

  @Permissions('platform:flag:write')
  @Post('v1/bridge/outbox/:id/discard')
  discardParked(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason?: unknown } | undefined,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 500) {
      throw new BadRequestException("'reason' is required (1-500 characters): discarding means ALEMBIC never hears of it");
    }
    return this.outboxAdmin.discard(id, principal.userId, reason);
  }
}
