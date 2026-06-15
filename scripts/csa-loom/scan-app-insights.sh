#!/usr/bin/env bash
# CSA Loom — App Insights / console-runtime telemetry scan-and-choose module.
#
# Deploy-readiness domain: "Console runtime (probes, resources, telemetry)".
#
# WHAT IT DOES
#   Enumerates EXISTING Application Insights components across every subscription
#   the signed-in principal can see (reuse-first), prints a recommendation, and
#   asks: use-existing / provision-new / disable. The choice is emitted as a
#   sourceable export block that the central scripts/csa-loom/scan-and-deploy.sh
#   folds into the generated .bicepparam (or as advisory output when run alone).
#
#   Telemetry is ON by default (opt-out) — a fresh deploy ALWAYS provisions a
#   workspace-based App Insights + Log Analytics via monitoring.bicep and wires
#   the console with the crash-hardened OTel SDK (live metrics off; see
#   apps/fiab-console/lib/telemetry/app-insights.ts and the #1382 fix). "disable"
#   only dark-wires the console OTel SDK (LOOM_CONSOLE_TELEMETRY_ENABLED='');
#   the workspace/account still exist so /monitor KQL + the Copilot-usage panel
#   (which read the workspace, not the SDK) keep working.
#
# USAGE
#   bash scripts/csa-loom/scan-app-insights.sh                 # interactive, all visible subs
#   bash scripts/csa-loom/scan-app-insights.sh --defaults      # non-interactive: provision-new + telemetry on
#   SUBS="<sub1> <sub2>" bash scripts/csa-loom/scan-app-insights.sh
#   source <(bash scripts/csa-loom/scan-app-insights.sh --emit) # export the chosen vars into the caller
#
# EMITTED EXPORTS (consumed by scan-and-deploy.sh → .bicepparam)
#   LOOM_CONSOLE_TELEMETRY_ENABLED   true|false   (opt-out posture)
#   EXISTING_APP_INSIGHTS_ID         <ARM id>     (set only when "use-existing")
#   EXISTING_APP_INSIGHTS_NAME/_RG/_SUB           (canonical EXISTING_* trio)
set -uo pipefail

DEFAULTS=0
EMIT=0
for a in "$@"; do
  case "$a" in
    --defaults) DEFAULTS=1 ;;
    --emit)     EMIT=1 ;;
  esac
done

log() { [[ "$EMIT" == "1" ]] && return 0; echo "$@" >&2; }

SUBS="${SUBS:-$(az account list --query "[].id" -o tsv 2>/dev/null)}"
if [[ -z "$SUBS" ]]; then
  log "No subscriptions visible. Run 'az login' first."
  echo "LOOM_CONSOLE_TELEMETRY_ENABLED=true"
  exit 0
fi

log "# CSA Loom — App Insights scan ($(echo "$SUBS" | wc -w) subscription(s))"

# Resource Graph is the fastest cross-sub scanner when the extension exists.
HAVE_GRAPH=0
az graph query -q "Resources | limit 1" -o none 2>/dev/null && HAVE_GRAPH=1

# Collect existing App Insights as "name|rg|subId" lines.
EXISTING=""
if [[ "$HAVE_GRAPH" == "1" ]]; then
  EXISTING=$(az graph query -q \
    "Resources | where type =~ 'microsoft.insights/components' | project name, resourceGroup, subscriptionId" \
    --first 200 -o tsv 2>/dev/null | awk 'NF>=3{print $1"|"$2"|"$3}')
else
  for s in $SUBS; do
    az monitor app-insights component show --subscription "$s" -o tsv \
      --query "[].{n:name,rg:resourceGroup}" 2>/dev/null \
      | awk -v sub="$s" 'NF>=2{print $1"|"$2"|"sub}' >> /tmp/_ai_scan.$$  || true
  done
  [[ -f /tmp/_ai_scan.$$ ]] && { EXISTING=$(cat /tmp/_ai_scan.$$); rm -f /tmp/_ai_scan.$$; }
fi

COUNT=$(printf '%s\n' "$EXISTING" | grep -c '|' || true)
log "Found ${COUNT} existing Application Insights component(s)."
log ""
log "RECOMMENDATION: provision-new (a workspace-based App Insights co-located with"
log "the hub Log Analytics workspace) so telemetry, /monitor KQL, and the"
log "Copilot-usage panel work on first login. Reuse an existing component only if"
log "you already centralize all app telemetry there."

choose() {
  # Non-interactive default = provision-new + telemetry on.
  if [[ "$DEFAULTS" == "1" || ! -t 0 ]]; then echo "new"; return; fi
  log ""
  log "Console-runtime telemetry (App Insights):"
  log "  [n] provision-new   (recommended — telemetry ON by default)"
  log "  [e] use-existing    (reuse a component listed above)"
  log "  [d] disable         (dark-wire the console OTel SDK; account still provisioned)"
  printf 'Choice [n/e/d] (default n): ' >&2
  read -r ans
  case "${ans:-n}" in e|E) echo "existing" ;; d|D) echo "disable" ;; *) echo "new" ;; esac
}

DECISION=$(choose)

case "$DECISION" in
  disable)
    echo "LOOM_CONSOLE_TELEMETRY_ENABLED=false"
    log "→ telemetry disabled (opt-out). monitoring.bicep still provisions the account."
    ;;
  existing)
    # Let the operator pick one of the discovered components.
    idx=1
    printf '%s\n' "$EXISTING" | while IFS='|' read -r n rg sub; do [[ -n "$n" ]] && log "  $idx) $n  (rg=$rg sub=$sub)"; idx=$((idx+1)); done
    printf 'Pick number (or blank for new): ' >&2; read -r pick
    line=$(printf '%s\n' "$EXISTING" | sed -n "${pick:-0}p")
    if [[ -n "$line" ]]; then
      n=${line%%|*}; rest=${line#*|}; rg=${rest%%|*}; sub=${rest##*|}
      id="/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Insights/components/$n"
      echo "LOOM_CONSOLE_TELEMETRY_ENABLED=true"
      echo "EXISTING_APP_INSIGHTS_ID=$id"
      echo "EXISTING_APP_INSIGHTS_NAME=$n"
      echo "EXISTING_APP_INSIGHTS_RG=$rg"
      echo "EXISTING_APP_INSIGHTS_SUB=$sub"
      log "→ reuse $n"
    else
      echo "LOOM_CONSOLE_TELEMETRY_ENABLED=true"
      log "→ no valid pick; falling back to provision-new."
    fi
    ;;
  *)
    echo "LOOM_CONSOLE_TELEMETRY_ENABLED=true"
    log "→ provision-new (default). monitoring.bicep deploys a workspace-based App Insights."
    ;;
esac
