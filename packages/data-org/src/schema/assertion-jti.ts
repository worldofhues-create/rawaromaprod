/**
 * S3 security review item 4 — Postgres-backed single-use store for `alembic-assertion` `jti`s.
 *
 * Replaces `AuthService`'s old in-process `Map<jti, exp>` (`usedAssertionJti`), which the
 * original code candidly called out as an MVP posture: "a multi-process deployment's exposure
 * is two API processes each accept one presentation inside that same short window". With
 * multiple API processes behind a load balancer (the AWS target topology this deployment
 * actually runs), that window is a real replay opportunity — a token intercepted in flight
 * could be presented once per process before any of them has seen the other's copy. A shared
 * table closes it: `insert ... on conflict (jti) do nothing` (see `auth.service.ts`) is atomic
 * across every process sharing the one Postgres, so exactly one presentation of a given `jti`
 * ever succeeds, cluster-wide.
 *
 * `expiresAt` mirrors the assertion's own `exp` claim (never later — a jti only needs to be
 * remembered for as long as the token itself could still pass signature verification) so a
 * lazy sweep (`delete from ... where expires_at < now()`, run by the same call that inserts)
 * keeps the table small without a cron job.
 */
import { timestamp, varchar } from "drizzle-orm/pg-core";
import { iam } from "./_schema.js";

export const assertionJti = iam.table("assertion_jti", {
  jti: varchar("jti", { length: 255 }).primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
