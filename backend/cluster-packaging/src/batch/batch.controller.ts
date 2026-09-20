/**
 * BatchController — REST over the finished-good batch document + its consumption rows. Reads
 * require `packaging:<table>:read`, writes `:write`. Flow endpoint: POST /finished-good-batches
 * produces the batch (+ consumption + outbox). Per-arg ZodValidationPipe; principal from the
 * token.
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
  createBatchConsumption,
  listQuery,
  produceFinishedGoodBatch,
  type CreateBatchConsumption,
  type ListQuery,
  type ProduceFinishedGoodBatch,
} from '../packaging.dtos.js';

@Controller()
export class BatchController {
  constructor(private readonly batch: BatchService) {}

  /* ── finished-good batch (flow produce + reads) ───────────────────── */

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/finished-good-batches')
  listFinishedGoodBatches(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listFinishedGoodBatches(query);
  }

  @Permissions('packaging:finished_good_batch_master:read')
  @Get('v1/finished-good-batches/:id')
  getFinishedGoodBatch(@Param('id') id: string) {
    return this.batch.getFinishedGoodBatch(id);
  }

  @Permissions('packaging:finished_good_batch_master:write')
  @Post('v1/finished-good-batches')
  produceFinishedGoodBatch(
    @Body(new ZodValidationPipe(produceFinishedGoodBatch)) body: ProduceFinishedGoodBatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batch.produceFinishedGoodBatch(body, principal);
  }

  /* ── finished-goods batch consumption ─────────────────────────────── */

  @Permissions('packaging:finished_goods_batch_consumption:read')
  @Get('v1/batch-consumptions')
  listBatchConsumption(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.batch.listBatchConsumption(query);
  }

  @Permissions('packaging:finished_goods_batch_consumption:read')
  @Get('v1/batch-consumptions/:id')
  getBatchConsumption(@Param('id') id: string) {
    return this.batch.getBatchConsumption(id);
  }

  @Permissions('packaging:finished_goods_batch_consumption:write')
  @Post('v1/batch-consumptions')
  createBatchConsumption(
    @Body(new ZodValidationPipe(createBatchConsumption)) body: CreateBatchConsumption,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.batch.createBatchConsumption(body, principal);
  }
}
