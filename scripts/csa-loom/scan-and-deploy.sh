#!/usr/bin/env bash
# CSA Loom — pre-deploy scan-and-choose + one-button deploy.
#
# WHAT IT DOES (the headline deploy-readiness CLI, PRP docs/fiab/prp/deploy-readiness-100pct.md)
#   A single push-button deploy that produces a CSA Loom where everything works
#   on first login. Before deploying it SCANS every subscription the signed-in
#   principal can see, and for each Loom-integrable Azure service shows what
#   already exists, then asks: USE-EXISTING / provision NEW / DISABLE — each with
#   a RECOMMENDATION. The default posture is everything-ON (opt-out): you disable
#   what you don't want; nothing is left unconfigured by default.
#
#   It then emits the same two artifacts the byo-wizard does (a self-contained
#   `params/<out>.bicepparam` + `temp/<out>.byo-exports.sh`) AND runs the real
#   `az deployment sub create` (unless --dry-run), then grants the Console UAMI
#   the navigator roles on every REUSED cross-sub resource.
#
# RELATION TO byo-wizard.sh
#   byo-wizard.sh is the read-only bicepparam GENERATOR (existing-vs-new prompts).
#   scan-and-deploy.sh is the ORCHESTRATOR: it adds (a) a recommendation default,
#   (b) a true non-interactive `--defaults` everything-NEW path, (c) the actual
#   `az deployment sub create`, (d) coverage of Storage/ADLS, Key Vault, Maps and
#   PostgreSQL, and (e) the day-one required inputs (tenant-admin OID) that the
#   live E2E found a fresh deploy is broken without. It reuses byo-wizard's proven
#   discover()/SERVICES engine pattern so the two stay consistent.
#
# NO MICROSOFT FABRIC DEPENDENCY (.claude/rules/no-fabric-dependency.md)
#   fabricEnabled stays FALSE (Azure-native). Fabric is opt-in only (BYO_FABRIC=true
#   on a Commercial boundary); gov boundaries are always fabricEnabled=false.
#
# NO VAPORWARE (.claude/rules/no-vaporware.md)
#   On missing `az`/login, or a service with no graph access, it prints the honest
#   gate + the literal command. It never fakes a deploy. --dry-run emits the param
#   and prints the exact `az deployment sub create` without executing it.
#
# USAGE
#   bash scripts/csa-loom/scan-and-deploy.sh                         # interactive, commercial-full
#   bash scripts/csa-loom/scan-and-deploy.sh --boundary gcc-high
#   bash scripts/csa-loom/scan-and-deploy.sh --defaults --dry-run    # everything-new, print only
#   bash scripts/csa-loom/scan-and-deploy.sh \
#        --subscription <admin-sub> --region eastus \
#        --tenant-admin-oid <your-user-object-id>
#
#   --defaults            non-interactive; every service = provision NEW (the
#                         acceptance-test entry: everything new on an empty sub set).
#   --boundary <b>        commercial-full | commercial | gcc | gcc-high | il5
#                         (default commercial-full).
#   --out <name>          output param basename (default <boundary>.scan).
#   --subscription <sub>  the admin-plane (hub) subscription to deploy into.
#   --region <loc>        deploy region (e.g. eastus). Required to deploy.
#   --tenant-admin-oid    bootstrap admin object id (REQUIRED to deploy — a fresh
#                         deploy 403s every admin page without it, PRP gap #4).
#   --tenant-admin-group  Entra group object id (alternative to --tenant-admin-oid).
#   --dry-run             emit the param + print the `az` command; do NOT execute.
#   --non-interactive     alias for --defaults.
#   -h | --help           this help.
#
# REQUIRES: az CLI logged in (`az login`). Discovery is read-only; the deploy step
#           is the only thing that creates resources (skipped under --dry-run).
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve repo paths (works from any cwd) — same convention as byo-wizard.sh.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BICEP_DIR="$REPO_ROOT/platform/fiab/bicep"
PARAMS_DIR="$BICEP_DIR/params"
MAIN_BICEP="$BICEP_DIR/main.bicep"
TEMP_DIR="$REPO_ROOT/temp"

BOUNDARY="commercial-full"
OUT_NAME=""
DEFAULTS=0
DRY_RUN=0
ADMIN_SUB=""
REGION=""
ADMIN_OID="${LOOM_TENANT_ADMIN_OID:-}"
ADMIN_GROUP="${LOOM_TENANT_ADMIN_GROUP_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary)            BOUNDARY="$2"; shift 2 ;;
    --out)                 OUT_NAME="$2"; shift 2 ;;
    --subscription|--sub)  ADMIN_SUB="$2"; shift 2 ;;
    --region|-l)           REGION="$2"; shift 2 ;;
    --tenant-admin-oid)    ADMIN_OID="$2"; shift 2 ;;
    --tenant-admin-group)  ADMIN_GROUP="$2"; shift 2 ;;
    --defaults|--non-interactive|--ci) DEFAULTS=1; shift ;;
    --dry-run)             DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

TEMPLATE="$PARAMS_DIR/$BOUNDARY.bicepparam"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: boundary template not found: $TEMPLATE" >&2; echo "Available: $(ls "$PARAMS_DIR"/*.bicepparam 2>/dev/null | xargs -n1 basename | sed 's/\.bicepparam//' | tr '\n' ' ')" >&2; exit 1; }
grep -q '>>> BYO-WIZARD START' "$TEMPLATE" || { echo "ERROR: template $TEMPLATE has no BYO-WIZARD markers — add them first (see byo-wizard.sh)." >&2; exit 1; }

[[ -z "$OUT_NAME" ]] && OUT_NAME="$BOUNDARY.scan"
OUT_PARAM="$PARAMS_DIR/$OUT_NAME.bicepparam"
mkdir -p "$TEMP_DIR"
OUT_ENV="$TEMP_DIR/$OUT_NAME.byo-exports.sh"

# Gov boundaries never offer Fabric (no Fabric in Azure Government).
case "$BOUNDARY" in
  gcc-high|il5|gcc) IS_GOV=1 ;;
  *) IS_GOV=0 ;;
esac

# Map boundary → the `boundary=` value main.bicep expects (Commercial/GCC/...).
case "$BOUNDARY" in
  commercial-full|commercial) BOUNDARY_PARAM="Commercial" ;;
  gcc)      BOUNDARY_PARAM="GCC" ;;
  gcc-high) BOUNDARY_PARAM="GCC-High" ;;
  il5)      BOUNDARY_PARAM="IL5" ;;
  *)        BOUNDARY_PARAM="Commercial" ;;
esac

echo "== CSA Loom — scan-and-deploy =="
echo "   boundary=$BOUNDARY  template=$(basename "$TEMPLATE")  out=params/$OUT_NAME.bicepparam"
echo "   mode=$([[ "$DEFAULTS" == "1" ]] && echo defaults/non-interactive || echo interactive)  gov=$IS_GOV  dry-run=$DRY_RUN"
echo

# ---------------------------------------------------------------------------
# az presence / login (honest gate — never fake).
# ---------------------------------------------------------------------------
if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: the Azure CLI (az) is not installed / not on PATH." >&2
  echo "Install it (https://aka.ms/azure-cli) and run 'az login', then re-run this script." >&2
  exit 1
fi

SUBS="${SUBS:-$(az account list --query "[].id" -o tsv 2>/dev/null)}"
if [[ -z "$SUBS" ]]; then
  echo "WARNING: no subscriptions visible (run 'az login'). Discovery skipped — every service defaults to NEW." >&2
fi
# Default the admin sub to the current az context when not supplied.
[[ -z "$ADMIN_SUB" ]] && ADMIN_SUB="$(az account show --query id -o tsv 2>/dev/null || true)"

HAVE_GRAPH=0
[[ -n "$SUBS" ]] && az graph query -q "Resources | limit 1" -o none 2>/dev/null && HAVE_GRAPH=1

q() { az "$@" 2>/dev/null || true; }

# discover <arm-type> [<extra-jmespath-filter>] -> prints "name|rg|sub" per candidate
discover() {
  local type="$1" filt="${2:-}"
  [[ -z "$SUBS" ]] && return 0
  if [[ "$HAVE_GRAPH" == "1" ]]; then
    local where="type =~ '$type'"
    [[ -n "$filt" ]] && where="$where and $filt"
    q graph query -q "Resources | where $where | project name, resourceGroup, subscriptionId" --first 100 \
        --query "data[].[name,resourceGroup,subscriptionId]" -o tsv \
      | awk -F'\t' 'NF>=3 && $1!="" {print $1"|"$2"|"$3}'
  else
    local s
    for s in $SUBS; do
      q resource list --subscription "$s" --resource-type "$type" --query "[].{n:name,r:resourceGroup}" -o tsv \
        | awk -F'\t' -v sub="$s" 'NF>=2 && $1!="" {print $1"|"$2"|"sub}'
    done
  fi
}

# ---------------------------------------------------------------------------
# Service table. Columns (|-separated):
#   key | label | arm-type | graph-filter | name-param | rg-param | sub-param
#       | env-name | env-rg | env-sub | enable-flag | special
# - name/rg/sub-param: the main.bicep `existing*` params. EMPTY when main.bicep
#   has no existing* param for the service (Storage/KeyVault/Maps/Postgres) — those
#   contribute env exports + RBAC only (post-deploy reuse), never a bicepparam line.
# - env-*: the CANONICAL EXISTING_* vars (match byo-wizard.sh / discover-services.sh
#   / patch-navigator-env.sh) so all consumers agree.
# - enable-flag: the `loom<Svc>Enabled`-style toggle (EMPTY for DLZ-provisioned
#   services that have no provisioning toggle — always provisioned with the platform).
# - special: 'purview-singleton' → recommend USE-EXISTING whenever ANY tenant
#   instance exists (one Enterprise Purview per tenant: "EnterpriseTenantAlreadyExists").
# ---------------------------------------------------------------------------
SERVICES=(
  "aisearch|AI Search|Microsoft.Search/searchServices||existingAiSearchService|existingAiSearchRg|existingAiSearchSub|EXISTING_AI_SEARCH_SERVICE|EXISTING_AI_SEARCH_RG|EXISTING_AI_SEARCH_SUB|aiSearchEnabled|"
  "apim|API Management|Microsoft.ApiManagement/service||existingApimName|existingApimRg|existingApimSub|EXISTING_APIM|EXISTING_APIM_RG|EXISTING_APIM_SUB|apimEnabled|"
  "adx|ADX / Kusto|Microsoft.Kusto/clusters||existingAdxClusterName|existingAdxClusterRg|existingAdxClusterSub|EXISTING_KUSTO_CLUSTER|EXISTING_KUSTO_RG|EXISTING_KUSTO_SUB|adxEnabled|"
  "foundry|AI Foundry / AOAI|Microsoft.CognitiveServices/accounts|kind =~ 'AIServices'|existingFoundryAccountName|existingFoundryRg|existingFoundrySub|EXISTING_AOAI|EXISTING_AOAI_RG|EXISTING_AOAI_SUB|aiFoundryEnabled|"
  "purview|Microsoft Purview|Microsoft.Purview/accounts||existingPurviewAccount|existingPurviewRg|existingPurviewSub|EXISTING_PURVIEW|EXISTING_PURVIEW_RG|EXISTING_PURVIEW_SUB|purviewEnabled|purview-singleton"
  "maps|Azure Maps|Microsoft.Maps/accounts|||||EXISTING_MAPS|EXISTING_MAPS_RG|EXISTING_MAPS_SUB|azureMapsEnabled|"
  "synapse|Synapse|Microsoft.Synapse/workspaces||existingSynapseWorkspace|existingSynapseRg|existingSynapseSub|EXISTING_SYNAPSE|EXISTING_SYNAPSE_RG|EXISTING_SYNAPSE_SUB||"
  "cosmos|Cosmos DB|Microsoft.DocumentDB/databaseAccounts||existingCosmosAccount|existingCosmosRg|existingCosmosSub|EXISTING_COSMOS_ACCOUNT|EXISTING_COSMOS_ACCOUNT_RG|EXISTING_COSMOS_ACCOUNT_SUB||"
  "adf|Data Factory|Microsoft.DataFactory/factories||existingAdfFactory|existingAdfRg|existingAdfSub|EXISTING_ADF|EXISTING_ADF_RG|EXISTING_ADF_SUB||"
  "eventhubs|Event Hubs|Microsoft.EventHub/namespaces||existingEventHubNamespace|existingEventHubRg|existingEventHubSub|EXISTING_EVENTHUB_NAMESPACE|EXISTING_EVENTHUB_RG|EXISTING_EVENTHUB_SUB||"
  "databricks|Databricks|Microsoft.Databricks/workspaces||existingDatabricksWorkspace|existingDatabricksRg|existingDatabricksSub|EXISTING_DATABRICKS|EXISTING_DATABRICKS_RG|EXISTING_DATABRICKS_SUB||"
  "storage|Storage / ADLS Gen2|Microsoft.Storage/storageAccounts|||||EXISTING_STORAGE|EXISTING_STORAGE_RG|EXISTING_STORAGE_SUB||"
  "postgres|PostgreSQL Flexible|Microsoft.DBforPostgreSQL/flexibleServers|||||EXISTING_POSTGRES|EXISTING_POSTGRES_RG|EXISTING_POSTGRES_SUB|postgresEnabled|"
  "keyvault|Key Vault|Microsoft.KeyVault/vaults|||||EXISTING_KEYVAULT|EXISTING_KEYVAULT_RG|EXISTING_KEYVAULT_SUB||"
)

# Accumulators
declare -a BLOCK_LINES ENV_LINES SUMMARY FLAG_NAMES FLAG_VALUES
declare -A HOST

upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

resolve_databricks_host() {  # name rg sub -> workspaceUrl
  local n="$1" r="$2" s="$3"
  [[ -z "$n" || -z "$r" ]] && return 0
  local args=(databricks workspace show -n "$n" -g "$r" --query workspaceUrl -o tsv)
  [[ -n "$s" ]] && args+=(--subscription "$s")
  q "${args[@]}"
}

# Compute the recommendation for a service given its candidate count + special.
# Echoes: "new" | "existing:<idx>" (1-based)
recommend() {
  local count="$1" special="$2"
  if [[ "$special" == "purview-singleton" && "$count" -ge 1 ]]; then echo "existing:1"; return; fi
  if [[ "$count" -eq 0 ]]; then echo "new"; return; fi
  if [[ "$count" -eq 1 ]]; then echo "existing:1"; return; fi
  echo "new"   # >1 ambiguous → recommend NEW, let the user override
}

for row in "${SERVICES[@]}"; do
  IFS='|' read -r key label type filt nameP rgP subP envName envRg envSub flag special <<<"$row"
  echo "── $label ──────────────────────────────────────────────"
  mapfile -t cands < <(discover "$type" "$filt")
  cc=${#cands[@]}
  REC="$(recommend "$cc" "$special")"
  choice=""
  n=""; r=""; s=""

  if [[ "$DEFAULTS" == "1" ]]; then
    # Everything-new acceptance path. Flagged services → enable + provision new.
    choice="new"
    echo "  --defaults: provision NEW"
  else
    if [[ "$cc" -gt 0 ]]; then
      echo "  Found $cc existing candidate(s):"
      i=1; for c in "${cands[@]}"; do IFS='|' read -r cn cr cs <<<"$c"; echo "    [$i] $cn   (rg=$cr sub=$cs)"; i=$((i+1)); done
    else
      echo "  (no existing candidate found in any visible subscription)"
    fi
    # Render the recommendation + the allowed actions.
    if [[ "$REC" == new ]]; then
      echo "  RECOMMENDED: New (provision a fresh instance)"
    else
      ridx="${REC#existing:}"; rc="${cands[$((ridx-1))]}"; IFS='|' read -r rn rr rs <<<"$rc"
      echo "  RECOMMENDED: Use existing [$ridx] $rn"
      [[ "$special" == "purview-singleton" ]] && echo "    (only one Enterprise Purview is allowed per tenant — reuse is strongly recommended)"
    fi
    if [[ -n "$flag" ]]; then dis="  / d=Disable"; else dis=""; fi
    read -r -p "  Choose: [Enter]=recommended / 1-$cc=use that existing / n=New$dis : " ans </dev/tty || ans=""
    if [[ -z "$ans" ]]; then choice="$REC"; else
      case "$ans" in
        n|N) choice="new" ;;
        d|D) if [[ -n "$flag" ]]; then choice="disable"; else echo "  (no disable toggle for $label — it deploys with the platform; treating as New)"; choice="new"; fi ;;
        ''|*[!0-9]*) choice="$REC" ;;
        *) idx=$((ans)); if [[ $idx -ge 1 && $idx -le $cc ]]; then choice="existing:$idx"; else choice="$REC"; fi ;;
      esac
    fi
  fi

  # Resolve the choice into name/rg/sub + a flag value.
  flagval=""
  case "$choice" in
    existing:*)
      idx="${choice#existing:}"; c="${cands[$((idx-1))]}"; IFS='|' read -r n r s <<<"$c"
      flagval="true"   # feature stays enabled; main.bicep reuses instead of provisioning
      ;;
    new)     flagval="true" ;;
    disable) flagval="false" ;;
    *)       echo "  (unrecognized choice '$choice' — treating as New)"; choice="new"; flagval="true" ;;
  esac

  if [[ "$key" == "databricks" && -n "$n" ]]; then
    HOST[$key]="$(resolve_databricks_host "$n" "$r" "$s")"
    [[ -z "${HOST[$key]:-}" ]] && echo "  (could not resolve workspaceUrl for $n — set EXISTING_DATABRICKS_HOSTNAME manually)"
  fi

  # bicepparam literal lines — only for services main.bicep has existing* params for.
  if [[ -n "$nameP" ]]; then
    BLOCK_LINES+=("param $nameP = '${n}'")
    BLOCK_LINES+=("param $rgP = '${r}'")
    BLOCK_LINES+=("param $subP = '${s}'")
  fi

  # Canonical EXISTING_* env triples for every service (post-deploy RBAC/env).
  ENV_LINES+=("export ${envName}='${n}'")
  ENV_LINES+=("export ${envRg}='${r}'")
  ENV_LINES+=("export ${envSub}='${s}'")

  # Enable-flag override (set later via set_param so we don't duplicate params).
  if [[ -n "$flag" ]]; then
    FLAG_NAMES+=("$flag"); FLAG_VALUES+=("$flagval")
  fi

  if [[ -n "$n" ]]; then
    SUMMARY+=("  ✓ $label: REUSE $n (rg=${r:-?} sub=${s:-deploy-sub})")
  elif [[ "$choice" == "disable" ]]; then
    SUMMARY+=("  - $label: DISABLED ($flag=false — honest gate until re-enabled)")
  else
    SUMMARY+=("  + $label: NEW$([[ -n "$flag" ]] && echo " ($flag=true)")")
  fi
  echo
done

# Databricks hostname (separate param + env).
DBX_HOST="${HOST[databricks]:-}"
BLOCK_LINES+=("param existingDatabricksHostname = '${DBX_HOST}'")
ENV_LINES+=("export EXISTING_DATABRICKS_HOSTNAME='${DBX_HOST}'")

# Fabric mode (no-fabric-dependency.md: default false; gov hard-false).
FABRIC_VAL="false"
if [[ "$IS_GOV" == "0" && "${BYO_FABRIC:-false}" == "true" ]]; then
  FABRIC_VAL="true"
  echo "NOTE: fabricEnabled=true requested (Commercial). A bound Fabric workspace is OPT-IN."
fi
BLOCK_LINES+=("param fabricEnabled = ${FABRIC_VAL}")
ENV_LINES+=("export FABRIC_ENABLED='${FABRIC_VAL}'")

# ---------------------------------------------------------------------------
# Day-one required input: bootstrap tenant admin (PRP gap #4 — without it every
# admin page 403s on a fresh deploy). Prompt when interactive + still unset.
# ---------------------------------------------------------------------------
if [[ -z "$ADMIN_OID" && -z "$ADMIN_GROUP" && "$DEFAULTS" != "1" ]]; then
  echo "── Bootstrap admin (required) ──────────────────────────────"
  echo "  A fresh deploy gives every admin page a 403 until a bootstrap admin is set."
  echo "  Enter your Entra USER object id (LOOM_TENANT_ADMIN_OID) — find it with:"
  echo "    az ad signed-in-user show --query id -o tsv"
  read -r -p "  tenant-admin object id (or blank to set an Entra GROUP id next): " ADMIN_OID </dev/tty || ADMIN_OID=""
  if [[ -z "$ADMIN_OID" ]]; then
    read -r -p "  tenant-admin Entra GROUP object id: " ADMIN_GROUP </dev/tty || ADMIN_GROUP=""
  fi
  echo
fi

# ---------------------------------------------------------------------------
# Emit the generated bicepparam: copy the template, replacing the marked block.
# ---------------------------------------------------------------------------
BLOCK_FILE="$(mktemp)"
{
  echo "// >>> BYO-WIZARD START (generated by scripts/csa-loom/scan-and-deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ))"
  for l in "${BLOCK_LINES[@]}"; do echo "$l"; done
  echo "// <<< BYO-WIZARD END"
} > "$BLOCK_FILE"

awk -v blockfile="$BLOCK_FILE" '
  /\/\/ >>> BYO-WIZARD START/ { while ((getline line < blockfile) > 0) print line; close(blockfile); skip=1; next }
  /\/\/ <<< BYO-WIZARD END/   { skip=0; next }
  skip==1 { next }
  { print }
' "$TEMPLATE" > "$OUT_PARAM"
rm -f "$BLOCK_FILE"

# set_param <name> <rhs> — rewrite an existing `param <name> = ...` line in the
# OUT param to the new RHS, or append it when absent. Keeps a single assignment
# (a duplicate `param` in a bicepparam is a hard error).
set_param() {
  local name="$1" rhs="$2"
  if grep -qE "^[[:space:]]*param[[:space:]]+$name[[:space:]]*=" "$OUT_PARAM"; then
    awk -v n="$name" -v v="$rhs" '
      $0 ~ "^[[:space:]]*param[[:space:]]+" n "[[:space:]]*=" { print "param " n " = " v; next }
      { print }
    ' "$OUT_PARAM" > "$OUT_PARAM.tmp" && mv "$OUT_PARAM.tmp" "$OUT_PARAM"
  else
    echo "param $name = $rhs" >> "$OUT_PARAM"
  fi
}

# Apply the everything-on (opt-out) enable flags chosen above.
for i in "${!FLAG_NAMES[@]}"; do
  set_param "${FLAG_NAMES[$i]}" "${FLAG_VALUES[$i]}"
done

# Wire the bootstrap admin into the param (literal beats the env fallback).
[[ -n "$ADMIN_OID" ]]   && set_param "loomTenantAdminOid" "'$ADMIN_OID'"
[[ -n "$ADMIN_GROUP" ]] && set_param "loomTenantAdminGroupId" "'$ADMIN_GROUP'"

# ---------------------------------------------------------------------------
# Emit the env file for the post-deploy scripts (+ env-driven deploy).
# ---------------------------------------------------------------------------
{
  echo "# CSA Loom scan-and-deploy env — generated $(date -u +%Y-%m-%dT%H:%M:%SZ) for boundary $BOUNDARY"
  echo "# Source then grant roles on REUSED resources:"
  echo "#   source $OUT_ENV && bash scripts/csa-loom/grant-navigator-rbac.sh"
  for l in "${ENV_LINES[@]}"; do echo "$l"; done
} > "$OUT_ENV"

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo "============================================================"
echo "Choices:"
for s in "${SUMMARY[@]}"; do echo "$s"; done
echo
echo "Wrote:"
echo "  • params/$OUT_NAME.bicepparam   (self-contained drop-in for az deployment sub create -p)"
echo "  • ${OUT_ENV#$REPO_ROOT/}        (EXISTING_* exports for the post-deploy RBAC scripts)"
echo

# ---------------------------------------------------------------------------
# Build the deploy command (mirrors apps/fiab-console/app/api/setup/deploy/route.ts
# so the CLI and the Setup Wizard stay identical).
# ---------------------------------------------------------------------------
DEPLOY_MODE="${LOOM_DEPLOYMENT_MODE:-single-sub}"
ADMIN_OID_LINE=""
[[ -n "$ADMIN_OID" ]]   && ADMIN_OID_LINE=" loomTenantAdminOid=$ADMIN_OID"
[[ -n "$ADMIN_GROUP" ]] && ADMIN_OID_LINE="$ADMIN_OID_LINE loomTenantAdminGroupId=$ADMIN_GROUP"

DEPLOY_ARGS=(deployment sub create
  --subscription "${ADMIN_SUB:-<admin-sub>}"
  -l "${REGION:-<region>}"
  -f "platform/fiab/bicep/main.bicep"
  -p "platform/fiab/bicep/params/$OUT_NAME.bicepparam"
  -p "topology=tenant" "boundary=$BOUNDARY_PARAM" "deploymentMode=$DEPLOY_MODE")
[[ -n "$ADMIN_OID" ]]   && DEPLOY_ARGS+=("loomTenantAdminOid=$ADMIN_OID")
[[ -n "$ADMIN_GROUP" ]] && DEPLOY_ARGS+=("loomTenantAdminGroupId=$ADMIN_GROUP")

print_deploy_cmd() {
  echo "  az deployment sub create \\"
  echo "    --subscription ${ADMIN_SUB:-<admin-sub>} \\"
  echo "    -l ${REGION:-<region>} \\"
  echo "    -f platform/fiab/bicep/main.bicep \\"
  echo "    -p platform/fiab/bicep/params/$OUT_NAME.bicepparam \\"
  echo "    -p topology=tenant boundary=$BOUNDARY_PARAM deploymentMode=$DEPLOY_MODE${ADMIN_OID_LINE}"
}

# Honest gates that block an actual deploy.
BLOCKERS=()
[[ -z "$ADMIN_SUB" ]] && BLOCKERS+=("no admin subscription (pass --subscription <id> or 'az account set')")
[[ -z "$REGION" ]] && BLOCKERS+=("no region (pass --region <loc>)")
[[ -z "$ADMIN_OID" && -z "$ADMIN_GROUP" ]] && BLOCKERS+=("no bootstrap admin (pass --tenant-admin-oid <oid>; without it every admin page 403s)")

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry-run — the deploy command (NOT executed):"
  print_deploy_cmd
  [[ ${#BLOCKERS[@]} -gt 0 ]] && { echo; echo "Before a real run, resolve:"; for b in "${BLOCKERS[@]}"; do echo "  • $b"; done; }
  echo
  echo "Then grant the Console UAMI roles on every REUSED resource:"
  echo "  source $OUT_ENV && bash scripts/csa-loom/grant-navigator-rbac.sh"
  exit 0
fi

if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
  echo "Cannot deploy yet — resolve these, then re-run (or use --dry-run to just emit the param):"
  for b in "${BLOCKERS[@]}"; do echo "  • $b"; done
  echo
  echo "The command that WILL run once resolved:"
  print_deploy_cmd
  exit 1
fi

# ---------------------------------------------------------------------------
# Run the real deploy (ARM-incremental → safe to re-run / idempotent).
# ---------------------------------------------------------------------------
echo "Deploying (az deployment sub create — ARM incremental, safe to re-run):"
print_deploy_cmd
echo
az "${DEPLOY_ARGS[@]}"
RC=$?
if [[ "$RC" != "0" ]]; then
  echo "ERROR: az deployment sub create failed (exit $RC). Fix the error above and re-run — the deploy is idempotent." >&2
  exit "$RC"
fi

# ---------------------------------------------------------------------------
# Post-deploy: grant the Console UAMI roles on every REUSED cross-sub resource
# + reconcile env (both scripts are reuse-first / error-suppressing).
# ---------------------------------------------------------------------------
echo
echo "Granting the Console UAMI roles on REUSED resources + reconciling env…"
# shellcheck disable=SC1090
source "$OUT_ENV"
bash "$SCRIPT_DIR/grant-navigator-rbac.sh" || echo "  (grant-navigator-rbac.sh reported issues — review above; reused-resource roles may need a manual grant)"
bash "$SCRIPT_DIR/patch-navigator-env.sh"  || echo "  (patch-navigator-env.sh reported issues — review above)"

# ---------------------------------------------------------------------------
# Post-deploy DATA-PLANE bootstraps that CANNOT be expressed in bicep/ARM RBAC.
# These mirror the canonical csa-loom-post-deploy-bootstrap.yml steps so the
# one-button LOCAL deploy reaches the same working state as the GH-Actions path:
#   • Purview Data Map roles (collection metadata policy, NOT ARM RBAC)
#   • Synapse SQL CREATE USER … FROM EXTERNAL PROVIDER (TDS, needs sqlcmd)
# Both are best-effort here (the runner must be Purview Collection Admin /
# Synapse SQL Administrator); a failure prints how to finish via the workflow.
# ---------------------------------------------------------------------------
echo
echo "Post-deploy data-plane bootstraps (Purview Data Map + Synapse SQL login)…"

# Purview Data Map — grant the Console UAMI data-reader + data-curator (+ the
# admin roles) on the root collection so catalog/lineage/sources/domains work
# (was a 403). Discover the provisioned account; skip cleanly when Purview is
# opted out or reused cross-sub.
PURVIEW_ACCT="${LOOM_PURVIEW_ACCOUNT:-$(az purview account list -g "rg-csa-loom-admin-$REGION" --query "[?starts_with(name,'purview-csa-loom')].name | [0]" -o tsv 2>/dev/null || true)}"
if [[ -n "${PURVIEW_ACCT:-}" ]]; then
  for ROLE in data-reader data-curator data-source-administrator collection-administrator; do
    PURVIEW_ACCOUNT="$PURVIEW_ACCT" ROLE="$ROLE" \
      bash "$SCRIPT_DIR/grant-purview-datamap-role.sh" \
      || echo "  (Purview '$ROLE' grant skipped/failed — run the deploy SP as Collection Admin, or use the GH workflow)"
  done
else
  echo "  (no purview-csa-loom* account found — Purview opted out or reused cross-sub; skipping Data Map grants)"
fi

# Synapse SQL login for the Console UAMI (dedicated pool + serverless). Requires
# sqlcmd; when absent, point at the workflow (which installs mssql-tools18) +
# the canonical SQL bootstrap file rather than silently dropping it.
if command -v sqlcmd >/dev/null 2>&1 || [[ -x /opt/mssql-tools18/bin/sqlcmd ]]; then
  echo "  sqlcmd present — running the Synapse SQL login bootstrap is best done via"
  echo "  csa-loom-post-deploy-bootstrap.yml (it manages the temp public-access window)."
fi
echo "  Synapse SQL login (CREATE USER … FROM EXTERNAL PROVIDER) for the Console UAMI:"
echo "    run the 'SQL-level grants via sqlcmd' steps in"
echo "    .github/workflows/csa-loom-post-deploy-bootstrap.yml (workflow_dispatch),"
echo "    or apply platform/fiab/bootstrap/sql-security-bootstrap.sql per database"
echo "    (the workflow now derives the region-correct uami-loom-console-<region> name)."

echo
echo "Done. CSA Loom deployed to subscription $ADMIN_SUB ($REGION), boundary $BOUNDARY_PARAM."
echo "Finish data-plane bootstraps (Purview/Synapse SQL/Graph consent) by running the"
echo "csa-loom-post-deploy-bootstrap workflow if any step above was skipped."
echo "First login uses the bootstrap admin you set (loomTenantAdminOid/Group)."
