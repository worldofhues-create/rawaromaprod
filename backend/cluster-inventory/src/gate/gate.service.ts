/**
 * GateService — CRUD over the gate-entry tables (GATE_ENTRY_MASTER, GATE_ENTRY_DOCUMENTS),
 * plus the gate-entry create flow that writes the master + its document rows in one
 * transaction. numeric → String(n); timestamps → new Date(iso); dict meta tail carries
 * status + created/updated by (username = principal.userId).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  INVENTORY_DB,
  inventorySchema,
  type InventoryDb,
} from '../cluster-inventory.tokens.js';
import type { Page, ListQuery } from '../cluster-inventory.dtos.js';
import type {
  CreateGateEntry,
  CreateGateEntryDocument,
} from '../cluster-inventory.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { gateEntryMaster, gateEntryDocuments } = inventorySchema;

@Injectable()
export class GateService {
  constructor(@Inject(INVENTORY_DB) private readonly db: InventoryDb) {}

  /* ── FLOW: gate_entry_master (+documents) create ────────────────────── */

  async createGateEntry(body: CreateGateEntry, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const gateEntryId = uuidv7();
      const master = ensure(
        (
          await tx
            .insert(gateEntryMaster)
            .values({
              gateEntryId,
              gateEntryNumber: body.gateEntryNumber ?? null,
              vendorId: body.vendorId ?? null,
              purchaseOrderId: body.purchaseOrderId ?? null,
              locationId: body.locationId ?? null,
              vehicleNumber: body.vehicleNumber ?? null,
              entryDt: body.entryDt ? new Date(body.entryDt) : null,
              exitDt: body.exitDt ? new Date(body.exitDt) : null,
              driverName: body.driverName ?? null,
              status: 'ACTIVE',
              createdBy: principal.userId,
              updatedBy: principal.userId,
            })
            .returning()
        )[0],
      );

      const documents: (typeof gateEntryDocuments.$inferSelect)[] = [];
      for (const doc of body.documents) {
        const row = ensure(
          (
            await tx
              .insert(gateEntryDocuments)
              .values({
                gateEntryDocumentId: uuidv7(),
                gateEntryId,
                documentTypeId: doc.documentTypeId ?? null,
                documentId: doc.documentId ?? null,
                status: 'ACTIVE',
                createdBy: principal.userId,
                updatedBy: principal.userId,
              })
              .returning()
          )[0],
        );
        documents.push(row);
      }

      return { gateEntry: master, documents };
    });
  }

  async listGateEntries(
    query: ListQuery,
  ): Promise<Page<typeof gateEntryMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(gateEntryMaster)
      .where(query.cursor ? lt(gateEntryMaster.gateEntryId, query.cursor) : undefined)
      .orderBy(desc(gateEntryMaster.gateEntryId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.gateEntryId);
  }

  async getGateEntry(id: string) {
    return (
      (
        await this.db
          .select()
          .from(gateEntryMaster)
          .where(eq(gateEntryMaster.gateEntryId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── gate_entry_documents ───────────────────────────────────────────── */

  async createGateEntryDocument(
    body: CreateGateEntryDocument,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(gateEntryDocuments)
          .values({
            gateEntryId: body.gateEntryId ?? null,
            documentTypeId: body.documentTypeId ?? null,
            documentId: body.documentId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listGateEntryDocuments(
    query: ListQuery,
  ): Promise<Page<typeof gateEntryDocuments.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(gateEntryDocuments)
      .where(
        query.cursor
          ? lt(gateEntryDocuments.gateEntryDocumentId, query.cursor)
          : undefined,
      )
      .orderBy(desc(gateEntryDocuments.gateEntryDocumentId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.gateEntryDocumentId);
  }

  async getGateEntryDocument(id: string) {
    return (
      (
        await this.db
          .select()
          .from(gateEntryDocuments)
          .where(eq(gateEntryDocuments.gateEntryDocumentId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
