#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI the Synapse data-plane roles (Synapse SQL
# Administrator + Synapse Administrator + Synapse Artifact Publisher) via an
# in-VNET Container App Job, so warehouse + serverless-SQL-pool provisioning
# works on a fully PRIVATE (publicNetworkAccess=Disabled) Synapse workspace
# WITHOUT ever enabling public network access.
#
# WHY (Refs #1549 — replicates a LIVE centralus hand-fix, done the no-public way):
#   warehouse + serverless-sql-pool provisioning fails with
#     "Login failed for user '<token-identified principal>'"
#   because the Console UAMI is not a Synapse SQL login. The grant that fixes it
#   (`az synapse role assignment create --role "Synapse SQL Administrator" ...`)
#   targets the Synapse dev/management endpoint (dev.azuresynapse.net). On a
#   PE-only workspace that endpoint is private — so a PUBLIC GitHub-hosted runner
#   CANNOT reach it. The existing bootstrap worked around this by toggling the
#   workspace to publicNetworkAccess=Enabled for the grant window, which VIOLATES
#   the no-public-network rule.
#
#   This script runs the grant from a Container App Job in the CONSOLE's
#   VNet-integrated environment (the hub VNet), which CAN reach the PE-only dev
#   endpoint over the hub<->DLZ private DNS + peering — exactly like the
#   loom-verify job (scripts/csa-loom/deploy-loom-verify-job.sh). No public
#   toggle, no firewall rule, no MFA.
#
# AUTH model: the job authenticates to ARM/Synapse as the DEPLOY SP
#   (limitlessdata_deploy, appId 95ca491e-...), which IS the workspace Synapse
#   AAD admin and can therefore grant Synapse-RBAC roles to the Console UAMI.
#   The SP credentials are passed to the job as container-app SECRETS (client id
#   / secret / tenant) — never printed. (The console UAMI itself is NOT a Synapse
#   admin and cannot self-grant, so we cannot use the job's managed identity for
#   the grant; we use it only to pull the azure-cli image is unnecessary — we use
#   the public mcr azure-cli image, so no registry identity is needed.)
#
# REQUIRES (caller env):
#   ADMIN_RG / ADMIN_SUB         hub admin RG + sub (holds the CAE + console UAMI)
#   CAE                          console Container App Environment name (VNet-integrated)
#   DLZ_SUB                      subscription holding the Synapse workspace
#   SYNAPSE_WS                   Synapse workspace name (PE-only)
#   CONSOLE_UAMI_PRINCIPAL       Console UAMI object (principal) id — the grantee
#   DEPLOY_SP_CLIENT_ID / DEPLOY_SP_SECRET / DEPLOY_SP_TENANT
#                                the limitlessdata_deploy SP creds (workspace admin)
#   LOCATION (optional)          job location; defaults to the CAE location
set -uo pipefail

ADMIN_RG="${ADMIN_RG:?set ADMIN_RG to the hub admin resource group}"
ADMIN_SUB="${ADMIN_SUB:?set ADMIN_SUB to the hub admin subscription id}"
CAE="${CAE:?set CAE to the console Container App Environment name (VNet-integrated)}"
DLZ_SUB="${DLZ_SUB:?set DLZ_SUB to the Synapse workspace subscription id}"
SYNAPSE_WS="${SYNAPSE_WS:?set SYNAPSE_WS to the Synapse workspace name}"
CONSOLE_UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:?set CONSOLE_UAMI_PRINCIPAL to the Console UAMI object id (grantee)}"
DEPLOY_SP_CLIENT_ID="${DEPLOY_SP_CLIENT_ID:?set DEPLOY_SP_CLIENT_ID (limitlessdata_deploy app id — workspace Synapse admin)}"
DEPLOY_SP_SECRET="${DEPLOY_SP_SECRET:?set DEPLOY_SP_SECRET (limitlessdata_deploy client secret)}"
DEPLOY_SP_TENANT="${DEPLOY_SP_TENANT:?set DEPLOY_SP_TENANT (AAD tenant id)}"

JOB_NAME="${JOB_NAME:-loom-synapse-rbac}"
CLI_IMAGE="${CLI_IMAGE:-mcr.microsoft.com/azure-cli:2.64.0}"

CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --query id -o tsv | tr -d '\r')"
if [ -z "${CAEID:-}" ]; then
  echo "::warning::Could not resolve Container App Environment '$CAE' in $ADMIN_RG — cannot run the in-VNET Synapse RBAC grant. The serverless/warehouse SQL login will not be created."
  exit 0
fi
LOCATION="${LOCATION:-$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --query location -o tsv | tr -d '\r')}"

# The grant script the job container runs IN-VNET. It logs in as the deploy SP
# (the workspace Synapse admin) and grants the three Synapse-RBAC roles to the
# Console UAMI by OBJECT id. NOTE: Synapse SQL Administrator granted by OBJECT id
# alone yields a BROKEN serverless login when an SPI grants to another SPI (Synapse
# can't fetch the app id from Graph) — so the durable functional grant is the
# AzurePowerShell consoleSqlAdminRoleScript in synapse.bicep (grants by APP id).
# This in-VNET job is the COMPLEMENTARY path that also makes the assignment when
# the bicep deployment-script ACI couldn't reach the PE-only dev endpoint; it
# grants Synapse Administrator (which DOES confer SQL admin server-side via the
# workspace role) + Synapse SQL Administrator + Artifact Publisher so the warehouse
# / serverless / artifact paths all work. Reaching the dev endpoint privately is
# the whole point — it runs inside the VNet.
# The grant script is base64-encoded and passed as a single-line env value (GRANT_B64)
# so it embeds cleanly in the YAML (a multi-line inline value would break YAML). The
# container decodes + runs it. (Mirrors the base64 approach in deploy-loom-verify-job.sh.)
read -r -d '' GRANT_SCRIPT <<'GRANT_EOF' || true
set -e
az cloud set --name "${AZ_CLOUD:-AzureCloud}" >/dev/null 2>&1 || true
az login --service-principal -u "$SP_CLIENT_ID" -p "$SP_SECRET" --tenant "$SP_TENANT" >/dev/null
az account set --subscription "$DLZ_SUB" >/dev/null
for ROLE in "Synapse Administrator" "Synapse SQL Administrator" "Synapse Artifact Publisher"; do
  echo "Granting [$ROLE] to Console UAMI $UAMI on $SYNAPSE_WS (in-VNET, PE-only dev endpoint)..."
  az synapse role assignment create \
    --workspace-name "$SYNAPSE_WS" \
    --role "$ROLE" \
    --assignee-object-id "$UAMI" \
    --assignee-principal-type ServicePrincipal \
    && echo "  OK: $ROLE" \
    || echo "  (already assigned, or insufficient rights — review output): $ROLE"
done
echo "LOOM_SYNAPSE_RBAC_RESULT done"
GRANT_EOF
GRANT_B64="$(printf '%s' "$GRANT_SCRIPT" | base64 -w0 2>/dev/null || printf '%s' "$GRANT_SCRIPT" | base64 | tr -d '\n')"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
mkdir -p "$REPO_ROOT/temp"
TMP="$REPO_ROOT/temp/loom-synapse-rbac-job-$$.yaml"
TMP_AZ="$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")"

cat > "$TMP" <<YAML
location: ${LOCATION}
properties:
  environmentId: ${CAEID}
  configuration:
    triggerType: Manual
    replicaTimeout: 600
    replicaRetryLimit: 1
    manualTriggerConfig:
      parallelism: 1
      replicaCompletionCount: 1
    secrets:
      - name: sp-secret
        value: "PLACEHOLDER"
  template:
    containers:
      - name: grant
        image: ${CLI_IMAGE}
        command: ["/bin/bash", "-c", "eval \"\$(echo \$GRANT_B64 | base64 -d)\""]
        resources: { cpu: 0.5, memory: 1.0Gi }
        env:
          - { name: SP_CLIENT_ID, value: "${DEPLOY_SP_CLIENT_ID}" }
          - { name: SP_TENANT, value: "${DEPLOY_SP_TENANT}" }
          - { name: SP_SECRET, secretRef: sp-secret }
          - { name: DLZ_SUB, value: "${DLZ_SUB}" }
          - { name: SYNAPSE_WS, value: "${SYNAPSE_WS}" }
          - { name: UAMI, value: "${CONSOLE_UAMI_PRINCIPAL}" }
          - { name: AZ_CLOUD, value: "${AZ_CLOUD:-AzureCloud}" }
          - { name: GRANT_B64, value: "${GRANT_B64}" }
YAML

az containerapp job create -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --yaml "$TMP_AZ" -o none 2>/dev/null \
  || az containerapp job update -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --yaml "$TMP_AZ" -o none
rm -f "$TMP"

# Set the real SP secret (never written to the YAML on disk / never printed).
az containerapp job secret set -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" \
  --secrets "sp-secret=$DEPLOY_SP_SECRET" -o none

echo "Starting in-VNET Synapse RBAC grant job '$JOB_NAME'..."
EXEC=$(az containerapp job start -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" \
         --query "name" -o tsv 2>/dev/null || true)
echo "  started execution: ${EXEC:-<unknown>}"

# Poll the execution to completion (best-effort, ~5 min cap) so the bootstrap log
# shows the result instead of returning before the grant lands.
if [ -n "${EXEC:-}" ]; then
  for i in $(seq 1 30); do
    STATUS=$(az containerapp job execution show -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" \
               --job-execution-name "$EXEC" --query "properties.status" -o tsv 2>/dev/null || true)
    echo "  [$i/30] status=$STATUS"
    case "$STATUS" in
      Succeeded) echo "  Synapse RBAC grant job succeeded."; break ;;
      Failed|Degraded) echo "::warning::Synapse RBAC grant job status=$STATUS — check the CAE Log Analytics ContainerAppConsoleLogs_CL (ContainerName_s=='grant')."; break ;;
    esac
    sleep 10
  done
fi

echo "In-VNET Synapse RBAC grant job complete (no public network access was enabled)."
