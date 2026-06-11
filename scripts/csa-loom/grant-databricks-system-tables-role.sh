#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI read access to the Databricks Unity Catalog
# SYSTEM TABLES used by the unified-lineage service (audit-t138).
#
# The unified lineage graph reads `system.access.table_lineage` (and optionally
# `system.access.column_lineage`) to surface the producing entity (notebook /
# job / pipeline / dashboard) of each table-to-table edge — the depth the REST
# `lineage-tracking` preview does not expose. See:
#   apps/fiab-console/lib/azure/unified-lineage.ts
#   apps/fiab-console/lib/azure/unity-catalog-client.ts (getTableLineageSystemTables)
#   https://learn.microsoft.com/azure/databricks/admin/system-tables/lineage
#
# WHY THIS IS GUIDANCE (not a single `az` call):
#   1. The `system` catalog schemas must be ENABLED in the metastore. As of
#      2026-06 `system.access` is enabled via the Unity Catalog system-schemas
#      REST API (PUT /api/2.0/unity-catalog/metastores/{id}/systemschemas/access)
#      by a metastore admin — there is no ARM surface for it.
#   2. The SELECT grant on `system.access` is a Unity Catalog SQL GRANT, run on a
#      SQL warehouse by a principal with MANAGE on the metastore. The Loom UAMI
#      is added to UC as a service principal (see grant-purview-uc-role.sh for
#      the UAMI→UC onboarding pattern), then granted USE SCHEMA + SELECT.
#
# The Console renders an honest infra-gate (UnityCatalogError naming this script)
# when the query fails, so this runbook maps directly to the gate text
# (per .claude/rules/no-vaporware.md).
#
# USAGE:
#   DATABRICKS_HOST=adb-xxxx.azuredatabricks.net \
#   METASTORE_ID=<metastore-guid> \
#   WAREHOUSE_ID=<sql-warehouse-id> \
#   UAMI_APP_ID=<console-uami-application-id> \
#     ./scripts/csa-loom/grant-databricks-system-tables-role.sh
#
# REQUIRES: az CLI (for the Databricks AAD token) logged in as a metastore admin,
#   curl, and a running SQL warehouse.
set -euo pipefail

: "${DATABRICKS_HOST:?set DATABRICKS_HOST (e.g. adb-1234.11.azuredatabricks.net)}"
: "${METASTORE_ID:?set METASTORE_ID (Unity Catalog metastore guid)}"
: "${WAREHOUSE_ID:?set WAREHOUSE_ID (a running SQL warehouse id)}"
: "${UAMI_APP_ID:?set UAMI_APP_ID (the Console UAMI application/client id, already onboarded to UC)}"

HOST="${DATABRICKS_HOST#https://}"
HOST="${HOST%/}"

echo "==> Acquiring a Databricks AAD token (resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d)…"
TOKEN="$(az account get-access-token \
  --resource '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d' \
  --query accessToken -o tsv)"

echo "==> 1/2 Enabling the system.access schema in metastore ${METASTORE_ID}…"
curl -sS -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${HOST}/api/2.0/unity-catalog/metastores/${METASTORE_ID}/systemschemas/access" \
  && echo "    system.access enabled (or already enabled)."

echo "==> 2/2 Granting USE SCHEMA + SELECT on system.access to the Loom UAMI (${UAMI_APP_ID})…"
SQL="GRANT USE SCHEMA, SELECT ON SCHEMA system.access TO \`${UAMI_APP_ID}\`"
STMT="$(curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  "https://${HOST}/api/2.0/sql/statements" \
  -d "{\"warehouse_id\":\"${WAREHOUSE_ID}\",\"statement\":\"${SQL}\",\"wait_timeout\":\"30s\"}")"
echo "${STMT}"

echo
echo "Done. Now set LOOM_DATABRICKS_LINEAGE_WAREHOUSE_ID=${WAREHOUSE_ID} on the Console"
echo "Container App (bicep param loomDatabricksLineageWarehouseId) so the unified"
echo "lineage service uses the entity-aware system-table path instead of the REST"
echo "preview fallback."
