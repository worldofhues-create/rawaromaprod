# RAW AROMACHEM — Deploy

Production is **AWS only** (EC2 + systemd + nginx + RDS PostgreSQL) — see
[`infra/aws/DEPLOY_AWS.md`](infra/aws/DEPLOY_AWS.md) for the full runbook (topology, secrets,
Formula Vault KMS setup, the ALEMBIC identity bridge, and the exact-SHA deploy/rollback script).

The previous Vercel + Render + Neon runbook (`render.yaml`, `web*/vercel.json`) has been removed
(G8, FINAL_OS §2.2/§5/§41 — AWS-only; no Vercel/Render/Neon/Aurora in production). If you need a
disposable preview deploy of a branch on that stack again, `infra/aws/nginx/` has the equivalent
static-file serving nginx would otherwise need — start from `infra/aws/DEPLOY_AWS.md` instead.

## The demo environment (lane D1)

A SEPARATE RawProd deployment of the same release artifact, on its own database, paired with the
ALEMBIC demo. Production never sets any of this.

- `RAWPROD_ENVIRONMENT=demo` (default `production`). An ALEMBIC assertion is accepted only when its
  `env` claim equals this value, so a production RawProd refuses every demo assertion and a demo
  RawProd refuses every production one.
- `ALEMBIC_ASSERTION_TENANT_ID=<the demo ALEMBIC tenant id>` — the demo tenant/org mapping.
- `pnpm db:seed` with `RAWPROD_ENVIRONMENT=demo` provisions the passwordless showcase account
  `demo@demo.alembic.invalid` holding the read-only, masked `showcase` role (coded manufacturing
  instructions, no Vault, no IAM, no formula, no writes). A production seed creates the role and
  never the account; the role is refused a session outside demo in any case.
- Showcase sessions never refresh: switching demo access off in ALEMBIC reaches a held RawProd
  showcase session within `JWT_ACCESS_TTL` (set it low on the demo box), and re-opening is refused
  by ALEMBIC at the assertion.
