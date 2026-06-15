#!/usr/bin/env bash
# publish-coe-reports.sh
#
# Publish the default Cloud Center of Excellence (CoE) Power BI report templates
# (docs/fiab/org-visuals/coe-library/<slug>/*.pbip) into a Power BI / Fabric
# workspace via the Power BI / Fabric REST API. Parameterized by workspace id +
# an Entra (AAD) token; idempotent (re-publishing updates the existing items in
# place rather than creating duplicates); sets the Power Query parameters
# (TenantId / SubscriptionId / BillingScope / LogAnalyticsWorkspaceId /
# ManagementApiBase) so each report points at THIS tenant's Azure estate.
#
# WHY this is a script (not bicep): publishing a Power BI report is a data-plane
# operation against the Power BI service, not an ARM deployment. PBIP (PBIR +
# TMDL) projects are published through the Fabric item-definition REST API
# (POST .../semanticModels and .../reports with the TMDL/PBIR parts inline). We
# drive that through `fabric-cicd`, Microsoft's supported PBIP deployment tool,
# which handles the semantic-model→report rebind and is idempotent by design.
#
# This is the Power BI path the operator asked for. It is strictly OPT-IN and is
# the ONLY place CSA Loom touches api.powerbi.com — browsing and cloning the CoE
# library in the Console requires NO Power BI / Fabric workspace (see
# .claude/rules/no-fabric-dependency.md). Azure-native / Gov alternative: render
# the same models in Grafana / Azure Managed Grafana over Azure Monitor + ADX
# (no Power BI dependency) — see docs/fiab/org-visuals/coe-library/README.md.
#
# ---------------------------------------------------------------------------
# Required permissions / prerequisites
#   - Python 3.9+ and pip (the script installs `fabric-cicd` if missing).
#   - The workspace must be backed by a Fabric / Power BI Premium or Fabric
#     capacity (PBIP item publishing requires capacity).
#   - Caller identity (interactive `az login` user OR a service principal via
#     AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET) must be a
#     **Member or Admin** of the target workspace.
#   - Tenant setting "Service principals can use Fabric APIs" enabled when
#     publishing with a service principal.
#   - API scopes: Power BI / Fabric — Workspace.ReadWrite.All,
#     Item.ReadWrite.All (Dataset.ReadWrite.All + Report.ReadWrite.All for the
#     classic Power BI surface). The first publish of a model with data sources
#     still needs a one-time data-source credential set in the workspace.
#
# Usage
#   ./publish-coe-reports.sh \
#       --workspace-id 46c42501-e97a-4295-8cdb-b1c7000cce1f \
#       --param SubscriptionId=<subId> \
#       --param TenantId=<tenantId> \
#       --param BillingScope=/subscriptions/<subId> \
#       --param LogAnalyticsWorkspaceId=<laWorkspaceId> \
#       [--slug cloud-cost-finops]      # publish one report (repeatable); default = all
#       [--library-path <dir>]          # default: docs/fiab/org-visuals/coe-library
#       [--dry-run]
#
# Auth: uses azure-identity DefaultAzureCredential — run `az login` first, or
# export AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET for a service
# principal. (No secret is read from or written to disk by this script.)
set -euo pipefail

WORKSPACE_ID="46c42501-e97a-4295-8cdb-b1c7000cce1f"   # operator default; override with --workspace-id
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LIBRARY_PATH="$REPO_ROOT/docs/fiab/org-visuals/coe-library"
declare -a SLUGS=()
declare -a PARAMS=()
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-id) WORKSPACE_ID="$2"; shift 2;;
    --library-path) LIBRARY_PATH="$2"; shift 2;;
    --slug) SLUGS+=("$2"); shift 2;;
    --param) PARAMS+=("$2"); shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '2,60p' "${BASH_SOURCE[0]}"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -d "$LIBRARY_PATH" ]] || { echo "ERROR: library path not found: $LIBRARY_PATH" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required" >&2; exit 1; }

echo "==> CoE report publish"
echo "    workspace : $WORKSPACE_ID"
echo "    library   : $LIBRARY_PATH"
echo "    scope     : ${SLUGS[*]:-<all reports>}"

# Stage the selected reports (so a --slug filter publishes only those items).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
if [[ ${#SLUGS[@]} -gt 0 ]]; then
  for slug in "${SLUGS[@]}"; do
    [[ -d "$LIBRARY_PATH/$slug" ]] || { echo "ERROR: no such report slug: $slug" >&2; exit 1; }
    cp -r "$LIBRARY_PATH/$slug/." "$STAGE/"
  done
else
  for d in "$LIBRARY_PATH"/*/; do
    [[ -d "${d}" ]] || continue
    # only directories that actually contain a PBIP item
    if ls "${d}"/*.pbip >/dev/null 2>&1; then cp -r "${d}." "$STAGE/"; fi
  done
fi

# Build a fabric-cicd parameter.yml so the M parameters are rebound at publish
# time (find/replace of the default placeholder values inside the TMDL).
PARAM_FILE="$STAGE/parameter.yml"
{
  echo "# Auto-generated by publish-coe-reports.sh — rebinds CoE template parameters."
  if [[ ${#PARAMS[@]} -gt 0 ]]; then
    echo "find_replace:"
    for kv in "${PARAMS[@]}"; do
      key="${kv%%=*}"; val="${kv#*=}"
      # The TMDL ships the parameter default as: expression <Key> = "<default>"
      echo "  - find_value: 'expression ${key} = \"'"
      echo "    replace_value:"
      echo "      PROD: 'expression ${key} = \"${val}//SET//'"
    done
    echo "# NOTE: review parameter.yml find/replace against your TMDL before PROD."
  fi
} > "$PARAM_FILE"

echo "==> ensuring fabric-cicd is installed"
python3 -m pip show fabric-cicd >/dev/null 2>&1 || python3 -m pip install --quiet --user fabric-cicd

DEPLOY_PY="$STAGE/_deploy.py"
cat > "$DEPLOY_PY" <<'PY'
import os, sys
from fabric_cicd import FabricWorkspace, publish_all_items

ws_id = os.environ["COE_WORKSPACE_ID"]
repo = os.environ["COE_STAGE_DIR"]
dry = os.environ.get("COE_DRY_RUN") == "1"

fw = FabricWorkspace(
    workspace_id=ws_id,
    repository_directory=repo,
    item_type_in_scope=["SemanticModel", "Report"],
)
# fabric-cicd publishes semantic models first, then reports, rebinding each
# report to the freshly-published model — idempotent (updates in place).
if dry:
    items = getattr(fw, "repository_items", None) or {}
    print("[dry-run] would publish from", repo)
    for it_type, items_of_type in (items.items() if hasattr(items, "items") else []):
        for name in items_of_type:
            print(f"  - {it_type}: {name}")
    sys.exit(0)

publish_all_items(fw)
print("[done] published CoE reports to workspace", ws_id)
PY

export COE_WORKSPACE_ID="$WORKSPACE_ID"
export COE_STAGE_DIR="$STAGE"
export COE_DRY_RUN="$DRY_RUN"

echo "==> publishing (idempotent)…"
python3 "$DEPLOY_PY"

if [[ "$DRY_RUN" == "0" ]]; then
  echo "==> done. Open the workspace to set data-source credentials on first refresh:"
  echo "    https://app.powerbi.com/groups/$WORKSPACE_ID/list"
fi
