/**
 * COA QC DTOs (owner ruling 2026-09-28, item 1). Numbers arrive as numbers; dates as yyyy-mm-dd.
 */
import { z } from 'zod';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-mm-dd');

export const upsertProductQcSpec = z
  .object({
    sgMin: z.number().positive().max(9999),
    sgMax: z.number().positive().max(9999),
    flashPointMinC: z.number().min(-273).max(9999),
    flashPointMaxC: z.number().min(-273).max(9999),
    shelfLifeMonths: z.number().int().min(1).max(240),
    colourAppearanceStandard: z.string().max(2000).nullish(),
    odourStandard: z.string().max(2000).nullish(),
  })
  .refine((b) => b.sgMin <= b.sgMax, { message: 'sgMin must be ≤ sgMax', path: ['sgMin'] })
  .refine((b) => b.flashPointMinC <= b.flashPointMaxC, { message: 'flashPointMinC must be ≤ flashPointMaxC', path: ['flashPointMinC'] });
export type UpsertProductQcSpec = z.infer<typeof upsertProductQcSpec>;

export const coaPhotoInput = z
  .object({
    documentId: z.string().uuid().optional(),
    url: z.string().max(2000).regex(/^https?:\/\//i, 'photo url must be http(s)').optional(),
    caption: z.string().max(200).optional(),
  })
  .refine((p) => !!p.documentId || !!p.url, { message: 'a photo needs a documentId or a url' });
export type CoaPhotoInput = z.infer<typeof coaPhotoInput>;

export const recordBatchCoa = z.object({
  oilBatchId: z.string().uuid(),
  /** Optional when the batch's production order resolves to exactly one product. */
  productId: z.string().uuid().optional(),
  sgResult: z.number().positive().max(9999),
  flashPointResultC: z.number().min(-273).max(9999),
  colourAppearance: z.string().trim().min(1).max(2000),
  colourAppearancePass: z.boolean(),
  odourDescription: z.string().trim().min(1).max(2000),
  odourPass: z.boolean(),
  /** Defaults to the oil batch's produced date. */
  productionDate: ymd.optional(),
  photos: z.array(coaPhotoInput).max(20).default([]),
});
export type RecordBatchCoa = z.infer<typeof recordBatchCoa>;

export const listCoaQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['TESTED', 'RELEASED']).optional(),
});
export type ListCoaQuery = z.infer<typeof listCoaQuery>;
