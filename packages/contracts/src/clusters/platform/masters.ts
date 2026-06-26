import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';

/** A row from the generic master engine (`master_items`). */
export const masterItem = z.object({
  id: uuid,
  typeKey: z.string(),
  key: z.string(),
  label: z.string(),
  parentId: uuid.nullable(),
  sortOrder: z.number().int(),
  metadata: z.record(z.unknown()).nullable(),
});

export const listMastersParams = z.object({
  typeKey: z.string().describe('property_type|amenity|measurement_unit|defect_taxonomy|...'),
  activeOnly: z.coerce.boolean().default(true),
});

/** Measurement-unit metadata convention (carried in `master_item.metadata`). */
export const measurementUnitMeta = z.object({
  dimension: z.enum(['area', 'length']),
  base: z.string(),
  factor: z.number().positive(),
});
