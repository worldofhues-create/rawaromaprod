/**
 * FormulaSetupController — the factory's formula-setup routes (lane vaultsetup).
 *
 *   GET  /v1/formula-setup/products     products + formula state + catalogue kind   packaging:product_formula_link:read
 *   POST /v1/formula-setup/shells       draft shells as Ruh, link each product      packaging:product_formula_link:write
 *                                       (kind defaults to the catalogue's; a catalogue blend is sealed as a
 *                                       single chemical only with overrideCatalogue: true)
 *   POST /v1/products/:id/formula-link  set or replace one product's formula        packaging:product_formula_link:write
 *   GET  /v1/formulas                   the formula list (code/status, no name)     packaging:product_formula_link:read
 *
 * The Ruh grant's two clicks are cluster-org's routes (ServicePrincipalController + the existing
 * vault-role-grant approve route).
 */
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Permissions, ZodValidationPipe, type AuthPrincipal } from '@core/backend-kernel';
import { SHELL_KINDS } from '@ra/cluster-formula';
import { FormulaSetupService } from './formula-setup.service.js';

const shellsBody = z
  .object({
    products: z
      .array(
        z
          .object({
            productId: z.string().uuid(),
            // Omitted = the catalogue's classification (refused for a product the catalogue lacks).
            kind: z.enum(SHELL_KINDS).nullable().optional(),
            materialId: z.string().uuid().nullable().optional(),
            // Required to seal a product the catalogue classifies as a blend as a single chemical.
            overrideCatalogue: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

const linkBody = z
  .object({
    formulaId: z.string().uuid(),
    reason: z.string().trim().min(3, 'say why the product\'s formula changes (min 3 characters)').max(500),
  })
  .strict();

const directoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().regex(/^\d{1,9}$/).optional(),
});

@Controller()
export class FormulaSetupController {
  constructor(private readonly setup: FormulaSetupService) {}

  @Permissions('packaging:product_formula_link:read')
  @Get('v1/formula-setup/products')
  products(@CurrentUser() principal: AuthPrincipal) {
    return this.setup.listProducts({ reveal: (principal.permissions ?? []).includes('masterdata:material:reveal') });
  }

  @Permissions('packaging:product_formula_link:write')
  @Post('v1/formula-setup/shells')
  shells(@Body(new ZodValidationPipe(shellsBody)) body: z.infer<typeof shellsBody>, @CurrentUser() principal: AuthPrincipal) {
    return this.setup.createShells(body, principal);
  }

  @Permissions('packaging:product_formula_link:write')
  @Post('v1/products/:id/formula-link')
  link(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(linkBody)) body: z.infer<typeof linkBody>,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.setup.linkFormula(id, body, principal);
  }

  @Permissions('packaging:product_formula_link:read')
  @Get('v1/formulas')
  formulas(@Query(new ZodValidationPipe(directoryQuery)) query: z.infer<typeof directoryQuery>) {
    return this.setup.directory(query.limit, query.cursor ?? null);
  }
}
