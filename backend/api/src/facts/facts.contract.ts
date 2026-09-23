/**
 * Facts API contract — the wire shape between ALEMBIC's ARIA and RawProd's read-only Facts
 * endpoint (PB-06; FINAL_OS §12-16, §32, §33 F12; V4 §40/§114; V5 §8). Pure types and
 * validation, no I/O — mirrors bridge/contract.ts's shape so this endpoint reads as a
 * sibling of the event channel rather than a new pattern.
 *
 * THE ALLOW-LIST IS THE WHOLE SECURITY MODEL FOR "NEVER FORMULA PLAINTEXT". `FACT_KINDS`
 * is a closed enum; `FactsService` never builds a query against `formula.*`, and a caller
 * naming any kind outside this list — including any future `formula_*` kind nobody has
 * written yet — is refused before a query is built. "Vault formula plaintext is never an
 * Aria resolver" (V4 §114) is therefore a property of this list, not a promise every query
 * author has to remember. `isNeverResolvable` is a second, independent check on the kind
 * STRING itself (same shape as backend-kernel's `PermissionsGuard.NEVER_IMPLICIT_PATTERNS`),
 * so a kind that merely *looks* formula/vault-shaped is refused even before the allow-list
 * lookup runs.
 */

export const FACT_KINDS = [
  "production_requirement_status",
  "material_availability",
  "po_status",
  "grn_status",
  "qc_status",
  "fg_atp",
  "dispatch_status",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** One RawProd permission code per fact kind — the thing `PermissionsGuard` would have
 *  checked had this arrived as an ordinary JWT-authenticated request. Real codes, taken
 *  from the existing `@Permissions(...)` catalogue (procurement/inventory/quality/
 *  packaging/sales/production), not invented for this endpoint. */
export const FACT_KIND_PERMISSION: Readonly<Record<FactKind, string>> = {
  production_requirement_status: "production:production_order:read",
  material_availability: "inventory:inventory_batch:read",
  po_status: "procurement:purchase_order:read",
  grn_status: "inventory:grn_master:read",
  qc_status: "quality:qc_inspections:read",
  fg_atp: "packaging:finished_good_batch_master:read",
  dispatch_status: "sales:dispatch_master:read",
};

/* Plain substring matches, not word-bounded: fact kinds are snake_case
   (`material_kek`, `provider_otp`), and `\b` does not see a boundary either side of an
   underscore (it is a `\w` character), so a bounded pattern would silently miss exactly the
   shape these kinds take. The safe direction for "never resolvable" is to over-refuse. */
const NEVER_RESOLVABLE_PATTERNS: readonly RegExp[] = [
  /formula/i, /vault/i, /kek/i, /dek/i, /password/i, /otp/i, /secret/i,
];

/** True for a fact-kind string that names — or merely resembles — something ARIA must
 *  never resolve, whether or not it is also a member of `FACT_KINDS`. */
export function isNeverResolvable(kind: string): boolean {
  return NEVER_RESOLVABLE_PATTERNS.some((re) => re.test(kind));
}

export function isKnownFactKind(kind: string): kind is FactKind {
  return (FACT_KINDS as readonly string[]).includes(kind);
}

/** The staff identity ALEMBIC is asking on behalf of. The HMAC signature over the request
 *  proves the CALLER IS ALEMBIC; it says nothing about whether THIS staff member may see
 *  THIS fact — that is re-checked against RawProd's own role→permission mapping from
 *  `roles`, never trusted from ALEMBIC's own authorization decision. */
export interface FactsCaller {
  readonly staffId: string;
  readonly roles: readonly string[];
}

export interface FactsQueryBody {
  readonly factKind: string;
  readonly params: Readonly<Record<string, string>>;
  readonly caller: FactsCaller;
}

export type FactsQueryProblem = "bad_fact_kind" | "bad_params" | "bad_caller";

export type FactsQueryValidation =
  | { readonly ok: true; readonly body: FactsQueryBody }
  | { readonly ok: false; readonly problems: readonly FactsQueryProblem[] };

/** Structural validation only — whether the CALLER may ask, and whether the KIND is
 *  resolvable at all, are separate checks the controller runs afterward with this. */
export function validateFactsQueryBody(raw: unknown): FactsQueryValidation {
  const problems: FactsQueryProblem[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, problems: ["bad_fact_kind", "bad_params", "bad_caller"] };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.factKind !== "string" || r.factKind.length === 0) problems.push("bad_fact_kind");

  if (typeof r.params !== "object" || r.params === null || Array.isArray(r.params)) {
    problems.push("bad_params");
  } else {
    for (const v of Object.values(r.params as Record<string, unknown>)) {
      if (typeof v !== "string") { problems.push("bad_params"); break; }
    }
  }

  const caller = r.caller as Record<string, unknown> | undefined;
  const rolesOk = Array.isArray(caller?.roles)
    && (caller!.roles as unknown[]).every((x) => typeof x === "string");
  if (typeof caller !== "object" || caller === null
    || typeof caller.staffId !== "string" || caller.staffId.length === 0
    || !rolesOk) {
    problems.push("bad_caller");
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    body: {
      factKind: r.factKind as string,
      params: r.params as Record<string, string>,
      caller: {
        staffId: (caller as Record<string, unknown>).staffId as string,
        roles: (caller as Record<string, unknown>).roles as string[],
      },
    },
  };
}
