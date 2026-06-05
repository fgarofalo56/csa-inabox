#!/usr/bin/env bash
# enable-all-diagnostics.sh
#
# Makes "all logs ON by default → the Loom Log Analytics workspace" true for the
# WHOLE live estate, not just the resources bicep wires at deploy time. Walks
# every resource in the Loom resource groups and, for any that lacks a
# diagnostic setting routing to the Loom LAW, creates the standardized
# `diag-loom-stdz` setting (categoryGroup=allLogs + AllMetrics). Idempotent:
# resources that already route to the LAW are skipped; types that don't support
# diagnostic settings are skipped silently.
#
# This is the deploy-time/bootstrap twin of the console's Monitor → Diagnostics
# tab (app/api/monitor/diagnostics). Both write the SAME setting name so there's
# one source of truth and DSC drift detection stays simple.
#
# Usage:
#   ./enable-all-diagnostics.sh --resource-groups "rg-a rg-b" [--law-name law-csa-loom-eastus2]
#   (LAW auto-discovered in the first RG if --law-name / --law-id omitted.)
#
# Pre-reqs: az CLI logged in with Monitoring Contributor (or Contributor) on the
# target RGs; the Log Analytics workspace already deployed.
set -uo pipefail

RGS="" LAW_NAME="" LAW_ID="" SETTING="diag-loom-stdz"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-groups) RGS="$2"; shift 2 ;;
    --law-name)        LAW_NAME="$2"; shift 2 ;;
    --law-id)          LAW_ID="$2"; shift 2 ;;
    --setting-name)    SETTING="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$RGS" ]] && { echo "ERROR: --resource-groups required" >&2; exit 1; }

# Resolve the Loom LAW resource id.
if [[ -z "$LAW_ID" ]]; then
  for rg in $RGS; do
    if [[ -n "$LAW_NAME" ]]; then
      LAW_ID=$(az monitor log-analytics workspace show -g "$rg" -n "$LAW_NAME" --query id -o tsv 2>/dev/null) || true
    else
      LAW_ID=$(az monitor log-analytics workspace list -g "$rg" --query "[0].id" -o tsv 2>/dev/null) || true
    fi
    [[ -n "$LAW_ID" ]] && break
  done
fi
[[ -z "$LAW_ID" ]] && { echo "ERROR: could not resolve the Loom Log Analytics workspace id (pass --law-id)" >&2; exit 1; }
echo ">>> Loom LAW: $LAW_ID"

LOGS_JSON='[{"categoryGroup":"allLogs","enabled":true}]'
METRICS_JSON='[{"category":"AllMetrics","enabled":true}]'

enabled=0 skipped=0 unsupported=0 failed=0

for rg in $RGS; do
  echo ">>> Scanning resource group: $rg"
  # id<TAB>type per resource
  while IFS=$'\t' read -r rid rtype; do
    [[ -z "$rid" ]] && continue
    # Already routing to the Loom LAW?
    existing=$(az monitor diagnostic-settings list --resource "$rid" \
                 --query "value[?workspaceId=='$LAW_ID'] | length(@)" -o tsv 2>/dev/null) || existing=""
    if [[ "$existing" =~ ^[1-9] ]]; then
      skipped=$((skipped+1)); continue
    fi

    # Try all-logs + all-metrics; fall back to metrics-only then logs-only for
    # resources that only support one half. Suppress noisy errors.
    if az monitor diagnostic-settings create --name "$SETTING" --resource "$rid" \
         --workspace "$LAW_ID" --logs "$LOGS_JSON" --metrics "$METRICS_JSON" >/dev/null 2>&1; then
      echo "    [on ] $rtype  ${rid##*/}"
      enabled=$((enabled+1))
    elif az monitor diagnostic-settings create --name "$SETTING" --resource "$rid" \
           --workspace "$LAW_ID" --metrics "$METRICS_JSON" >/dev/null 2>&1; then
      echo "    [on ] $rtype  ${rid##*/}  (metrics-only)"
      enabled=$((enabled+1))
    elif az monitor diagnostic-settings create --name "$SETTING" --resource "$rid" \
           --workspace "$LAW_ID" --logs "$LOGS_JSON" >/dev/null 2>&1; then
      echo "    [on ] $rtype  ${rid##*/}  (logs-only)"
      enabled=$((enabled+1))
    else
      # Most failures here are "resource type does not support diagnostic
      # settings" — expected and harmless.
      unsupported=$((unsupported+1))
    fi
  done < <(az resource list -g "$rg" --query "[].[id,type]" -o tsv 2>/dev/null)
done

echo ""
echo "✓ Diagnostics sweep complete: ${enabled} enabled, ${skipped} already-on, ${unsupported} unsupported/skipped."
exit 0
