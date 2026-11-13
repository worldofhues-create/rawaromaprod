/**
 * PROM-3 — the retained reference per product (reference-standard.service.ts).
 *   GET  /v1/prodfloor/qc/references/:productId          the product's references   quality:reference_standard:read
 *   POST /v1/prodfloor/qc/references {oilBatchId, reason, expiresAt?}   propose   quality:reference_standard:write
 *   POST /v1/prodfloor/qc/references/:id/approve {retireReason?}  a second person, fresh sign-in   quality:reference_standard:approve
 *   POST /v1/prodfloor/qc/references/:id/decline {reason}                        quality:reference_standard:write
 *   GET  /v1/prodfloor/qc/batches/:id/context?productId= the next stage and what to compare with   quality:qc_inspections:read
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser, FreshAuth, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { ReferenceStandardService } from './reference-standard.service.js';
import { QcFloorService } from './qc-floor.service.js';

type B = Record<string, unknown>;

@Controller('v1/prodfloor/qc')
export class ReferenceStandardController {
  constructor(private readonly refs: ReferenceStandardService, private readonly qc: QcFloorService) {}

  @Permissions('quality:reference_standard:read')
  @Get('references/:productId')
  list(@Param('productId', new ParseUUIDPipe()) productId: string) { return this.refs.list(productId); }

  @Permissions('quality:reference_standard:write')
  @Post('references')
  propose(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.refs.propose(b ?? {}, p); }

  @Permissions('quality:reference_standard:approve')
  @FreshAuth(300)
  @Post('references/:id/approve')
  approve(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.refs.approve(id, b ?? {}, p); }

  @Permissions('quality:reference_standard:write')
  @Post('references/:id/decline')
  decline(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.refs.decline(id, b ?? {}, p); }

  @Permissions('quality:qc_inspections:read')
  @Get('batches/:id/context')
  context(@Param('id', new ParseUUIDPipe()) id: string, @Query('productId') productId?: string) {
    return this.qc.context(id, productId && /^[0-9a-f-]{36}$/i.test(productId) ? productId : null);
  }
}
