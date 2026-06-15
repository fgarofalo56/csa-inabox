#!/usr/bin/env bash
# =============================================================================
# scan-and-deploy.sh — CSA Loom push-button, scan-and-choose deploy (CLI)
#
# Implements the pre-deploy CLI scanner from
# docs/fiab/prp/deploy-readiness-100pct.md:
#
#   1. enumerate every subscription the signed-in identity can see
#   2. for each Loom-integrable Azure backend, find existing instances (az graph)
#   3. prompt: use-existing / provision-new / disable  — WITH a recommendation
#   4. emit a generated .bicepparam (existing* IDs OR loom<Svc>Enabled=true/false)
#   5. run `az deployment sub create`
#
# Default posture is EVERYTHING ON (opt-out). `--defaults` is non-interactive
# and provisions the full stack new.
#
# This file is owned jointly across deploy-readiness domains; THIS revision
# wires the **data-engineering** backends (Synapse / Databricks / ADF / SHIR).
# Other domains (RTI, Auth, AOAI, Governance/Purview) append their own service
# rows to SERVICES[] + the choose loop below. Keep the structure modular so the
# integrator can merge the per-domain rows without rewriting the harness.
#
# Usage:
#   scripts/csa-loom/scan-and-deploy.sh \
#       --boundary Commercial \
#       --location eastus2 \
#       --base-param platform/fiab/bicep/params/commercial.bicepparam \
#       [--defaults] [--no-deploy] [--out temp/scan.generated.bicepparam]
# =============================================================================
set -euo pipefail

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------
BOUNDARY="Commercial"
LOCATION=""
BASE_PARAM=""
OUT="temp/scan.generated.bicepparam"
DEFAULTS=0
NO_DEPLOY=0
TEMPLATE="platform/fiab/bicep/main.bicep"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --boundary)   BOUNDARY="$2"; shift 2;;
    --location)   LOCATION="$2"; shift 2;;
    --base-param) BASE_PARAM="$2"; shift 2;;
    --out)        OUT="$2"; shift 2;;
    --template)   TEMPLATE="$2"; shift 2;;
    --defaults)   DEFAULTS=1; shift;;
    --no-deploy)  NO_DEPLOY=1; shift;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

mkdir -p "$(dirname "$OUT")"

log()  { printf '\033[36m[scan]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[err ]\033[0m %s\n' "$*" >&2; }

command -v az >/dev/null || { err "az CLI not found"; exit 1; }
az account show >/dev/null 2>&1 || { err "run 'az login' first"; exit 1; }

# Resource Graph is the fast cross-sub enumerator; fall back to per-sub list.
HAVE_GRAPH=0
az graph query -q "Resources | limit 1" -o none 2>/dev/null && HAVE_GRAPH=1 || \
  warn "az graph unavailable (install: az extension add -n resource-graph) — scan disabled, defaulting to provision-new"

# ----------------------------------------------------------------------------
# Service table — data-engineering domain rows.
#   name | armType | flagVar | existingNameVar | existingRgVar | existingSubVar
# flagVar is the loom<Svc>Enabled main.bicep param toggled for provision-new.
# ----------------------------------------------------------------------------
SERVICES=(
  "Synapse|Microsoft.Synapse/workspaces|loomSynapseEnabled|existingSynapseWorkspace|existingSynapseRg|existingSynapseSub"
  "Databricks|Microsoft.Databricks/workspaces|loomDatabricksEnabled|existingDatabricksWorkspace|existingDatabricksRg|existingDatabricksSub"
  "DataFactory|Microsoft.DataFactory/factories|loomDataFactoryEnabled|existingAdfFactory|existingAdfRg|existingAdfSub"
  # SHIR has no standalone resource to reuse (it is a VMSS the DLZ ADF registers);
  # it only has on/off, gated on DataFactory. No scan row — handled in the loop.
)

# ----------------------------------------------------------------------------
# scan <armType> -> prints "name<TAB>rg<TAB>sub" lines for healthy instances
# ----------------------------------------------------------------------------
scan_existing() {
  local armType="$1"
  [[ $HAVE_GRAPH -eq 1 ]] || return 0
  az graph query -q "Resources | where type =~ '${armType}' | project name, resourceGroup, subscriptionId, location | order by name asc" \
    --first 200 -o tsv --query "data[].[name,resourceGroup,subscriptionId]" 2>/dev/null || true
}

# Generated param accumulator
GEN_LINES=()
add_param() { GEN_LINES+=("param $1 = $2"); }

# ----------------------------------------------------------------------------
# Per-service choose loop
# ----------------------------------------------------------------------------
log "Boundary=$BOUNDARY  Location=${LOCATION:-<from base param>}  Defaults=$DEFAULTS"
log "Scanning subscriptions for reusable data-engineering backends..."

for row in "${SERVICES[@]}"; do
  IFS='|' read -r NAME ARMTYPE FLAGVAR EXNAME EXRG EXSUB <<<"$row"

  mapfile -t FOUND < <(scan_existing "$ARMTYPE")
  COUNT=${#FOUND[@]}

  # Recommendation: reuse a healthy instance in the target region if present,
  # else provision-new. (Disable is never recommended by default — opt-out posture.)
  REC="new"
  REC_IDX=-1
  if [[ $COUNT -gt 0 ]]; then
    REC="existing"; REC_IDX=0
  fi

  if [[ $DEFAULTS -eq 1 ]]; then
    # Non-interactive: everything new (full stack), honor the opt-out default.
    add_param "$FLAGVAR" "true"
    log "$NAME: provision-new (default)"
    continue
  fi

  echo "" >&2
  log "=== $NAME ($ARMTYPE) ==="
  if [[ $COUNT -gt 0 ]]; then
    log "Found $COUNT existing instance(s):"
    local_i=0
    for f in "${FOUND[@]}"; do
      IFS=$'\t' read -r fn frg fsub <<<"$f"
      printf '   [%d] %s  (rg=%s sub=%s)\n' "$local_i" "$fn" "$frg" "$fsub" >&2
      local_i=$((local_i+1))
    done
  else
    log "No existing $NAME found in the visible subscriptions."
  fi
  log "Recommendation: $REC"
  printf '   Choose for %s — (e)xisting / (n)ew / (d)isable [%s]: ' "$NAME" "$REC" >&2
  read -r CH || CH=""
  CH="${CH:-${REC:0:1}}"

  case "$CH" in
    e|existing)
      if [[ $COUNT -eq 0 ]]; then
        warn "$NAME: no existing instance to reuse — falling back to provision-new"
        add_param "$FLAGVAR" "true"
      else
        printf '   Which index? [%d]: ' "$REC_IDX" >&2
        read -r IDX || IDX=""
        IDX="${IDX:-$REC_IDX}"
        IFS=$'\t' read -r fn frg fsub <<<"${FOUND[$IDX]}"
        add_param "$EXNAME" "'$fn'"
        add_param "$EXRG"   "'$frg'"
        add_param "$EXSUB"  "'$fsub'"
        # Reusing an existing backend → do NOT provision a new one.
        add_param "$FLAGVAR" "false"
        log "$NAME: reuse $fn"
      fi
      ;;
    d|disable)
      add_param "$FLAGVAR" "false"
      log "$NAME: DISABLED (editor will honest-gate)"
      ;;
    *)
      add_param "$FLAGVAR" "true"
      log "$NAME: provision-new"
      ;;
  esac
done

# SHIR follows the Data Factory decision (scale-to-0 VMSS on the DLZ ADF).
if [[ $DEFAULTS -eq 1 ]]; then
  add_param "loomSelfHostedIrEnabled" "true"
else
  printf '\n   Self-hosted IR (scale-to-0 VMSS on the DLZ ADF) — (n)ew / (d)isable [new]: ' >&2
  read -r SH || SH=""
  case "${SH:-n}" in
    d|disable) add_param "loomSelfHostedIrEnabled" "false"; log "SHIR: DISABLED";;
    *)         add_param "loomSelfHostedIrEnabled" "true";  log "SHIR: provision-new";;
  esac
fi

# ----------------------------------------------------------------------------
# Emit the generated .bicepparam (base param + the scan-chosen overrides)
# ----------------------------------------------------------------------------
{
  if [[ -n "$BASE_PARAM" && -f "$BASE_PARAM" ]]; then
    echo "// Generated by scan-and-deploy.sh from $BASE_PARAM on $(date -u +%FT%TZ)"
    echo "using '$(realpath --relative-to="$(dirname "$OUT")" "$TEMPLATE" 2>/dev/null || echo "$TEMPLATE")'"
    echo ""
    echo "// ---- base param values (inlined) ----"
    # Strip the base file's `using` line; keep its param assignments.
    grep -vE '^\s*using\b' "$BASE_PARAM" || true
  else
    echo "// Generated by scan-and-deploy.sh on $(date -u +%FT%TZ) (no base param)"
    echo "using '$TEMPLATE'"
  fi
  echo ""
  echo "// ---- scan-and-choose overrides (data-engineering backends) ----"
  for l in "${GEN_LINES[@]}"; do echo "$l"; done
} > "$OUT"

log "Wrote generated param file: $OUT"
log "Overrides:"; for l in "${GEN_LINES[@]}"; do printf '   %s\n' "$l" >&2; done

# ----------------------------------------------------------------------------
# Deploy
# ----------------------------------------------------------------------------
if [[ $NO_DEPLOY -eq 1 ]]; then
  log "--no-deploy set; skipping az deployment. Review $OUT then run:"
  log "  az deployment sub create --location ${LOCATION:-<region>} --template-file $TEMPLATE --parameters $OUT"
  exit 0
fi

[[ -n "$LOCATION" ]] || { err "--location required to deploy (or pass --no-deploy)"; exit 1; }
log "Validating template (what-if)..."
az deployment sub what-if \
  --location "$LOCATION" \
  --template-file "$TEMPLATE" \
  --parameters "$OUT" || warn "what-if reported differences (expected on a fresh sub)"

if [[ $DEFAULTS -eq 0 ]]; then
  printf '\n   Proceed with az deployment sub create? [y/N]: ' >&2
  read -r GO || GO=""
  [[ "$GO" =~ ^[Yy]$ ]] || { log "Aborted by user."; exit 0; }
fi

log "Deploying..."
az deployment sub create \
  --location "$LOCATION" \
  --name "csa-loom-scan-$(date -u +%Y%m%d%H%M%S)" \
  --template-file "$TEMPLATE" \
  --parameters "$OUT"

log "Deploy submitted. Post-deploy: run the bootstrap workflow"
log "  (.github/workflows/csa-loom-post-deploy-bootstrap.yml) to apply the"
log "  Synapse Administrator grant, Databricks SCIM/UC, and patch-navigator-env."
