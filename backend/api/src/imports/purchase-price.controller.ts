/**
 * IMPORT-RP-COST (LD-156) — a material's purchase price, one at a time. The sheet
 * (`material-purchase-prices` under /v1/imports) and these routes go through the same
 * PurchasePriceService.judge and .record.
 *
 *   GET  /v1/material-purchase-prices?materialCode=   the price history, newest first
 *   POST /v1/material-purchase-prices                 one price: { materialCode, unit?, supplier?, listPrice,
 *                                                     discountPercent?, gstRate?, hsn?, effectiveFrom, note? }
 *   GET  /v1/material-purchase-prices/large-change    the limit above which a preview lists a change
 *   PUT  /v1/material-purchase-prices/large-change    { largeChangePct }
 */
import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { todayIst } from './imports.service.js';
import { PurchasePriceService } from './purchase-price.service.js';

@Controller()
export class PurchasePriceController {
  constructor(private readonly prices: PurchasePriceService) {}

  @Permissions('procurement:material_purchase_price:read')
  @Get('v1/material-purchase-prices')
  history(@Query('materialCode') materialCode: string | undefined, @Query('limit') limit: string | undefined) {
    return this.prices.history(materialCode, Number(limit) || 200);
  }

  @Permissions('procurement:material_purchase_price:write')
  @Post('v1/material-purchase-prices')
  record(@Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.prices.recordOne(body ?? {}, p, todayIst());
  }

  @Permissions('procurement:material_purchase_price:read')
  @Get('v1/material-purchase-prices/large-change')
  async limit() {
    return { largeChangePct: await this.prices.largeChangePct() };
  }

  @Permissions('procurement:material_purchase_price:write')
  @Put('v1/material-purchase-prices/large-change')
  setLimit(@Body() body: Record<string, unknown>, @CurrentUser() p: AuthPrincipal) {
    return this.prices.setLargeChangePct(body?.largeChangePct, p);
  }
}
