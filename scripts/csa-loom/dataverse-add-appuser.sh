#!/usr/bin/env bash
#
# Loom Dataverse Application User registration
#
# For every environment in the tenant that has a Dataverse database,
# register the Loom MSAL Web App SP as an Application User with the
# System Administrator security role. Idempotent — re-running is safe
# (skips envs where the AppUser already exists).
#
# Prerequisites:
#   - Caller must have Dataverse System Administrator on each target env.
#     For the Default env, this requires the one-time manual "Promote To
#     Admin" click (see docs/fiab/dataverse-app-user.md).
#   - az CLI signed in as a tenant admin / env admin.
#   - LOOM_MSAL_CLIENT_ID env var set (the App Registration to register).
#
# Usage:
#   LOOM_MSAL_CLIENT_ID=9844c28c-... ./scripts/csa-loom/dataverse-add-appuser.sh
#   LOOM_MSAL_CLIENT_ID=9844c28c-... ./scripts/csa-loom/dataverse-add-appuser.sh --env-id <envId>
#
# Exit codes (the bootstrap workflow branches on these):
#   0 - completed. Includes the GENUINE no-op: the BAP admin API answered 2xx
#       with a real environment list, and no environment in it has Dataverse.
#   2 - bad invocation (no client id).
#   3 - COULD NOT ESTABLISH the environment list. The token call failed, the API
#       returned a non-2xx, or the body carried no `value` array. This is NOT
#       "no environments" and must never be reported as one.
#
# -- #3688: WHY EXIT 3 EXISTS ------------------------------------------------
# The discovery call was `curl -s` with no status check, piped into a parser
# that printed nothing when `value` was absent. A 401 or a 403 from the BAP
# admin API therefore produced an empty ENVS, which fell into the
# "(no envs with Dataverse found)" branch and exited 0. The bootstrap job read
# that as success.
#
# On 2026-08-12 run 31572941870 printed exactly that line and exited 0 while the
# estate demonstrably had a live Dataverse org (orgd9f634de.crm.dynamics.com), so
# the whole Power Platform item family stayed blocked on a grant the deploy
# believed it had performed. The script asserted a fact about the TENANT that it
# had only established about its own HTTP call: deploy-integrity.md R7.
#
# The same reasoning covers the token acquisition below: `az account
# get-access-token` failing is not evidence that the tenant has no Power
# Platform, so it may no longer reach the parser as an empty string.
set -euo pipefail

APP_CLIENT_ID="${LOOM_MSAL_CLIENT_ID:-${1:-}}"
ENV_FILTER="${2:-}"
if [ -z "$APP_CLIENT_ID" ]; then
  echo "error: LOOM_MSAL_CLIENT_ID env var or first arg required" >&2
  exit 2
fi

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# Discover every env with Dataverse provisioned
echo "==> Discovering envs with Dataverse via BAP admin API"
if ! BAP_TOKEN=$(az account get-access-token --resource https://api.bap.microsoft.com --query accessToken -o tsv 2>"$TMPD/token.err"); then
  echo "  x Could not acquire a BAP admin token (az account get-access-token failed):" >&2
  sed 's/^/    /' "$TMPD/token.err" >&2 || true
  echo "  This is NOT evidence that the tenant has no Dataverse environment." >&2
  exit 3
fi
if [ -z "${BAP_TOKEN:-}" ]; then
  echo "  x az returned an EMPTY BAP admin token. Not evidence of an empty tenant." >&2
  exit 3
fi

# The status goes to its own file rather than being appended to the body: the
# body is JSON and splitting a combined stream is one more thing to get wrong.
# `-sS` keeps curl quiet on success but still reports transport errors, which are
# captured and printed rather than discarded (a discarded stderr is how a
# permission denial became "no environments" in the first place).
#
# `|| true` — NOT `|| HTTP_CODE=""`, and NOT `|| echo`. Under `set -e` the bare
# assignment would abort the script AT THIS LINE on a connection failure, before
# the `case` below that exists to report exactly that. `|| true` fixes only the
# exit STATUS and leaves stdout alone, so a transport failure keeps curl's
# printed `000` and falls to `*)` with the curl stderr attached — strictly more
# honest than the `<no response>` an emptied variable would have produced.
# (`|| echo X` would CONCATENATE onto what curl already printed; see
# scripts/ci/check-curl-httpcode-fallback.mjs.)
HTTP_CODE=$(curl -sS -o "$TMPD/envs.json" -w '%{http_code}' \
  -H "Authorization: Bearer $BAP_TOKEN" \
  'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01&$expand=properties/linkedEnvironmentMetadata' \
  2>"$TMPD/curl.err") || true

case "${HTTP_CODE:-}" in
  2??) ;;
  *)
    echo "  x Could not list Power Platform environments (HTTP ${HTTP_CODE:-<no response>})." >&2
    if [ -s "$TMPD/curl.err" ]; then sed 's/^/    /' "$TMPD/curl.err" >&2; fi
    if [ -s "$TMPD/envs.json" ]; then head -c 400 "$TMPD/envs.json" | sed 's/^/    /' >&2; echo >&2; fi
    echo "  The Loom MSAL SP was NOT registered anywhere. This is a REFUSAL, not an" >&2
    echo "  empty tenant: the caller most likely lacks Power Platform Administrator" >&2
    echo "  or Global Administrator. See docs/fiab/dataverse-app-user.md." >&2
    exit 3
    ;;
esac

# Extract each env's Dataverse instance URL (only envs WITH Dataverse have
# linkedEnvironmentMetadata.instanceUrl). The parser exits 3 when the body has no
# `value` ARRAY at all — an {"error": ...} payload under a 200, or a truncated
# response, is an UNPARSED ANSWER and not a count of zero.
set +e
ENVS=$(ENV_FILTER="$ENV_FILTER" python3 - "$TMPD/envs.json" <<'PYEOF'
import json, os, sys
path = sys.argv[1]
env_filter = os.environ.get('ENV_FILTER', '')
try:
    with open(path, 'r', encoding='utf-8') as fh:
        d = json.load(fh)
except Exception as ex:
    sys.stderr.write('    unparseable BAP response: %s\n' % ex)
    sys.exit(3)
if not isinstance(d, dict) or not isinstance(d.get('value'), list):
    keys = sorted(d.keys()) if isinstance(d, dict) else type(d).__name__
    sys.stderr.write("    BAP response carried no 'value' array; keys=%s\n" % (keys,))
    sys.exit(3)
for e in d['value']:
    name = e.get('name', '')
    if env_filter and name != env_filter:
        continue
    meta = e.get('properties', {}).get('linkedEnvironmentMetadata') or {}
    instance = (meta.get('instanceUrl') or '').rstrip('/')
    if instance:
        sys.stdout.write('%s\t%s\n' % (name, instance))
PYEOF
)
PARSE_RC=$?
set -e
if [ "$PARSE_RC" -ne 0 ]; then
  echo "  x Could not read an environment list out of a HTTP $HTTP_CODE response." >&2
  echo "  The Loom MSAL SP was NOT registered anywhere. Not an empty tenant." >&2
  exit 3
fi

if [ -z "$ENVS" ]; then
  # The GENUINE no-op, and the only one that reaches here: the API answered 2xx
  # with a real `value` array carrying no Dataverse-backed environment.
  echo "  (no envs with Dataverse found; BAP admin API answered HTTP $HTTP_CODE with a parsed, Dataverse-free environment list)"
  exit 0
fi

ROLE_NAME="${LOOM_DATAVERSE_ROLE:-System Administrator}"

# Per-environment failures are counted rather than aborting the loop — one env
# the caller is not SA on must not stop the others being registered — but the
# count is the EXIT STATUS, so a run in which nothing was registered cannot
# report success.
REGISTERED=0
FAILED=0

while IFS=$'\t' read -r ENV_ID DV_URL; do
  echo ""
  echo "==> $ENV_ID  ($DV_URL)"
  if ! TOKEN=$(az account get-access-token --resource "$DV_URL" --query accessToken -o tsv 2>"$TMPD/dv-token.err"); then
    echo "  x Cannot get a Dataverse token for $DV_URL:" >&2
    sed 's/^/    /' "$TMPD/dv-token.err" >&2 || true
    FAILED=$((FAILED + 1))
    continue
  fi
  if [ -z "${TOKEN:-}" ]; then
    echo "  x az returned an EMPTY Dataverse token for $DV_URL" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  # Check if AppUser already exists
  EXISTING=$(curl -s -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
    "$DV_URL/api/data/v9.2/systemusers?\$select=systemuserid&\$filter=applicationid%20eq%20$APP_CLIENT_ID" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['value'][0]['systemuserid'] if d.get('value') else '')" 2>/dev/null || echo "")

  if [ -n "$EXISTING" ]; then
    echo "  + AppUser already exists ($EXISTING) — verifying role"
    APP_USER_ID="$EXISTING"
  else
    # Resolve root BU
    BU_ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
      "$DV_URL/api/data/v9.2/businessunits?\$select=businessunitid&\$filter=parentbusinessunitid%20eq%20null" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['value'][0]['businessunitid'])" 2>/dev/null || echo "")
    if [ -z "$BU_ID" ]; then
      echo "  x Could not resolve root BU — caller may lack SA; see docs/fiab/dataverse-app-user.md Step 1" >&2
      FAILED=$((FAILED + 1))
      continue
    fi
    echo "  -> Creating AppUser (BU $BU_ID)"
    APP_USER_ID=$(curl -s -X POST \
      -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
      -H "Content-Type: application/json" -H "Prefer: return=representation" \
      -d "{\"applicationid\":\"$APP_CLIENT_ID\",\"businessunitid@odata.bind\":\"/businessunits($BU_ID)\",\"firstname\":\"CSA Loom\",\"lastname\":\"Console\"}" \
      "$DV_URL/api/data/v9.2/systemusers" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('systemuserid',''))" 2>/dev/null || echo "")
    if [ -z "$APP_USER_ID" ]; then
      echo "  x AppUser create failed" >&2
      FAILED=$((FAILED + 1))
      continue
    fi
    echo "  + AppUser created: $APP_USER_ID"
  fi

  # Assign role (idempotent — Dataverse returns 200 on association even if it exists)
  ROLE_ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" \
    "$DV_URL/api/data/v9.2/roles?\$select=roleid&\$filter=name%20eq%20'$(printf '%s' "$ROLE_NAME" | sed 's/ /%20/g')'&\$top=1" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['value'][0]['roleid'] if d.get('value') else '')" 2>/dev/null || echo "")
  if [ -z "$ROLE_ID" ]; then
    echo "  x Role '$ROLE_NAME' not found" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  # `|| true` for the same reason as the BAP probe above: under `set -e` an
  # unguarded capture dies HERE on a transport failure, skipping the `*)` branch
  # that counts the failure. With it, curl's `000` reaches that branch and the
  # env is recorded as failed rather than the whole run vanishing mid-loop.
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "OData-Version: 4.0" -H "Content-Type: application/json" \
    -d "{\"@odata.id\": \"$DV_URL/api/data/v9.2/roles($ROLE_ID)\"}" \
    "$DV_URL/api/data/v9.2/systemusers($APP_USER_ID)/systemuserroles_association/\$ref") || true
  case "$STATUS" in
    204|200)
      echo "  + registered $APP_CLIENT_ID on $ENV_ID: role '$ROLE_NAME' assigned"
      REGISTERED=$((REGISTERED + 1))
      ;;
    412)
      echo "  + registered $APP_CLIENT_ID on $ENV_ID: role '$ROLE_NAME' already assigned"
      REGISTERED=$((REGISTERED + 1))
      ;;
    *)
      echo "  x Role assignment HTTP $STATUS" >&2
      FAILED=$((FAILED + 1))
      ;;
  esac
done <<< "$ENVS"

echo ""
echo "Done. registered=$REGISTERED failed=$FAILED. Re-run anytime — it's idempotent."
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
