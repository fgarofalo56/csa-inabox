#!/usr/bin/env bash
# CSA Loom — patch the live loom-console Container App with the REAL service
# navigator env vars, discovered from the deployed Azure resources.
#
# WHY THIS EXISTS
#   admin-plane/main.bicep wires every navigator env var from module outputs,
#   but a *live* environment cannot re-run main.bicep (accumulated drift:
#   RoleAssignmentExists -> private-DNS vnet-link Conflict -> firewall churn),
#   and the app-roll step (full-app-deploy-commercial.yml) only updates the
#   container *image*, never the env. So for an already-running deployment the
#   corrected env vars never land. This script bridges that gap: it discovers
#   the real resource names/URIs/hostnames in the tenant and applies them to
#   the live console app via `az containerapp update --set-env-vars` (a merge —
#   it updates/adds only the named vars and keeps everything else).
#
# REUSE-FIRST + BRING-YOUR-OWN
#   For each service it first honors an explicit override env var (point Loom at
#   an EXISTING resource in ANY sub/RG), else discovers in the Loom admin/DLZ
#   resource groups, else leaves the var UNSET so the navigator shows its honest
#   config-gate (never a fake). Nothing is provisioned here.
#
# IDEMPOTENT: re-running is safe; only resources that resolve get wired.
#
# REQUIRES: az CLI logged in to the sub that owns the Loom Admin Plane, with
#           read access to the admin + DLZ resource groups and Container Apps
#           write on loom-console.
set -uo pipefail

# ---------------------------------------------------------------------------
# Context (override via env for other deployments / boundaries)
# ---------------------------------------------------------------------------
SUB="${SUB:-363ef5d1-0e77-4594-a530-f51af23dbf8c}"
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-eastus2}"
DLZ_RG="${DLZ_RG:-rg-csa-loom-dlz-single-eastus2}"
LOCATION="${LOCATION:-eastus2}"
CONSOLE_APP="${CONSOLE_APP:-loom-console}"

az account set --subscription "$SUB" 2>/dev/null || true
echo "== CSA Loom navigator env patch =="
echo "   sub=$SUB admin_rg=$ADMIN_RG dlz_rg=$DLZ_RG app=$CONSOLE_APP"
echo

# Collected KEY=VALUE pairs to apply in a single revision.
declare -a PAIRS=()
add() { # add NAME VALUE  — only when VALUE is non-empty
  local name="$1" val="$2"
  if [[ -n "$val" && "$val" != "null" && "$val" != "None" ]]; then
    PAIRS+=("$name=$val")
    echo "  + $name=$val"
  else
    echo "  - $name (not found / not deployed — leaving honest gate)"
  fi
}
q() { az "$@" 2>/dev/null || true; }   # query helper that never aborts the script

# ---------------------------------------------------------------------------
# Databricks — the workspace URL embeds a non-deterministic id, so it MUST be
# discovered (bicep cannot synthesize it). Powers the Databricks navigator +
# Unity Catalog federation hostname list.
# ---------------------------------------------------------------------------
DBX_HOST="${EXISTING_DATABRICKS_HOSTNAME:-}"
if [[ -z "$DBX_HOST" ]]; then
  DBX_HOST="$(q databricks workspace list -g "$DLZ_RG" --query "[0].workspaceUrl" -o tsv)"
  [[ -z "$DBX_HOST" ]] && DBX_HOST="$(q databricks workspace list -g "$ADMIN_RG" --query "[0].workspaceUrl" -o tsv)"
fi
add LOOM_DATABRICKS_HOSTNAME  "$DBX_HOST"
add LOOM_DATABRICKS_HOSTNAMES "$DBX_HOST"

# ---------------------------------------------------------------------------
# ADX / Kusto — shared cluster lives in the admin plane.
# ---------------------------------------------------------------------------
KUSTO_NAME="${EXISTING_KUSTO_CLUSTER:-${EXISTING_KUSTO_CLUSTER_NAME:-}}"
KUSTO_RG="${EXISTING_KUSTO_RG:-$ADMIN_RG}"
if [[ -z "$KUSTO_NAME" ]]; then
  KUSTO_NAME="$(q kusto cluster list -g "$KUSTO_RG" --query "[0].name" -o tsv)"
fi
if [[ -n "$KUSTO_NAME" ]]; then
  KUSTO_URI="$(q kusto cluster show -n "$KUSTO_NAME" -g "$KUSTO_RG" --query "uri" -o tsv)"
  add LOOM_KUSTO_CLUSTER_URI  "$KUSTO_URI"
  add LOOM_KUSTO_CLUSTER_NAME "$KUSTO_NAME"
  add LOOM_KUSTO_RG           "$KUSTO_RG"
  add LOOM_KUSTO_SUB          "${EXISTING_KUSTO_SUB:-}"
  add LOOM_KUSTO_LOCATION     "$LOCATION"
  # default database — prefer a loomdb-* db, else the first non-system db.
  # ADX `database list` returns names as "<cluster>/<db>", so strip the prefix.
  KUSTO_DB="$(q kusto database list --cluster-name "$KUSTO_NAME" -g "$KUSTO_RG" \
      --query "[?contains(name,'loomdb')].name | [0]" -o tsv | sed 's#.*/##')"
  [[ -z "$KUSTO_DB" ]] && KUSTO_DB="$(q kusto database list --cluster-name "$KUSTO_NAME" -g "$KUSTO_RG" --query "[0].name" -o tsv | sed 's#.*/##')"
  add LOOM_KUSTO_DEFAULT_DB   "${KUSTO_DB:-loomdb-default}"
else
  echo "  - ADX cluster not found in $KUSTO_RG — leaving Kusto navigator gated"
fi

# ---------------------------------------------------------------------------
# AI Search — reuse an existing service anywhere, else discover in admin RG.
# ---------------------------------------------------------------------------
SEARCH_NAME="${EXISTING_AI_SEARCH_SERVICE:-}"
SEARCH_RG="${EXISTING_AI_SEARCH_RG:-$ADMIN_RG}"
if [[ -z "$SEARCH_NAME" ]]; then
  SEARCH_NAME="$(q search service list -g "$SEARCH_RG" --query "[0].name" -o tsv)"
fi
add LOOM_AI_SEARCH_SERVICE "$SEARCH_NAME"
[[ -n "$SEARCH_NAME" ]] && add LOOM_AI_SEARCH_RG "$SEARCH_RG"
[[ -n "$SEARCH_NAME" ]] && add LOOM_AI_SEARCH_SUB "${EXISTING_AI_SEARCH_SUB:-}"

# ---------------------------------------------------------------------------
# APIM — reuse-first, else discover in admin RG.
# ---------------------------------------------------------------------------
APIM_NAME="${EXISTING_APIM:-${EXISTING_APIM_NAME:-}}"
APIM_RG="${EXISTING_APIM_RG:-$ADMIN_RG}"
if [[ -z "$APIM_NAME" ]]; then
  APIM_NAME="$(q apim list -g "$APIM_RG" --query "[0].name" -o tsv)"
fi
add LOOM_APIM_NAME "$APIM_NAME"
[[ -n "$APIM_NAME" ]] && add LOOM_APIM_RG "$APIM_RG"
[[ -n "$APIM_NAME" ]] && add LOOM_APIM_SUB "${EXISTING_APIM_SUB:-}"

# ---------------------------------------------------------------------------
# Cosmos (control-plane navigator) — the DLZ account (distinct from Loom's own
# LOOM_COSMOS_ENDPOINT store).
# ---------------------------------------------------------------------------
COSMOS_ACCT="${EXISTING_COSMOS_ACCOUNT:-}"
COSMOS_RG="${EXISTING_COSMOS_ACCOUNT_RG:-$DLZ_RG}"
if [[ -z "$COSMOS_ACCT" ]]; then
  COSMOS_ACCT="$(q cosmosdb list -g "$COSMOS_RG" --query "[?starts_with(name,'cosmos-loom')].name | [0]" -o tsv)"
  [[ -z "$COSMOS_ACCT" ]] && COSMOS_ACCT="$(q cosmosdb list -g "$COSMOS_RG" --query "[0].name" -o tsv)"
fi
add LOOM_COSMOS_ACCOUNT "$COSMOS_ACCT"
[[ -n "$COSMOS_ACCT" ]] && add LOOM_COSMOS_ACCOUNT_RG "$COSMOS_RG"
[[ -n "$COSMOS_ACCT" ]] && add LOOM_COSMOS_ACCOUNT_SUB "${EXISTING_COSMOS_ACCOUNT_SUB:-}"

# ---------------------------------------------------------------------------
# Event Hubs — the DLZ namespace (Eventstream navigator).
# ---------------------------------------------------------------------------
EH_NS="${EXISTING_EVENTHUB_NAMESPACE:-}"
EH_RG="${EXISTING_EVENTHUB_RG:-$DLZ_RG}"
if [[ -z "$EH_NS" ]]; then
  EH_NS="$(q eventhubs namespace list -g "$EH_RG" --query "[0].name" -o tsv)"
fi
add LOOM_EVENTHUB_NAMESPACE "$EH_NS"
[[ -n "$EH_NS" ]] && add LOOM_EVENTHUB_RG "$EH_RG"
[[ -n "$EH_NS" ]] && add LOOM_EVENTHUB_SUB "${EXISTING_EVENTHUB_SUB:-}"

# ---------------------------------------------------------------------------
# AI Foundry — AOAI model-hosting account + Foundry project (Copilot backend +
# data-agent Publish). Only when Foundry is actually deployed.
# ---------------------------------------------------------------------------
AOAI_NAME="${EXISTING_AOAI:-${EXISTING_AOAI_ACCOUNT:-}}"
AOAI_RG="${EXISTING_AOAI_RG:-$ADMIN_RG}"
if [[ -z "$AOAI_NAME" ]]; then
  AOAI_NAME="$(q cognitiveservices account list -g "$AOAI_RG" --query "[?kind=='AIServices'].name | [0]" -o tsv)"
fi
if [[ -n "$AOAI_NAME" ]]; then
  add LOOM_AOAI_ACCOUNT "$AOAI_NAME"
  add LOOM_AOAI_RG      "$AOAI_RG"
  add LOOM_AOAI_SUB     "${EXISTING_AOAI_SUB:-}"
  add LOOM_FOUNDRY_SUB  "${EXISTING_AOAI_SUB:-}"
  AOAI_EP="$(q cognitiveservices account show -n "$AOAI_NAME" -g "$AOAI_RG" --query "properties.endpoint" -o tsv)"
  add LOOM_AOAI_ENDPOINT "$AOAI_EP"
  # First chat deployment (for the in-console copilot orchestrator)
  AOAI_DEP="$(q cognitiveservices account deployment list -n "$AOAI_NAME" -g "$AOAI_RG" \
      --query "[?contains(properties.model.name,'gpt')].name | [0]" -o tsv)"
  [[ -z "$AOAI_DEP" ]] && AOAI_DEP="$(q cognitiveservices account deployment list -n "$AOAI_NAME" -g "$AOAI_RG" --query "[0].name" -o tsv)"
  add LOOM_AOAI_DEPLOYMENT "$AOAI_DEP"
  # Foundry project endpoint + GUID (real workspace GUID, which bicep can't emit)
  PROJ_EP="$(q rest --method get --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$AOAI_RG/providers/Microsoft.CognitiveServices/accounts/$AOAI_NAME/projects?api-version=2025-04-01-preview" --query "value[0].properties.endpoints.\"AI Foundry API\"" -o tsv)"
  PROJ_GUID="$(q rest --method get --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$AOAI_RG/providers/Microsoft.CognitiveServices/accounts/$AOAI_NAME/projects?api-version=2025-04-01-preview" --query "value[0].properties.internalId" -o tsv)"
  add LOOM_FOUNDRY_PROJECT_ENDPOINT "$PROJ_EP"
  add LOOM_FOUNDRY_PROJECT_ID       "$PROJ_GUID"
fi
add LOOM_FOUNDRY_REGION "$LOCATION"

# Content Safety (Foundry content-filter editor) — reuse if present.
CS_EP="${EXISTING_CONTENT_SAFETY_ENDPOINT:-}"
[[ -z "$CS_EP" ]] && CS_EP="$(q cognitiveservices account list -g "$ADMIN_RG" --query "[?kind=='ContentSafety'].properties.endpoint | [0]" -o tsv)"
add LOOM_CONTENT_SAFETY_ENDPOINT "$CS_EP"

# ---------------------------------------------------------------------------
# Purview — reuse the tenant Purview if one exists (only one Enterprise-tier
# Purview is allowed per tenant, so this is almost always a reuse).
# ---------------------------------------------------------------------------
# Honor either override var name (discover-services.sh exports EXISTING_PURVIEW;
# older callers used EXISTING_PURVIEW_ACCOUNT) — accept both.
PURVIEW="${EXISTING_PURVIEW:-${EXISTING_PURVIEW_ACCOUNT:-}}"
if [[ -z "$PURVIEW" ]]; then
  # Only one Enterprise Purview is allowed per tenant, and it may live in a
  # DIFFERENT subscription than the Loom DLZ (e.g. a shared governance sub). Scan
  # every subscription the principal can see, not just the current one, so the
  # console's Purview tab / catalog federation bind automatically.
  for _psub in $(az account list --query "[].id" -o tsv 2>/dev/null); do
    PURVIEW="$(az purview account list --subscription "$_psub" --query "[0].name" -o tsv 2>/dev/null)"
    [[ -n "$PURVIEW" ]] && { echo "  Purview found in sub $_psub: $PURVIEW" >&2; break; }
  done
fi
add LOOM_PURVIEW_ACCOUNT "$PURVIEW"
[[ -n "$PURVIEW" ]] && add LOOM_PURVIEW_SUB "${EXISTING_PURVIEW_SUB:-}"

# ---------------------------------------------------------------------------
# Apply — one merge update => one new console revision.
# ---------------------------------------------------------------------------
echo
if [[ ${#PAIRS[@]} -eq 0 ]]; then
  echo "No resources resolved — nothing to patch. All navigators stay honestly gated."
  exit 0
fi
echo "Applying ${#PAIRS[@]} env var(s) to $CONSOLE_APP in $ADMIN_RG ..."
az containerapp update -g "$ADMIN_RG" -n "$CONSOLE_APP" --set-env-vars "${PAIRS[@]}" -o none
echo "Done. A new revision is rolling; the navigators that resolved will return real data."
CONSOLE_FQDN="$(q containerapp show -g "$ADMIN_RG" -n "$CONSOLE_APP" --query "properties.configuration.ingress.fqdn" -o tsv)"
[[ -n "$CONSOLE_FQDN" ]] && echo "Console: https://$CONSOLE_FQDN"
