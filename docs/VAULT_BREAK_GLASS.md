# Vault break-glass and KMS key recovery

Scope: the RawProd formula vault (vault-pg, the vault EC2, and the two KMS keys). Resource IDs are in
`infra/aws/PROVISIONED.md`. This file holds no secret values.

Break-glass means an operator bypasses the normal path (the vault app role on the vault EC2) because that path is
broken. Every break-glass use must be written down in the incident log below *before* the operator starts, and it
must be reviewed within 24 h by the second owner (Almas / Avinandan, whoever did not run it).

## What protects the formula data

| Layer | Key or control | Who can use it |
|---|---|---|
| Disk, snapshots and PITR of vault-pg | CMK `alias/rawprod-vault-storage` (52ca0c82-...) | RDS only (`kms:ViaService=rds.us-west-2`). No human can decrypt with it directly. |
| Formula rows (envelope encryption in the app) | CMK `alias/rawprod-vault-envelope` (83c66cf8-...) | Role `rawprod-vault-app` only. The key policy has an explicit Deny for every other principal, root included. |
| Network | SG `rawprod-vault-db` allows 5432 from the vault-app SG only | The vault EC2, reached through SSM Session Manager only |
| DB credentials | RDS-managed master secret, SSM `/rawaroma/vault/*` | vault EC2 role, and account admins |

Both keys have annual automatic rotation enabled. Old key material is kept by KMS for ever, so rotation never
makes old ciphertext unreadable.

## Scenario A: the vault EC2 is dead or compromised

1. Isolate: remove all inbound rules from `rawprod-vault-app` (there are none except the H5 allow-list /32s), then
   `aws ec2 stop-instances --instance-ids i-0edad222a96eeed07` (termination protection is on, so it cannot be terminated by mistake).
2. Launch a replacement from the same AMI family (Ubuntu 24.04 arm64, t4g.small) with instance profile
   `rawprod-vault-app`, SG `rawprod-vault-app`, IMDSv2 required. The key policy trusts the **role**, not the
   instance, so a new instance with the same profile can decrypt immediately.
3. Re-run `infra/aws/install-ops.sh vault` from a checkout of this repo, then `systemctl enable --now vault-api`.
4. If the old instance was compromised, rotate: `/rawaroma/vault/DB_PASSWORD_*` (ALTER ROLE and put-parameter),
   the RDS master secret (`aws secretsmanager rotate-secret`), and `/rawaroma/vault/JWT_SECRET`.

## Scenario B: the role `rawprod-vault-app` was deleted or its policy broken

The envelope key policy names the role ARN. If the role is deleted and recreated with the same name, **the key
policy does not trust it**: IAM gives the new role a new unique ID, and the policy principal now shows as the
old ID. To recover:

1. Recreate the role and instance profile `rawprod-vault-app` (trust ec2.amazonaws.com, inline `vault-least-privilege`
   and `vault-ops` from `infra/aws/iam/`, managed AmazonSSMManagedInstanceCore).
2. Key admins (account root, `alembic-deploy`) still hold `kms:PutKeyPolicy`. The policy's crypto Deny does not block
   management actions. Run `aws kms get-key-policy --key-id 83c66cf8-c125-4574-a889-584ecedf154c --policy-name default`,
   set the principal of statement `VaultRoleCrypto` back to `arn:aws:iam::859485559854:role/rawprod-vault-app`, and run
   `put-key-policy`. The Deny statement (`DenyCryptoToAllButVaultRole`) needs no change. It compares
   `aws:PrincipalArn` as an ARN string, so the recreated role already passes it.
3. Test from the vault EC2: `aws kms generate-data-key --key-id alias/rawprod-vault-envelope --key-spec AES_256`.

## Scenario C: a key was disabled or scheduled for deletion

- Disabled: `aws kms enable-key --key-id <id>`. Decrypt works again right away. The CloudWatch alarm
  `rawprod-kms-envelope-decrypt-errors` fires while it is disabled.
- Scheduled for deletion: `aws kms cancel-key-deletion --key-id <id>`, then `enable-key`. The waiting period is at
  least 7 days, so there is always a window to do this. **After deletion completes, the data is gone for ever.**
  Neither AWS nor we can recover it. So `kms:ScheduleKeyDeletion` should only ever be used together with a signed decision.
- Storage key disabled: vault-pg goes to `inaccessible-encryption-credentials`. Re-enable the key, then
  `aws rds start-db-instance` if RDS stopped it. The INFRA lane hit this once, when a Deny blocked RDS's grants.
  See PROVISIONED.md.

## Scenario D: vault-pg data loss or corruption

1. Pick a restore point. PITR covers 7 days: `aws rds describe-db-instances --db-instance-identifier vault-pg --query 'DBInstances[0].[EarliestRestorableTime,LatestRestorableTime]'`.
2. Restore to a **new** instance, following exactly the steps in `infra/aws/restore-drill/vault-drill.sh`, but
   use `--restore-time <iso>` and a name like `vault-pg-restored-<date>`. That script is rehearsed every week, and
   its evidence is in `s3://alembic-backups-859485559854-usw2/restore-drills/vault/`.
3. Check the data (the drill's row-count query), then point `/rawaroma/vault/FORMULA_DATABASE_URL` and
   `MIGRATE_FORMULA_DATABASE_URL` at the new endpoint, run `render-env.sh vault`, and restart vault-api.
4. Keep the old instance (deletion protection on) until the second owner signs off.

The envelope-encrypted formula rows stay readable after a restore, because the wrapped data keys are in the rows
and the envelope CMK is unchanged.

## Scenario E: human read access to formula plaintext (true break-glass)

There is deliberately no standing human path to plaintext. When a documented legal or operational need exists:

1. Both owners agree in writing (ticket or email), and the entry goes in the log below.
2. Open an SSM session to the vault EC2 (`aws ssm start-session --target i-0edad222a96eeed07`). Only there does the
   role hold kms:Decrypt. Use the application's own read path (the vault API or its CLI) rather than raw SQL
   plus manual unwrap, so the formula audit trail (`formula` audit tables, HMAC-chained) records the access.
3. CloudTrail trail `rawaroma-audit` records every Decrypt call. Afterwards, attach the time window of the session to the log entry.

## Scenario F: account-level lockout

If root and `alembic-deploy` are both lost, only AWS Support can restore account access, and the KMS keys stay
intact. Keep the root MFA device and the break-glass root credentials in the owner's offline safe, not on any laptop.

## Monitoring that points here

`rawprod-kms-envelope-decrypt-errors`, `rawprod-vault-*`, and `rawprod-vault-restore-drill-failed` all go to the
SNS topic `rawprod-alerts`.

## Break-glass log

| Date (UTC) | Operator | Scenario | Reason / approval | Reviewed by |
|---|---|---|---|---|
| | | | | |
