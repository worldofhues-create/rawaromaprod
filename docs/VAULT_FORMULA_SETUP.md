# Formula setup — "Ruh drafts, one person approves"

Owner decisions 2026-10-05: products are mostly blended in-house; Ruh drafts, one person approves.
Formula content never leaves the Vault and never passes through an AI model. "Ruh (automation)" is
deterministic RawProd server code acting under its own audited identity. It is not a model.

## The owners' two clicks (once per deployment)

Factory console → **Formula setup** → card **Let Ruh draft formulas**.

1. **Owner 1** clicks **Let Ruh draft formulas** and confirms. This creates the non-login account
   "Ruh (automation)" (`ruh.automation@service.rawprod.invalid`, `account_kind = SERVICE`) if it does
   not exist, and opens the ordinary two-person Vault-role grant request for the `formulator` role.
   It is PENDING and grants nothing yet. The card shows who asked, when the request expires (72 h)
   and which owners/admins may approve it.
2. **A different owner or admin** opens the same card and clicks **Approve**. This is the existing
   `POST /v1/vault-role-grant-requests/:id/approve` route with its existing rules: the approver
   cannot be the requester, cannot be the target, and cannot be an account the requester created
   (directly or through other accounts). There is no Ruh-specific shortcut.

A tenant with only one owner/admin cannot complete click 2. That is deliberate (see
`security.service.ts`). Add a genuinely independent second owner first.

## What Ruh can and cannot do

- It holds `formulator` and nothing else. Any other role is refused when it is requested and again
  when it is approved, and each refusal is audited (`security.service_role.refused`).
- It never signs in. Password, ALEMBIC assertion, refresh, set-password and change-email are all
  refused. CHECK constraints stop a SERVICE row from ever holding a password or an ALEMBIC identity.
- For each "Draft formula shells" click the factory box mints one short-lived token that carries
  only `formula:formula_master:write`, `formula:formula_version:write` and
  `formula:formula_ingredients:write`. It never carries plaintext read or any approval permission.
  The token is used for one Vault call, and every mint is audited (`security.service_token.minted`).
- It can never approve. Its token has no approval permission, and the Vault refuses an approval by
  the version's author (Ruh) as well as by anyone who sealed ingredients on that version.

## Day to day

1. **Factory → Formula setup → Products and their formulas.** Tick the products that have no
   formula, check **Single chemical** or **Blend** for each (pre-filled from the ALEMBIC
   catalogue's classification; see below), then click **Draft formula shells**. Ruh drafts
   one Vault formula per product (`F-<product code>`, DRAFT v1), and each product is linked to its
   formula. Each link is audited in `packaging.audit_events`.
   - A single chemical is sealed at once as `[its own material, 100 %, sequence 1]` and sent for
     approval. Its own material is the catalogue's material for it, else the one material whose
     code equals the product code, unless the caller names a different one. A catalogue blend
     is never sealed this way unless the owner overrides the catalogue on screen.
   - A blend is left as an empty DRAFT marked "recipe needed".
   Running it again is safe: a product that already has a shell gets the same shell back.
2. **Vault → Recipes needed** (formulator). Enter a blend's recipe line by line, or upload many
   recipes at once as CSV/TSV. The file is parsed in the Vault, deterministically, and materials
   are matched by exact code or name. **Check** shows unmatched or ambiguous materials (with
   suggestions), bad numbers and each recipe's total. A total that is not 100 % is a warning; a
   percentage of 0 or less blocks the upload. **Seal** writes every recipe or none, sealed as the
   uploading formulator, and sends each one for approval.
   Columns: `product_code` (or `formula_code`), `material_code` or `material_name`, `percentage`,
   optional `stage` and `sequence`. A blank product cell repeats the line above. Floor codes are not
   accepted, because they never leave the factory box.
3. **Vault → Approve recipes** (vault approver). Select the versions (or **Select all**) and click
   **Approve selected**. One fresh sign-in covers the request. Each version is then approved on
   its own, with its own audit row in your name and its own segregation-of-duties check. The list
   tells you which versions you may not approve: ones you drafted or sealed.
4. **Factory → Produce next.** A product whose formula is approved plans with one click, and the
   floor sees the formula code and version only. Until then the queue shows `NO_APPROVED_FORMULA`
   (or `NO_FORMULA_LINK` for a product with no formula), and the formula roles get an alert.

To replace a product's formula: **Formula setup → Replace formula…**, or **Products → Link
formula**. This needs `packaging:product_formula_link:write` (owner, production, packaging). A
reason is required, and the before/after is audited. The generic edit route still cannot change
`formula_id`.

## Classification from the catalogue

The ALEMBIC catalogue sync stores each product's `single_chemical` / `blend` classification in
`bridge.catalogue_item` (see `docs/bridge/FACTORY_CATALOGUE.md`). `CatalogueProductKindSource`
(`backend/api/src/formula-setup/catalogue-kind.source.ts`) reads it, and
`formula-setup.module.ts` provides it under `PRODUCT_KIND_SOURCE`.

- **Formula setup screen.** Each product shows the catalogue's kind, marked "from the catalogue"
  (hover shows ALEMBIC's reason), and the kind picker starts on it. A product the catalogue does not
  hold has no kind; the picker starts on Blend, which is the safe choice because a blend is never
  sealed.
- **Own material.** A single chemical is sealed at 100 % of the catalogue's material for it. If the
  catalogue has no material for it, the fallback is the one material whose code equals the product
  code.
- **`POST /v1/formula-setup/shells`** takes `{ productId, kind?, materialId?, overrideCatalogue? }`
  per product. When `kind` is left out, the catalogue's kind is used. A product with neither is
  refused ("choose single chemical or blend"), and nothing for it reaches the Vault.
- **A catalogue blend is never sealed as a single chemical** unless `overrideCatalogue: true` is
  sent for that product. The screen sends it only when the owner changes a catalogue blend to
  Single chemical, and the confirmation says so. Otherwise the request is refused per product, with
  the catalogue's reason. Going the other way (a catalogue single chemical drafted as a blend) is
  always allowed.
- **Conflicting catalogue rows.** If several catalogue rows on one product disagree on the kind, the
  product has no kind, and the system never guesses one.
- **Audit.** The link audit row says where the kind came from: from the catalogue, as the catalogue
  says, chosen by the owner, or owner override of the catalogue's blend or single chemical.
- **Factory setup checklist.** "Formulas linked" counts distinct catalogue products that have a
  real `product_master.formula_id` link. It also shows how many of those formulas the Vault has
  approved (`formulas.approved`, which is null when the Vault did not answer). The step is done only
  when every product is linked and approved, and it opens Formula setup for roles that have that
  screen.

## Where it lives

| Piece | Code |
|---|---|
| Ruh account, grant status, token | `backend/cluster-org/src/service-principal/` |
| Service-account refusals | `cluster-org` `auth.service.ts`, `security.service.ts` |
| Shells, recipe import, review queue, bulk approval (Vault box) | `backend/cluster-formula/src/setup/` |
| Recipe parser (pure) | `backend/cluster-formula/src/setup/recipe-csv.ts` |
| SoD: a sealer cannot approve | `cluster-formula` `approvals.service.ts` |
| Factory routes + link + `GET /v1/formulas` | `backend/api/src/formula-setup/` |
| Screens | `web/ws-formula-setup.js`, `web-vault/vault.js` (Recipes needed, Approve recipes) |
| Migration | `scripts/migrations/2026-10-05-formula-setup.sql` (then the two new permissions: `docs/releases/rc-rp-1005-permission-grants.sql`, generated by `scripts/gen-permission-grants.ts`; never `db:seed` on production) |
