import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';
import { defineEvent } from '../../primitives/events.js';
import { flagState } from '../../registries/flags.js';

export const platformEvents = {
  flagChanged: defineEvent(
    'platform.flag.changed',
    z.object({ key: z.string(), env: z.string(), state: flagState }),
  ),
  geoUpdated: defineEvent('platform.geo.updated', z.object({ regionId: uuid })),
  masterUpdated: defineEvent('platform.master.updated', z.object({ typeKey: z.string() })),
  checklistPublished: defineEvent(
    'platform.checklist_template.published',
    z.object({ templateId: uuid, version: z.number().int() }),
  ),
} as const;
