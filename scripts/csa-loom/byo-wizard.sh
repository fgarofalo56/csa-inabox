#!/usr/bin/env bash
# CSA Loom — Bring-Your-Own (BYO) bicepparam generator / wizard.
#
# WHAT IT DOES
#   For a one-button deploy, lets you choose EXISTING vs NEW (vs honest-gate) for
#   every reusable Azure service. It scans every subscription the signed-in
#   principal can see (reuse-first), prompts per service, and emits TWO artifacts:
#     1. platform/fiab/bicep/params/<name>.generated.bicepparam — a drop-in for
#        `az deployment sub create -p ...` (the redeploy-gov.sh Phase-2 argument),
#        with existing<Svc>{Name,Rg,Sub} set literally for every reuse pick.
#     2. temp/<name>.byo-exports.sh — canonical EXISTING_* exports consumed by
#        scripts/csa-loom/{grant-navigator-rbac,patch-navigator-env}.sh AND by
#        any boundary .bicepparam (readEnvironmentVariable). Source it, then deploy.
#
#   The generated bicepparam is produced by regenerating the block between the
#   `// >>> BYO-WIZARD START` / `// <<< BYO-WIZARD END` markers in the chosen
#   boundary template — so the rest of the boundary's parameters are preserved
#   verbatim and only the BYO surface changes.
#
# NO MICROSOFT FABRIC DEPENDENCY (no-fabric-dependency.md)
#   fabricEnabled defaults FALSE (Azure-native). The wizard only offers Fabric on
#   Commercial boundaries when BYO_FABRIC=true is set explicitly; gov boundaries
#   are always fabricEnabled=false.
#
# CROSS-SUB (…Sub)
#   Every reuse pick captures name+RG+SUB, so cross-sub reuse (e.g. a shared
#   governance-sub Purview) is a first-class deploy-time input, not a post-deploy
#   patch. The …Sub values flow into LOOM_<SVC>_SUB Console env vars + the RBAC
#   script. They are pure string pass-throughs (NOT Bicep `existing` cross-sub
#   references); post-deploy RBAC is granted by grant-navigator-rbac.sh.
#
# USAGE
#   bash scripts/csa-loom/byo-wizard.sh                          # interactive, commercial-full
#   bash scripts/csa-loom/byo-wizard.sh --boundary gcc-high
#   bash scripts/csa-loom/byo-wizard.sh --boundary commercial --out my-deploy
#   # non-interactive (CI / 1-button): drive every choice via env
#   BYO_NONINTERACTIVE=1 \
#     BYO_PURVIEW='reuse:dmlz-dev-purview-eastus:rg-dmlz-dev-governance-eastus:e093f4fd-...' \
#     BYO_APIM='reuse:dml-ai-east-aigateway:rg-dlz-aiml-stack-dev:363ef5d1-...' \
#     BYO_AISEARCH=new BYO_ADX=gate \
#     bash scripts/csa-loom/byo-wizard.sh --boundary commercial-full --non-interactive
#   Each BYO_<KEY> = 'reuse:<name>[:<rg>[:<sub>]]' | 'new' | 'gate' (default 'gate'
#   when not discovered; default 'reuse:<first-candidate>' offered interactively).
#
# REQUIRES: az CLI logged in (`az login`). Read-only enumeration — nothing is
#           created or modified by this script.
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve repo paths (works from any cwd).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BICEP_DIR="$REPO_ROOT/platform/fiab/bicep"
PARAMS_DIR="$BICEP_DIR/params"
TEMP_DIR="$REPO_ROOT/temp"

BOUNDARY="commercial-full"
OUT_NAME=""
NONINTERACTIVE="${BYO_NONINTERACTIVE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary) BOUNDARY="$2"; shift 2 ;;
    --out)      OUT_NAME="$2"; shift 2 ;;
    --non-interactive|--ci) NONINTERACTIVE=1; shift ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

TEMPLATE="$PARAMS_DIR/$BOUNDARY.bicepparam"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: boundary template not found: $TEMPLATE" >&2; echo "Available: $(ls "$PARAMS_DIR"/*.bicepparam 2>/dev/null | xargs -n1 basename | sed 's/\.bicepparam//' | tr '\n' ' ')" >&2; exit 1; }
grep -q '>>> BYO-WIZARD START' "$TEMPLATE" || { echo "ERROR: template $TEMPLATE has no BYO-WIZARD markers — add them first." >&2; exit 1; }

[[ -z "$OUT_NAME" ]] && OUT_NAME="$BOUNDARY.generated"
OUT_PARAM="$PARAMS_DIR/$OUT_NAME.bicepparam"
mkdir -p "$TEMP_DIR"
OUT_ENV="$TEMP_DIR/$OUT_NAME.byo-exports.sh"

# Gov boundaries never offer Fabric (no Fabric in Azure Government).
case "$BOUNDARY" in
  gcc-high|il5|gcc) IS_GOV=1 ;;
  *) IS_GOV=0 ;;
esac

echo "== CSA Loom — Bring-Your-Own wizard =="
echo "   boundary=$BOUNDARY  template=$(basename "$TEMPLATE")  out=params/$OUT_NAME.bicepparam"
echo "   mode=$([[ "$NONINTERACTIVE" == "1" ]] && echo non-interactive || echo interactive)  gov=$IS_GOV"
echo

SUBS="${SUBS:-$(az account list --query "[].id" -o tsv 2>/dev/null)}"
if [[ -z "$SUBS" ]]; then
  echo "WARNING: no subscriptions visible (run 'az login'). Discovery skipped — every service defaults to gate/new." >&2
fi
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
    # NOTE: `az graph query -o tsv` flattens the RESULT WRAPPER (count/skip_token),
    # not the rows — extract the data array explicitly with --query.
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
#       | env-name | env-rg | env-sub | enabled-flag
# The env-name/env-rg/env-sub are the CANONICAL EXISTING_* vars — they match the
# bicepparam readEnvironmentVariable() names AND discover-services.sh /
# patch-navigator-env.sh, so all consumers agree (fixes the §1.4 var-name drift).
# enabled-flag is '' for DLZ-provisioned services (no provisioning toggle).
# ---------------------------------------------------------------------------
SERVICES=(
  "aisearch|AI Search|Microsoft.Search/searchServices||existingAiSearchService|existingAiSearchRg|existingAiSearchSub|EXISTING_AI_SEARCH_SERVICE|EXISTING_AI_SEARCH_RG|EXISTING_AI_SEARCH_SUB|aiSearchEnabled"
  "apim|API Management|Microsoft.ApiManagement/service||existingApimName|existingApimRg|existingApimSub|EXISTING_APIM|EXISTING_APIM_RG|EXISTING_APIM_SUB|apimEnabled"
  "adx|ADX / Kusto|Microsoft.Kusto/clusters||existingAdxClusterName|existingAdxClusterRg|existingAdxClusterSub|EXISTING_KUSTO_CLUSTER|EXISTING_KUSTO_RG|EXISTING_KUSTO_SUB|adxEnabled"
  "foundry|AI Foundry / AOAI|Microsoft.CognitiveServices/accounts|kind =~ 'AIServices'|existingFoundryAccountName|existingFoundryRg|existingFoundrySub|EXISTING_AOAI|EXISTING_AOAI_RG|EXISTING_AOAI_SUB|aiFoundryEnabled"
  "purview|Microsoft Purview|Microsoft.Purview/accounts||existingPurviewAccount|existingPurviewRg|existingPurviewSub|EXISTING_PURVIEW|EXISTING_PURVIEW_RG|EXISTING_PURVIEW_SUB|purviewEnabled"
  "synapse|Synapse|Microsoft.Synapse/workspaces||existingSynapseWorkspace|existingSynapseRg|existingSynapseSub|EXISTING_SYNAPSE|EXISTING_SYNAPSE_RG|EXISTING_SYNAPSE_SUB|"
  "cosmos|Cosmos DB|Microsoft.DocumentDB/databaseAccounts||existingCosmosAccount|existingCosmosRg|existingCosmosSub|EXISTING_COSMOS_ACCOUNT|EXISTING_COSMOS_ACCOUNT_RG|EXISTING_COSMOS_ACCOUNT_SUB|"
  "adf|Data Factory|Microsoft.DataFactory/factories||existingAdfFactory|existingAdfRg|existingAdfSub|EXISTING_ADF|EXISTING_ADF_RG|EXISTING_ADF_SUB|"
  "eventhubs|Event Hubs|Microsoft.EventHub/namespaces||existingEventHubNamespace|existingEventHubRg|existingEventHubSub|EXISTING_EVENTHUB_NAMESPACE|EXISTING_EVENTHUB_RG|EXISTING_EVENTHUB_SUB|"
  "databricks|Databricks|Microsoft.Databricks/workspaces||existingDatabricksWorkspace|existingDatabricksRg|existingDatabricksSub|EXISTING_DATABRICKS|EXISTING_DATABRICKS_RG|EXISTING_DATABRICKS_SUB|"
  "law|Log Analytics|Microsoft.OperationalInsights/workspaces||existingLogAnalyticsWorkspace|existingLogAnalyticsRg|existingLogAnalyticsSub|EXISTING_LAW|EXISTING_LAW_RG|EXISTING_LAW_SUB|"
  "keyvault|Key Vault|Microsoft.KeyVault/vaults||existingKeyVaultName|existingKeyVaultRg|existingKeyVaultSub|EXISTING_KEYVAULT|EXISTING_KEYVAULT_RG|EXISTING_KEYVAULT_SUB|"
  "gateway|App Gateway / Front Door|Microsoft.Network/applicationGateways||existingGatewayName|existingGatewayRg|existingGatewaySub|EXISTING_GATEWAY|EXISTING_GATEWAY_RG|EXISTING_GATEWAY_SUB|appGatewayEnabled"
)

# Accumulators
declare -A NAME RG SUB HOST
declare -a BLOCK_LINES ENV_LINES SUMMARY

upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

resolve_databricks_host() {  # name rg sub -> workspaceUrl
  local n="$1" r="$2" s="$3"
  [[ -z "$n" || -z "$r" ]] && return 0
  local args=(databricks workspace show -n "$n" -g "$r" --query workspaceUrl -o tsv)
  [[ -n "$s" ]] && args+=(--subscription "$s")
  q "${args[@]}"
}

for row in "${SERVICES[@]}"; do
  IFS='|' read -r key label type filt nameP rgP subP envName envRg envSub flag <<<"$row"
  echo "── $label ──────────────────────────────────────────────"
  mapfile -t cands < <(discover "$type" "$filt")
  envKey="BYO_$(upper "$key")"
  choice=""

  if [[ "$NONINTERACTIVE" == "1" ]]; then
    choice="${!envKey:-}"
    if [[ -z "$choice" ]]; then
      # No explicit BYO_<KEY>: do NOT silently reuse a discovered resource.
      # DLZ services (no enabled-flag) provision new with the platform; the four
      # flagged admin-plane services default to an honest gate until chosen.
      if [[ -z "$flag" ]]; then choice="new"; else choice="gate"; fi
    fi
  else
    if [[ ${#cands[@]} -gt 0 ]]; then
      echo "  Found ${#cands[@]} existing candidate(s):"
      i=1; for c in "${cands[@]}"; do IFS='|' read -r cn cr cs <<<"$c"; echo "    [$i] $cn   (rg=$cr sub=$cs)"; i=$((i+1)); done
      echo "    [n] provision NEW    [g] honest-gate (leave unconfigured)"
      read -r -p "  Choose 1-${#cands[@]} / n / g [default 1=reuse]: " ans </dev/tty || ans=""
      ans="${ans:-1}"
      case "$ans" in
        n|N) choice="new" ;;
        g|G) choice="gate" ;;
        ''|*[!0-9]*) choice="gate" ;;
        *) idx=$((ans-1)); if [[ $idx -ge 0 && $idx -lt ${#cands[@]} ]]; then c="${cands[$idx]}"; choice="reuse:${c//|/:}"; else choice="gate"; fi ;;
      esac
    else
      echo "  (no existing candidate found)"
      if [[ -n "$flag" ]]; then
        read -r -p "  provision NEW or honest-gate? [N/g]: " ans </dev/tty || ans="N"
        [[ "$ans" =~ ^[gG] ]] && choice="gate" || choice="new"
      else
        echo "  DLZ-provisioned by default (a new instance deploys with the platform)."
        choice="new"
      fi
    fi
  fi

  # Parse the choice into name/rg/sub.
  n=""; r=""; s=""
  case "$choice" in
    reuse:*)
      IFS=':' read -r _ n r s <<<"$choice"
      ;;
    new)  : ;;   # leave existing* empty; *Enabled flag (if any) governs provisioning
    gate) : ;;   # leave existing* empty; honest gate
    *)    echo "  (unrecognized choice '$choice' — treating as gate)"; choice="gate" ;;
  esac

  NAME[$key]="$n"; RG[$key]="$r"; SUB[$key]="$s"
  if [[ "$key" == "databricks" && -n "$n" ]]; then
    HOST[$key]="$(resolve_databricks_host "$n" "$r" "$s")"
    [[ -z "${HOST[$key]}" ]] && echo "  (could not resolve workspaceUrl for $n — set EXISTING_DATABRICKS_HOSTNAME manually)"
  fi

  # Build the literal bicepparam lines for this service.
  BLOCK_LINES+=("param $nameP = '${n}'")
  BLOCK_LINES+=("param $rgP = '${r}'")
  BLOCK_LINES+=("param $subP = '${s}'")

  # Build the env-file lines (canonical EXISTING_* triples — names match the
  # bicepparam readEnvironmentVariable + the post-deploy scripts).
  ENV_LINES+=("export ${envName}='${n}'")
  ENV_LINES+=("export ${envRg}='${r}'")
  ENV_LINES+=("export ${envSub}='${s}'")

  if [[ -n "$n" ]]; then
    SUMMARY+=("  ✓ $label: REUSE $n (rg=${r:-?} sub=${s:-deploy-sub})")
  elif [[ "$choice" == "new" ]]; then
    SUMMARY+=("  + $label: NEW$([[ -n "$flag" ]] && echo " (ensure $flag=true)")")
  else
    SUMMARY+=("  - $label: GATE (honest MessageBar until configured)")
  fi
  echo
done

# Databricks hostname (separate param + env, resolved above).
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
# Emit the generated bicepparam: copy the template, replacing the marked block.
# ---------------------------------------------------------------------------
BLOCK_FILE="$(mktemp)"
{
  echo "// >>> BYO-WIZARD START (generated by scripts/csa-loom/byo-wizard.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ))"
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

# ---------------------------------------------------------------------------
# Emit the env file for the post-deploy scripts (+ env-driven deploy).
# ---------------------------------------------------------------------------
{
  echo "# CSA Loom BYO env — generated $(date -u +%Y-%m-%dT%H:%M:%SZ) for boundary $BOUNDARY"
  echo "# Source then deploy (env-driven) OR feed grant-navigator-rbac.sh / patch-navigator-env.sh:"
  echo "#   source $OUT_ENV && az deployment sub create -f platform/fiab/bicep/main.bicep -p platform/fiab/bicep/params/$BOUNDARY.bicepparam"
  for l in "${ENV_LINES[@]}"; do echo "$l"; done
} > "$OUT_ENV"

# ---------------------------------------------------------------------------
# Summary + next steps.
# ---------------------------------------------------------------------------
echo "============================================================"
echo "Choices:"
for s in "${SUMMARY[@]}"; do echo "$s"; done
echo
echo "Wrote:"
echo "  • params/$OUT_NAME.bicepparam   (drop-in for az deployment sub create -p)"
echo "  • ${OUT_ENV#$REPO_ROOT/}        (EXISTING_* exports for the post-deploy scripts)"
echo
echo "Next — one-button deploy with your BYO choices:"
echo "  az deployment sub create \\"
echo "    -f platform/fiab/bicep/main.bicep \\"
echo "    -p platform/fiab/bicep/params/$OUT_NAME.bicepparam \\"
echo "    -l <region>"
echo
echo "Then grant the Console UAMI roles on every REUSED resource:"
echo "  source $OUT_ENV && bash scripts/csa-loom/grant-navigator-rbac.sh"
echo "(For an already-running console, reconcile env without redeploy:"
echo "  source $OUT_ENV && bash scripts/csa-loom/patch-navigator-env.sh )"
