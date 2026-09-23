# Vault removal patch — for U1/P0 only

**Lane U4 does not edit `web/app.js`, `web/index.html`, or `web/sw.js` (owned by U1's
shell/module split). This file describes exactly what to delete from `web/app.js` so the
factory PWA stops shipping Formula Vault UI, per
`P0_UI_PARITY_PUBLIC_GREEN_ADDENDUM.md` §7/§13 and
`ALEMBIC_RAWPROD_FINAL_LAUNCH_DIRECTIVE_V4.md` §109.4:

> Vault Console is NOT a PWA. Required: no service worker; no offline cache; ... Vault is
> excluded from PWA behavior.

Today the Vault sits inside `web/app.js`'s `superadmin` role and is shipped as part of the
PWA `app.js` bundle, which `web/sw.js` network-first-with-cache-fallback precaches
(`CACHE = 'ra-shell-v76'`, the `app.js` handler at sw.js's "app.js — NETWORK-FIRST" block).
That means Vault UI (and its shape — nav labels, which endpoints exist) is cached on-device
by every superadmin/owner install, which §109.4 forbids. The Vault has moved to its own
console: `web-vault/` (this lane's deliverable — not a PWA, no service worker, no
localStorage/IndexedDB for formula data).

Verified against `web/app.js` at commit `db4815fba8136f1f3c2486e0d3632449f41b2f55`
(2183 lines, md5 `eaaf93ccc7752bafb09adf3288619287`) — re-check each snippet still matches
before deleting; line numbers may have shifted if the shell split landed first.

## 1. Nav entries — `ROLES.superadmin.nav` (around line 96-112)

Remove these three tuples from the `superadmin` role's `nav` array (leave every other tuple
in that array untouched — `plans`, `runs`, `materials`, `users`, `audit`, `approvals`, etc.
all stay; `audit` → `/v1/formula-event-hist` also stays, it's a general change-log view, not
a plaintext/decrypt surface):

```js
['formulas', 'Formula vault', 'lock', '/v1/formulas'],
['fversions', 'Formula versions', 'layers', '/v1/formula-versions'],
```
(currently on the same source line as `runs`, line 98-99 — split that line so `runs` stays)

```js
['facaudit', 'Formula access', 'lock', '/v1/formula-access-audit'],
```
(currently joined with `approvals` on line 112 — keep `approvals`, drop only `facaudit`)

## 2. Table columns — `COLS` (around lines 180-182, 228)

Remove these three entries (dead once nothing links to the resource, but delete them
explicitly so a future grep for `/v1/formula` doesn't find stale UI config):

```js
'/v1/formulas': ['formulaCode', 'formulaName', 'status'],
'/v1/formula-types': ['typeCode', 'typeName', 'status'],
```
and (further down, ~line 228)
```js
'/v1/formula-access-audit': ['occurredAt', 'action', 'actor', 'entityType'],
```

Leave `'/v1/formula-event-hist'` and `'/v1/formula-versions'` COLS entries in place ONLY if
`fversions` nav access is fully removed per §1 — since nothing will link to
`/v1/formula-versions` anymore either, remove that COLS entry too (~line 263):
```js
'/v1/formula-versions': ['versionNumber', 'formulaId', 'approvedDt', 'status']
```

## 3. Row actions — `ACTIONS` (around lines 678-680, 768-771)

Remove the whole `/v1/formulas` action entry:
```js
'/v1/formulas': [
  { label: 'Attach IFRA cert', perm: 'platform:document_master:write', when: function () { return true; }, run: function (r) { openAttachIfra(r); } }
],
```

Remove the whole `/v1/formula-versions` action entry:
```js
'/v1/formula-versions': [
  { label: 'Seal ingredients', perm: 'formula:formula_ingredients:write', when: function (r) { return UP(r.status) === 'DRAFT'; }, run: function (r) { openAddIngredients(r); } },
  { label: 'Approve', perm: 'formula:formula_approval:write', tone: 'good', when: function (r) { return UP(r.status) === 'DRAFT'; }, path: function (r) { return '/v1/formula-versions/' + r.formulaVersionId + '/approve'; }, body: { approvalLevel: 1 } }
],
```

**Leave the `/v1/finished-good-batches` → `Trace` action alone** (line ~776,
`perm: 'formula:actual:read'`). That is a manufacturing-traceability feature on a
DIFFERENT resource (FG batches), not Vault nav — it stays in the factory PWA. It will now
403 for every factory role (owner included — see backend commits on this branch:
`formula:actual:read` is no longer implicit for `owner`/`super_admin`, and only
`formulator`/`vault_approver` hold it). **Flag for P0/U3**: `openTrace()`
(`web/app.js:1880`) currently calls the raw owner-only `/actual` endpoint directly, which
is now a real Vault plaintext read — recommend it call
`VaultPort.resolveManufacturingInstruction` (§109.7, masked/coded output) instead, or be
removed from Trace and left as a Vault-console-only lookup. Not fixed here: it's a
different resource/screen than the three nav keys this lane was scoped to remove, and the
directive's §109.7 masking-policy design for that port is a backend decision beyond this
patch.

## 4. Edit-form definitions — `DETAIL`/edit dialogs (around line 874-875)

Remove:
```js
'/v1/formula-versions': { resource: 'formula-versions', idKey: 'formulaVersionId', perm: 'formula:formula_version:write', statusField: 'status', title: 'Edit formula version',
  fields: [{ n: 'status', l: 'Status', t: 'select', en: ['DRAFT', 'APPROVED', 'ARCHIVED', 'REJECTED'] }] },
```

## 5. Create-form definitions (around lines 1356-1364)

Remove both:
```js
'/v1/formulas': { title: 'New formula', perm: 'formula:formula_master:write', fields: [
  { n: 'formulaCode', l: 'Formula code', t: 'text', req: true }, { n: 'formulaName', l: 'Formula name', t: 'text', req: true },
  { n: 'formulaTypeId', l: 'Type', t: 'select', fk: '/v1/formula-types', fv: 'formulaTypeId', fl: 'typeName' }
] },
'/v1/formula-versions': { title: 'New formula version', perm: 'formula:formula_version:write', fields: [
  { n: 'formulaId', l: 'Formula', t: 'select', fk: '/v1/formulas', fv: 'formulaId', fl: 'formulaName', req: true },
  { n: 'versionNumber', l: 'Version number', t: 'number', req: true }
] },
```

(Leave the `'/v1/document-registry'` create-form's `entityType` select alone — `'formula'`
staying in that enum just labels a document as formula-related; it doesn't expose Vault
data or link to a removed screen.)

## 6. Dead functions

Once §1-5 are removed, nothing calls these three functions — delete them:
- `openAttachIfra(formula)` — `web/app.js:1708-1743`ish (ends before `openAddIngredients`)
- `openAddIngredients(version)` — `web/app.js:1746-1783`ish (the "Seal into vault" dialog —
  this is the one that actually POSTs real `{materialId, percentage}` pairs; removing it is
  the highest-value part of this whole patch)

Do NOT delete `openTrace(fg)` (`web/app.js:1880`) — see §3, it's out of this patch's scope.

## 7. `sw.js` precache (owned by U1, informational only)

No `web/sw.js` line references `/v1/formula*` directly (it's a generic shell-cache
strategy — `app.js` is cached whole, network-first). Once §1-6 land, `app.js` simply no
longer CONTAINS Vault code, so nothing further is needed in `sw.js` itself. Bump `CACHE`
version (`ra-shell-v76` → next) as part of whatever U1/P0 already does for the shell split,
so installed clients pick up the smaller bundle promptly — don't add a Vault-specific cache
rule.

## 8. What this does NOT change

- Backend routes (`/v1/formulas`, `/v1/formula-versions`, `/v1/formula-access-audit`, …)
  are untouched and still exist — `web-vault/` (this lane) is the new, correct client for
  them. Deleting the factory-PWA UI is a client-only change.
- `formula:formula_event_hist:read` (`Audit log` nav, `/v1/formula-event-hist`) stays in
  the superadmin nav — it's a general change-log, not a Vault decrypt/approve surface, and
  isn't one of the three nav keys (`formulas`/`fversions`/`facaudit`) this patch targets.
