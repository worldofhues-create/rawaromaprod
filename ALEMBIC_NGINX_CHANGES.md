# ALEMBIC-side changes for P0 (lane HOSTS, 2026-09-24) — NOT applied to ALEMBIC repo or prod env by this lane

## nginx (live on box, owned by RawProd repo file infra/aws/nginx/huecycle-hosts.conf)
- No edit to /etc/nginx/sites-available/alembic.conf. New file sites-enabled/zz-huecycle-hosts.conf adds server blocks for
  rawstudio (→ alembic_web :3000 / alembic_api :4000, `/`→302 /studio, /studio, /api/, /_next/, static-asset regex, else 404,
  security-headers-console.conf) and rawdemo/rawdemoadmin/rawdemoagent/rawdemostudio (→ :3010/:4010, mirrors raw/rawadmin/rawagent).
- It depends on alembic.conf's `upstream alembic_api`, `upstream alembic_web` and http-level proxy_set_header set:
  if ALEMBIC ops/nginx renames those, update huecycle-hosts.conf in the same change.
- Suggest P0 mirror the rawstudio block into ALEMBIC repo ops/nginx (alongside the three-origin alembic.conf).

## App / env needs (P0 decides; nothing edited)
1. `/studio` route: https://rawstudio.huecycle.in/studio currently returns the Next app's 404 on prod SHA 658e0d6 —
   Content Studio route must ship in the ALEMBIC release (and in the demo build for rawdemostudio).
2. ALEMBIC_CORS_ORIGINS: keep EMPTY — rawstudio serves /api/ same-origin exactly like rawadmin; no CORS needed.
   Demo: same (rawdemo* each proxy /api/ same-origin).
3. Host allow-lists: any app-level allowed-host / public-origin list (e.g. PUBLIC_ORIGIN, staff console origin checks,
   CSRF Origin checks, WebAuthn RP origins, email links) must add https://rawstudio.huecycle.in (prod) and
   https://rawdemo*.huecycle.in (demo env of alembic-demo-api/web).
4. Cookies: stay host-scoped (no Domain=.huecycle.in). A Studio session is a separate login from rawadmin — accept, or decide otherwise.
5. PWA: manifest.webmanifest / sw.js are served from each host root; if Studio gets its own manifest, set scope/start_url "/studio".
6. Payment/webhook return URLs for demo must use rawdemo.huecycle.in, not the execute-api hostname, once demo moves to these names.
