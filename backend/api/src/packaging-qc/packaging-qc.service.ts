/**
 * PackagingQcService — Module 9 packaging QC (leakage / label / carton checks on a finished-good
 * batch). Lightweight raw-SQL service off the shared PG_CLIENT (same pattern as the dashboard),
 * since this is a single late-added table outside the cluster schema barrels.
 *
 * G3 (lane F2): `create()` now also records a `packaging.qc.recorded` row on `packaging.outbox`
 * (same transaction as the packaging_qc insert) — mirroring `production.qc.recorded`
 * (backend/cluster-production/src/production.events.ts), this table previously emitted NOTHING,
 * so nothing downstream could react to a packaging QC result. The G3 PackagingReleaseService
 * (backend/api/src/automation/packaging-release.service.ts) consumes it to release the FG batch
 * to availability + emit the bridge visibility event on PASS.
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
    const packagingQcId = this.uuid();
    const finishedGoodBatchId = (body.finishedGoodBatchId as string) ?? null;
    const rows = await this.sql.begin(async (tx) => {
      const inserted = await tx`
        insert into packaging.packaging_qc
          (packaging_qc_id, finished_good_batch_id, leakage_check, label_check, carton_check,
           overall_result, inspected_by, inspection_dt, status, created_dt, updated_dt, created_by, updated_by)
        values (${packagingQcId}, ${finishedGoodBatchId},
          ${(body.leakageCheck as string) ?? null}, ${(body.labelCheck as string) ?? null}, ${(body.cartonCheck as string) ?? null},
          ${overall}, ${principal.userId}, now(), 'ACTIVE', now(), now(), ${principal.userId}, ${principal.userId})
        returning packaging_qc_id as "packagingQcId", overall_result as "overallResult", status`;
      // G3: one outbox row per recorded packaging QC result, keyed by packaging_qc_id — the
      // trigger PackagingReleaseService (backend/api/src/automation) polls for.
      await tx`
        insert into packaging.outbox (type, aggregate_id, payload)
        values ('packaging.qc.recorded', ${packagingQcId},
          ${JSON.stringify({ packagingQcId, finishedGoodBatchId, overallResult: overall })}::jsonb)`;
      return inserted;
    });
    return rows[0];
  }

  private uuid(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (globalThis.crypto?.randomUUID?.() ?? require('node:crypto').randomUUID()) as string;
  }
}
