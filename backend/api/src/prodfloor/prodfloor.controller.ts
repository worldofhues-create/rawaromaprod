/**
 * PROD-B — REST for production floor P2: receiving audit, payment release, QC checkpoints and
 * rounds, lot hold and recall review, putaway label. Each route reuses the permission of the table
 * it acts on; payment release has its own (procurement:po_payment_release:*).
 */
import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { ReceivingService } from './receiving.service.js';
import { PaymentReleaseService } from './payment-release.service.js';
import { QcFloorService } from './qc-floor.service.js';
import { LotTraceService } from './lot-trace.service.js';

type B = Record<string, unknown>;

@Controller()
export class ProdfloorController {
  constructor(
    private readonly recv: ReceivingService,
    private readonly pay: PaymentReleaseService,
    private readonly qc: QcFloorService,
    private readonly lots: LotTraceService,
  ) {}

  /* receiving */
  @Permissions('inventory:grn_master:read')
  @Get('v1/prodfloor/receiving/po/:id')
  receivingPreview(@Param('id') id: string) { return this.recv.preview(id); }

  @Permissions('inventory:grn_master:read')
  @Get('v1/prodfloor/receiving/audits')
  audits(@Query('purchaseOrderId') po?: string) { return this.recv.listAudits(po); }

  @Permissions('inventory:grn_master:write')
  @Post('v1/prodfloor/receiving/audits')
  submitAudit(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.recv.submit(b, p); }

  @Permissions('inventory:gate_entry_master:write')
  @Post('v1/prodfloor/gate-entries/:id/resolve-hold')
  resolveHold(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.recv.resolveHold(id, b, p); }

  /* payment release */
  @Permissions('procurement:po_payment_release:read')
  @Get('v1/prodfloor/payments/po/:id')
  paySummary(@Param('id') id: string) { return this.pay.summary(id); }

  @Permissions('procurement:po_payment_release:write')
  @Post('v1/prodfloor/payments')
  payRequest(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.pay.request(b, p); }

  @Permissions('procurement:po_payment_release:write')
  @Post('v1/prodfloor/payments/:id/approve')
  payApprove(@Param('id') id: string, @CurrentUser() p: AuthPrincipal) { return this.pay.approve(id, p); }

  @Permissions('procurement:po_payment_release:write')
  @Post('v1/prodfloor/payments/:id/release')
  payRelease(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.pay.release(id, b, p); }

  @Permissions('procurement:po_payment_release:write')
  @Post('v1/prodfloor/payments/:id/refuse')
  payRefuse(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.pay.refuse(id, b, p); }

  /* QC checkpoints */
  @Permissions('quality:qc_parameter_master:read')
  @Get('v1/prodfloor/qc/checkpoints/:productId')
  checkpoints(@Param('productId') id: string) { return this.qc.checkpoints(id); }

  @Permissions('quality:qc_parameter_master:write')
  @Post('v1/prodfloor/qc/checkpoints/:productId')
  publish(@Param('productId') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.qc.publish(id, b, p); }

  @Permissions('quality:qc_parameter_master:write')
  @Put('v1/prodfloor/qc/parameters/:id')
  param(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.qc.updateParameter(id, b, p); }

  /* QC rounds */
  @Permissions('quality:qc_inspections:read')
  @Get('v1/prodfloor/qc/batches/:id')
  qcBatch(@Param('id') id: string) { return this.qc.batch(id); }

  @Permissions('quality:qc_inspections:write')
  @Post('v1/prodfloor/qc/batches/:id/rounds')
  round(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.qc.recordRound(id, b, p); }

  @Permissions('quality:qc_inspections:write')
  @Post('v1/prodfloor/qc/batches/:id/reworks')
  rework(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.qc.recordRework(id, b, p); }

  /* lot hold, recall, putaway label */
  @Permissions('inventory:rm_batch_master:read')
  @Get('v1/prodfloor/holds')
  holds() { return this.lots.holds(); }

  @Permissions('inventory:rm_batch_master:write')
  @Post('v1/prodfloor/holds')
  hold(@Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.lots.hold(b, p); }

  @Permissions('inventory:rm_batch_master:write')
  @Post('v1/prodfloor/holds/:id/release')
  releaseHold(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.lots.release(id, b, p); }

  @Permissions('inventory:batch_genealogy_history:read')
  @Get('v1/prodfloor/recall/rm-lot/:id')
  recall(@Param('id') id: string) { return this.lots.recall(id); }

  @Permissions('inventory:rm_batch_master:read')
  @Post('v1/prodfloor/putaway/:id/label')
  label(@Param('id') id: string, @Body() b: B, @CurrentUser() p: AuthPrincipal) { return this.lots.putawayLabel(id, b, p); }
}
