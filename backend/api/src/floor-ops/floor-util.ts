/**
 * Small helpers shared by the floor services (lane pf-c). No I/O.
 */
import { BadRequestException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Sql } from 'postgres';

const dialect = new PgDialect();
/** A postgres.js client or transaction as the `execute(sql\`…\`)` surface the kernel's helpers take. */
export function drizzleExec(tx: Sql) {
  return {
    execute: (q: SQL) => {
      const c = dialect.sqlToQuery(q);
      return tx.unsafe(c.sql, c.params as never[]);
    },
  };
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** sha-256 hex: device tokens and pairing codes are stored only as this. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A 6-digit pairing code, uniformly drawn (leading zeros kept). */
export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** A device token: 32 random bytes, url-safe. Shown once, at pairing. */
export function newDeviceToken(): string {
  return 'rdt_' + randomBytes(32).toString('base64url');
}

/** Timestamps arrive as Date (plain client) or text (the API's client): one ISO string either way. */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export function text(body: Record<string, unknown>, key: string, max: number, required = true): string | null {
  const raw = body[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw new BadRequestException(`${key} is required.`);
    return null;
  }
  if (typeof raw !== 'string') throw new BadRequestException(`${key} must be text.`);
  const v = raw.trim();
  if (v.length > max) throw new BadRequestException(`${key} must be at most ${max} characters.`);
  return v;
}

/** A whole number of milligrams (weights are never floats). */
export function mg(body: Record<string, unknown>, key: string, opts: { required?: boolean; min?: number } = {}): number | null {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required ?? true) throw new BadRequestException(`${key} is required (whole milligrams).`);
    return null;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) throw new BadRequestException(`${key} must be a whole number of milligrams.`);
  if (n < (opts.min ?? 0)) throw new BadRequestException(`${key} must be at least ${opts.min ?? 0} mg.`);
  return n;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidField(body: Record<string, unknown>, key: string, required = true): string | null {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new BadRequestException(`${key} is required.`);
    return null;
  }
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw new BadRequestException(`${key} must be an id.`);
  return raw;
}
