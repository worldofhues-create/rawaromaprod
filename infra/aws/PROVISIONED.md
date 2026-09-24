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
