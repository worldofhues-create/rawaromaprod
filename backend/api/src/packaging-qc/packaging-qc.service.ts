/**
 * PackagingQcService — Module 9 packaging QC (leakage / label / carton checks on a finished-good
 * batch). Lightweight raw-SQL service off the shared PG_CLIENT (same pattern as the dashboard),
 * since this is a single late-added table outside the cluster schema barrels.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';

const COLS = `packaging_qc_id as "packagingQcId", finished_good_batch_id as "finishedGoodBatchId",
  leakage_check as "leakageCheck", label_check as "labelCheck", carton_check as "cartonCheck",
  overall_result as "overallResult", inspected_by as "inspectedBy", inspection_dt as "inspectionDt", status`;

@Injectable()
export class PackagingQcService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list(limit = 100): Promise<{ items: unknown[]; nextCursor: null }> {
    const rows = await this.sql.unsafe(
      `select ${COLS} from packaging.packaging_qc order by created_dt desc limit ${Math.min(Math.max(1, limit), 200)}`,
    );
    return { items: rows, nextCursor: null };
  }

  async get(id: string): Promise<unknown | null> {
    const rows = await this.sql.unsafe(`select ${COLS} from packaging.packaging_qc where packaging_qc_id = $1 limit 1`, [id]);
    return rows[0] ?? null;
  }

  async create(body: Record<string, unknown>, principal: AuthPrincipal): Promise<unknown> {
    const checks = [body.leakageCheck, body.labelCheck, body.cartonCheck].map((v) => String(v ?? '').toUpperCase());
    const overall =
      (body.overallResult as string) ||
      (checks.some((v) => v === 'FAIL') ? 'FAIL' : checks.some((v) => v === 'HOLD') ? 'HOLD' : 'PASS');
    const rows = await this.sql`
      insert into packaging.packaging_qc
        (packaging_qc_id, finished_good_batch_id, leakage_check, label_check, carton_check,
         overall_result, inspected_by, inspection_dt, status, created_dt, updated_dt, created_by, updated_by)
      values (${this.uuid()}, ${(body.finishedGoodBatchId as string) ?? null},
        ${(body.leakageCheck as string) ?? null}, ${(body.labelCheck as string) ?? null}, ${(body.cartonCheck as string) ?? null},
        ${overall}, ${principal.userId}, now(), 'ACTIVE', now(), now(), ${principal.userId}, ${principal.userId})
      returning packaging_qc_id as "packagingQcId", overall_result as "overallResult", status`;
    return rows[0];
  }

  private uuid(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (globalThis.crypto?.randomUUID?.() ?? require('node:crypto').randomUUID()) as string;
  }
}
