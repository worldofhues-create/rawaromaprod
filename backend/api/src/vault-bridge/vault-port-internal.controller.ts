/**
 * VaultPortInternalController — the VAULT box's half of the main-box -> Vault channel (PB-03
 * remainder, V4 §109.1 / §109.7). The main app box's `VaultApiClient` (`@ra/cluster-formula`,
 * vault-port.ts) calls these over the signed internal channel; the main box holds no
 * formula-database connection of its own.
 *
 *   POST /internal/vault/resolve-pick-list — a production order's bill of materials: per line a
 *        keyed material reference (material-ref.ts), the required quantity for `orderQty` and the
 *        sequence number. Never the material_id, an alias, the raw percentage or the formula name.
 *   POST /internal/vault/resolve-manufacturing-lines — the §109.7 coded instruction's lines with
 *        keyed material references (the main box resolves floor codes from its own masterdata).
 *   POST /internal/vault/resolve-manufacturing-instruction — the older alias-resolving form; it
 *        needs this box's facts bridge back to the main box (MAIN_API_INTERNAL_URL). Kept for a
 *        main box on an older build; the current main box does not call it.
 *   POST /internal/vault/security-audit — appends a `security.*` record to the Vault's
 *        hash-chained `formula.audit_events` (the edge guards' sensitive refusals on the main box).
 *
 * Neither pick-list nor manufacturing-lines needs any masterdata read, so answering them never
 * requires a call back into the main box.
 *
 * Injects `FORMULA_LOOKUP` / `SECURITY_AUDIT_SINK` directly (this process IS the vault,
 * in-process). `@Public()` + `InternalBridgeGuard`, same posture as `MaterialFactsController`: no
 * user JWT reaches here; the signed channel is the access control, and the caller's own
 * production permission was already checked on the main box. Mounted only by `VaultAppModule`;
 * the public nginx vhost does not proxy `/internal/`.
 */
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  InternalBridgeGuard,
  Public,
  SECURITY_AUDIT_SINK,
  ZodValidationPipe,
  type SecurityAuditSink,
} from '@core/backend-kernel';
import {
  FORMULA_LOOKUP,
  type CodedInstruction,
  type CodedMaterialLine,
  type CodedPickLine,
  type FormulaLookup,
  type ReadContext,
} from '@ra/cluster-formula';

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

const manufacturingLinesBody = z.object({
  formulaVersionId: z.string().uuid(),
  permittedBatchQuantity: z.number().finite().nonnegative(),
  ctx: readContext,
});

const pickListBody = z.object({
  formulaVersionId: z.string().uuid(),
  orderQty: z.number().finite().positive(),
  ctx: readContext,
});

/** Only `security.*` records may be written through this channel — never a `formula.*` read/write
 *  event, which only the Vault's own services record. */
const securityAuditBody = z.object({
  actorId: z.string().uuid().nullable(),
  action: z.string().regex(/^security\.[a-z0-9_.]+$/).max(100),
  entityType: z.string().min(1).max(100),
  entityId: z.string().uuid().nullable(),
  requestId: z.string().max(200).nullable().optional(),
  ip: z.string().max(100).nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
  result: z.enum(['allow', 'refuse']).optional(),
});

@Controller('internal/vault')
@Public()
@UseGuards(InternalBridgeGuard)
export class VaultPortInternalController {
  constructor(
    @Inject(FORMULA_LOOKUP) private readonly formula: FormulaLookup,
    @Inject(SECURITY_AUDIT_SINK) private readonly securityAudit: SecurityAuditSink,
  ) {}

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

  @Post('resolve-manufacturing-lines')
  async resolveManufacturingLines(
    @Body(new ZodValidationPipe(manufacturingLinesBody)) body: z.infer<typeof manufacturingLinesBody>,
  ): Promise<{ result: CodedMaterialLine[] | null }> {
    const result = await this.formula.resolveManufacturingLines(
      body.formulaVersionId,
      body.permittedBatchQuantity,
      body.ctx,
    );
    return { result };
  }

  @Post('resolve-pick-list')
  async resolvePickList(
    @Body(new ZodValidationPipe(pickListBody)) body: z.infer<typeof pickListBody>,
  ): Promise<{ result: CodedPickLine[] | null }> {
    const result = await this.formula.resolvePickList(body.formulaVersionId, body.orderQty, body.ctx);
    return { result };
  }

  @Post('security-audit')
  async securityAuditRecord(
    @Body(new ZodValidationPipe(securityAuditBody)) body: z.infer<typeof securityAuditBody>,
  ): Promise<{ recorded: true }> {
    await this.securityAudit.record(body);
    return { recorded: true };
  }
}
