#!/usr/bin/env bash
# CSA Loom — scan-and-choose pre-deploy driver (PRP: day-one deploy readiness).
#
# WHAT THIS DOES
#   For every Azure backend Loom can wire into, this script (1) SCANS every
#   subscription the signed-in principal can see for an existing instance, then
#   (2) lets you choose, per service: USE an existing one, PROVISION a new one,
#   or DISABLE it — each with a RECOMMENDATION. The choices are written to a
#   generated `.bicepparam` fragment (existing IDs as `existing*` params, or the
#   `loom<Svc>Enabled=true` provision flag), which is then fed to
#   `az deployment sub create`. Default posture is EVERYTHING ON (opt-out).
#
#   This is the CLI half of the PRP "scan-and-choose" deliverable; the Setup
#   Wizard (/setup + /api/setup/*) is the in-console interactive half (parity).
#
# MODULARITY
#   Each domain contributes ONE `choose_<service>` function that appends its
#   chosen lines to $PARAM_FRAGMENT via `emit`. This file currently implements
#   the Console-metadata Cosmos choice end-to-end; sibling deploy-readiness
#   domains add their own choose_* functions and a call in run_all_choices.
#
# USAGE
#   bash scripts/csa-loom/scan-and-deploy.sh                 # interactive
#   bash scripts/csa-loom/scan-and-deploy.sh --defaults      # all-new, non-interactive
#   bash scripts/csa-loom/scan-and-deploy.sh --boundary tenant-dmlz --location centralus
#   bash scripts/csa-loom/scan-and-deploy.sh --defaults --deploy   # also run the deployment
#
# Read-only until the optional `--deploy`: scanning never creates or modifies
# anything. Without `--deploy` it prints the generated bicepparam + the exact
# `az deployment sub create` command for you to review and run.
set -uo pipefail

# --------------------------------------------------------------------------
# Args
# --------------------------------------------------------------------------
DEFAULTS=0
DO_DEPLOY=0
BOUNDARY=""
LOCATION="${LOCATION:-centralus}"
BICEP_MAIN="platform/fiab/bicep/main.bicep"
OUT_DIR="${OUT_DIR:-temp}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --defaults)  DEFAULTS=1; shift ;;
    --deploy)    DO_DEPLOY=1; shift ;;
    --boundary)  BOUNDARY="${2:-}"; shift 2 ;;
    --location)  LOCATION="${2:-}"; shift 2 ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//' | head -40
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"
PARAM_FRAGMENT="$OUT_DIR/loom-scan-choices.bicepparam"
: > "$PARAM_FRAGMENT"

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
q() { az "$@" 2>/dev/null || true; }

emit() { printf '%s\n' "$1" >> "$PARAM_FRAGMENT"; }

note() { printf '\n\033[1;36m%s\033[0m\n' "$*" >&2; }
info() { printf '  %s\n' "$*" >&2; }

# prompt_choice "<service label>" "<recommendation: existing|new|disable>" "<found names, newline-sep>"
# echoes one of: existing|new|disable  (honors --defaults → always "new")
prompt_choice() {
  local label="$1" rec="$2" found="$3"
  if [[ "$DEFAULTS" == "1" ]]; then echo "new"; return; fi
  note "── $label ──"
  if [[ -n "$found" ]]; then
    info "Existing instances found:"; while IFS= read -r f; do [[ -n "$f" ]] && info "    • $f"; done <<< "$found"
  else
    info "No existing instance found in any visible subscription."
  fi
  info "Recommendation: $rec"
  local ans
  while true; do
    printf '  Use [e]xisting / provision [n]ew / [d]isable? (default=%s): ' "$rec" >&2
    read -r ans </dev/tty || ans=""
    ans="${ans:-$rec}"
    case "$ans" in
      e|existing) echo "existing"; return ;;
      n|new)      echo "new"; return ;;
      d|disable)  echo "disable"; return ;;
      *) info "Please answer e, n, or d." ;;
    esac
  done
}

# Cross-sub scan for an ARM type → newline-separated "name\trg\tsub" rows.
scan_type() {
  local type="$1"
  if az graph query -q "Resources | limit 1" -o none 2>/dev/null; then
    q graph query -q "Resources | where type =~ '$type' | project name, resourceGroup, subscriptionId" \
      --first 50 --query "data[].[name,resourceGroup,subscriptionId]" -o tsv
  else
    local s
    for s in $(az account list --query "[].id" -o tsv 2>/dev/null); do
      q resource list --subscription "$s" --resource-type "$type" \
        --query "[].[name,resourceGroup]" -o tsv | sed "s/\$/\t$s/"
    done
  fi
}

# --------------------------------------------------------------------------
# Domain: Console metadata Cosmos (serverless)
#   The Console's own `loom` database (items, workspaces, configs, copilot
#   sessions, tenant-topology). In tenant/dlz-attach topologies the hub module
#   provisions it; single-sub hosts it in the DLZ. Provision-new is SERVERLESS
#   (no 25-container cap). Disable is only honest when reusing an existing
#   account (the Console cannot run without a metadata store).
# --------------------------------------------------------------------------
choose_console_cosmos() {
  local rows found first_name first_rg first_sub choice
  rows="$(scan_type 'Microsoft.DocumentDB/databaseAccounts')"
  found="$(printf '%s\n' "$rows" | awk -F'\t' 'NF{printf "%s  (rg=%s sub=%s)\n",$1,$2,$3}')"

  choice="$(prompt_choice "Console metadata Cosmos (serverless)" "new" "$found")"

  case "$choice" in
    new)
      emit "// Console metadata Cosmos — provision NEW serverless account (no 25-container cap)."
      emit "param loomConsoleCosmosEnabled = true"
      info "→ provision-new serverless Console Cosmos"
      ;;
    existing)
      # Pick the first discovered account by default; honor explicit env override.
      first_name="${EXISTING_COSMOS_ACCOUNT:-$(printf '%s\n' "$rows" | awk -F'\t' 'NF{print $1; exit}')}"
      first_rg="${EXISTING_COSMOS_ACCOUNT_RG:-$(printf '%s\n' "$rows" | awk -F'\t' 'NF{print $2; exit}')}"
      first_sub="${EXISTING_COSMOS_ACCOUNT_SUB:-$(printf '%s\n' "$rows" | awk -F'\t' 'NF{print $3; exit}')}"
      if [[ -z "$first_name" ]]; then
        info "No existing Cosmos to reuse — falling back to provision-new serverless."
        emit "param loomConsoleCosmosEnabled = true"
        return
      fi
      emit "// Console metadata Cosmos — REUSE existing account (auto-skips the hub provision)."
      emit "param existingCosmosAccount = '$first_name'"
      emit "param existingCosmosRg      = '$first_rg'"
      emit "param existingCosmosSub     = '$first_sub'"
      info "→ reuse existing Cosmos: $first_name (rg=$first_rg sub=$first_sub)"
      ;;
    disable)
      # Disable is ONLY honest alongside a reusable existing account, else the
      # Console env still points at LOOM_COSMOS_ENDPOINT with nothing behind it.
      first_name="${EXISTING_COSMOS_ACCOUNT:-$(printf '%s\n' "$rows" | awk -F'\t' 'NF{print $1; exit}')}"
      if [[ -z "$first_name" ]]; then
        info "Cannot disable: the Console requires a metadata store and no existing"
        info "Cosmos was found to reuse. Defaulting to provision-new serverless."
        emit "param loomConsoleCosmosEnabled = true"
      else
        first_rg="${EXISTING_COSMOS_ACCOUNT_RG:-$(printf '%s\n' "$rows" | awk -F'\t' 'NF{print $2; exit}')}"
        first_sub="${EXISTING_COSMOS_ACCOUNT_SUB:-$(printf '%s\n' "$rows" | awk -F'\t' 'NF{print $3; exit}')}"
        emit "// Console metadata Cosmos — DISABLED hub provision; reusing existing account."
        emit "param loomConsoleCosmosEnabled = false"
        emit "param existingCosmosAccount = '$first_name'"
        emit "param existingCosmosRg      = '$first_rg'"
        emit "param existingCosmosSub     = '$first_sub'"
        info "→ disable hub provision, reuse existing Cosmos: $first_name"
      fi
      ;;
  esac
}

# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------
run_all_choices() {
  choose_console_cosmos
  # Sibling deploy-readiness domains append their choose_<service> calls here.
}

main() {
  command -v az >/dev/null || { echo "az CLI not found." >&2; exit 1; }
  az account show -o none 2>/dev/null || { echo "Run 'az login' first." >&2; exit 1; }

  note "CSA Loom scan-and-choose — scanning subscriptions (read-only)…"
  run_all_choices

  note "Generated choices → $PARAM_FRAGMENT"
  cat "$PARAM_FRAGMENT" >&2

  local deploy_cmd="az deployment sub create --location $LOCATION --template-file $BICEP_MAIN"
  [[ -n "$BOUNDARY" ]] && deploy_cmd+=" --parameters platform/fiab/bicep/params/$BOUNDARY.bicepparam"
  deploy_cmd+=" --parameters @$PARAM_FRAGMENT"

  note "Deploy command:"
  echo "  $deploy_cmd" >&2

  if [[ "$DO_DEPLOY" == "1" ]]; then
    note "Running deployment…"
    eval "$deploy_cmd"
  else
    note "Review above, then re-run with --deploy (or run the command yourself)."
  fi
}

main
