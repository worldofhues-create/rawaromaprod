#!/usr/bin/env bash
# RawProd CloudFront front door (owner ruling 2026-09-24: DNS/office IPs are POST_LAUNCH). Idempotent.
# Run from an operator laptop: AWS_PROFILE=rawaroma ./infra/aws/cloudfront/apply.sh
#   - SSM /rawaroma/rawprod/cf-origin-secret (SecureString, created once, never printed)
#   - SG rawprod-cf-origin: 8443 from the CloudFront origin-facing prefix list only; attached to the app box
#     in ADDITION to its existing SGs (network-interface change, no restart)
#   - distribution "rawprod-consoles": origin raw.huecycle.in:8443 (TLS, cert matches), X-Origin-Verify header,
#     API paths /rpc* /crypto/* /v1/* /auth/* /health never cached, all methods, viewer HTTPS only.
# ALIASES (config-driven): set CF_ALIASES="rawfactory.huecycle.in,rawplatform.huecycle.in" and CF_CERT_ARN
# (ACM, us-east-1) once H7 DNS lands, then re-run. Empty = the default *.cloudfront.net name only.
set -euo pipefail
export AWS_REGION=${AWS_REGION:-us-west-2} AWS_USE_DUALSTACK_ENDPOINT=true
APP_EC2=i-04e7dc4e5edcc1ff7; VPC=vpc-0ea16289321edd00b; ORIGIN=${CF_ORIGIN:-raw.huecycle.in}; PORT=8443
CF_ALIASES=${CF_ALIASES:-}; CF_CERT_ARN=${CF_CERT_ARN:-}; COMMENT=rawprod-consoles

aws ssm get-parameter --name /rawaroma/rawprod/cf-origin-secret >/dev/null 2>&1 || \
  aws ssm put-parameter --name /rawaroma/rawprod/cf-origin-secret --type SecureString \
    --value "$(openssl rand -hex 32)" --tags Key=Project,Value=rawaroma >/dev/null
SECRET=$(aws ssm get-parameter --name /rawaroma/rawprod/cf-origin-secret --with-decryption --query Parameter.Value --output text)

PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=rawprod-cf-origin Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name rawprod-cf-origin --vpc-id $VPC --description "RawProd origin 8443 from CloudFront only" \
    --tag-specifications 'ResourceType=security-group,Tags=[{Key=Project,Value=rawaroma},{Key=Component,Value=rawprod}]' --query GroupId --output text)
  aws ec2 revoke-security-group-egress --group-id $SG --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null
fi
aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions \
  "[{\"IpProtocol\":\"tcp\",\"FromPort\":$PORT,\"ToPort\":$PORT,\"PrefixListIds\":[{\"PrefixListId\":\"$PL\",\"Description\":\"CloudFront origin-facing\"}]}]" >/dev/null 2>&1 || true
CUR=$(aws ec2 describe-instances --instance-ids $APP_EC2 --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
grep -qw $SG <<<"$CUR" || aws ec2 modify-instance-attribute --instance-id $APP_EC2 --groups $CUR $SG

umask 077; CFJ=$(mktemp)
python3 - "$ORIGIN" "$PORT" "$SECRET" "$CF_ALIASES" "$CF_CERT_ARN" "$COMMENT" > "$CFJ" <<'PY'
import json,sys,time
origin,port,secret,aliases,cert,comment=sys.argv[1:]
DIS="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"; OPT="658327ea-f89d-4fab-a63d-7e88639e58f6"; ALLV="b689b0a8-53d0-40ab-baf2-68738e2966ac"
ALL=["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"]
def beh(path=None,cache=DIS):
    b={"TargetOriginId":"app","ViewerProtocolPolicy":"redirect-to-https","Compress":True,"CachePolicyId":cache,
       "OriginRequestPolicyId":ALLV,"AllowedMethods":{"Quantity":7,"Items":ALL,"CachedMethods":{"Quantity":2,"Items":["GET","HEAD"]}}}
    if path: b["PathPattern"]=path
    return b
paths=["/rpc*","/crypto/*","/v1/*","/auth/*","/health","/healthz"]
al=[a for a in aliases.split(",") if a]
cfg={"CallerReference":f"rawprod-{int(time.time())}","Comment":comment,"Enabled":True,"PriceClass":"PriceClass_200","HttpVersion":"http2and3","IsIPV6Enabled":True,
 "Aliases":{"Quantity":len(al),**({"Items":al} if al else {})},
 "Origins":{"Quantity":1,"Items":[{"Id":"app","DomainName":origin,"OriginPath":"",
   "CustomHeaders":{"Quantity":1,"Items":[{"HeaderName":"X-Origin-Verify","HeaderValue":secret}]},
   "CustomOriginConfig":{"HTTPPort":80,"HTTPSPort":int(port),"OriginProtocolPolicy":"https-only","OriginSslProtocols":{"Quantity":1,"Items":["TLSv1.2"]},
     "OriginReadTimeout":60,"OriginKeepaliveTimeout":5},"ConnectionAttempts":3,"ConnectionTimeout":10}]},
 # default: console static files. CachingDisabled until the web build ships; switch to OPT for hashed assets then.
 "DefaultCacheBehavior":beh(),
 "CacheBehaviors":{"Quantity":len(paths),"Items":[beh(p) for p in paths]},
 "ViewerCertificate":({"ACMCertificateArn":cert,"SSLSupportMethod":"sni-only","MinimumProtocolVersion":"TLSv1.2_2021"} if cert else {"CloudFrontDefaultCertificate":True}),
 "Restrictions":{"GeoRestriction":{"RestrictionType":"none","Quantity":0}},"DefaultRootObject":"index.html"}
print(json.dumps(cfg))
PY
ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$COMMENT'].Id | [0]" --output text)
if [ "$ID" = None ] || [ -z "$ID" ]; then
  ID=$(aws cloudfront create-distribution-with-tags --distribution-config-with-tags \
    "{\"DistributionConfig\":$(cat "$CFJ"),\"Tags\":{\"Items\":[{\"Key\":\"Project\",\"Value\":\"rawaroma\"},{\"Key\":\"Component\",\"Value\":\"rawprod\"}]}}" --query Distribution.Id --output text)
else
  ETAG=$(aws cloudfront get-distribution-config --id $ID --query ETag --output text)
  REF=$(aws cloudfront get-distribution-config --id $ID --query DistributionConfig.CallerReference --output text)
  python3 -c 'import json,sys;c=json.load(open(sys.argv[2]));c["CallerReference"]=sys.argv[1];json.dump(c,open(sys.argv[2],"w"))' "$REF" "$CFJ"
  aws cloudfront update-distribution --id $ID --if-match $ETAG --distribution-config file://"$CFJ" >/dev/null
fi
rm -f "$CFJ"
echo "sg $SG  distribution $ID  $(aws cloudfront get-distribution --id $ID --query 'Distribution.[DomainName,Status]' --output text)"
