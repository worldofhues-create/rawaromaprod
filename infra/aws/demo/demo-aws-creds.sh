#!/usr/bin/env bash
# H1 (security review RC .2): short-lived demo AWS credentials, written by ROOT, so no demo process ever touches IMDS.
#   app box:   demo-aws-creds.sh app    -> assumes alembic-demo-app      -> /etc/alembic-demo/aws/{creds.json,config}  (root:alembic-demo 0640)
#   vault box: demo-aws-creds.sh vault  -> assumes rawprod-vault-demo    -> /etc/rawprod-demo/aws/{creds.json,config}  (root:rawprod-demo 0640)
# Run by <box>-demo-aws-creds.timer every 30 min; sessions last 1 h, so a missed run still leaves >= 30 min of validity.
# The demo units set IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128 + AWS_EC2_METADATA_DISABLED=true and point
# AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE here. The config uses credential_process (a `cat` of the JSON file,
# which carries Expiration) — NOT credential_source — so the SDK re-reads the file when the session nears expiry
# instead of memoising a static key forever. Secrets are never printed: only the expiry is echoed.
# rawprod-demo-api needs no AWS at all and gets no credentials (it is only IMDS-denied).
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
ACCT=859485559854
case "${1:?app|vault}" in
  app)   ROLE=alembic-demo-app;   GRP=alembic-demo; DIR=/etc/alembic-demo/aws ;;
  vault) ROLE=rawprod-vault-demo; GRP=rawprod-demo; DIR=/etc/rawprod-demo/aws ;;
  *) echo "usage: $0 app|vault" >&2; exit 2 ;;
esac
install -d -o root -g "$GRP" -m 750 "$DIR"
chmod go+x "$(dirname "$DIR")"   # traverse-only; the root 0600 env files there stay unreadable to the demo user
umask 027
t=$(mktemp "$DIR/.credsXXXX")
trap 'rm -f "$t"' EXIT
aws sts assume-role --role-arn "arn:aws:iam::$ACCT:role/$ROLE" --role-session-name "$GRP-$(hostname -s)" \
  --duration-seconds 3600 --query Credentials --output json \
| python3 -c 'import json,sys
c=json.load(sys.stdin)
json.dump({"Version":1,"AccessKeyId":c["AccessKeyId"],"SecretAccessKey":c["SecretAccessKey"],
           "SessionToken":c["SessionToken"],"Expiration":c["Expiration"]},sys.stdout)' > "$t"
chown root:"$GRP" "$t"; chmod 640 "$t"; mv -f "$t" "$DIR/creds.json"; trap - EXIT
c=$(mktemp "$DIR/.cfgXXXX")
printf '[default]\nregion = us-west-2\ncredential_process = /bin/cat %s/creds.json\n' "$DIR" > "$c"
chown root:"$GRP" "$c"; chmod 640 "$c"; mv -f "$c" "$DIR/config"
# AWS_SHARED_CREDENTIALS_FILE points at an intentionally EMPTY file so no static key can shadow credential_process.
[ -f "$DIR/credentials" ] || { : > "$DIR/credentials"; chown root:"$GRP" "$DIR/credentials"; chmod 640 "$DIR/credentials"; }
echo "demo creds for $ROLE written to $DIR (expires $(python3 -c 'import json;print(json.load(open("'"$DIR"'/creds.json"))["Expiration"])'))"
