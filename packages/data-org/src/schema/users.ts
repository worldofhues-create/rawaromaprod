/**
 * USER_MASTER (Phase-1A Data Dictionary). Auth backend for the platform — PasswordHash is
 * Argon2id (set by the auth service). OrganizationID is an in-schema FK to org_master.
 */
import { sql } from "drizzle-orm";
import { boolean, index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { iam } from "./_schema.js";
import { orgMaster } from "./org.js";

export const userMaster = iam.table(
  "user_master",
  {
    userId: dictPk("user_id"),
    organizationId: uuid("organization_id").references(() => orgMaster.organizationId),
    employeeCode: varchar("employee_code", { length: 50 }),
    userName: varchar("user_name", { length: 200 }),
    email: varchar("email", { length: 150 }),
    mobileNumber: varchar("mobile_number", { length: 20 }),
    passwordHash: varchar("password_hash", { length: 255 }),
    isActive: boolean("is_active"),
    /**
     * S3 security review item 1 — the ALEMBIC staff id (assertion `sub`, e.g.
     * `staff:admin@rawaroma.local`) this row is bound to, once a first successful
     * `alembic-assertion` login has claimed it. NULL until then. Closes a vault-takeover path:
     * without this column, `AuthService.loginWithAssertion` maps an assertion to a RawProd
     * account by EMAIL ALONE, so anyone who could get `iam:user_master:write` (which
     * `EditService`'s generic PATCH granted) could retarget a privileged account's email to an
     * address they control on ALEMBIC and sign in as that account. Once bound, every later
     * login for this row REQUIRES the assertion's `sub` to match — email alone is no longer
     * sufficient — and `EditService`'s generic edit path never exposes this column (see
     * `backend/api/src/edit/edit.service.ts`).
     */
    alembicSubject: varchar("alembic_subject", { length: 255 }),
    /**
     * Lane vaultsetup (owner decision 2026-10-05, "Ruh drafts, one person approves"): HUMAN for
     * every person; SERVICE for a non-login system principal (today only "Ruh (automation)", the
     * Formula Vault drafting account). A SERVICE row can never sign in (password, ALEMBIC
     * assertion, refresh — AuthService refuses each), never gets a password or an email change,
     * and may only ever hold the `formulator` role, granted through the ordinary two-person
     * Vault-role grant. Its tokens are minted server-side only, for one Vault call at a time
     * (ServicePrincipalService.mintVaultToken). scripts/migrations/2026-10-05-formula-setup.sql.
     */
    accountKind: varchar("account_kind", { length: 20 }).notNull().default("HUMAN"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("user_master_email_uq").on(t.email),
    index("user_master_org_idx").on(t.organizationId),
    uniqueIndex("user_master_alembic_subject_uq")
      .on(t.alembicSubject)
      .where(sql`${t.alembicSubject} IS NOT NULL`),
  ],
);
