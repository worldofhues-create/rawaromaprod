/**
 * MaterialFactsController — the MAIN app box's half of the material-facts bridge (PB-03
 * remainder, V4 §109.1). Serves the SAME minimal `MasterdataLookup` shape (id + code/name/alias
 * refs only — never cost/vendor/QC fields) the Vault box's `MaterialFactsClient`
 * (`@ra/cluster-formula`) calls over the signed internal channel when `VAULT_MODE=true`, so the
 * Vault box never needs its own `PG_CLIENT`/main-DB credential just to resolve a material's
 * RM_ALIAS or run the Vault draft editor's material picker.
 *
 * `@Public()` (no user JWT here — this is a process-to-process call) + `InternalBridgeGuard`
 * (the actual access control: a valid HMAC signature over the exact raw request, see that
 * guard's header). Mounted only by `AppModule` (the main box always has `MASTERDATA_LOOKUP`
 * locally); `VaultAppModule` never imports this controller.
 */
import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InternalBridgeGuard, Public, ZodValidationPipe } from '@core/backend-kernel';
import { MASTERDATA_LOOKUP, type AliasRef, type MasterdataLookup, type MaterialRef } from '@ra/cluster-masterdata';

const searchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const aliasesBatchBody = z.object({
  materialIds: z.array(z.string()).min(1).max(500),
});

@Controller('internal/vault-bridge')
@Public()
@UseGuards(InternalBridgeGuard)
export class MaterialFactsController {
  constructor(@Inject(MASTERDATA_LOOKUP) private readonly masterdata: MasterdataLookup) {}

  @Get('material/:materialId')
  findMaterial(@Param('materialId') materialId: string): Promise<MaterialRef | null> {
    return this.masterdata.findMaterial(materialId);
  }

  @Get('material-alias/:materialId')
  findAliasForMaterial(@Param('materialId') materialId: string): Promise<AliasRef | null> {
    return this.masterdata.findAliasForMaterial(materialId);
  }

  @Post('material-aliases-batch')
  async findAliasesForMaterials(
    @Body(new ZodValidationPipe(aliasesBatchBody)) body: z.infer<typeof aliasesBatchBody>,
  ): Promise<Array<[string, AliasRef]>> {
    const map = await this.masterdata.findAliasesForMaterials(body.materialIds);
    return [...map.entries()];
  }

  @Get('material-search')
  searchMaterials(
    @Query(new ZodValidationPipe(searchQuery)) query: z.infer<typeof searchQuery>,
  ): Promise<MaterialRef[]> {
    return this.masterdata.searchMaterials(query.q, query.limit);
  }
}
