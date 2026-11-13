/**
 * FormulaImportService (IMPORT-RP) — the Vault box's bulk import: one engine over the Vault's own
 * `formula.import_job`, with one kind, `formulas` (formula-import.kind.ts, which states the formula
 * rule). The mechanism is the same ImportEngine the factory box uses.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { DomainError, IMPORT_MAX_BYTES, ImportEngine, type AuthPrincipal, type ImportContext } from '@core/backend-kernel';
import { FORMULA_PG_CLIENT } from '../formula.tokens.js';
import { FormulaSetupService } from '../setup/formula-setup.service.js';
import { formulasKind } from './formula-import.kind.js';

/** The uploaded file out of a JSON body (the console's channel carries JSON only). The cap is checked
 *  on the text before a byte is decoded. Never logged. */
export function fileBytes(fileBase64: unknown): Buffer {
  if (typeof fileBase64 !== 'string' || fileBase64.length === 0) throw new DomainError('VALIDATION_FAILED', 'Choose a file to upload.', 422);
  if (fileBase64.length > Math.ceil(IMPORT_MAX_BYTES / 3) * 4 + 4) throw new DomainError('VALIDATION_FAILED', `The file is larger than ${IMPORT_MAX_BYTES / 1048576} MB. Split it into smaller files.`, 422);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(fileBase64)) throw new DomainError('VALIDATION_FAILED', 'The file did not arrive whole. Upload it again.', 422);
  return Buffer.from(fileBase64, 'base64');
}
export const contextOf = (principal: AuthPrincipal): ImportContext =>
  ({ principal, today: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) });

@Injectable()
export class FormulaImportService {
  readonly engine: ImportEngine;
  constructor(@Inject(FORMULA_PG_CLIENT) sql: Sql, setup: FormulaSetupService) {
    this.engine = new ImportEngine(sql, 'formula', [formulasKind(sql, setup)] as never);
  }
}
