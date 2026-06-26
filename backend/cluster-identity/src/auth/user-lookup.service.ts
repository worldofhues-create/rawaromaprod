/**
 * UserLookupService — the in-cluster implementation of the `UserLookup` public port.
 * Provided under `USER_LOOKUP` so other clusters depend only on the interface (doc 06 §10).
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { IAM_DB, iamSchema, type IamDb } from '@core/backend-kernel';
import type { PublicUser, UserLookup } from '../public-api.js';

@Injectable()
export class UserLookupService implements UserLookup {
  constructor(@Inject(IAM_DB) private readonly db: IamDb) {}

  async findById(userId: string): Promise<PublicUser | null> {
    const rows = await this.select().where(
      and(eq(iamSchema.users.id, userId), isNull(iamSchema.users.deletedAt)),
    );
    return rows[0] ? toPublic(rows[0]) : null;
  }

  async findManyByIds(userIds: string[]): Promise<PublicUser[]> {
    if (userIds.length === 0) return [];
    const rows = await this.select().where(
      and(inArray(iamSchema.users.id, userIds), isNull(iamSchema.users.deletedAt)),
    );
    return rows.map(toPublic);
  }

  private select() {
    const { users } = iamSchema;
    return this.db
      .select({
        id: users.id,
        fullName: users.fullName,
        mobile: users.mobile,
        email: users.email,
        status: users.status,
      })
      .from(users);
  }
}

interface UserRow {
  id: string;
  fullName: string | null;
  mobile: string | null;
  email: string | null;
  status: string;
}

function toPublic(row: UserRow): PublicUser {
  const status =
    row.status === 'active' || row.status === 'suspended' || row.status === 'pending'
      ? row.status
      : 'pending';
  return {
    id: row.id,
    fullName: row.fullName ?? '',
    mobile: row.mobile,
    email: row.email,
    status,
  };
}
