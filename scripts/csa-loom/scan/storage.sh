#!/usr/bin/env bash
# CSA Loom deploy-readiness — Storage / OneLake catalog / org-visuals scanner.
#
# Part of the push-button "scan every subscription, then ask use-existing /
# provision-new / disable (with a recommendation)" flow (PRP
# docs/fiab/prp/deploy-readiness-100pct.md, deliverable B).
#
# This module is BOTH:
#   1. Sourceable — `source scan/storage.sh` then call `scan_storage` from the
#      top-level scripts/csa-loom/scan-and-deploy.sh orchestrator. It appends the
#      chosen `.bicepparam` lines to $LOOM_PARAM_OUT and exports the env overrides
#      the post-deploy bootstrap / patch-navigator-env.sh consume.
#   2. Standalone — run it directly to scan + choose just the storage domain.
#
# DOMAIN BACKENDS (Azure-native default, no Fabric/Power BI dependency):
#   ADLS Gen2 (HNS) medallion lakehouse + the org-visuals container backing
#   Embed codes (F22) + Organizational visuals (F23). The medallion account is
#   foundational (always provisioned by landing-zone/storage.bicep); the
#   org-visuals grant + LOOM_ORG_VISUALS_URL env is the opt-out
#   (loomOrgVisualsEnabled, default true).
#
# CHOICES: use-existing | provision-new | disable.
#   RECOMMENDATION = provision-new — Loom needs the exact container layout
#   (bronze/silver/gold/landing/checkpoints/csv-imports/org-visuals) + HNS; an
#   arbitrary existing account rarely matches, so a fresh account is safest.
#
# REQUIRES: az CLI logged in; the Resource Graph extension (auto-installed by az
#           on first `az graph query`).
set -uo pipefail

# Emit the chosen .bicepparam fragment to this file (the orchestrator sets it);
# default to stdout when run standalone.
LOOM_PARAM_OUT="${LOOM_PARAM_OUT:-/dev/stdout}"
# Non-interactive: everything NEW (provision the full stack). Set by --defaults.
LOOM_SCAN_DEFAULTS="${LOOM_SCAN_DEFAULTS:-0}"

_st_recommend() { printf '  >> recommendation: %s\n' "$1" >&2; }

# scan_storage [subscriptionId ...]
# Scans the given subs (or the current sub) for HNS-enabled ADLS Gen2 accounts,
# prompts the operator, and writes the resulting bicepparam fragment.
scan_storage() {
  local subs=("$@")
  [ ${#subs[@]} -eq 0 ] && subs=("$(az account show --query id -o tsv 2>/dev/null)")

  echo "== Storage / OneLake / org-visuals scan ==" >&2
  echo "   Scanning ${#subs[@]} subscription(s) for HNS-enabled ADLS Gen2 accounts..." >&2

  # Resource Graph: every Data Lake (HNS) account across the selected subs.
  local sub_csv
  sub_csv=$(printf "'%s'," "${subs[@]}"); sub_csv="${sub_csv%,}"
  local found
  found=$(az graph query -q "resources
    | where type =~ 'microsoft.storage/storageaccounts'
    | where properties.isHnsEnabled == true
    | project name, rg=resourceGroup, sub=subscriptionId, loc=location
    | order by name asc" \
    --subscriptions "${subs[@]}" \
    --query "data[].{name:name, rg:rg, sub:sub, loc:loc}" -o json 2>/dev/null || echo '[]')

  local count
  count=$(echo "$found" | az_jq 'length' 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ] 2>/dev/null; then
    echo "   Found $count existing Data Lake (HNS) account(s):" >&2
    echo "$found" | az_jq -r '.[] | "     - \(.name)  (rg=\(.rg), \(.loc))"' >&2
  else
    echo "   No existing Data Lake (HNS) accounts found." >&2
  fi

  _st_recommend "provision-new (Loom needs the exact medallion + org-visuals container layout on a fresh HNS account)"

  local choice
  if [ "$LOOM_SCAN_DEFAULTS" = "1" ]; then
    choice="new"
    echo "   --defaults → provision-new" >&2
  else
    echo "   Choose for Storage / org-visuals:" >&2
    echo "     [n] provision-new (recommended)   [e] use-existing   [d] disable org-visuals" >&2
    read -r -p "   > " choice </dev/tty || choice="n"
    case "$choice" in
      e|E|existing) choice="existing" ;;
      d|D|disable)  choice="disable" ;;
      *)            choice="new" ;;
    esac
  fi

  {
    echo "// ---- Storage / OneLake / org-visuals (deploy-readiness scan) ----"
    case "$choice" in
      new)
        echo "// provision-new: landing-zone/storage.bicep creates the HNS account +"
        echo "// medallion + org-visuals container; org-visuals grant + env ON (opt-out)."
        echo "param loomOrgVisualsEnabled = true"
        ;;
      existing)
        local pick_name pick_rg
        if [ "$count" -gt 0 ] 2>/dev/null; then
          # Prefer a Loom-named account, else the first.
          pick_name=$(echo "$found" | az_jq -r '[.[] | select(.name|startswith("saloom"))][0].name // .[0].name')
          pick_rg=$(echo "$found"   | az_jq -r "[.[] | select(.name==\"$pick_name\")][0].rg")
          echo "// use-existing: $pick_name (rg=$pick_rg). The post-deploy bootstrap +"
          echo "// scripts/csa-loom/patch-navigator-env.sh wire LOOM_ORG_VISUALS_URL +"
          echo "// medallion URLs from this account (EXISTING_LOOM_STORAGE_ACCOUNT)."
          echo "param loomOrgVisualsEnabled = true"
          # Env overrides for the bootstrap / patch-navigator-env.sh reuse path.
          export EXISTING_LOOM_STORAGE_ACCOUNT="$pick_name"
          export EXISTING_LOOM_STORAGE_RG="$pick_rg"
          echo "// EXISTING_LOOM_STORAGE_ACCOUNT=$pick_name (exported for bootstrap)"
        else
          echo "// use-existing requested but none found — falling back to provision-new."
          echo "param loomOrgVisualsEnabled = true"
        fi
        ;;
      disable)
        echo "// disable: medallion lake still provisioned (foundational), but the"
        echo "// org-visuals grant + LOOM_ORG_VISUALS_URL are skipped (Embed codes +"
        echo "// Org visuals honest-gate). Set the LOOM_ORG_VISUALS_DISABLED=1 repo var"
        echo "// so the post-deploy bootstrap also skips the wiring step."
        echo "param loomOrgVisualsEnabled = false"
        export LOOM_ORG_VISUALS_DISABLED=1
        ;;
    esac
  } >>"$LOOM_PARAM_OUT"

  echo "   Storage choice: $choice (written to $LOOM_PARAM_OUT)" >&2
}

# jq shim — use jq if present, else `az` cannot help; require jq for parsing.
az_jq() { jq "$@"; }

# Standalone entrypoint.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required for the storage scanner." >&2; exit 1
  fi
  scan_storage "$@"
fi
