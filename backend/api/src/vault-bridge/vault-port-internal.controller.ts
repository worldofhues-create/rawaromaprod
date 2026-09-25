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
 *        needs floor codes this box does not hold (the old Vault -> main facts bridge is gone), so
 *        it refuses; kept only so an older main build gets an explicit error. The current main
 *        box does not call it.
 *   POST /internal/vault/security-audit — appends a `security.*` record to the Vault's
 *        hash-chained `formula.audit_events` (the edge guards' sensitive refusals on the main box).
 *   POST /internal/vault/formula-labels — formula code, version number and status per id, plus
 *        (for the dashboard) the first formula codes and the latest lifecycle event types. Never a
 *        formula name or an event's remarks (formula-directory.service.ts says why).
 *   POST /internal/vault/access-audit — one page of `formula.audit_events` for the main box's
 *        `/v1/formula-access-audit` (the caller's `formula:actual:read` is checked there).
 *   POST /internal/vault/material-catalogue — the main box PUSHES the material id/code/name
 *        catalogue the Vault console's picker searches (a digest probe, or one part of a full
 *        replacement — facts-bridge/material-catalogue.ts). The Vault never calls the main box.
 *
 * Nothing here needs a masterdata read, so answering never requires a call back into the main box.
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
  FormulaDirectoryService,
  MATERIAL_CATALOGUE_PART_SIZE,
  MaterialCatalogue,
  type AccessAuditPage,
  type CodedInstruction,
  type CodedMaterialLine,
  type CodedPickLine,
  type FormulaLabels,
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

const formulaLabelsBody = z.object({
  formulaVersionIds: z.array(z.string().uuid()).max(200).default([]),
  formulaIds: z.array(z.string().uuid()).max(200).default([]),
  recent: z.boolean().optional(),
});

const accessAuditBody = z.object({
  limit: z.number().int().min(1).max(500),
  cursor: z.string().regex(/^\d{1,9}$/).nullable().optional(),
});

/** Only the three fields the picker shows cross (material-catalogue.ts). Column sizes as
 *  masterdata.material (material_code varchar(50), material_name varchar(200)). */
const catalogueEntry = z
  .object({
    materialId: z.string().uuid(),
    materialCode: z.string().max(50).nullable(),
    materialName: z.string().max(200).nullable(),
  })
  .strict();

const materialCatalogueBody = z
  .object({
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    part: z.number().int().min(0).optional(),
    parts: z.number().int().min(1).optional(),
    materials: z.array(catalogueEntry).max(MATERIAL_CATALOGUE_PART_SIZE).optional(),
  })
  .strict();

@Controller('internal/vault')
@Public()
@UseGuards(InternalBridgeGuard)
export class VaultPortInternalController {
  constructor(
    @Inject(FORMULA_LOOKUP) private readonly formula: FormulaLookup,
    @Inject(SECURITY_AUDIT_SINK) private readonly securityAudit: SecurityAuditSink,
    @Inject(FormulaDirectoryService) private readonly directory: FormulaDirectoryService,
    @Inject(MaterialCatalogue) private readonly catalogue: MaterialCatalogue,
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

  @Post('formula-labels')
  async formulaLabels(
    @Body(new ZodValidationPipe(formulaLabelsBody)) body: z.infer<typeof formulaLabelsBody>,
  ): Promise<{ result: FormulaLabels }> {
    return { result: await this.directory.labels(body) };
  }

  @Post('access-audit')
  async accessAudit(
    @Body(new ZodValidationPipe(accessAuditBody)) body: z.infer<typeof accessAuditBody>,
  ): Promise<{ result: AccessAuditPage }> {
    return { result: await this.directory.accessAudit(body.limit, body.cursor) };
  }

  @Post('material-catalogue')
  materialCatalogue(
    @Body(new ZodValidationPipe(materialCatalogueBody)) body: z.infer<typeof materialCatalogueBody>,
  ): { result: { current: boolean } } {
    return { result: this.catalogue.receive(body) };
  }
}
