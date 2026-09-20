/**
 * MastersController — `GET /v1/masters?typeKey=` (doc 06 §2). Public read; query
 * validated against the contracts `listMastersParams`.
 */
import { Controller, Get, Query, UsePipes } from '@nestjs/common';
import { Public, ZodValidationPipe } from '@core/backend-kernel';
import { platform } from '@core/contracts';
import { z } from 'zod';
import { MastersService, type MasterItemView } from './masters.service.js';

type ListMastersParams = z.infer<typeof platform.masters.listMastersParams>;

@Controller()
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @Public()
  @Get('v1/masters')
  @UsePipes(new ZodValidationPipe(platform.masters.listMastersParams))
  list(@Query() query: ListMastersParams): Promise<MasterItemView[]> {
    return this.masters.list(query.typeKey, query.activeOnly);
  }
}
