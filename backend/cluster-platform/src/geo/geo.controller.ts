/**
 * GeoController — `GET /v1/geo/suggest?q=` (doc 06 §2). Public read; query validated
 * against the contracts `geoSuggestParams` (coerces + caps `limit`).
 */
import { Controller, Get, Query, UsePipes } from '@nestjs/common';
import { Public, ZodValidationPipe } from '@core/backend-kernel';
import { platform } from '@core/contracts';
import { z } from 'zod';
import { GeoService, type GeoSuggestItem } from './geo.service.js';

type GeoSuggestParams = z.infer<typeof platform.geo.geoSuggestParams>;

@Controller()
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Public()
  @Get('v1/geo/suggest')
  @UsePipes(new ZodValidationPipe(platform.geo.geoSuggestParams))
  suggest(@Query() query: GeoSuggestParams): Promise<GeoSuggestItem[]> {
    return this.geo.suggest({
      q: query.q,
      typeKey: query.typeKey,
      limit: query.limit,
    });
  }
}
