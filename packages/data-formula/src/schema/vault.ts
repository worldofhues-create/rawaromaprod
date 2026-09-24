/**
 * Formula vault + access control (Phase-1A Data Dictionary, schema `formula`):
 * FORMULA_VAULT, FORMULA_ACCESS_POLICY, FORMULA_APPROVAL.
 *
 * FORMULA_VAULT holds the per-formula encryption-key reference (encryption_key_ref) and the
 * vault_location — the pointer the seal/unseal path resolves to fetch the data key.
 *
 * In-schema FKs: formula_vault.formula_id → formula_master;
 * formula_access_policy.formula_id → formula_master;
 * formula_approval.formula_version_id → formula_version.
 * role_id, user_id, approver_user_id are soft refs (plain uuid, no FK).
 */
import { index, integer, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { formula } from "./_schema.js";
import { formulaMaster, formulaVersion } from "./master.js";

/** FORMULA_VAULT — formula_id is an in-schema FK; key ref + location per the dict. */
export const formulaVault = formula.table(
  "formula_vault",
  {
    formulaVaultId: dictPk("formula_vault_id"),
    formulaId: uuid("formula_id").references(() => formulaMaster.formulaId),
    encryptionKeyRef: varchar("encryption_key_ref", { length: 255 }),
    // text, not varchar(255): stores JSON.stringify(<KMS envelope>), which exceeds 255 chars.
    vaultLocation: text("vault_location"),
    ...metaColumns(),
  },
  (t) => [index("formula_vault_formula_idx").on(t.formulaId)],
);

/** FORMULA_ACCESS_POLICY — formula_id is an in-schema FK; role/user are soft. */
export const formulaAccessPolicy = formula.table(
  "formula_access_policy",
  {
    formulaAccessPolicyId: dictPk("formula_access_policy_id"),
    formulaId: uuid("formula_id").references(() => formulaMaster.formulaId),
    roleId: uuid("role_id"),
    userId: uuid("user_id"),
    accessLevel: integer("access_level"),
    ...metaColumns(),
  },
  (t) => [
    index("formula_access_policy_formula_idx").on(t.formulaId),
    index("formula_access_policy_role_idx").on(t.roleId),
    index("formula_access_policy_user_idx").on(t.userId),
  ],
);

/** FORMULA_APPROVAL — formula_version_id is an in-schema FK; approver is soft. */
export const formulaApproval = formula.table(
  "formula_approval",
  {
    formulaApprovalId: dictPk("formula_approval_id"),
    formulaVersionId: uuid("formula_version_id").references(() => formulaVersion.formulaVersionId),
    approverUserId: uuid("approver_user_id"),
    approvalLevel: integer("approval_level"),
    approvalStatus: varchar("approval_status", { length: 30 }),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [
    index("formula_approval_version_idx").on(t.formulaVersionId),
    index("formula_approval_approver_idx").on(t.approverUserId),
  ],
);
