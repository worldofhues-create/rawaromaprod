#!/usr/bin/env bash
# Interim HTTPS front door while CloudFront is blocked on account verification (OPS1, 2026-09-24).
# Two API Gateway HTTP APIs, one per console, each on its own *.execute-api.us-west-2.amazonaws.com host at the
# root ($default stage), so root-absolute asset paths, the manifest and the /sw.js service-worker scope keep working.
#   rawprod-factory  -> X-RawProd-Site: factory   (web/)
#   rawprod-platform -> X-RawProd-Site: platform  (web-platform/)
# Both proxy every path (HTTP_PROXY, no caching exists on HTTP APIs) to https://raw.huecycle.in:8443 (the origin
# vhost, publicly trusted LE cert as API Gateway requires) and inject X-Origin-Verify from SSM
# /rawaroma/rawprod/cf-origin-secret. The value is never printed; it is visible to principals with apigateway:GET*.
# Origin SG rawprod-apigw-origin: 8443 from the API_GATEWAY us-west-2 ranges of ip-ranges.json only.
# Idempotent: re-running updates integrations/SG; re-run after the ranges or the secret change.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-west-2}"
ORIGIN="${ORIGIN:-https://raw.huecycle.in:8443}"
INSTANCE=i-04e7dc4e5edcc1ff7; VPC=vpc-0ea16289321edd00b
TAGS='Project=rawaroma,Component=rawprod'
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# --- origin SG
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=rawprod-apigw-origin Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name rawprod-apigw-origin --vpc-id $VPC \
    --description "RawProd origin 8443 from API Gateway us-west-2 ranges only" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=rawaroma},{Key=Component,Value=rawprod},{Key=Name,Value=rawprod-apigw-origin}]" --query GroupId --output text)
  aws ec2 revoke-security-group-egress --group-id $SG --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null
fi
curl -fsS https://ip-ranges.amazonaws.com/ip-ranges.json | python3 -c '
import json,sys
d=json.load(sys.stdin); c=sorted({p["ip_prefix"] for p in d["prefixes"] if p["service"]=="API_GATEWAY" and p["region"]=="us-west-2"})
print(json.dumps([{"IpProtocol":"tcp","FromPort":8443,"ToPort":8443,"IpRanges":[{"CidrIp":x,"Description":"API_GATEWAY us-west-2"} for x in c]}]))' > "$tmp/perm.json"
aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions "file://$tmp/perm.json" >/dev/null 2>&1 || true
cur=$(aws ec2 describe-instances --instance-ids $INSTANCE --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
case " $cur " in *" $SG "*) ;; *) aws ec2 modify-instance-attribute --instance-id $INSTANCE --groups $cur $SG ;; esac
echo "sg $SG"

# --- APIs
export SECRET=$(aws ssm get-parameter --with-decryption --name /rawaroma/rawprod/cf-origin-secret --query Parameter.Value --output text)
for site in factory platform; do
  name="rawprod-$site"
  API=$(aws apigatewayv2 get-apis --query "Items[?Name=='$name'].ApiId|[0]" --output text)
  [ "$API" = None ] && API=$(aws apigatewayv2 create-api --name "$name" --protocol-type HTTP --tags "$TAGS" --query ApiId --output text)
  for pair in "ANY /:$ORIGIN/" "ANY /{proxy+}:$ORIGIN/{proxy}"; do
    rk="${pair%%:*}"; uri="${pair#*:}"
    python3 - "$uri" "$site" > "$tmp/int.json" <<PY
import json,sys,os
print(json.dumps({"IntegrationType":"HTTP_PROXY","IntegrationMethod":"ANY","IntegrationUri":sys.argv[1],
  "PayloadFormatVersion":"1.0","TimeoutInMillis":30000,
  "RequestParameters":{"overwrite:header.X-Origin-Verify":os.environ["SECRET"],"overwrite:header.X-RawProd-Site":sys.argv[2]}}))
PY
    RID=$(aws apigatewayv2 get-routes --api-id $API --query "Items[?RouteKey=='$rk'].RouteId|[0]" --output text)
    if [ "$RID" = None ]; then
      IID=$(aws apigatewayv2 create-integration --api-id $API --cli-input-json "file://$tmp/int.json" --query IntegrationId --output text)
      aws apigatewayv2 create-route --api-id $API --route-key "$rk" --target "integrations/$IID" >/dev/null
    else
      IID=$(aws apigatewayv2 get-route --api-id $API --route-id $RID --query Target --output text); IID=${IID#integrations/}
      aws apigatewayv2 update-integration --api-id $API --integration-id $IID --cli-input-json "file://$tmp/int.json" >/dev/null
    fi
  done
  aws apigatewayv2 get-stage --api-id $API --stage-name '$default' >/dev/null 2>&1 || \
    aws apigatewayv2 create-stage --api-id $API --stage-name '$default' --auto-deploy \
      --default-route-settings ThrottlingBurstLimit=200,ThrottlingRateLimit=100 --tags "$TAGS" >/dev/null
  echo "$site https://$API.execute-api.$AWS_REGION.amazonaws.com/"
done
