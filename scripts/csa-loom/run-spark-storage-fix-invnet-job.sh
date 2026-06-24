#!/usr/bin/env bash
# CSA Loom — create the Synapse managed PRIVATE ENDPOINTS (dfs + blob) from the
# Synapse managed VNet to the workspace DEFAULT ADLS Gen2 account, via an
# in-VNET Container App Job, on a fully PRIVATE (publicNetworkAccess=Disabled)
# Synapse workspace WITHOUT ever enabling public network access.
#
# WHY (the gap this closes):
#   On a managed-VNet Synapse workspace with preventDataExfiltration=true, a
#   Spark notebook/job can only reach a storage account it has an APPROVED
#   managed private endpoint to. Reading mirrored data / lakehouse Delta off the
#   DLZ lake therefore HANGS (the ABFS driver retries a blocked egress; the
#   notebook cell shows "running" for many minutes with no error) until that
#   managed PE exists.
#
#   `fix-synapse-spark-storage-access.sh` creates exactly those managed PEs, but
#   the post-deploy bootstrap runs it on the PUBLIC GitHub-hosted runner. On a
#   PE-only workspace the Synapse dev/management endpoint (dev.azuresynapse.net)
#   is private, so the public runner CANNOT reach it and the managed-PE create
#   fails silently (the bootstrap step is `|| ::warning`). Result: no managed PE,
#   and Spark→lake reads hang on the live deployment.
#
#   This launcher runs the create+approve from a Container App Job in the
#   CONSOLE's VNet-integrated environment (hub VNet), which CAN reach the PE-only
#   dev endpoint over the hub<->DLZ private DNS + peering — exactly like
#   grant-synapse-rbac-invnet-job.sh. No public toggle, no firewall rule, no MFA.
#
# AUTH model: the job authenticates to ARM/Synapse as the DEPLOY SP
#   (limitlessdata_deploy), which IS the workspace Synapse admin and can create
#   managed private endpoints + approve the resulting connection on the storage
#   account. The SP credentials are passed to the job as a container-app SECRET
#   (never printed). The Console UAMI is NOT a Synapse admin and cannot create
#   managed PEs; the az-CLI `--identity` path also can't parse the ACA MSI token
#   (405), so we use the deploy SP exactly as the sibling grant job does.
#
# REQUIRES (caller env):
#   ADMIN_RG / ADMIN_SUB   hub admin RG + sub (holds the CAE)
#   CAE                    console Container App Environment name (VNet-integrated)
#   DLZ_SUB                subscription holding the Synapse workspace + default SA
#   SYNAPSE_WS             Synapse workspace name (PE-only)
#   DEPLOY_SP_CLIENT_ID / DEPLOY_SP_SECRET / DEPLOY_SP_TENANT
#                          the limitlessdata_deploy SP creds (workspace admin)
#   STORAGE_ACCOUNT (optional)  default ADLS account name; auto-resolved from the
#                          workspace's defaultDataLakeStorage when unset
#   LOCATION (optional)    job location; defaults to the CAE location
set -uo pipefail

ADMIN_RG="${ADMIN_RG:?set ADMIN_RG to the hub admin resource group}"
ADMIN_SUB="${ADMIN_SUB:?set ADMIN_SUB to the hub admin subscription id}"
CAE="${CAE:?set CAE to the console Container App Environment name (VNet-integrated)}"
DLZ_SUB="${DLZ_SUB:?set DLZ_SUB to the Synapse workspace subscription id}"
SYNAPSE_WS="${SYNAPSE_WS:?set SYNAPSE_WS to the Synapse workspace name}"
DEPLOY_SP_CLIENT_ID="${DEPLOY_SP_CLIENT_ID:?set DEPLOY_SP_CLIENT_ID (limitlessdata_deploy app id — workspace Synapse admin)}"
DEPLOY_SP_SECRET="${DEPLOY_SP_SECRET:?set DEPLOY_SP_SECRET (limitlessdata_deploy client secret)}"
DEPLOY_SP_TENANT="${DEPLOY_SP_TENANT:?set DEPLOY_SP_TENANT (AAD tenant id)}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-}"

JOB_NAME="${JOB_NAME:-loom-synapse-spark-storage-fix}"
CLI_IMAGE="${CLI_IMAGE:-mcr.microsoft.com/azure-cli:2.64.0}"

# --- Resolve the workspace's default storage account (id + MSI) on the runner --
# Use `az --query` projections (no python dependency) and the list form (no RG
# needed — the name is unique per sub).
MSI_OID="$(az synapse workspace list --subscription "$DLZ_SUB" \
  --query "[?name=='$SYNAPSE_WS'].identity.principalId | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
if [ -z "$STORAGE_ACCOUNT" ]; then
  DEFAULT_URL="$(az synapse workspace list --subscription "$DLZ_SUB" \
    --query "[?name=='$SYNAPSE_WS'].defaultDataLakeStorage.accountUrl | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
  STORAGE_ACCOUNT="$(echo "$DEFAULT_URL" | sed -E 's#^https?://##; s#\.dfs\..*$##')"
fi
[ -z "$STORAGE_ACCOUNT" ] && { echo "ERROR: could not resolve the Synapse default storage account — set STORAGE_ACCOUNT." >&2; exit 1; }
SA_ID="$(az storage account list --subscription "$DLZ_SUB" --query "[?name=='$STORAGE_ACCOUNT'].id | [0]" -o tsv 2>/dev/null || true)"
[ -z "$SA_ID" ] && { echo "ERROR: storage account '$STORAGE_ACCOUNT' not found in $DLZ_SUB." >&2; exit 1; }
echo "Synapse workspace : $SYNAPSE_WS"
echo "Default storage   : $STORAGE_ACCOUNT"
echo "Storage id        : $SA_ID"
echo "Workspace MSI oid : ${MSI_OID:-<unresolved>}"

CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --query id -o tsv | tr -d '\r')"
if [ -z "${CAEID:-}" ]; then
  echo "::warning::Could not resolve Container App Environment '$CAE' in $ADMIN_RG — cannot run the in-VNET Synapse Spark storage fix."
  exit 0
fi
LOCATION="${LOCATION:-$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --query location -o tsv | tr -d '\r')}"

# --- The in-container fix the job runs IN-VNET as the deploy SP ----------------
# Mirrors fix-synapse-spark-storage-access.sh's managed-PE create+approve, plus a
# belt-and-suspenders MSI Storage Blob Data Contributor grant. Base64-encoded so
# it embeds cleanly as a single-line env value (see deploy-loom-verify-job.sh).
read -r -d '' FIX_SCRIPT <<'FIX_EOF' || true
set -e
az cloud set --name "${AZ_CLOUD:-AzureCloud}" >/dev/null 2>&1 || true
az login --service-principal -u "$SP_CLIENT_ID" -p "$SP_SECRET" --tenant "$SP_TENANT" >/dev/null
az account set --subscription "$DLZ_SUB" >/dev/null
echo "Fixing Spark->storage access on $SYNAPSE_WS / $STORAGE_ACCOUNT (in-VNET, PE-only dev endpoint)..."
if [ -n "${MSI_OID:-}" ]; then
  az role assignment create --assignee-object-id "$MSI_OID" --assignee-principal-type ServicePrincipal \
    --role "Storage Blob Data Contributor" --scope "$SA_ID" >/dev/null 2>&1 \
    && echo "  MSI 'Storage Blob Data Contributor' granted (or already present)." \
    || echo "  (MSI role assignment already present or not permitted — continuing)."
fi
for grp in dfs blob; do
  name="loom-default-sa-$grp"
  printf '{"privateLinkResourceId":"%s","groupId":"%s"}' "$SA_ID" "$grp" > /tmp/mpe-$grp.json
  if az synapse managed-private-endpoints show --workspace-name "$SYNAPSE_WS" --pe-name "$name" >/dev/null 2>&1; then
    echo "  MPE exists: $name"
  else
    az synapse managed-private-endpoints create --workspace-name "$SYNAPSE_WS" --pe-name "$name" --file "@/tmp/mpe-$grp.json" >/dev/null 2>&1 \
      || az synapse managed-private-endpoints create --workspace-name "$SYNAPSE_WS" --pe-name "$name" --resource-id "$SA_ID" --group-Id "$grp" >/dev/null 2>&1 \
      || { echo "  MPE create FAILED: $name"; continue; }
    echo "  MPE created: $name ($grp)"
  fi
done
echo "Approving pending private-endpoint connections on $STORAGE_ACCOUNT..."
PENDING="$(az network private-endpoint-connection list --id "$SA_ID" \
  --query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id" -o tsv 2>/dev/null || true)"
if [ -z "$PENDING" ]; then
  echo "  (no pending connections — already approved, or delegated to the SA owner)."
else
  for pcid in $PENDING; do
    az network private-endpoint-connection approve --id "$pcid" \
      --description "Synapse Spark managed PE to the default lake (CSA Loom)" >/dev/null 2>&1 \
      && echo "  approved: $(basename "$pcid")" \
      || echo "  approve failed: $(basename "$pcid")"
  done
fi
echo "LOOM_SPARK_STORAGE_FIX_RESULT done"
FIX_EOF
FIX_B64="$(printf '%s' "$FIX_SCRIPT" | base64 -w0 2>/dev/null || printf '%s' "$FIX_SCRIPT" | base64 | tr -d '\n')"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
mkdir -p "$REPO_ROOT/temp"
TMP="$REPO_ROOT/temp/loom-spark-storage-fix-job-$$.yaml"
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
      - name: sparkfix
        image: ${CLI_IMAGE}
        command: ["/bin/bash", "-c", "eval \"\$(echo \$FIX_B64 | base64 -d)\""]
        resources: { cpu: 0.5, memory: 1.0Gi }
        env:
          - { name: SP_CLIENT_ID, value: "${DEPLOY_SP_CLIENT_ID}" }
          - { name: SP_TENANT, value: "${DEPLOY_SP_TENANT}" }
          - { name: SP_SECRET, secretRef: sp-secret }
          - { name: DLZ_SUB, value: "${DLZ_SUB}" }
          - { name: SYNAPSE_WS, value: "${SYNAPSE_WS}" }
          - { name: STORAGE_ACCOUNT, value: "${STORAGE_ACCOUNT}" }
          - { name: SA_ID, value: "${SA_ID}" }
          - { name: MSI_OID, value: "${MSI_OID:-}" }
          - { name: AZ_CLOUD, value: "${AZ_CLOUD:-AzureCloud}" }
          - { name: FIX_B64, value: "${FIX_B64}" }
YAML

az containerapp job create -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --yaml "$TMP_AZ" -o none 2>/dev/null \
  || az containerapp job update -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" --yaml "$TMP_AZ" -o none
rm -f "$TMP"

# Set the real SP secret (never written to the YAML on disk / never printed).
az containerapp job secret set -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" \
  --secrets "sp-secret=$DEPLOY_SP_SECRET" -o none

echo "Starting in-VNET Synapse Spark storage-fix job '$JOB_NAME'..."
EXEC=$(az containerapp job start -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" \
         --query "name" -o tsv 2>/dev/null || true)
echo "  started execution: ${EXEC:-<unknown>}"

if [ -n "${EXEC:-}" ]; then
  for i in $(seq 1 30); do
    STATUS=$(az containerapp job execution show -n "$JOB_NAME" -g "$ADMIN_RG" --subscription "$ADMIN_SUB" \
               --job-execution-name "$EXEC" --query "properties.status" -o tsv 2>/dev/null || true)
    echo "  [$i/30] status=$STATUS"
    case "$STATUS" in
      Succeeded) echo "  Synapse Spark storage-fix job succeeded."; break ;;
      Failed|Degraded) echo "::warning::Synapse Spark storage-fix job status=$STATUS — check the CAE Log Analytics ContainerAppConsoleLogs_CL (ContainerName_s=='sparkfix')."; break ;;
    esac
    sleep 10
  done
fi

echo "In-VNET Synapse Spark storage fix complete (no public network access was enabled)."
