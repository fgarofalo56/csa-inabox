#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI a Microsoft Purview UNIFIED CATALOG role
# (Catalog Reader / Data Product Owner) in a GOVERNANCE DOMAIN, for the F22
# data-product adapter (lib/dataproducts/purview-unified-store.ts).
#
# WHY THIS SCRIPT IS GUIDANCE (and not an `az ...` call):
#   Unified Catalog (purview.microsoft.com) governance-domain roles are NOT ARM
#   RBAC and — unlike the classic Data Map metadata-policy API — have NO public
#   data-plane REST / az CLI surface for role assignment as of 2026-06. They are
#   assigned in the Purview portal only. This script prints the exact, ordered
#   portal steps + the values to paste, so the honest infra-gate the Console
#   renders (PurviewNotConfiguredError.hint, see purview-unified-client.ts) maps
#   to a concrete operator runbook. It also verifies the grant landed by calling
#   the live data plane the adapter uses.
#
# Roles (Unified Catalog data plane):
#   Catalog Reader      → read data products  (ucGet / ucList)
#   Data Product Owner  → create/update/delete (ucCreate / ucUpdate / ucRemove)
#   ref: https://learn.microsoft.com/purview/data-governance-roles-permissions
#
# Adapter routing (must ALL hold for the adapter to be active):
#   LOOM_DATAPRODUCTS_BACKEND=purview-unified
#   LOOM_PURVIEW_UNIFIED_ACCOUNT=<uc-account>  (or LOOM_PURVIEW_UC_ENDPOINT=<host>)
#   CSA_LOOM_BOUNDARY=Commercial               (GCC/GCC-High/IL5 fall through to Cosmos)
#
# USAGE:
#   UAMI_PRINCIPAL=<console-uami-oid> GOVERNANCE_DOMAIN_ID=<domain-guid> \
#     LOOM_PURVIEW_UNIFIED_ACCOUNT=<uc-account> ./scripts/csa-loom/grant-purview-uc-role.sh
#
# REQUIRES (for the optional live verify step): az CLI logged in as a principal
#   that already holds Catalog Reader in the domain, + jq.
set -uo pipefail

UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-${UAMI_PRINCIPAL:-<console-uami-object-id>}}"
GOVERNANCE_DOMAIN_ID="${GOVERNANCE_DOMAIN_ID:-${LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID:-<governance-domain-guid>}}"
UC_ACCOUNT="${LOOM_PURVIEW_UNIFIED_ACCOUNT:-<uc-account>}"
UC_ENDPOINT="${LOOM_PURVIEW_UC_ENDPOINT:-https://api.purview-service.microsoft.com}"
UC_ENDPOINT="${UC_ENDPOINT%/}"
API_VERSION="${LOOM_PURVIEW_UC_API_VERSION:-2026-03-20-preview}"
RESOURCE="https://purview.azure.net"

cat <<EOF
== CSA Loom — Purview Unified Catalog role grant (portal-only) ==
   uami=$UAMI_PRINCIPAL
   governanceDomain=$GOVERNANCE_DOMAIN_ID
   ucAccount=$UC_ACCOUNT  endpoint=$UC_ENDPOINT

Unified Catalog governance-domain roles have no az CLI / REST assignment surface.
Grant them in the Purview portal (one-time, ~1 min):

  1. Open  https://purview.microsoft.com  →  Unified Catalog.
  2. Catalog management  →  Governance domains  →  open domain  $GOVERNANCE_DOMAIN_ID.
  3. Roles tab.
  4. Add the Console UAMI (object id $UAMI_PRINCIPAL) to BOTH:
       - Catalog Reader      (lets Loom list/get data products)
       - Data Product Owner  (lets Loom create/update/delete data products)
  5. Save. Propagation is near-immediate.

Then set (Commercial only) and redeploy admin-plane:
   loomDataProductsBackend  = 'purview-unified'   (=> LOOM_DATAPRODUCTS_BACKEND)
   loomPurviewUnifiedAccount = '$UC_ACCOUNT'       (=> LOOM_PURVIEW_UNIFIED_ACCOUNT)
EOF

# Optional live verify: hit the same data plane the adapter uses. A 200/empty
# list means the host resolves and the signed-in principal can read the catalog;
# 401/403 means the role has not propagated yet (or the signed-in principal
# itself lacks Catalog Reader).
if command -v az >/dev/null 2>&1; then
  echo
  echo "-> live verify: GET ${UC_ENDPOINT}/datagovernance/catalog/dataProducts?api-version=${API_VERSION}&domainId=${GOVERNANCE_DOMAIN_ID}"
  TOKEN="$(az account get-access-token --resource "$RESOURCE" --query accessToken -o tsv 2>/dev/null)"
  if [[ -z "$TOKEN" ]]; then
    echo "   (skipped — run 'az login' as a Catalog Reader to verify)"
  else
    HTTP_CODE="$(curl -sS -o /tmp/loom-uc-verify.json -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "${UC_ENDPOINT}/datagovernance/catalog/dataProducts?api-version=${API_VERSION}&domainId=${GOVERNANCE_DOMAIN_ID}")"
    case "$HTTP_CODE" in
      200) echo "   ✓ HTTP 200 — Unified Catalog reachable + reader role effective." ;;
      401|403) echo "   ✗ HTTP $HTTP_CODE — role not yet effective (or signed-in principal lacks Catalog Reader). Re-run after the portal grant propagates." ;;
      *) echo "   ? HTTP $HTTP_CODE — response:"; head -c 500 /tmp/loom-uc-verify.json; echo ;;
    esac
  fi
fi
