# LHDS ingress self-signed certificate (loaded by tls-cert.bicep via loadTextContent).
# Kept at column 0: heredoc terminators and python blocks are indentation-sensitive.
# Fails closed (set -e, bounded waits): a script that cannot confirm the certificate is
# enabled and readable exits non-zero and FAILS the deployment (deploy-integrity R6).
# Env: KV_NAME CERT_NAME CERT_FQDN RENEW_BEFORE_DAYS
set -eu

# Read the certificate. RBAC on a fresh role assignment and the private DNS record for the
# vault endpoint can lag the deployment, so a 403 / name-resolution failure is retried;
# only an explicit "not found" means the certificate does not exist.
show() {
  az keyvault certificate show --vault-name "$KV_NAME" --name "$CERT_NAME" -o json 2>err.txt
}
FOUND=""
for i in $(seq 1 24); do
  if show > cur.json; then FOUND=yes; break; fi
  if grep -qiE 'CertificateNotFound|was not found' err.txt; then FOUND=no; break; fi
  echo "vault read attempt $i not ready: $(head -c 240 err.txt | tr '\n' ' ')"
  sleep 20
done
if [ -z "$FOUND" ]; then
  echo "FAILED: could not read vault $KV_NAME after 24 attempts (RBAC, private DNS or private endpoint)"
  exit 1
fi

NEED=yes
if [ "$FOUND" = yes ]; then
  cat > check.py <<'PY'
import json, sys, datetime
days, fqdn = int(sys.argv[1]), sys.argv[2]
c = json.load(open('cur.json'))
attrs = c.get('attributes', {})
exp = attrs.get('expires')
subj = (c.get('policy', {}).get('x509CertificateProperties', {}) or {}).get('subject', '')
ok = bool(exp) and subj == 'CN=' + fqdn and bool(attrs.get('enabled'))
if ok:
    e = datetime.datetime.fromisoformat(exp.replace('Z', '+00:00'))
    ok = e - datetime.datetime.now(datetime.timezone.utc) > datetime.timedelta(days=days)
print('no' if ok else 'yes')
PY
  NEED=$(python3 check.py "$RENEW_BEFORE_DAYS" "$CERT_FQDN")
fi

if [ "$NEED" = yes ]; then
  echo "issuing self-signed certificate $CERT_NAME for CN=$CERT_FQDN"
  cat > policy.json <<EOF
{"issuerParameters":{"name":"Self"},
 "keyProperties":{"exportable":true,"keySize":2048,"keyType":"RSA","reuseKey":false},
 "lifetimeActions":[{"action":{"actionType":"AutoRenew"},"trigger":{"daysBeforeExpiry":30}}],
 "secretProperties":{"contentType":"application/x-pkcs12"},
 "x509CertificateProperties":{"keyUsage":["digitalSignature","keyEncipherment"],
   "ekus":["1.3.6.1.5.5.7.3.1"],"subject":"CN=$CERT_FQDN",
   "subjectAlternativeNames":{"dnsNames":["$CERT_FQDN"]},"validityInMonths":12}}
EOF
  az keyvault certificate create --vault-name "$KV_NAME" --name "$CERT_NAME" --policy @policy.json -o none
  OK=""
  for i in $(seq 1 30); do
    if show > cur.json && grep -q '"enabled": true' cur.json; then OK=yes; break; fi
    sleep 10
  done
  if [ -z "$OK" ]; then echo "FAILED: certificate $CERT_NAME was not enabled within 300s"; exit 1; fi
else
  echo "certificate $CERT_NAME already valid for CN=$CERT_FQDN; keeping it"
fi

# PUBLIC material only: never the secret / private key.
cat > out.py <<'PY'
import json, base64, hashlib, os
c = json.load(open('cur.json'))
der = base64.b64decode(c['cer'])
out = {
    'notAfter': c['attributes']['expires'],
    'thumbprintSha1': c.get('x509ThumbprintHex') or c.get('x509Thumbprint', ''),
    'fingerprintSha256': hashlib.sha256(der).hexdigest(),
    'versionId': c['id'].rsplit('/', 1)[-1],
}
json.dump(out, open(os.environ['AZ_SCRIPTS_OUTPUT_PATH'], 'w'))
print(json.dumps(out))
PY
python3 out.py
