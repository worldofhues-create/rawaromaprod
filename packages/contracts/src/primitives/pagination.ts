import { z } from 'zod';

/** Cursor pagination request params (query string). */
export const cursorParams = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorParams = z.infer<typeof cursorParams>;

/** A paginated page of `T`. The next cursor lives in the envelope `meta.cursor`. */
export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
