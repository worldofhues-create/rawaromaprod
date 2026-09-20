import { z } from 'zod';
import { uuid } from '../../primitives/ids.js';
import { defineEvent } from '../../primitives/events.js';

export const identityEvents = {
  userRegistered: defineEvent(
    'identity.user.registered',
    z.object({ userId: uuid, portal: z.string() }),
  ),
  userSuspended: defineEvent('identity.user.suspended', z.object({ userId: uuid })),
  sessionRevoked: defineEvent('identity.session.revoked', z.object({ sessionId: uuid, userId: uuid })),
  roleChanged: defineEvent('identity.role.changed', z.object({ userId: uuid })),
  orgCreated: defineEvent('identity.org.created', z.object({ orgId: uuid, type: z.string() })),
  memberAdded: defineEvent('identity.member.added', z.object({ orgId: uuid, userId: uuid })),
} as const;
