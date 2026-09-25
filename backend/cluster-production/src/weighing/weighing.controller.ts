/**
 * WeighingController (OPS-GREEN Act L) — the WEIGH step. Writing a reading needs the mixing
 * session's write permission AND the coded-instruction read (the response carries the resolved
 * target, which is instruction data): production + compounding hold both; owner and filling do
 * not hold the instruction read and are refused. Reads need the session read.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { WeighingService } from './weighing.service.js';
import { listWeighings, recordWeighing, type ListWeighings, type RecordWeighing } from '../production.dtos.js';

@Controller()
export class WeighingController {
  constructor(private readonly weighing: WeighingService) {}

  @Permissions('production:secure_mixing_session:write', 'production:manufacturing_instruction:read')
  @Post('v1/mixing-sessions/:id/weighings')
  record(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(recordWeighing)) body: RecordWeighing,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.weighing.recordWeighing(id, body, principal);
  }

  @Permissions('production:secure_mixing_session:read')
  @Get('v1/weighing-records')
  list(@Query(new ZodValidationPipe(listWeighings)) query: ListWeighings) {
    return this.weighing.list(query);
  }

  @Permissions('production:secure_mixing_session:read')
  @Get('v1/weighing-records/:id')
  get(@Param('id') id: string) {
    return this.weighing.get(id);
  }
}
