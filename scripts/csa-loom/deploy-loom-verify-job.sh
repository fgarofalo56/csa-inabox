#!/usr/bin/env bash
# Deploy/refresh the `loom-verify` Container App Job — an UNATTENDED, in-VNet
# verifier for the live CSA Loom console.
#
# WHY a CA Job (not a GitHub-hosted runner): the loom estate is fully private
# (Key Vault / ACR / Purview all publicNetworkAccess=Disabled). A public
# GitHub runner cannot reach the KV data plane to read SESSION_SECRET. A
# Container App Job in the console's VNet-integrated environment CAN — it reuses
# the console image, the console UAMI (already has AcrPull + KV access), and runs
# entirely inside the VNet. Nothing is exposed publicly; no MFA; no user creds.
#
# WHAT it does: mints a `loom_session` cookie from the console's SESSION_SECRET
# (the app's own session-signing scheme, see apps/fiab-console/lib/auth/session.ts)
# with the tenant-admin oid as claims, then probes the key admin/security/
# governance API endpoints and exits non-zero if any returns 401/5xx. The
# minted session asserts a clearly-labelled `loom-ui-verify@automation` upn so
# it is obvious in audit logs that it is the harness, not a person.
#
# IMPORTANT — SESSION_SECRET source: the console currently stores SESSION_SECRET
# as a container-app LITERAL secret that is NOT synced to the KV `session-secret`
# secret (see the desync issue this script's PR references). So the job's secret
# is set from the CONSOLE's literal value (read via the ARM control plane), NOT
# from KV. If/when the console's SESSION_SECRET is made KV-backed and synced,
# switch the job secret to a keyvaultref.
#
# Run (from a shell logged in as a principal with Contributor on the admin RG +
# ARM read on the console's secrets):
#   ADMIN_RG=rg-csa-loom-admin-centralus SUB=<sub> CONSOLE_APP=loom-console \
#   CAE=cae-csa-loom-centralus ACR=acrloomk6mvh5sm6z7do.azurecr.io \
#   CONSOLE_UAMI_ID=<uami resource id> CONSOLE_IMAGE=<acr>/loom-console:v0.1 \
#   LOOM_URL=<console FD url> LOOM_AUTOMATION_OID=<tenant-admin oid> \
#   ./deploy-loom-verify-job.sh
#
# Then trigger + read results:
#   az containerapp job start -n loom-verify -g $ADMIN_RG
#   # results land in the cae Log Analytics workspace, ContainerAppConsoleLogs_CL,
#   # ContainerName_s == 'verify', look for the "LOOM_VERIFY_RESULT {...}" line.
set -euo pipefail

ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
SUB="${SUB:?set SUB to the admin-plane subscription id}"
CONSOLE_APP="${CONSOLE_APP:-loom-console}"
CAE="${CAE:-cae-csa-loom-centralus}"
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:?set CONSOLE_UAMI_ID to the console UAMI resource id}"
CONSOLE_IMAGE="${CONSOLE_IMAGE:?set CONSOLE_IMAGE to the console image (acr/loom-console:tag)}"
ACR="${ACR:-${CONSOLE_IMAGE%%/*}}"
LOOM_URL="${LOOM_URL:?set LOOM_URL to the console URL}"
LOOM_AUTOMATION_OID="${LOOM_AUTOMATION_OID:?set LOOM_AUTOMATION_OID to the tenant-admin oid}"
LOOM_AUTOMATION_UPN="${LOOM_AUTOMATION_UPN:-loom-ui-verify@automation}"
LOOM_AUTOMATION_NAME="${LOOM_AUTOMATION_NAME:-LoomUIVerify}"

HERE="$(cd "$(dirname "$0")" && pwd)"
B64="$(base64 -w0 "$HERE/loom-verify.js" 2>/dev/null || base64 "$HERE/loom-verify.js" | tr -d '\n')"
CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$SUB" --query id -o tsv | tr -d '\r')"

# Repo-relative temp path (NOT mktemp): on Windows/MSYS the /tmp/tmp.XXXX path
# from mktemp(1) is unreadable by the Windows `az` CLI ("does not exist").
REPO_ROOT_VERIFY="$(cd "$HERE/../.." && pwd)"
mkdir -p "$REPO_ROOT_VERIFY/temp"
TMP="$REPO_ROOT_VERIFY/temp/loom-verify-job-$$.yaml"
# Windows `az` needs a Windows path (E:\...), not an MSYS path (/e/...).
TMP_AZ="$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")"
cat > "$TMP" <<YAML
location: centralus
identity:
  type: UserAssigned
  userAssignedIdentities:
    ${CONSOLE_UAMI_ID}: {}
properties:
  environmentId: ${CAEID}
  configuration:
    triggerType: Manual
    replicaTimeout: 300
    replicaRetryLimit: 0
    manualTriggerConfig:
      parallelism: 1
      replicaCompletionCount: 1
    registries:
      - server: ${ACR}
        identity: ${CONSOLE_UAMI_ID}
    secrets:
      # MUST be declared here, even though the `az containerapp job secret set`
      # below immediately overwrites the value (on the update path it is written
      # and replaced within two consecutive CLI calls; the job is Manual-trigger,
      # so nothing can execute in between). ARM rejects a request whose env var
      # carries a secretRef to a secret the payload does not define ("deployment
      # error referencing unknown secret" — Learn, troubleshoot-deployment-errors).
      # The identical omission in the loom-uat sibling made THAT job uncreatable
      # until #1545: "the job YAML referenced secretRef: session-secret but never
      # DEFINED it -> create failed -> the || job update also failed (job does not
      # exist)". This script kept the same shape from #1533 and never got the fix.
      - name: session-secret
        value: "placeholder-overwritten-below"
  template:
    containers:
      - name: verify
        image: ${CONSOLE_IMAGE}
        command: ["node", "-e", "eval(atob(process.env.VS))"]
        resources: { cpu: 0.5, memory: 1.0Gi }
        env:
          - { name: LOOM_URL, value: "${LOOM_URL}" }
          - { name: LOOM_AUTOMATION_OID, value: "${LOOM_AUTOMATION_OID}" }
          - { name: LOOM_AUTOMATION_UPN, value: "${LOOM_AUTOMATION_UPN}" }
          - { name: LOOM_AUTOMATION_NAME, value: "${LOOM_AUTOMATION_NAME}" }
          - { name: VS, value: "${B64}" }
          - { name: SESSION_SECRET, secretRef: session-secret }
YAML

# Create or update — branch on an explicit existence probe rather than
# `create 2>/dev/null || update`. The old form discarded the create's stderr,
# so when the create failed for a REAL reason (the undeclared secret above) the
# operator saw only the fallback's "job does not exist" and the actual cause was
# gone. Only the `show` probe swallows output, and its failure is not an error.
# Same shape as deploy-lineage-extractor-job.sh / deploy-secret-expiry-job.sh.
if az containerapp job show -n loom-verify -g "$ADMIN_RG" --subscription "$SUB" >/dev/null 2>&1; then
  echo "[deploy-loom-verify-job] Updating existing loom-verify job..."
  az containerapp job update -n loom-verify -g "$ADMIN_RG" --subscription "$SUB" --yaml "$TMP_AZ" -o none
else
  echo "[deploy-loom-verify-job] Creating loom-verify job..."
  az containerapp job create -n loom-verify -g "$ADMIN_RG" --subscription "$SUB" --yaml "$TMP_AZ" -o none
fi
rm -f "$TMP"

# Set the job secret to the CONSOLE's literal SESSION_SECRET (read via ARM,
# piped — never printed). Switch to a keyvaultref once the console secret is
# KV-backed + synced.
SS="$(az containerapp secret show -n "$CONSOLE_APP" -g "$ADMIN_RG" --subscription "$SUB" \
        --secret-name session-secret --query value -o tsv | tr -d '\r\n')"
az containerapp job secret set -n loom-verify -g "$ADMIN_RG" --subscription "$SUB" \
  --secrets "session-secret=$SS" -o none
unset SS

echo "loom-verify job deployed. Trigger: az containerapp job start -n loom-verify -g $ADMIN_RG --subscription $SUB"
