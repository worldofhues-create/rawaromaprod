import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';

/** A node in the generic admin-region tree (country→…→locality). */
export const geoRegion = z.object({
  id: uuid,
  typeKey: z.string().describe('country|state|district|tehsil|village|city|ward|municipality|locality'),
  parentId: uuid.nullable(),
  name: z.string(),
  code: z.string().nullable().describe('LGD/census code'),
  centroid: z.object({ lat: z.number(), lng: z.number() }).nullable(),
});

export const geoSuggestParams = z.object({
  q: z.string().min(1),
  typeKey: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export const geoSuggestItem = geoRegion.pick({ id: true, typeKey: true, name: true }).extend({
  path: z.string().describe('breadcrumb e.g. "Vijay Nagar, Indore, MP"'),
});
