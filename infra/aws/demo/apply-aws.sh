#!/usr/bin/env bash
# DEMO-INFRA (2026-09-24): the AWS-side resources of the ALEMBIC OS DEMO environment. Run from an operator shell:
#   AWS_PROFILE=rawaroma AWS_USE_DUALSTACK_ENDPOINT=true infra/aws/demo/apply-aws.sh
# Idempotent. Additive only: nothing here touches a production resource's configuration except
#   (a) a NEW SG rawaroma-demo-apigw-origin (8444 from API Gateway ranges) attached to the app box, and
#   (b) new inline policies on the two instance roles (demo paths only).
# Secrets are generated here, written straight to SSM SecureString, and never printed. Existing values are kept.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-west-2}"
ACCT=859485559854; INSTANCE=i-04e7dc4e5edcc1ff7; VPC=vpc-0ea16289321edd00b
D=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
rnd(){ python3 -c 'import secrets;print(secrets.token_urlsafe(32))'; }
put(){ # name value-generator [String]
  local n=$1; shift
  if aws ssm get-parameter --name "$n" --query Parameter.Name --output text >/dev/null 2>&1; then echo "ssm $n (kept)"; return; fi
  local v; v=$("$@")
  printf '{"Name":"%s","Type":"SecureString","Value":%s,"Tags":[{"Key":"Project","Value":"rawaroma"},{"Key":"Component","Value":"demo"}]}' \
    "$n" "$(printf %s "$v" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" > "$tmp/p.json"
  aws ssm put-parameter --cli-input-json "file://$tmp/p.json" >/dev/null; rm -f "$tmp/p.json"; echo "ssm $n (created)"
}
b64key(){ python3 -c 'import secrets,base64;print("d1:"+base64.b64encode(secrets.token_bytes(32)).decode())'; }
hex32(){ python3 -c 'import secrets;print(secrets.token_hex(32))'; }
demo_pw(){ printf %s "${DEMO_PASSWORD:?set DEMO_PASSWORD for the first run (owner-published demo credential)}"; }

# ---------- SSM (/rawaroma/demo/*) ----------
put /rawaroma/demo/password demo_pw
put /rawaroma/demo/origin-secret rnd
put /rawaroma/demo/alembic/DB_PASSWORD_owner rnd
put /rawaroma/demo/alembic/DB_PASSWORD_app rnd
put /rawaroma/demo/alembic/SECRET_KEYS b64key
put /rawaroma/demo/rawprod/DB_PASSWORD_owner rnd
put /rawaroma/demo/rawprod/DB_PASSWORD_app rnd
put /rawaroma/demo/rawprod/JWT_SECRET hex32
put /rawaroma/demo/vault/DB_PASSWORD_owner rnd
put /rawaroma/demo/vault/DB_PASSWORD_app rnd
# No /rawaroma/demo/vault/JWT_SECRET: P0 decision (2026-09-24, lane FIXV) — vault-api verifies
# RawProd-issued JWTs and must use the SAME signing key as rawprod-demo's, so
# render-demo-env.sh's vault case reads /rawaroma/demo/rawprod/JWT_SECRET directly instead of a
# separate copy that could drift out of sync (prod's render-env.sh does the same).
# demo ALEMBIC -> demo RawProd assertion key pair (Ed25519, pkcs8/spki DER base64), never the prod pair
if ! aws ssm get-parameter --name /rawaroma/demo/alembic/rawprod-assertion-signing-key >/dev/null 2>&1; then
  openssl genpkey -algorithm ed25519 -outform DER -out "$tmp/k.der" 2>/dev/null
  sk(){ base64 < "$tmp/k.der" | tr -d '\n'; }; pk(){ openssl pkey -inform DER -in "$tmp/k.der" -pubout -outform DER | base64 | tr -d '\n'; }
  put /rawaroma/demo/rawprod/assertion-verify-key pk
  put /rawaroma/demo/alembic/rawprod-assertion-signing-key sk
  rm -f "$tmp/k.der"
fi

# ---------- IAM: demo vault role (the only principal allowed crypto on the demo envelope key) ----------
if ! aws iam get-role --role-name rawprod-vault-demo >/dev/null 2>&1; then
  cat > "$tmp/trust.json" <<J
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCT:role/rawprod-vault-app"},"Action":"sts:AssumeRole"}]}
J
  aws iam create-role --role-name rawprod-vault-demo --assume-role-policy-document "file://$tmp/trust.json" \
    --description "Demo vault-api only: crypto on alias/rawprod-demo-vault-envelope. Assumed from the vault box." \
    --tags Key=Project,Value=rawaroma Key=Component,Value=demo >/dev/null
fi

# ---------- KMS: alias/rawprod-demo-vault-envelope ----------
KEY=$(aws kms describe-key --key-id alias/rawprod-demo-vault-envelope --query KeyMetadata.KeyId --output text 2>/dev/null || true)
DEMO_ROLE=arn:aws:iam::$ACCT:role/rawprod-vault-demo
cat > "$tmp/kp.json" <<J
{"Version":"2012-10-17","Statement":[
 {"Sid":"KeyAdminNoCrypto","Effect":"Allow","Principal":{"AWS":["arn:aws:iam::$ACCT:user/alembic-deploy","arn:aws:iam::$ACCT:root"]},
  "Action":["kms:Create*","kms:Describe*","kms:Enable*","kms:List*","kms:Put*","kms:Update*","kms:Revoke*","kms:Disable*","kms:Get*","kms:Delete*","kms:TagResource","kms:UntagResource","kms:ScheduleKeyDeletion","kms:CancelKeyDeletion","kms:RotateKeyOnDemand"],"Resource":"*"},
 {"Sid":"DemoVaultRoleCrypto","Effect":"Allow","Principal":{"AWS":"$DEMO_ROLE"},"Action":["kms:Encrypt","kms:Decrypt","kms:GenerateDataKey","kms:DescribeKey"],"Resource":"*"},
 {"Sid":"DenyCryptoToAllButDemoVaultRole","Effect":"Deny","Principal":"*","Action":["kms:Encrypt","kms:Decrypt","kms:ReEncrypt*","kms:GenerateDataKey*"],"Resource":"*",
  "Condition":{"ArnNotEquals":{"aws:PrincipalArn":"$DEMO_ROLE"}}}]}
J
if [ -z "$KEY" ] || [ "$KEY" = None ]; then
  sleep 10   # new role must be resolvable by KMS
  KEY=$(aws kms create-key --description "RawProd DEMO vault envelope key (demo vault-api only)" --policy "file://$tmp/kp.json" \
    --tags TagKey=Project,TagValue=rawaroma TagKey=Component,TagValue=demo --query KeyMetadata.KeyId --output text)
  aws kms create-alias --alias-name alias/rawprod-demo-vault-envelope --target-key-id "$KEY"
  aws kms enable-key-rotation --key-id "$KEY"
else
  aws kms put-key-policy --key-id "$KEY" --policy-name default --policy "file://$tmp/kp.json"
fi
aws ssm put-parameter --name /rawaroma/demo/vault/FORMULA_KMS_KEY_ID --type String --value "$KEY" --overwrite >/dev/null
echo "kms alias/rawprod-demo-vault-envelope $KEY"
cat > "$tmp/demo-kms.json" <<J
{"Version":"2012-10-17","Statement":[{"Sid":"DemoEnvelopeOnly","Effect":"Allow","Action":["kms:Encrypt","kms:Decrypt","kms:GenerateDataKey","kms:DescribeKey"],"Resource":"arn:aws:kms:$AWS_REGION:$ACCT:key/$KEY"}]}
J
aws iam put-role-policy --role-name rawprod-vault-demo --policy-name demo-envelope --policy-document "file://$tmp/demo-kms.json"

# ---------- IAM: demo ALEMBIC role (H1, RC .2 review) ----------
# The demo ALEMBIC API needs AWS only for ARIA (bedrock-mantle / bedrock) and Translate. It never reads the box role:
# root's demo-aws-creds.sh app assumes this role every 30 min and the IMDS-denied unit reads the 0640 session file.
# No S3 (prod documents/backups), no Chime, no Secrets Manager, no SSM.
if ! aws iam get-role --role-name alembic-demo-app >/dev/null 2>&1; then
  cat > "$tmp/trust-app.json" <<J
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCT:role/alembic-ec2"},"Action":"sts:AssumeRole"}]}
J
  aws iam create-role --role-name alembic-demo-app --assume-role-policy-document "file://$tmp/trust-app.json" --max-session-duration 3600 \
    --description "Demo ALEMBIC API only: ARIA inference + Translate. Assumed by root on the app box (demo-aws-creds.sh)." \
    --tags Key=Project,Value=rawaroma Key=Component,Value=demo >/dev/null
fi
aws iam put-role-policy --role-name alembic-demo-app --policy-name demo-app --policy-document "file://$D/iam/alembic-demo-app.policy.json"

# ---------- IAM: instance-role additions (demo paths only) ----------
aws iam put-role-policy --role-name alembic-ec2 --policy-name demo-runtime --policy-document "file://$D/iam/alembic-ec2.demo-runtime.json"
aws iam put-role-policy --role-name rawprod-vault-app --policy-name demo-vault --policy-document "file://$D/iam/rawprod-vault-app.demo-vault.json"
echo "iam inline policies applied"

# ---------- origin SG for the demo listeners (8444 alembic, 8445 factory) ----------
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=rawaroma-demo-apigw-origin Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name rawaroma-demo-apigw-origin --vpc-id $VPC \
    --description "DEMO origin 8444-8445 from API Gateway us-west-2 ranges only" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=rawaroma},{Key=Component,Value=demo},{Key=Name,Value=rawaroma-demo-apigw-origin}]" --query GroupId --output text)
  aws ec2 revoke-security-group-egress --group-id $SG --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null
fi
curl -fsS https://ip-ranges.amazonaws.com/ip-ranges.json | python3 -c '
import json,sys
d=json.load(sys.stdin); c=sorted({p["ip_prefix"] for p in d["prefixes"] if p["service"]=="API_GATEWAY" and p["region"]=="us-west-2"})
print(json.dumps([{"IpProtocol":"tcp","FromPort":8444,"ToPort":8445,"IpRanges":[{"CidrIp":x,"Description":"API_GATEWAY us-west-2"} for x in c]}]))' > "$tmp/perm.json"
aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions "file://$tmp/perm.json" >/dev/null 2>&1 || true
cur=$(aws ec2 describe-instances --instance-ids $INSTANCE --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
case " $cur " in *" $SG "*) ;; *) aws ec2 modify-instance-attribute --instance-id $INSTANCE --groups $cur $SG ;; esac
echo "sg $SG"

# ---------- API Gateway HTTP APIs (one hostname each; the origin splits by X-Demo-Site) ----------
export SECRET=$(aws ssm get-parameter --with-decryption --name /rawaroma/demo/origin-secret --query Parameter.Value --output text)
ORIGIN_HOST="${ORIGIN_HOST:-https://raw.huecycle.in}"
for site in alembic factory; do
  ORIGIN="$ORIGIN_HOST:$([ $site = alembic ] && echo 8444 || echo 8445)"
  name="rawaroma-demo-$site"
  API=$(aws apigatewayv2 get-apis --query "Items[?Name=='$name'].ApiId|[0]" --output text)
  [ "$API" = None ] && API=$(aws apigatewayv2 create-api --name "$name" --protocol-type HTTP --tags Project=rawaroma,Component=demo --query ApiId --output text)
  for pair in "ANY /:$ORIGIN/" "ANY /{proxy+}:$ORIGIN/{proxy}"; do
    rk="${pair%%:*}"; uri="${pair#*:}"
    python3 - "$uri" "$site" > "$tmp/int.json" <<'PY'
import json,sys,os
print(json.dumps({"IntegrationType":"HTTP_PROXY","IntegrationMethod":"ANY","IntegrationUri":sys.argv[1],
  "PayloadFormatVersion":"1.0","TimeoutInMillis":30000,
  "RequestParameters":{"overwrite:header.X-Origin-Verify":os.environ["SECRET"],"overwrite:header.X-Demo-Site":sys.argv[2],
                       "overwrite:header.X-Demo-Host":"$context.domainName"}}))
PY
    RID=$(aws apigatewayv2 get-routes --api-id $API --query "Items[?RouteKey=='$rk'].RouteId|[0]" --output text)
    if [ "$RID" = None ]; then
      IID=$(aws apigatewayv2 create-integration --api-id $API --cli-input-json "file://$tmp/int.json" --query IntegrationId --output text)
      aws apigatewayv2 create-route --api-id $API --route-key "$rk" --target "integrations/$IID" >/dev/null
    else
      IID=$(aws apigatewayv2 get-route --api-id $API --route-id $RID --query Target --output text); IID=${IID#integrations/}
      aws apigatewayv2 update-integration --api-id $API --integration-id $IID --cli-input-json "file://$tmp/int.json" >/dev/null
    fi
    rm -f "$tmp/int.json"
  done
  aws apigatewayv2 get-stage --api-id $API --stage-name '$default' >/dev/null 2>&1 || \
    aws apigatewayv2 create-stage --api-id $API --stage-name '$default' --auto-deploy \
      --default-route-settings ThrottlingBurstLimit=100,ThrottlingRateLimit=50 --tags Project=rawaroma,Component=demo >/dev/null
  url="https://$API.execute-api.$AWS_REGION.amazonaws.com"
  aws ssm put-parameter --name "/rawaroma/demo/$site-url" --type String --value "$url" --overwrite >/dev/null
  echo "$site $url/"
done
