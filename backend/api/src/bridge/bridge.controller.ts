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
 *
 * `@Body() rawBody` is a plain string, not a parsed object: the whole point of §26's
 * transport rule is that the signature covers the exact bytes sent, and re-serializing
 * a Nest-parsed body would compute the signature over different bytes than the sender
 * signed. The route reads the raw body itself (see bridge.module.ts's raw-body config).
 */
import { Body, Controller, Headers, HttpCode, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Permissions } from '@core/backend-kernel';
import { ImporterService } from './importer.service.js';
import { ConfigAdminService } from './config-admin.service.js';

@Controller()
export class BridgeController {
  constructor(
    private readonly importer: ImporterService,
    private readonly configAdmin: ConfigAdminService,
  ) {}

  @Post('v1/bridge/alembic/events')
  @HttpCode(200)
  async receive(
    @Req() req: FastifyRequest,
    @Headers('x-bridge-signature') signature: string | undefined,
  ) {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const result = await this.importer.handleAlembicEvent(rawBody, signature ?? null);
    return result.body;
  }

  @Permissions('platform:flag:write')
  @Put('v1/bridge/config')
  async configure(@Body() body: { enabled?: boolean; webhookUrl?: string; hmacSecret?: string }) {
    // The permission guard has already authenticated the caller; a named actor for the
    // audit trail is a config-admin-service concern once RawProd's principal shape is
    // threaded through here (see the lane report's remaining-work note).
    return this.configAdmin.configure(body, 'admin');
  }
}
