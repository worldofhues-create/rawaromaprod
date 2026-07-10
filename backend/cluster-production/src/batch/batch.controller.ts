/**
 * BatchController — REST over the oil batch genealogy + production QC, plus the produce-oil-batch
 * and record-production-qc flows. Reads require `production:<table>:read`, writes `:write`.
 * `POST /v1/oil-batches` produces a batch (master + consumption + PRODUCED event) and emits
 * production.oil_batch.created; `POST /v1/production-qc` records a reading (qc + history +
 * QC_RECORDED event) and emits production.qc.recorded. Per-arg ZodValidationPipe.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { BatchService } from './batch.service.js';
import {
  listQuery,
  produceOilBatch,
  recordProductionQc,
  transitionOilBatch,
  type ListQuery,
  type ProduceOilBatch,
  type RecordProductionQc,
  type TransitionOilBatch,
} from '../production.dtos.js';

@Controller()
export class BatchController {
  constructor(private readonly batch: BatchService) {}

  /* ── oil batch master ─────────────────────────────────────────────── */

  @Permissions('production:oil_batch_master:read')
  @Get('v1/oil-batches')
  listOilBatches(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listOilBatches(query);
  }

  @Permissions('production:oil_batch_master:read')
  @Get('v1/oil-batches/:id')
  getOilBatch(@Param('id') id: string) {
    return this.batch.getOilBatch(id);
  }

  /* ── flow: produce oil batch ─────────────────────────────────────── */

  @Permissions('production:oil_batch_master:write')
  @Post('v1/oil-batches')
  produceOilBatch(
    @Body(new ZodValidationPipe(produceOilBatch)) body: ProduceOilBatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batch.produceOilBatch(body, principal);
  }

  @Permissions('production:oil_batch_master:write')
  @Post('v1/oil-batches/:id/transition')
  transitionOilBatch(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transitionOilBatch)) body: TransitionOilBatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batch.transitionOilBatch(id, body.status, principal);
  }

  /* ── oil batch consumption ───────────────────────────────────────── */

  @Permissions('production:oil_batch_consumption:read')
  @Get('v1/oil-batch-consumption')
  listConsumption(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listConsumption(query);
  }

  @Permissions('production:oil_batch_consumption:read')
  @Get('v1/oil-batch-consumption/:id')
  getConsumption(@Param('id') id: string) {
    return this.batch.getConsumption(id);
  }

  /* ── oil batch event history ─────────────────────────────────────── */

  @Permissions('production:oil_batch_event_history:read')
  @Get('v1/oil-batch-events')
  listEventHistory(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listEventHistory(query);
  }

  @Permissions('production:oil_batch_event_history:read')
  @Get('v1/oil-batch-events/:id')
  getEventHistory(@Param('id') id: string) {
    return this.batch.getEventHistory(id);
  }

  /* ── production QC ───────────────────────────────────────────────── */

  @Permissions('production:production_qc:read')
  @Get('v1/production-qc')
  listQc(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listQc(query);
  }

  @Permissions('production:production_qc:read')
  @Get('v1/production-qc/:id')
  getQc(@Param('id') id: string) {
    return this.batch.getQc(id);
  }

  /* ── flow: record production QC ──────────────────────────────────── */

  @Permissions('production:production_qc:write')
  @Post('v1/production-qc')
  recordProductionQc(
    @Body(new ZodValidationPipe(recordProductionQc)) body: RecordProductionQc,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batch.recordProductionQc(body, principal);
  }

  /* ── oil batch QC history ────────────────────────────────────────── */

  @Permissions('production:oil_batch_qc_history:read')
  @Get('v1/oil-batch-qc-history')
  listQcHistory(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listQcHistory(query);
  }

  @Permissions('production:oil_batch_qc_history:read')
  @Get('v1/oil-batch-qc-history/:id')
  getQcHistory(@Param('id') id: string) {
    return this.batch.getQcHistory(id);
  }
}
