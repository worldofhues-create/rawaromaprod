# RawProd AWS: provisioned resources (lane INFRA, 2026-09-24)

Account 859485559854, region us-west-2, default VPC vpc-0ea16289321edd00b. Every resource is tagged
`Project=rawaroma` and `Component=rawprod|vault`. This file holds no secret values. Secrets are only in
Secrets Manager and in SSM SecureString.

## Safety step before any change
- Manual snapshot of alembic-pg: `alembic-pg-pre-infra-20260924` (available). alembic-pg and
  i-04e7dc4e5edcc1ff7 were not modified: no reboot, no parameter-group change, no restart. Additive only.

## KMS (rotation enabled on both keys)
| Alias | KeyId | Policy |
|---|---|---|
| alias/rawprod-vault-storage | 52ca0c82-325b-4c55-87eb-3c4b0a619a21 | Admins (root, alembic-deploy) get management actions only, no crypto. Crypto is allowed only with `kms:ViaService=rds.us-west-2` and CallerAccount. |
| alias/rawprod-vault-envelope | 83c66cf8-c125-4574-a889-584ecedf154c | Admins get management only. Encrypt/Decrypt/GenerateDataKey go to role `rawprod-vault-app` only. An explicit Deny blocks crypto for every other principal ARN. This key is FORMULA_KMS_KEY_ID (SSM `/rawaroma/vault/FORMULA_KMS_KEY_ID`). |

Proofs: GenerateDataKey from the vault EC2 succeeded. From the alembic-ec2 role it returned AccessDeniedException. From the alembic-deploy user it returned AccessDeniedException.
Lesson: an explicit Deny on `kms:ViaService != rds` also blocks RDS's own grant-based calls. It put the
first vault-pg into `inaccessible-encryption-credentials`. That empty instance was deleted and recreated,
and the Deny was removed from the storage key.

## Network
- Private route table rtb-04566e8e73b65b83b has the `local` route only: no IGW and no NAT.
- Private subnets: subnet-0ecb4ce8f613ce9b9 (us-west-2a, 172.31.64.0/20) and subnet-08e34e3bc71e7b6eb
  (us-west-2d, 172.31.80.0/20). DB subnet group `rawprod-vault-private`.
- SG sg-09345a5b4efc3ce65 `rawprod-vault-app` has NO inbound rules. Operators reach the box through SSM only.
- SG sg-05d6f9f3bbdac6404 `rawprod-vault-db` allows 5432 from sg-09345a5b4efc3ce65 only, and has no egress.
- The RawProd API on i-04e7dc4e5edcc1ff7 uses the existing SGs (alembic-web to alembic-db). No change was made.

### Egress decision for the vault EC2: public subnet, zero inbound, no endpoints and no NAT
Interface endpoints for ssm, ssmmessages, ec2messages, kms and secretsmanager would cost about $36/mo in one AZ,
and they still give no path to GitHub or npm for install and deploy. A NAT gateway costs about $33/mo plus data.
The vault host has to be internet-facing anyway, to serve 443 to the allow-list through its own IP/EIP.
So it runs in default subnet subnet-040b6538a7332ae28 (us-west-2d) with a public IPv4 (~$3.6/mo). It has
IMDSv2 required and an SG with no inbound rules. The database is what must stay private, and it sits in
the no-route subnets above.

## RDS vault-pg
- db.t4g.micro, PostgreSQL 16.15, 20 GiB gp3 with autoscaling up to 100 GiB, encrypted with the vault-storage CMK
  (Performance Insights uses the same key), not public, subnet group `rawprod-vault-private`, SG
  sg-05d6f9f3bbdac6404, **Multi-AZ** (+~$12/mo, judged cheap enough), deletion protection on, 7-day PITR,
  IAM auth enabled, parameter group `rawprod-vault-pg16` (rds.force_ssl=1, log_min_duration_statement=500).
- DB `vault`. Master `vault_master`, whose password is managed by RDS in Secrets Manager (see the ids at the end of this file).
  The vault EC2 role can read that secret, using a tag condition on `aws:rds:primaryDBInstanceArn`.

## IAM
- Role and instance profile `rawprod-vault-app`: AmazonSSMManagedInstanceCore, plus inline `vault-least-privilege`.
  That policy grants kms Encrypt/Decrypt/GenerateDataKey/DescribeKey on the envelope key only, GetSecretValue on the
  vault-pg master secret only, and ssm:GetParameter* on `/rawaroma/vault/*` only.

## EC2 vault
- i-0edad222a96eeed07 `rawprod-vault-app`: t4g.small, Ubuntu 24.04 arm64 (the same family as alembic-app),
  ami-06c11807f6c511068, encrypted 20 GiB gp3, termination protection on, IMDSv2 required.
- Installed: node 22.12.0 in /opt/node-v22.12.0, pnpm 10.34.5, and psql 16. The repo is at /srv/rawprod/app @195fa66,
  owned by user `rawprod`. nginx is installed but disabled, so no vhost is live.

## alembic-pg (shared instance, additive only)
- New DB `rawprod`, owned by `rawprod_owner`. CONNECT is revoked from PUBLIC. Role `rawprod_app` has DML through
  default privileges and explicit grants. Extensions: pgcrypto 1.3, citext 1.6, pg_trgm 1.6, postgis 3.4.6
  (created as master).
- `pnpm db:migrate` ran with `SKIP_TARGETS=formula` at 195fa66: 19 ledger rows, 193 tables across 13 schemas,
  and the formula schema is empty here as intended. Nothing was seeded.
- App box: /srv/rawprod/app @195fa66, node 22.12.0 in /opt/node-v22.12.0 (ALEMBIC's system node 24 is untouched),
  RDS CA at /etc/rawprod/rds-global-bundle.pem. No rawprod service was started.

## vault-pg schema
- Roles: `ra_vault_owner` (DDL, owns DB `vault`) and `ra_vault` (DML only). CONNECT is revoked from PUBLIC. Extensions
  pgcrypto, citext, pg_trgm and postgis were created as master.
- `pnpm db:migrate` ran with `SKIP_TARGETS=main` from the vault EC2 @195fa66: 4 ledger rows, formula 15 tables,
  0 rows. `ra_vault` can read it, and `ssl=on` is verified.
- Master secret: arn:aws:secretsmanager:us-west-2:859485559854:secret:rds!db-5dd9e408-71ab-4463-8048-d7dd0be6f125-bKf3wk
  (RDS-managed, rotating). It is fetched on-box only.
- Endpoint: vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432. DbiResourceId: db-X5B6AZR5PYJCPGR4MWWXHJG5QI.

## Monthly cost delta (us-west-2 on-demand, approximate)
| Item | Cost |
|---|---|
| vault-pg db.t4g.micro Multi-AZ | ~$23.4 |
| 2x20 GiB gp3 storage | ~$4.6 |
| vault EC2 t4g.small | ~$12.3 |
| 20 GiB EBS | ~$1.6 |
| Public IPv4 | ~$3.6 |
| 2 CMKs | $2 |
| Secrets Manager (1 secret) | $0.4 |
| **Total** | **≈ $48/mo** |

SSM Standard parameters, the snapshot in the free backup allowance and PI 7-day retention add $0.
The t4g.large upgrade and alembic-pg Multi-AZ from the plan were **not** done: both need a reboot or failover of prod.

## SSM parameters (SecureString unless noted)
`/rawaroma/rawprod/{DATABASE_URL, MIGRATE_DATABASE_URL, DB_PASSWORD_owner, DB_PASSWORD_app}`
`/rawaroma/vault/{FORMULA_DATABASE_URL, MIGRATE_FORMULA_DATABASE_URL, DB_PASSWORD_owner, DB_PASSWORD_app}` and
`/rawaroma/vault/FORMULA_KMS_KEY_ID` (String).

## Blocked on the owner
- H7 DNS and hostnames. After that: nginx vhosts, certbot and EIP for the vault.
- H5 allow-list IPs. After that: add a 443 ingress per /32 to sg-09345a5b4efc3ce65
  (`aws ec2 authorize-security-group-ingress --group-id sg-09345a5b4efc3ce65 --protocol tcp --port 443 --cidr <ip>/32`)
  and write the nginx `vault-allowlist.conf`.
- H1/H2 Neon source credential and the real-vs-demo ruling. H4 legacy FORMULA_KEK, for the re-wrap into the envelope CMK.

---

# Lane INFRA2 (2026-09-24): G6 monitoring, G7 restore drills, alembic-pg CONNECT hardening, go-live prep, CloudFront

Everything below is code in `infra/aws/` and is idempotent. The only ALEMBIC-box service restarted was `amazon-cloudwatch-agent`
(via append-config). nginx got one graceful `reload`, gated by `nginx -t`. No alembic-* restart, no reboot.
ALEMBIC health was 200 before and after every step. No secret value is in git or in any log.

## IAM (additive inline policies, JSON in `infra/aws/iam/`)
- `alembic-ec2` / `rawprod-runtime`: ssm:GetParameter* on `/rawaroma/{rawprod,bridge,alembic}/*`, PutMetricData (namespace `RawAroma/*`),
  logs on `/rawaroma/*`.
- `rawprod-vault-app` / `vault-ops`: GetParameter on `/rawaroma/rawprod/{DATABASE_URL,assertion-verify-key}`, PutMetricData `RawAroma/*`,
  logs `/rawaroma/*`, RDS PITR restore of vault-pg into `vault-drill-*` only, Delete/Modify on `vault-drill-*` only, and s3:PutObject on
  `restore-drills/*`.
- `rawaroma-cloudtrail-to-cwl` (CloudTrail -> CloudWatch Logs).

## G6 monitoring (FINAL_OS §36): `infra/aws/cloudwatch/apply.sh`
- SNS `arn:aws:sns:us-west-2:859485559854:rawprod-alerts`, with email subscriptions to almaskhanraw@gmail.com and avinandan.toc@gmail.com.
  **HUMAN STEP: both are PendingConfirmation. Each recipient must click Confirm in the AWS email.**
- CloudTrail `rawaroma-audit`: single region, management events (read+write), log-file validation. It writes to S3 `rawaroma-cloudtrail-859485559854-usw2`
  (SSE-S3, public access blocked, TLS-only, 90-day expiry) and to log group `/rawaroma/cloudtrail` (30 days). This is the first trail in the account, so the management-event copy is free.
  The only costs are S3 and about $0.50/GB of CWL ingestion.
- Metric filter `kms-envelope-decrypt-errors`: CloudTrail events with kms Decrypt + errorCode on the envelope CMK go to `RawAroma/Security EnvelopeKeyDecryptErrors`
  (the pattern was checked with test-metric-filter).
- 22 alarms `rawprod-*`, all wired to the topic: vault-pg cpu/free-storage/connections/memory; vault EC2 status-check/cpu/disk; rawprod DB size (>5 GiB)
  and DB-size growth (>256 MiB/day, metric math DIFF); KMS decrypt errors; rawprod-api / vault-api unit down; bridge backlog age (>15 min);
  outbox backlog age (>30 min); dead letters (>=1); QC-hold age (>48 h); overdue PR/PO (>=1); metrics heartbeats (missing data breaches);
  weekly restore-drill failed x2.
  **No replica-lag alarm:** vault-pg is Multi-AZ with no read replica, and a Multi-AZ standby does not publish ReplicaLag. alembic-pg's own alarms are unchanged.
- Custom metrics, one per box, as a systemd timer every 5 min, running as user `rawprod` with hardened units:
  - app box `rawprod-metrics.timer` (`infra/aws/metrics/rawprod-metrics.sh`, read-only SQL on `rawprod`) writes `RawAroma/RawProd`: BridgeBacklog(+OldestAge),
    OutboxBacklog(+OldestAge) summed across every `<schema>.outbox`, DeadLetterCount (outbox attempts>=5 + parked `bridge.inbound_event`),
    QcHoldCount/OldestAgeHours, OverduePurchaseRequests/Orders, DatabaseSizeBytes, UnitActive, and MetricsHeartbeat. First run: all zero, DB 26 MB.
  - vault box `vault-metrics.timer` writes `RawAroma/Vault` UnitActive and a heartbeat. A unit reports UnitActive only once it is *enabled*, so the staged units do not alarm.
- CloudWatch agent: newly installed on the vault box (it also collects mem/disk into `RawAroma/Host`). On the ALEMBIC box a second config was appended to the existing agent.
  Log groups: `/rawaroma/rawprod/{api,vault-api,metrics,restore-drill,vault-nginx-error,vault-nginx-access}` (30 d, restore-drill 90 d).
  The rawprod-api/vault-api units now log to `/var/log/rawprod/*.log`, with logrotate.
- The vault box had the snap aws CLI, which cannot run inside hardened units, so AWS CLI v2 is now installed at /usr/local/bin.

## G7 restore drills: `infra/aws/restore-drill/`, timers `Sun 21:30 UTC` weekly on both boxes
- rawprod: pg_dump -Fc, then restore into a throwaway `rawprod_drill_<ts>` DB on alembic-pg (CONNECT revoked from PUBLIC), then exact row counts per table,
  then DROP. The dump is also kept at `s3://alembic-backups-859485559854-usw2/rawprod/pg_dump/` (a weekly logical backup).
- vault-pg: RDS PITR to the latest restorable time into `vault-drill-<ts>` (single-AZ micro, same private subnet/SG/PG, storage CMK), then row counts vs live,
  then delete with skip-final-snapshot and delete-automated-backups. Cost is about $0.01 per drill.
- **First run 2026-09-24, both PASS.** Evidence:
  - `s3://alembic-backups-859485559854-usw2/restore-drills/rawprod/20260924T004639Z.json`: 193/193 tables, 8519/8519 rows, 19 ledger rows, 9 s.
  - `s3://alembic-backups-859485559854-usw2/restore-drills/vault/20260924T004608Z.json`: 17/17 tables, 8504/8504 rows, ssl on,
    10.7 min to available. The drill instance was deleted.
- Runbook: `docs/VAULT_BREAK_GLASS.md` (KMS key recovery, role recreation, key disable/deletion, PITR restore, true break-glass, log).

## alembic-pg CONNECT hardening (done, verified)
- `alembic`: `GRANT CONNECT, TEMPORARY ... TO alembic_owner, alembic_app`, then `REVOKE CONNECT ... FROM PUBLIC`. ACL is now
  `{=T/alembic_owner, alembic_owner=CTc, alembic_app=Tc}`. Fresh connections were proved with ALEMBIC's own env-file credentials
  (alembic_app via api.env DATABASE_URL_APP, alembic_owner via migrate.env). Health was 200 local and public, before and after. No rollback was needed.
  Rollback if ever needed: `GRANT CONNECT ON DATABASE alembic TO PUBLIC`.
- `rawprod`: already correct from INFRA (`rawprod_owner=CTc`, `rawprod_app=Tc`, no PUBLIC). No change.
- Found but not mine: **`alembic-backup.service` has failed nightly since 2026-09-21.** pg_dump cannot find `/home/alembic/.postgresql/root.crt`
  (sslmode=verify-full with no sslrootcert). The fix is to set PGSSLROOTCERT to an RDS bundle in its env. Flagged to P0. I did not touch it.

## Go-live prep (step 4)
- SSM SecureString, created (values never printed): `/rawaroma/alembic/rawprod-assertion-signing-key` (Ed25519 pkcs8 DER b64 = ALEMBIC's
  `ALEMBIC_RAWPROD_ASSERTION_SIGNING_KEY`), `/rawaroma/rawprod/assertion-verify-key` (spki DER b64 = `ALEMBIC_ASSERTION_VERIFY_KEY`),
  `/rawaroma/bridge/hmac` (32 bytes hex), `/rawaroma/rawprod/JWT_SECRET` and `/rawaroma/vault/JWT_SECRET` (kept separate on purpose, so a factory token is not a vault token),
  and `/rawaroma/rawprod/cf-origin-secret`.
  ALEMBIC still has to load the signing key into its own config, and the bridge HMAC goes into the bridge connector config through Admin (self-service). Both are P0/ALEMBIC steps.
- Env files, rendered by `/usr/local/lib/rawaroma/render-env.sh app|vault` (source `infra/aws/env/render-env.sh`), are root 0600:
  app `/etc/rawprod/api.env` and `migrate.env` (SKIP_TARGETS=formula); vault `/etc/rawprod/vault.env` and `vault-migrate.env` (SKIP_TARGETS=main). No value is empty.
- Units installed in /etc/systemd/system and **disabled, not started**: rawprod-api/rawprod-migrate (app) and vault-api/vault-migrate (vault).
  Unit fixes: ExecStart now uses `/opt/node-v22.12.0/bin/node` (the app box's /usr/bin/node is ALEMBIC's node 24), migrate puts node 22 first in PATH,
  and vault-api reads `/etc/rawprod/vault.env`.
- nginx: `rawprod-main.conf` (app) and `vault.conf` (vault) are staged in sites-available only. `http2 on;` was changed to `listen ... ssl http2`,
  because both boxes run nginx 1.24, which does not have the `http2` directive.
- Known gap (unchanged, documented in vault-api.service): the vault box cannot reach alembic-pg for its interim `DATABASE_URL`, because alembic-db's SG only
  admits alembic-web. vault-api cannot boot until P0 decides between an SG rule and the vault-only entrypoint (PB-03).

## CloudFront front door (P0 ruling 2026-09-24: DNS and office IPs are POST_LAUNCH)
- Origin vhost `rawprod-cf-origin.conf` is **enabled** on the app box: port 8443 TLS with the raw.huecycle.in LE cert, so certbot renewal covers it.
  A request without the correct `X-Origin-Verify` header gets 403. Security headers are on every response. `/healthz` is a static 200. `/` is a placeholder page (`/var/www/rawprod-cf`).
  `/rpc,/crypto/,/v1/,/auth/,/health` proxy to 127.0.0.1:4100 with no-store. Right now they return 502 because rawprod-api is not started (by design).
  Tested on-box: no header 403, wrong header 403, right header 200 with HSTS/XFO/no-store. ALEMBIC was 200 before and after the reload.
- SG `sg-08d47035c2cd53a57` `rawprod-cf-origin`: 8443 from the CloudFront origin-facing prefix list `pl-82a045eb` only, no egress. It is attached to i-04e7dc4e5edcc1ff7
  in addition to alembic-web, with no restart. From the internet, 8443 times out.
- Distribution: `infra/aws/cloudfront/apply.sh`. Origin raw.huecycle.in:8443 https-only, with the secret header. API paths and /health(z) use CachingDisabled with all methods.
  PriceClass_200 (includes India), http2and3, IPv6. Aliases and the ACM cert come from `CF_ALIASES`/`CF_CERT_ARN`, so they can be added when DNS is ready.
  **BLOCKED (HUMAN STEP):** CreateDistribution returned `AccessDenied: Your account must be verified before you can add new CloudFront resources`.
  The owner must open an AWS Support case (Account and billing, which works on the free support plan) asking to verify the account for CloudFront. After that, re-run
  `AWS_PROFILE=rawaroma infra/aws/cloudfront/apply.sh`. Everything else is in place.
- The origin depends on DNS `raw.huecycle.in -> 35.82.209.155` and on that cert. If the box's public IP changes, update DNS; nothing else needs to change.

## INFRA2 monthly cost delta (approximate)
CloudWatch: 22 alarms (~$2.2, the first 10 are free), about 15 custom metrics (~$4.5), agent mem/disk (~$0.6), logs <1 GB (~$0.5).
CloudTrail S3 plus CWL ingestion ~$1. Weekly vault drill ~$0.05. CloudFront, once live, is pay-per-use (~$1 at this traffic). **Total ≈ $10/mo.**

---

# Lane OPS1 (2026-09-24): ALEMBIC backup fix, interim API Gateway front door

## ALEMBIC nightly backup (host-only, details and repo diff in `ALEMBIC_OPS_CHANGES.md`)
- Root cause: `alembic-backup.timer` was **disabled**, so it never ran at night. The single manual run on 09-21 failed because the unit had no `PGSSLROOTCERT`
  (the URL uses verify-full, and libpq defaulted to ~/.postgresql/root.crt).
- Fix: drop-in `alembic-backup.service.d/10-ops1-sslroot-s3.conf` (PGSSLROOTCERT=/etc/alembic/certs/rds-global-bundle.pem, plus ExecStartPost for an
  S3 offsite copy through `/usr/local/lib/rawaroma/alembic-backup-s3.sh`), and the timer is enabled (daily 19:00 UTC).
- Proof: `s3://alembic-backups-859485559854-usw2/alembic/pg_dump/alembic-20260924T005944Z.pgc` (426,681 B, pg_restore --list OK).
  No bucket lifecycle exists for `alembic/`. Local retention is 14 by count; S3 keeps everything until P0 sets a rule.

## Interim HTTPS front door: API Gateway HTTP APIs (`infra/aws/apigw/apply.sh`, idempotent)
| Console | ApiId | URL |
|---|---|---|
| factory (web/) | izcqrmad81 | https://izcqrmad81.execute-api.us-west-2.amazonaws.com/ |
| platform (web-platform/) | 4f8gxugmq8 | https://4f8gxugmq8.execute-api.us-west-2.amazonaws.com/ |
- Decision: **two APIs, not one API with /platform/**. Both consoles use root-absolute paths (`/shell.js`, `/platform.js`, `/manifest.webmanifest`)
  and both register `/sw.js`. A /platform/ prefix would break the assets and make the two service workers collide. Each API therefore sits at its host root (`$default` stage,
  auto-deploy, throttle 100 rps / burst 200).
- Routes `ANY /` and `ANY /{proxy+}` use HTTP_PROXY to `https://raw.huecycle.in:8443/{proxy}`. The request mapping overwrites `X-Origin-Verify` (value from SSM
  `/rawaroma/rawprod/cf-origin-secret`, never printed; readable by anyone with apigateway:GET) and `X-RawProd-Site: factory|platform`.
  HTTP APIs have no cache, so /rpc, /crypto/*, /v1/*, /auth/* are never cached, and nginx also sends no-store. /sw.js is served `no-cache`.
- Origin TLS: API Gateway HTTP integrations need a publicly trusted cert. The origin reuses the raw.huecycle.in Let's Encrypt cert, so no self-signed cert or sslip.io name was needed.
- Origin vhost: the static root is chosen by `X-RawProd-Site`, which maps to `/var/www/rawprod-cf/{factory,platform}`. These are copies (no build/, dotfiles or md) made by
  `cloudfront/install-origin.sh` from `/srv/rawprod/app` **@195fa66**. Re-run it after each RawProd deploy. With no header, the root falls back to the placeholder (CloudFront later).
- SG `sg-0eb2c2a212fa82207` `rawprod-apigw-origin`: 8443 from the 14 `API_GATEWAY` us-west-2 CIDRs in ip-ranges.json, no egress. It is attached to
  i-04e7dc4e5edcc1ff7 next to alembic-web and rawprod-cf-origin, with no restart. There is no AWS-managed prefix list for API Gateway, so re-run apply.sh when the ranges change.
  The secret header remains the real gate, because the ranges are shared with other API Gateway customers.
- Verified: /healthz is 200 on both URLs, `/` and the assets are 200, `/build/build.py` is 404, and `/rpc` is 502 (rawprod-api not started, as designed). A direct hit on
  35.82.209.155:8443 / raw.huecycle.in:8443 from the internet times out. On-box without the header it is 403. ALEMBIC stayed 200 and alembic-api/web stayed active throughout.
  The vault is untouched and closed.
- Cost: HTTP API $1.00 per million requests plus data out, so ≈ $0–1/mo at this traffic. S3 dumps ≈ 0.4 MB/day, a few cents per month. SG is free.
- Delete when CloudFront is live: `aws apigatewayv2 delete-api --api-id izcqrmad81` (and 4f8gxugmq8). Then detach and delete sg-0eb2c2a212fa82207.

---

# Lane DEMO-INFRA (2026-09-24): ALEMBIC OS DEMO environment, staged (no app code deployed)

Code: `infra/aws/demo/` (idempotent). Production was never restarted: raw/rawadmin returned 200 and alembic-api/web stayed active
before and after every step. nginx got a graceful reload gated by `nginx -t`. No secret value is in git or in any log.

## Data isolation (separate DBs, separate roles)
| DB | Instance | Owner / app role | Extensions |
|---|---|---|---|
| `alembic_demo` | alembic-pg | `alembic_demo_owner` / `alembic_demo_app` | pgcrypto, btree_gist (same as prod) |
| `rawprod_demo` | alembic-pg | `rawprod_demo_owner` / `rawprod_demo_app` | pgcrypto, citext, pg_trgm, postgis |
| `vault_demo` | vault-pg | `vault_demo_owner` / `vault_demo_app` | pgcrypto, citext, pg_trgm, postgis |
- `provision-db.sh app|vault`: CONNECT/TEMP is revoked from PUBLIC and granted only to that DB's two demo roles. The master is a member of the demo owner only while the script runs.
  Proven with has_database_privilege: the prod roles alembic_app, rawprod_owner, rawprod_app, ra_vault_owner and ra_vault get **false** on every demo DB, and every demo role gets **false** on alembic, rawprod and vault.
  **Residual:** the alembic-pg RDS master *is* `alembic_owner`, which is also ALEMBIC's migrate role. As rds_superuser it can reach every DB, demo included. That was already the case before this lane and cannot be changed without a new master.
- ALEMBIC migrations GRANT to the literal `alembic_app` in 73 files, and roles are cluster-wide. `sql/alembic-demo-grants.sql` moves every table, column, schema, routine, type, default-ACL and policy privilege
  from `alembic_app` to `alembic_demo_app` inside alembic_demo, and it raises an error if anything is left behind. It runs as ExecStartPost of `alembic-demo-migrate` and inside reset.
  It was tested on a full local migrate: 398 relation grants and 159 column grants moved, and 0 remained on alembic_app.
- RawProd and vault migrations name no role. `sql/app-role-grants.sql` grants DML to the demo app role after each migrate.

## KMS / IAM
- `alias/rawprod-demo-vault-envelope`, key 034c5485-02cb-4aad-b944-ff08a9b33f1e, with rotation on. Its policy mirrors the prod envelope key: admins get management only, crypto is allowed only to
  role **`rawprod-vault-demo`**, and an explicit Deny applies to every other principal. That role is assumed from the vault box role, through `/etc/rawprod-demo/aws-config` (credential_source=Ec2InstanceMetadata).
  Proven: the demo role can GenerateDataKey on the demo key. The box role on the demo key gets AccessDenied. The demo role on the prod key gets AccessDenied.
- Inline policies: `alembic-ec2/demo-runtime` (`iam/alembic-ec2.demo-runtime.json`) and `rawprod-vault-app/demo-vault` (`iam/rawprod-vault-app.demo-vault.json`: `/rawaroma/demo/vault/*`,
  the demo verify key, and sts:AssumeRole on rawprod-vault-demo only).

## SSM (SecureString unless noted)
`/rawaroma/demo/password` (owner-published demo credential), `/rawaroma/demo/origin-secret`,
`/rawaroma/demo/alembic/{DB_PASSWORD_owner,DB_PASSWORD_app,SECRET_KEYS,rawprod-assertion-signing-key}`,
`/rawaroma/demo/rawprod/{DB_PASSWORD_owner,DB_PASSWORD_app,JWT_SECRET,assertion-verify-key}` (a new Ed25519 pair, not the prod pair),
`/rawaroma/demo/vault/{DB_PASSWORD_owner,DB_PASSWORD_app,JWT_SECRET}` and `/rawaroma/demo/vault/FORMULA_KMS_KEY_ID` (String),
`/rawaroma/demo/{alembic-url,factory-url}` (String).

## Runtime (installed, **disabled, not started**)
| Unit | Box | Port | User / workdir | Env (root 0600, `render-demo-env.sh`) |
|---|---|---|---|---|
| alembic-demo-api.socket + .service | app | 127.0.0.1:4010 | alembic-demo, /srv/alembic-demo/app | /etc/alembic-demo/api.env (ALEMBIC_ENVIRONMENT=demo) |
| alembic-demo-web | app | 127.0.0.1:3010 | alembic-demo | /etc/alembic-demo/web.env |
| alembic-demo-migrate | app | n/a | alembic-demo | /etc/alembic-demo/migrate.env |
| rawprod-demo-api / -migrate | app | 4110 | rawprod-demo, /srv/rawprod-demo/app | /etc/rawprod-demo/api.env (RAWPROD_ENVIRONMENT=demo, JWT_ACCESS_TTL=300) |
| vault-demo-api / -migrate | vault | 4111 | rawprod-demo, /srv/rawprod-demo/app | /etc/rawprod-demo/vault.env (demo KMS key, vault_demo) |
Each demo unit has MemoryMax set (450M/450M/500M/400M) and CPUWeight=50, so the demo cannot starve prod. ALEMBIC_TENANT_ID comes from `/etc/alembic-demo/tenant-id`, which reset writes.
- **Headroom:** the app box (t4g.medium, 2 vCPU, 3.8 GiB) has 3.0 GiB available, 0 swap and load 0.07. Prod rawprod-api (~0.3 GiB) plus the three demo units (~0.6 GiB typical, 1.4 GiB capped) fit, so **no resize is needed**.
  Recommendation for P0: add a 2 GiB swapfile. It needs no reboot, and I did not do it. The vault box (t4g.small, 1.8 GiB) has 1.4 GiB available, which is enough for vault-api plus vault-demo-api.

## HTTPS without DNS: API Gateway HTTP APIs (in `demo/apply-aws.sh`)
| Demo | ApiId | URL | Origin |
|---|---|---|---|
| ALEMBIC (store `/`, Admin `/admin`, Agent `/agent`, API `/api/`) | s6sc99wp4g | https://s6sc99wp4g.execute-api.us-west-2.amazonaws.com/ | raw.huecycle.in:8444 |
| RawProd factory | b41jjd8l48 | https://b41jjd8l48.execute-api.us-west-2.amazonaws.com/ | raw.huecycle.in:8445 |
- Origin vhost `demo/nginx/rawaroma-demo-origin.conf` is **enabled**. Prod ALEMBIC nginx splits surfaces by host, and execute-api gives one hostname, so the demo routes by **path** instead. The Next app already serves /admin and /agent by path.
  Console security headers are used on /admin and /agent. Host and X-Forwarded-Host are set from `X-Demo-Host` (= `$context.domainName`), because API Gateway forbids overwriting X-Forwarded-Host.
- Gates: SG `sg-061d01a9c5b2e04ee` `rawaroma-demo-apigw-origin` allows 8444-8445 from the 14 API_GATEWAY us-west-2 CIDRs only, has no egress, and is attached with no restart. The request must also carry
  X-Origin-Verify = `/rawaroma/demo/origin-secret` (a different secret from prod) and X-Demo-Site pinned per port.
  Verified: on-box, no header gives 403, the wrong site gives 403 and the right one gives 200. /healthz returns 200 on both URLs. The factory placeholder `/` returns 200. ALEMBIC `/api/*` returns 502 because the app is not deployed (expected). A direct connection to :8444 from the internet times out.

## Reset: `infra/aws/demo/reset-demo.sh ssm` (or `vault`, then `app`, on the boxes)
It recreates vault_demo, then alembic_demo and rawprod_demo. It then runs the ALEMBIC migrate with the grant move, ALEMBIC `pnpm demo:seed`, writes the tenant-id, and runs `create-demo-account.mjs --user demo --mark-tenant-demo`
(the password comes from SSM on stdin; demo access stays **OFF** until Admin turns on `demo.access_enabled`). After that come the RawProd migrate and the RawProd `pnpm demo:seed`, and finally the units that were enabled are restarted. It refuses to run until
/srv/alembic-demo/app and /srv/rawprod-demo/app are deployed (checked: it refuses today).

## Deploy (P0, one step once the RC is chosen)
Put the RC artifact into /srv/alembic-demo/app and /srv/rawprod-demo/app (on both boxes), owned by the demo users. Then run `reset-demo.sh ssm`, then
`systemctl enable --now alembic-demo-api.socket alembic-demo-api alembic-demo-web rawprod-demo-api` (app) and `vault-demo-api` (vault). Re-run `install-box.sh app` to copy the factory static files.

## Open items for P0 / owner
1. **Formula seed path.** The RawProd seed writes formulas to FORMULA_DATABASE_URL, and the app box cannot reach vault-pg. Reset therefore refuses with `FORMULA_TARGET=vault` until there is a path
   (for example a 5432 rule from alembic-web to rawprod-vault-db, which is a prod-vault SG change and was not made). `FORMULA_TARGET=local` puts the formula schema into rawprod_demo instead; that is an explicit opt-in.
2. **Seeded formulas vs the demo KMS key.** `demo-seed.ts` seals with EnvKmsAdapter (FORMULA_KEK derived from a label), and vault-api in NODE_ENV=production accepts only AWS KMS. The demo vault-api will
   therefore not decrypt seeded formulas until the seed can use `FORMULA_KMS_KEY_ID`. This is an app-code item.
3. The demo vault JWT_SECRET is kept separate from the demo RawProd one, mirroring prod. vault-api.service's header says the two must be equal, and prod has the same contradiction. Decide it once for both.
4. ALEMBIC `ALEMBIC_RAWPROD_ASSERTION_SIGNING_KEY` is set in the demo api.env (demo pair). Prod has not loaded its own key yet.
- Cost: about $1/mo for the KMS key, $0 for SSM Standard, a few cents for HTTP APIs, and the extra DBs are free on the existing instances. **≈ $1–2/mo.**
- Delete path: disable the units, `aws apigatewayv2 delete-api` s6sc99wp4g and b41jjd8l48, detach and delete sg-061d01a9c5b2e04ee, DROP the 3 DBs and 6 roles, schedule deletion of the demo key, delete role rawprod-vault-demo and `/rawaroma/demo/*`.
