#!/usr/bin/env bash
# CSA Loom — scan-and-deploy (deploy-readiness PRP).
#
# One pre-deploy entry point that SCANS every subscription the caller can see for
# the Azure services Loom can integrate, lets you CHOOSE per service
# (use-existing / provision-new / disable) WITH a recommendation, emits a
# drop-in .bicepparam, and runs `az deployment sub create`.
#
# This wraps the per-service scanner + chooser in scripts/csa-loom/byo-wizard.sh
# (its SERVICES table already covers AI Search, APIM, ADX, AI Foundry/AOAI,
# Microsoft PURVIEW, Synapse, Cosmos, ADF, Event Hubs, Databricks) so there is a
# single source of truth for discovery + param emission. Governance (Purview) is
# included: byo-wizard's `purview` row discovers existing accounts and lets you
# reuse / provision-new / honest-gate; this orchestrator adds the recommendation
# and the deploy call.
#
# DEFAULT posture = everything ON (opt-out): with --defaults the wizard provisions
# the full stack new (purviewEnabled=true etc.). Per .claude/rules/no-vaporware.md
# + no-fabric-dependency.md (Azure-native default).
#
# Usage:
#   scripts/csa-loom/scan-and-deploy.sh --boundary Commercial --region eastus2 [--defaults] [--deploy]
#
# Flags:
#   --boundary <Commercial|GCC|GCC-High|IL5>   (default: Commercial)
#   --region   <azure-region>                  (default: eastus2 / usgovvirginia for gov)
#   --defaults                                 non-interactive; provision everything new
#   --deploy                                   run az deployment after emitting params (else just print the command)
#   --recommend-only                           print the per-service scan + recommendation, then exit
#
# Recommendation logic (governance/Purview): reuse the single existing
# purview-csa-loom* / tenant Enterprise account if exactly one is found in scope;
# otherwise provision NEW (classic Microsoft.Purview/accounts can coexist — only
# the unified Enterprise account is tenant-singleton).

set -uo pipefail
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOUNDARY="Commercial"
REGION=""
DEFAULTS="0"
DO_DEPLOY="0"
RECOMMEND_ONLY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary) BOUNDARY="$2"; shift 2 ;;
    --region)   REGION="$2"; shift 2 ;;
    --defaults) DEFAULTS="1"; shift ;;
    --deploy)   DO_DEPLOY="1"; shift ;;
    --recommend-only) RECOMMEND_ONLY="1"; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$BOUNDARY" in
  GCC-High|IL5) IS_GOV=1; [[ -z "$REGION" ]] && REGION="usgovvirginia" ;;
  *)            IS_GOV=0; [[ -z "$REGION" ]] && REGION="eastus2" ;;
esac

command -v az >/dev/null 2>&1 || { echo "az CLI required" >&2; exit 1; }

# Map boundary → its real .bicepparam (matches app/api/setup/deploy/route.ts).
case "$BOUNDARY" in
  Commercial) PARAM_FILE="platform/fiab/bicep/params/commercial-full.bicepparam" ;;
  GCC)        PARAM_FILE="platform/fiab/bicep/params/gcc.bicepparam" ;;
  GCC-High)   PARAM_FILE="platform/fiab/bicep/params/gcc-high.bicepparam" ;;
  IL5)        PARAM_FILE="platform/fiab/bicep/params/il5.bicepparam" ;;
  *) echo "unknown boundary: $BOUNDARY" >&2; exit 2 ;;
esac

echo "============================================================"
echo "CSA Loom scan-and-deploy — boundary=$BOUNDARY region=$REGION defaults=$DEFAULTS"
echo "============================================================"

# ---------------------------------------------------------------------------
# Governance / Purview recommendation (illustrative; byo-wizard does the full
# per-service scan + choose for ALL services below).
# ---------------------------------------------------------------------------
recommend_purview() {
  echo "── Governance: Microsoft Purview ─────────────────────────"
  local rows
  rows="$(az graph query -q "Resources | where type =~ 'Microsoft.Purview/accounts' | project name, resourceGroup, subscriptionId" \
    --first 100 --query "data[].[name,resourceGroup,subscriptionId]" -o tsv 2>/dev/null \
    | awk -F'\t' 'NF>=1 && $1!="" {print}')"
  local count; count="$(printf '%s\n' "$rows" | grep -c . || true)"
  if [[ "$count" -eq 0 ]]; then
    echo "  No existing Purview accounts found in scope."
    echo "  RECOMMENDATION: provision NEW (purviewEnabled=true) — Azure-native governance ON by default."
  elif [[ "$count" -eq 1 ]]; then
    echo "  Found 1 existing account:"; printf '    %s\n' "$rows"
    echo "  RECOMMENDATION: REUSE it (set LOOM_PURVIEW_ACCOUNT / existingPurviewAccount) to avoid a second account."
  else
    echo "  Found $count existing accounts:"; printf '    %s\n' "$rows"
    echo "  RECOMMENDATION: REUSE your tenant's primary, or provision NEW (classic accounts can coexist)."
  fi
  echo
}

recommend_purview
[[ "$RECOMMEND_ONLY" == "1" ]] && { echo "(--recommend-only) done."; exit 0; }

# ---------------------------------------------------------------------------
# Full per-service scan + choose + param emission via byo-wizard.
#   • interactive (default): byo-wizard prompts per service (reuse/new/gate).
#   • --defaults: NONINTERACTIVE=1 → DLZ services provision new; flagged
#     admin-plane services default to their bicepparam (purviewEnabled=true etc.).
# ---------------------------------------------------------------------------
WIZARD="$REPO_ROOT/scripts/csa-loom/byo-wizard.sh"
if [[ -x "$WIZARD" || -f "$WIZARD" ]]; then
  echo "Running per-service scan-and-choose (byo-wizard.sh)…"
  if [[ "$DEFAULTS" == "1" ]]; then
    NONINTERACTIVE=1 BOUNDARY="$BOUNDARY" bash "$WIZARD" || echo "::warning::byo-wizard returned non-zero (continuing with base param file)."
  else
    BOUNDARY="$BOUNDARY" bash "$WIZARD" || echo "::warning::byo-wizard returned non-zero (continuing with base param file)."
  fi
else
  echo "::warning::byo-wizard.sh not found — using the base $BOUNDARY bicepparam as-is."
fi

DEPLOY_CMD="az deployment sub create -f platform/fiab/bicep/main.bicep -p $PARAM_FILE -l $REGION --name csa-loom-$(date -u +%Y%m%d%H%M%S)"
echo
echo "Deploy command:"
echo "  $DEPLOY_CMD"
if [[ "$DO_DEPLOY" == "1" ]]; then
  echo "== launching deploy =="
  ( cd "$REPO_ROOT" && eval "$DEPLOY_CMD" )
else
  echo "(dry-run — re-run with --deploy to launch, or copy the command above)"
fi
