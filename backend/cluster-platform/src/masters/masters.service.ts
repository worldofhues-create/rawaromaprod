/**
 * MastersService — reads the generic master engine (`master_items` by `type_key`),
 * doc 06 §2. Every platform-wide dropdown comes from here; adding a list is an INSERT,
 * never a migration. Active-only by default, ordered by `sort_order`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { PLATFORM_DB, platformSchema, type PlatformDb } from '@core/backend-kernel';

export interface MasterItemView {
  id: string;
  typeKey: string;
  key: string;
  label: string;
  parentId: string | null;
  sortOrder: number;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class MastersService {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** List the items of one master type. */
  async list(typeKey: string, activeOnly = true): Promise<MasterItemView[]> {
    const { masterItems } = platformSchema;
    const conditions = [eq(masterItems.typeKey, typeKey)];
    if (activeOnly) conditions.push(eq(masterItems.isActive, true));

    const rows = await this.db
      .select({
        id: masterItems.id,
        typeKey: masterItems.typeKey,
        key: masterItems.key,
        label: masterItems.label,
        parentId: masterItems.parentId,
        sortOrder: masterItems.sortOrder,
        metadata: masterItems.metadata,
      })
      .from(masterItems)
      .where(and(...conditions))
      .orderBy(asc(masterItems.sortOrder), asc(masterItems.label));

    return rows.map((r) => ({
      id: r.id,
      typeKey: r.typeKey,
      key: r.key,
      label: r.label,
      parentId: r.parentId,
      sortOrder: r.sortOrder,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    }));
  }
}
