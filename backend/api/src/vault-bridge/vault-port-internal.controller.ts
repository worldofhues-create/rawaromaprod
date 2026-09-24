/**
 * VaultPortInternalController — the VAULT box's half of the coded-instruction bridge (PB-03
 * remainder, V4 §109.1 / §109.7 `VaultPort.resolveManufacturingInstruction`). The main app
 * box's `VaultPortHttpClient` (`@ra/cluster-formula`) calls this over the signed internal
 * channel instead of holding its own live decrypt path for this one read.
 *
 * Injects `FORMULA_LOOKUP` directly (not `VAULT_PORT` — this process IS the vault, in-process;
 * `VAULT_PORT`/`VaultPortHttpClient` exists for the OTHER side of this same call, reached
 * remotely). `@Public()` + `InternalBridgeGuard`, same posture as `MaterialFactsController`.
 * Mounted only by `VaultAppModule`.
 */
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InternalBridgeGuard, Public, ZodValidationPipe } from '@core/backend-kernel';
import { FORMULA_LOOKUP, type CodedInstruction, type FormulaLookup, type ReadContext } from '@ra/cluster-formula';

const readContext = z.object({
  actorId: z.string().nullable(),
  requestId: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
});

const resolveBody = z.object({
  formulaVersionId: z.string().min(1),
  permittedBatchQuantity: z.number(),
  ctx: readContext,
});

@Controller('internal/vault')
@Public()
@UseGuards(InternalBridgeGuard)
export class VaultPortInternalController {
  constructor(@Inject(FORMULA_LOOKUP) private readonly formula: FormulaLookup) {}

  @Post('resolve-manufacturing-instruction')
  async resolve(
    @Body(new ZodValidationPipe(resolveBody)) body: z.infer<typeof resolveBody>,
  ): Promise<{ result: CodedInstruction[] | null }> {
    const ctx: ReadContext = body.ctx;
    const result = await this.formula.resolveManufacturingInstruction(
      body.formulaVersionId,
      body.permittedBatchQuantity,
      ctx,
    );
    return { result };
  }
}
