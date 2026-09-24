# CLAUDE.md — RawProd within ALEMBIC OS

## OWNER DIRECTIVE — ALEMBIC OS DEMO PRODUCTISATION (2026-09-24)

This directive is authoritative for current release work.

### Product boundary

- **ALEMBIC + RawProd = one product: ALEMBIC OS.**
- ALEMBIC owns customer/commercial/control-plane truth.
- RawProd is the factory/manufacturing domain inside ALEMBIC OS.
- RawProd must not re-introduce an independent commercial order authority, standalone customer system, standalone login authority, Neon dependency, Render/Vercel production dependency, or legacy Vault dependency.
- The Formula Vault remains a separately isolated trust domain inside ALEMBIC OS. Vault plaintext must never be exposed to ALEMBIC, ordinary RawProd services, ARIA/AI, or demo identities.
- Legacy Neon/Render/Vercel/old-Vault state is `LEGACY_NON_AUTHORITATIVE`. Recover only opportunistically for archival or verified historical reconciliation. Its absence is not a launch blocker.

### Release objective

Continue until the defined launch scope is **100% productised and qualified**.

A feature is not complete merely because code exists. Productised means the intended UI is wired through API/service/data/event/job/permission/audit/observability as applicable and works in the real user journey.

No launch-scope page, screen, pane, tab, drawer or PWA may render blank. Zero data must produce an intentional empty state. Dependency failure must produce an explicit failure/retry state. A blank screen is a release failure.

### Dedicated demo ALEMBIC OS

Build a fully isolated demo deployment/database pair from the same release artifact as production. Never seed synthetic demo operating data into the live Raw Aroma Chem tenant.

Required public demo credential:

```
User ID: demo
Password: raw123456
```

This is intentionally a known demo credential, not a production secret. Use the normal password hasher/credential verification path. Never compare the plaintext credential in frontend code.

The ALEMBIC Admin setting `demo.access_enabled` is the server-authoritative kill switch and defaults OFF.

Required semantics:

1. OFF: demo login is rejected server-side and the demo-login UI is hidden/disabled.
2. ON: the dedicated demo deployment accepts the documented credential.
3. OFF after a login: any previously issued demo session must fail on its next request.
4. The live Raw Aroma Chem deployment must reject the demo credential regardless of config drift.
5. Demo auth must not be described or persisted as OTP/MFA.
6. Existing production auth/RBAC/step-up rules remain intact.

### RawProd demo scope is mandatory

The demo is not an ALEMBIC-only facade. It must include representative RawProd manufacturing truth and exercise the actual ALEMBIC -> RawProd -> ALEMBIC seam.

Seed deterministic, obviously synthetic data so every launch-scope RawProd page has meaningful content or an intentional empty/error state, including representative data for:

- material/vendor/procurement;
- PR/RFQ/PO lifecycle;
- gate entry / GRN;
- quarantine + incoming QC;
- warehouse/inventory/batches/transfers;
- production requirement / production order;
- coded manufacturing instruction consumption;
- packaging/filling;
- finished-goods release / ATP;
- dispatch and status-return bridge;
- automation decisions, retries/DLQ and audit/event history;
- users/roles, branches/warehouses, integrations/status cards and tutorials where in scope.

The synthetic story must reconcile with the ALEMBIC-side demo story. Do not create a second unrelated set of customers/orders inside RawProd.

### Vault boundary in demo

Demo identities must never receive:

- `formula:actual:read`;
- formula drafting/approval/lock authority;
- Vault plaintext;
- Vault secrets/KMS material.

If a Vault-related demo screen is needed, use obviously synthetic coded manufacturing-instruction/projection data that preserves the real trust boundary. Do not weaken Vault isolation for presentation completeness.

### Synthetic regulatory data

Never fabricate a plausible government-issued registration, licence, certificate, CAS/UN identity or other regulated fact and present it as genuine. Use explicit DEMO/SAMPLE/NOT LEGALLY VALID states or clearly synthetic projections/documents.

### Acceptance proof

Do not mark this work complete until the integrated release proves:

- `demo.access_enabled=false` -> demo login refused;
- `demo.access_enabled=true` -> `demo / raw123456` can enter the isolated demo deployment;
- turning the switch OFF invalidates a held demo session on its next request;
- production Raw Aroma Chem rejects the demo credential;
- demo cannot obtain Vault plaintext/authority;
- seeds are deterministic and idempotent;
- second seed run creates no duplicate business records;
- every launch-scope RawProd page is non-blank;
- representative ALEMBIC -> RawProd -> ALEMBIC journey succeeds;
- exact release SHA passes existing typecheck/tests/migrations/security/browser/release gates.

Do not weaken production auth, RLS, event idempotence, audit, financial controls, bridge signing or Vault controls to make the demo easier.
