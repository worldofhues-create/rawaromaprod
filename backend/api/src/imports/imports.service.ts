/**
 * ImportsService (IMPORT-RP) — the factory box's bulk import: one engine over `platform.import_job`
 * with the factory's kinds (factory-kinds.ts). The mechanism itself is @core/backend-kernel's
 * ImportEngine; the Vault box builds its own over its own database for formulas.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { DomainError, IMPORT_MAX_BYTES, ImportEngine, PG_CLIENT, type AuthPrincipal, type ImportContext } from '@core/backend-kernel';
import { MaterialImportService } from '../floor/material-import.service.js';
import { factoryKinds } from './factory-kinds.js';

/** The uploaded file out of a JSON body. The console's channel carries JSON only, so a file travels as
 *  base64; the size cap is checked on the text before a byte is decoded. */
export function fileBytes(fileBase64: unknown): Buffer {
  if (typeof fileBase64 !== 'string' || fileBase64.length === 0) throw new DomainError('VALIDATION_FAILED', 'Choose a file to upload.', 422);
  if (fileBase64.length > Math.ceil(IMPORT_MAX_BYTES / 3) * 4 + 4) {
    throw new DomainError('VALIDATION_FAILED', `The file is larger than ${IMPORT_MAX_BYTES / 1048576} MB. Split it into smaller files.`, 422);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(fileBase64)) throw new DomainError('VALIDATION_FAILED', 'The file did not arrive whole. Upload it again.', 422);
  return Buffer.from(fileBase64, 'base64');
}
/** Today in India (the factory's day), read once at the edge. */
export const todayIst = (now = new Date()): string => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
export const contextOf = (principal: AuthPrincipal): ImportContext => ({ principal, today: todayIst() });

@Injectable()
export class ImportsService {
  readonly engine: ImportEngine;
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, materialImport: MaterialImportService) {
    this.engine = new ImportEngine(sql, 'platform', factoryKinds(sql, materialImport));
  }

  /** The history with each uploader's and committer's name, where the id is a user on file. */
  async history(principal: AuthPrincipal, kind?: string) {
    const jobs = await this.engine.history(principal, kind);
    const ids = [...new Set(jobs.flatMap((j) => [j.uploadedBy, j.committedBy]).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map(ids.length
      ? (await this.sql<{ id: string; name: string | null }[]>`select user_id::text as id, coalesce(nullif(user_name, ''), email) as name from iam.user_master where user_id = any(${ids}::uuid[])`).map((u) => [u.id, u.name])
      : []);
    return jobs.map((j) => ({ ...j, uploadedByName: names.get(j.uploadedBy) ?? null, committedByName: j.committedBy ? names.get(j.committedBy) ?? null : null }));
  }
}
