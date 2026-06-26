# infra — reusable infrastructure recipe

The deployment + network standard every project reuses. Provision (VPS/Cloudflare) is per-project;
the *recipe* is fixed.

## Local development
```bash
docker compose -f infra/docker-compose.dev.yml up -d         # PG+PostGIS, Redis
docker compose -f infra/docker-compose.dev.yml --profile broker up -d   # + NATS (extraction stage)
# then, from repo root:
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/app
pnpm --filter @core/data-iam migrate && pnpm --filter @core/data-iam seed
pnpm --filter @core/data-platform migrate && pnpm --filter @core/data-platform seed
```

## Production topology (network masking — see ../docs/architecture-standard.md)
```
Internet → Cloudflare (proxied DNS · CDN · WAF · DDoS)         ← only public entry
            │ authenticated origin pulls (mTLS)
            ▼
  VPS-1 "app": Caddy (443, allow Cloudflare IPs only) → api + worker + web apps
            │ private VLAN
            ▼
  VPS-2 "data": Postgres (8 schemas) + Redis        ← no public ports
  SSH/DB admin via Tailscale/WireGuard only · ops/admin hostnames behind Cloudflare Access
```
- Origin firewall accepts 443 **only from Cloudflare IP ranges** → origin IP undiscoverable.
- Per-cluster Postgres roles (schema-scoped grants) → lateral-movement containment.
- Egress allowlist on app containers (payment/SMS/email/storage endpoints only).

## CI/CD
`.github/workflows/ci.yml` (template) runs lint + typecheck + build on every push.
Deploy with **Dokploy** (self-hosted PaaS) on the VPS: git push → build image → zero-downtime swap.
Two images from one backend build: `api` (HTTP) and `worker` (jobs/outbox).

## Backups
Nightly `pg_dump` → object storage (separate account, object-lock). WAL archiving at scale (RPO ~5min).
Weekly restore drill is part of the runbook.
