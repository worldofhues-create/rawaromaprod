/**
 * Reading loosely-typed request bodies into SQL parameters for the raw-SQL services on the shared
 * PG_CLIENT pool. Every value comes back as a STRING or null: that pool is wrapped by Drizzle, whose
 * postgres-js driver passes parameters through unserialized (see pg-timestamp.ts), so binding a JS
 * Date or number is not safe there. Casts happen in the SQL. A malformed id/number/date is a 400
 * with a plain message, never a Postgres 500.
 */
import { BadRequestException } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class BodyFields {
  constructor(private readonly body: Record<string, unknown>) {}

  /** Trimmed text, or null when absent/blank. */
  text(key: string, max = 2000): string | null {
    const v = this.body[key];
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (s.length > max) throw new BadRequestException(`${key} is too long (max ${max} characters).`);
    return s;
  }

  uuid(key: string): string | null {
    const s = this.text(key, 36);
    if (s !== null && !UUID.test(s)) throw new BadRequestException(`${key} is not a valid id.`);
    return s;
  }

  number(key: string): string | null {
    const s = this.text(key, 40);
    if (s !== null && !Number.isFinite(Number(s))) throw new BadRequestException(`${key} must be a number.`);
    return s;
  }

  /** YYYY-MM-DD. */
  date(key: string): string | null {
    const s = this.text(key, 10);
    if (s !== null && (!DATE.test(s) || Number.isNaN(Date.parse(s)))) {
      throw new BadRequestException(`${key} must be a date (YYYY-MM-DD).`);
    }
    return s;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T | null {
    const s = this.text(key, 100);
    if (s !== null && !(allowed as readonly string[]).includes(s)) {
      throw new BadRequestException(`${key} must be one of: ${allowed.join(', ')}.`);
    }
    return s as T | null;
  }

  required<T>(key: string, value: T | null): T {
    if (value === null) throw new BadRequestException(`${key} is required.`);
    return value;
  }
}
