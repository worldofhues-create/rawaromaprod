# RAW AROMACHEM — Deploy

Production is **AWS only** (EC2 + systemd + nginx + RDS PostgreSQL) — see
[`infra/aws/DEPLOY_AWS.md`](infra/aws/DEPLOY_AWS.md) for the full runbook (topology, secrets,
Formula Vault KMS setup, the ALEMBIC identity bridge, and the exact-SHA deploy/rollback script).

The previous Vercel + Render + Neon runbook (`render.yaml`, `web*/vercel.json`) has been removed
(G8, FINAL_OS §2.2/§5/§41 — AWS-only; no Vercel/Render/Neon/Aurora in production). If you need a
disposable preview deploy of a branch on that stack again, `infra/aws/nginx/` has the equivalent
static-file serving nginx would otherwise need — start from `infra/aws/DEPLOY_AWS.md` instead.
