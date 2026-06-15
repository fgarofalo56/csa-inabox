#!/usr/bin/env bash
# CSA Loom — scan-and-deploy (PRP Deliverable B: docs/fiab/prp/deploy-readiness-100pct.md).
#
# The single push-button, scan-first CLI bootstrap. It:
#   1. SCANS every subscription the signed-in principal can see for the Azure
#      services Loom can reuse (reuse-first, read-only).
#   2. ASKS per service — use-EXISTING / provision-NEW / DISABLE — WITH A
#      RECOMMENDATION (default posture: everything ON / new — opt-out).
#   3. EMITS the boundary .bicepparam with your picks (existing* IDs for reuse,
#      loom<Svc>Enabled / *Enabled flags for new), plus the EXISTING_* env file.
#   4. DEPLOYS via `az deployment sub create` (or `--what-if` to preview), then
#      points you at the post-deploy RBAC/env reconcile scripts.
#
# Steps 1-3 are delegated to scripts/csa-loom/byo-wizard.sh (the canonical
# scan + choose + emit engine, covering ALL reusable services). This wrapper
# adds the domain RECOMMENDATIONS banner + the actual `az deployment` step +
# a non-interactive `--defaults` (everything-new/on) path for CI / headless.
#
# DEFAULT POSTURE = everything ON (opt-out), per the PRP. The four services in
# the APIM / Azure Maps / Key Vault / Firewall domain:
#   • APIM         — recommend NEW (ON by default). ~30 min Premium provisioning.
#   • Azure Maps   — recommend NEW on Commercial/GCC (honest-gated on GCC-High/IL5).
#   • Key Vault    — FOUNDATIONAL: always NEW (no reuse / no disable offered).
#   • Hub Firewall — recommend ON (loomFirewallEnabled=true); on/off only.
#
# USAGE
#   bash scripts/csa-loom/scan-and-deploy.sh --boundary commercial -l eastus
#   bash scripts/csa-loom/scan-and-deploy.sh --boundary gcc -l usgovvirginia --what-if
#   # non-interactive 1-button (everything new/on):
#   bash scripts/csa-loom/scan-and-deploy.sh --boundary commercial -l eastus --defaults --yes
#
# REQUIRES: az CLI logged in (`az login`). Scanning is read-only; only the final
#           deploy step creates resources (and only after confirmation / --yes).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BICEP_DIR="$REPO_ROOT/platform/fiab/bicep"
PARAMS_DIR="$BICEP_DIR/params"
TEMPLATE_MAIN="$BICEP_DIR/main.bicep"

BOUNDARY="commercial"
REGION=""
OUT_NAME=""
DEFAULTS=0
WHATIF=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary)       BOUNDARY="$2"; shift 2 ;;
    -l|--location|--region) REGION="$2"; shift 2 ;;
    --out)            OUT_NAME="$2"; shift 2 ;;
    --defaults)       DEFAULTS=1; shift ;;
    --what-if|--whatif) WHATIF=1; shift ;;
    -y|--yes)         ASSUME_YES=1; shift ;;
    -h|--help)        sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

TEMPLATE="$PARAMS_DIR/$BOUNDARY.bicepparam"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: boundary template not found: $TEMPLATE" >&2; \
  echo "Available: $(ls "$PARAMS_DIR"/*.bicepparam 2>/dev/null | xargs -n1 basename | sed 's/\.bicepparam//' | tr '\n' ' ')" >&2; exit 1; }

[[ -z "$OUT_NAME" ]] && OUT_NAME="$BOUNDARY.generated"
OUT_PARAM="$PARAMS_DIR/$OUT_NAME.bicepparam"
OUT_ENV="$REPO_ROOT/temp/$OUT_NAME.byo-exports.sh"

echo "=========================================================================="
echo " CSA Loom — scan-and-deploy   (boundary=$BOUNDARY  region=${REGION:-<unset>})"
echo "=========================================================================="
echo
echo " Day-1 posture = everything ON (opt-out). Recommendations for this domain:"
echo "   APIM         → NEW  (ON by default; ~30 min Premium provisioning)"
case "$BOUNDARY" in
  gcc-high|il5) echo "   Azure Maps   → DISABLE (unavailable in GCC-High/IL5 — honest-gated)";;
  *)            echo "   Azure Maps   → NEW  (Commercial/GCC)";;
esac
echo "   Key Vault    → NEW  (FOUNDATIONAL — always provisioned; no reuse/disable)"
echo "   Hub Firewall → ON   (loomFirewallEnabled=true; egress hardening)"
echo

# --------------------------------------------------------------------------
# 1-3. Scan + choose + emit  (delegate to byo-wizard.sh).
#       --defaults → non-interactive, force every reusable service to NEW.
# --------------------------------------------------------------------------
WIZ_ARGS=(--boundary "$BOUNDARY" --out "$OUT_NAME")
WIZ_ENV=()
if [[ "$DEFAULTS" == "1" ]]; then
  WIZ_ARGS+=(--non-interactive)
  # Force every reusable service to provision NEW (everything-on default).
  for k in AISEARCH APIM MAPS ADX FOUNDRY PURVIEW SYNAPSE COSMOS ADF EVENTHUBS DATABRICKS; do
    WIZ_ENV+=("BYO_${k}=new")
  done
fi

echo "── Scanning subscriptions + choosing existing/new/disable per service ──"
if ! env "${WIZ_ENV[@]}" bash "$SCRIPT_DIR/byo-wizard.sh" "${WIZ_ARGS[@]}"; then
  echo "ERROR: byo-wizard.sh (scan/choose/emit) failed." >&2
  exit 1
fi
[[ -f "$OUT_PARAM" ]] || { echo "ERROR: expected generated param not written: $OUT_PARAM" >&2; exit 1; }
echo

# --------------------------------------------------------------------------
# 4. Deploy (or --what-if preview).
# --------------------------------------------------------------------------
if [[ -z "$REGION" ]]; then
  echo "No --region/-l given — stopping after emit. To deploy:"
  echo "  az deployment sub create -f $TEMPLATE_MAIN -p $OUT_PARAM -l <region>"
  echo "Then reconcile RBAC/env on any REUSED resources:"
  echo "  source $OUT_ENV && bash $SCRIPT_DIR/grant-navigator-rbac.sh"
  exit 0
fi

DEPLOY_NAME="csa-loom-$BOUNDARY-$(date -u +%Y%m%d%H%M%S)"
DEPLOY_ARGS=(deployment sub create
  --name "$DEPLOY_NAME"
  --location "$REGION"
  --template-file "$TEMPLATE_MAIN"
  --parameters "$OUT_PARAM")
[[ "$WHATIF" == "1" ]] && DEPLOY_ARGS+=(--what-if)

echo "── $([[ "$WHATIF" == "1" ]] && echo 'what-if preview' || echo 'Deploy') ──"
echo "  az ${DEPLOY_ARGS[*]}"
if [[ "$WHATIF" != "1" && "$ASSUME_YES" != "1" ]]; then
  read -r -p "Proceed with deployment to region '$REGION'? [y/N]: " ans </dev/tty || ans="N"
  [[ "$ans" =~ ^[yY] ]] || { echo "Aborted (emit-only). Param: $OUT_PARAM"; exit 0; }
fi

if ! az "${DEPLOY_ARGS[@]}"; then
  echo "ERROR: az deployment failed. The generated param is at: $OUT_PARAM" >&2
  exit 1
fi

if [[ "$WHATIF" != "1" ]]; then
  echo
  echo "Deploy submitted ($DEPLOY_NAME). Reconcile RBAC/env on any REUSED resources:"
  echo "  source $OUT_ENV && bash $SCRIPT_DIR/grant-navigator-rbac.sh"
  echo "  source $OUT_ENV && bash $SCRIPT_DIR/patch-navigator-env.sh   # already-running console"
fi
