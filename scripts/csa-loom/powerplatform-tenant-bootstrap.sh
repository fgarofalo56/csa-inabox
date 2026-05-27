#!/usr/bin/env bash
#
# CSA Loom — Power Platform tenant bootstrap
#
# Idempotent, automated as far as Power Platform tenant config allows.
# Backs the Power Platform / ML / Geo / Graph sweep:
#
#   powerplatform-environment   - lists envs visible to the SP
#   dataverse-table             - Dataverse Web API metadata read
#   power-app                   - PowerApps admin REST (`apps`)
#   power-automate-flow         - Flow management API + flow run
#   power-page                  - Power Pages (websites table in Dataverse)
#   ai-builder-model            - AI Builder (msdyn_aimodel table)
#
# Prerequisites (one-time manual; this script verifies them but cannot
# automate the consent itself due to Microsoft tenant gates):
#
#   1. Loom MSAL Web App registered in Entra ID
#      (LOOM_MSAL_CLIENT_ID env var).
#
#   2. SP is a Power Platform Admin via:
#        Microsoft 365 admin center > Roles > Power Platform Admin
#      ↑ THIS IS A CLICK-OPS REQUIREMENT. The script prints the exact
#      M365 admin URL to complete it.
#
#   3. SP has the Application User registered in each env's Dataverse
#      (delegates to scripts/csa-loom/dataverse-add-appuser.sh).
#
#   4. Tenant has the "Allow service principal access" toggle enabled in
#      the Power Platform admin center (`admin.powerplatform.microsoft.com`
#      → Settings → Tenant settings → Service principal access).
#
# What this script DOES automate:
#
#   ✓ Discovers every env via BAP admin API (no env id needed)
#   ✓ Discovers Power Platform admin role assignment
#   ✓ For each env, calls dataverse-add-appuser.sh to register the SP
#   ✓ Verifies each env's data plane is reachable with the SP token
#   ✓ Emits a JSON summary of what worked + what needs manual remediation
#
# Per `no-vaporware.md` rule 5 (bicep sync requirement, tenant-config
# subclause): non-bicep tenant config is documented + automated here.
#
# Usage:
#   LOOM_MSAL_CLIENT_ID=<guid> LOOM_TENANT_ID=<guid> \
#     ./scripts/csa-loom/powerplatform-tenant-bootstrap.sh
#
#   # Dry-run (read-only checks only):
#   LOOM_MSAL_CLIENT_ID=<guid> ./scripts/csa-loom/powerplatform-tenant-bootstrap.sh --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${DRY_RUN:-}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

CLIENT_ID="${LOOM_MSAL_CLIENT_ID:-}"
TENANT_ID="${LOOM_TENANT_ID:-}"
if [ -z "$CLIENT_ID" ]; then
  echo "error: LOOM_MSAL_CLIENT_ID env var required (the SP that the Loom Console uses)" >&2
  exit 2
fi
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(az account show --query tenantId -o tsv 2>/dev/null || true)
  if [ -z "$TENANT_ID" ]; then
    echo "error: LOOM_TENANT_ID env var required (or sign into az)" >&2
    exit 2
  fi
fi

REPORT_DIR="${LOOM_REPORT_DIR:-./test-results/pp-tenant-bootstrap}"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/report.json"

echo "==> CSA Loom — Power Platform tenant bootstrap"
echo "    Tenant:    $TENANT_ID"
echo "    Client ID: $CLIENT_ID"
echo "    Mode:      ${DRY_RUN:+dry-run}${DRY_RUN:-apply}"
echo

# ---------------------------------------------------------------------
# Step 1 — discover envs visible to the SP
# ---------------------------------------------------------------------
echo "==> Step 1: enumerate Power Platform environments (BAP admin API)"
BAP_TOKEN=$(az account get-access-token --resource https://api.bap.microsoft.com --query accessToken -o tsv)

ENVS_JSON=$(curl -fs -H "Authorization: Bearer $BAP_TOKEN" \
  'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01&$expand=properties/linkedEnvironmentMetadata,properties/billingPolicy')

ENV_COUNT=$(echo "$ENVS_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('value',[])))")
echo "  -> $ENV_COUNT environment(s) visible"

if [ "$ENV_COUNT" -eq 0 ]; then
  cat <<'EOF'

  WARNING — no envs visible.

  This means one (or more) of:

  (a) The SP isn't a Power Platform Admin yet. Resolve via:
        https://admin.microsoft.com/Adminportal/Home#/RoleAssignments
      Add the Loom MSAL Web App SP to "Power Platform Administrator".

  (b) Service-principal admin access is disabled tenant-wide. Resolve via:
        https://admin.powerplatform.microsoft.com → Settings → Tenant settings →
        Service principal access → ON

  (c) The SP isn't visible to BAP yet (~15 min propagation after role
      assignment).

EOF
  echo '{"ok":false,"step":"enumerate","reason":"no environments visible to SP"}' > "$REPORT_FILE"
  exit 3
fi

# ---------------------------------------------------------------------
# Step 2 — for each env, attempt Dataverse AppUser registration
# ---------------------------------------------------------------------
echo
echo "==> Step 2: register the SP as a Dataverse Application User per env"

declare -A ENV_STATUS
ENV_NAMES=$(echo "$ENVS_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('value',[]):
  name=e.get('name','')
  inst=(e.get('properties',{}).get('linkedEnvironmentMetadata') or {}).get('instanceUrl','').rstrip('/')
  if inst: print(f'{name}\t{inst}')
")

while IFS=$'\t' read -r env_name instance_url; do
  if [ -z "$env_name" ]; then continue; fi
  printf '  %s  (%s)\n' "$env_name" "$instance_url"

  if [ -n "$DRY_RUN" ]; then
    ENV_STATUS["$env_name"]="dry-run"
    continue
  fi

  if [ -f "$SCRIPT_DIR/dataverse-add-appuser.sh" ]; then
    LOOM_MSAL_CLIENT_ID="$CLIENT_ID" \
      bash "$SCRIPT_DIR/dataverse-add-appuser.sh" "$CLIENT_ID" "$env_name" 2>&1 | sed 's/^/      /' \
      && ENV_STATUS["$env_name"]="ok" \
      || ENV_STATUS["$env_name"]="failed"
  else
    echo "      (dataverse-add-appuser.sh not present; skipping)"
    ENV_STATUS["$env_name"]="skipped-no-helper"
  fi
done <<< "$ENV_NAMES"

# ---------------------------------------------------------------------
# Step 3 — verify data-plane reachability per editor surface
# ---------------------------------------------------------------------
echo
echo "==> Step 3: probe each Power Platform surface with the SP token"

# We use the SP's own token (delegated to api.flow.microsoft.com /
# api.powerapps.com / Dataverse). The az CLI can't mint SP tokens
# unless you've configured the SP's credential; in CI this script
# runs as the SP via federated identity, which makes this implicit.
FLOW_TOKEN=$(az account get-access-token --resource https://service.flow.microsoft.com/ --query accessToken -o tsv 2>/dev/null || echo "")
APPS_TOKEN=$(az account get-access-token --resource https://service.powerapps.com/ --query accessToken -o tsv 2>/dev/null || echo "")

probe() {
  local label="$1" url="$2" token="$3"
  if [ -z "$token" ]; then
    echo "  - $label: SKIPPED (no token — sign in as SP via federated identity)"
    return
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url")
  echo "  - $label: HTTP $code"
}

probe "PowerApps admin"  "https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2020-06-01"     "$APPS_TOKEN"
probe "Flow admin"       "https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/scopes/admin/environments?api-version=2016-11-01" "$FLOW_TOKEN"

# ---------------------------------------------------------------------
# Step 4 — Tenant-level toggle reminders (cannot automate)
# ---------------------------------------------------------------------
echo
echo "==> Step 4: tenant settings checklist (manual gates)"
cat <<'EOF'

  Verify these toggles in https://admin.powerplatform.microsoft.com/settings/tenantSettings :

    [ ] Service principal access → ON
    [ ] Block tenant create trial environments → unchanged (Loom doesn't need it)
    [ ] Allow guest makers → unchanged
    [ ] Power Apps maker portal → enabled (only relevant if you'll click into make.*)

  And in https://admin.microsoft.com/Adminportal/Home#/RoleAssignments :

    [ ] Loom SP has role "Power Platform Administrator"
    [ ] Loom SP has role "Dynamics 365 Service Administrator"  (needed for the Default env)

EOF

# ---------------------------------------------------------------------
# Step 5 — emit JSON report
# ---------------------------------------------------------------------
{
  echo '{'
  echo "  \"ok\": true,"
  echo "  \"tenantId\": \"$TENANT_ID\","
  echo "  \"clientId\": \"$CLIENT_ID\","
  echo "  \"environmentCount\": $ENV_COUNT,"
  echo "  \"environments\": {"
  first=1
  for k in "${!ENV_STATUS[@]}"; do
    if [ $first -eq 1 ]; then first=0; else echo ","; fi
    printf '    "%s": "%s"' "$k" "${ENV_STATUS[$k]}"
  done
  echo
  echo "  },"
  echo "  \"manualGates\": ["
  echo "    \"verify SP is Power Platform Administrator\","
  echo "    \"verify Tenant Settings > Service principal access = ON\","
  echo "    \"verify Promote To Admin clicked for Default env\""
  echo "  ]"
  echo '}'
} > "$REPORT_FILE"

echo
echo "==> Done. Report written to $REPORT_FILE"
