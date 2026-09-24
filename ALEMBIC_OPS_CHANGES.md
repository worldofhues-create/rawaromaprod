# ALEMBIC ops changes for P0 (lane OPS1, 2026-09-24)

## 1. alembic-backup: nightly backup never ran; the one manual start failed on the RDS root cert

Found on i-04e7dc4e5edcc1ff7 (prod 658e0d6):
- `alembic-backup.timer` was installed but **disabled**, so no nightly run ever fired. The only journal entry is a manual start on
  2026-09-21 22:59 UTC that failed: `root certificate file "/home/alembic/.postgresql/root.crt" does not exist`. migrate.env's
  DATABASE_URL uses sslmode=verify-full with no sslrootcert, and the unit (ProtectHome=true) has no PGSSLROOTCERT.
- `ops/scripts/backup.sh` writes local-only (`/srv/alembic/var/backups`). Nothing went offsite.

On-box fix (host-only, done; no alembic-api/web restart):
- Drop-in `/etc/systemd/system/alembic-backup.service.d/10-ops1-sslroot-s3.conf`:
  `Environment=PGSSLROOTCERT=/etc/alembic/certs/rds-global-bundle.pem` (the same file as api.env's ALEMBIC_DB_CA_FILE),
  `Environment=HOME=/tmp`, `ExecStartPost=/usr/local/lib/rawaroma/alembic-backup-s3.sh`.
- `/usr/local/lib/rawaroma/alembic-backup-s3.sh` copies the newest verified dump to
  `s3://alembic-backups-859485559854-usw2/alembic/pg_dump/` (SSE-S3). The alembic-ec2 role already had s3:PutObject on the bucket.
- `systemctl enable --now alembic-backup.timer`. The next run is 19:00 UTC daily.
- Verified: run at 2026-09-24T00:59:44Z gave `alembic-20260924T005944Z.pgc`, 426,681 B. The pg_restore --list check passed, and the object is
  in S3 with the same size (the 09-21 manual dump was 482,528 B).

Repo fix needed so this survives the next deploy. A deploy that rewrites the unit keeps the drop-in, but the change belongs in the repo.
```diff
--- a/ops/systemd/alembic-backup.service
+++ b/ops/systemd/alembic-backup.service
@@ [Service]
 EnvironmentFile=/etc/alembic/migrate.env
+# migrate.env's URL is sslmode=verify-full with no sslrootcert; libpq would look in ~/.postgresql/root.crt (ProtectHome hides it).
+Environment=PGSSLROOTCERT=/etc/alembic/certs/rds-global-bundle.pem
+Environment=HOME=/tmp
 ExecStart=/srv/alembic/app/ops/scripts/backup.sh
```
```diff
--- a/ops/scripts/backup.sh
+++ b/ops/scripts/backup.sh
@@ after: echo "backup $FILE ($(du -h "$FILE" | cut -f1))"
+# Offsite copy. A backup on the same disk as the database host's app is not a backup.
+if [ -n "${ALEMBIC_BACKUP_S3:-}" ]; then
+  aws s3 cp "$FILE" "$ALEMBIC_BACKUP_S3/$(basename "$FILE")" --sse AES256 --only-show-errors
+  echo "offsite $ALEMBIC_BACKUP_S3/$(basename "$FILE")"
+fi
```
Also set `ALEMBIC_BACKUP_S3=s3://alembic-backups-859485559854-usw2/alembic/pg_dump` in the unit, or in migrate.env through the deploy template.
The deploy/cutover script must also run `systemctl enable --now alembic-backup.timer`. Once the repo carries all of this, delete the drop-in and the helper script.
**Check the same way:** is `alembic-restore-drill.timer` enabled? It was not changed here.

## 2. nginx (host-only, RawProd vhost; ALEMBIC vhosts untouched)
The `rawprod-cf-origin.conf` 8443 vhost now picks its static root by the `X-RawProd-Site` header (set by API Gateway). One graceful reload, gated by `nginx -t`.
