#!/usr/bin/env bash
# Grant the Loom Console UAMI the Unity Catalog metastore SHARING privileges so
# the Marketplace "Data shares" → "Shared by me" flow (publish outbound Delta
# shares + recipients + providers) works. The INBOUND subscribe side needs only
# workspace access and works without this grant.
#
# Run by a Databricks **metastore admin** (the operator). Analogous to the
# Power Platform SP grant — the Console UAMI cannot grant itself.
#
# Prereqs:
#   - Delta Sharing ENABLED on the metastore (Databricks account console →
#     metastore → Delta Sharing → set the sharing organization name).
#   - A running Databricks SQL warehouse, OR run the GRANTs in a Databricks SQL
#     editor / notebook as a metastore admin.
#
# Usage:
#   DBX_HOST=adb-7405606457049619.19.azuredatabricks.net \
#   UAMI_APP_ID="<loom-console UAMI application (client) id>" \
#   WAREHOUSE_ID="<sql-warehouse-id>" \
#   DATABRICKS_TOKEN="<metastore-admin PAT>" \
#   ./grant-databricks-delta-sharing.sh
#
# Or paste these into a Databricks SQL editor as a metastore admin:
#   GRANT CREATE SHARE     ON METASTORE TO `<UAMI_APP_ID>`;
#   GRANT CREATE RECIPIENT ON METASTORE TO `<UAMI_APP_ID>`;
#   GRANT CREATE PROVIDER  ON METASTORE TO `<UAMI_APP_ID>`;
set -euo pipefail

: "${DBX_HOST:?set DBX_HOST (e.g. adb-xxxx.NN.azuredatabricks.net)}"
: "${UAMI_APP_ID:?set UAMI_APP_ID (the loom-console UAMI application/client id)}"
: "${WAREHOUSE_ID:?set WAREHOUSE_ID (a running Databricks SQL warehouse id)}"
: "${DATABRICKS_TOKEN:?set DATABRICKS_TOKEN (a metastore-admin PAT)}"

run_sql() {
  local stmt="$1"
  echo "  -> $stmt"
  curl -sf -X POST "https://${DBX_HOST}/api/2.0/sql/statements" \
    -H "Authorization: Bearer ${DATABRICKS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"warehouse_id\":\"${WAREHOUSE_ID}\",\"statement\":\"${stmt}\",\"wait_timeout\":\"30s\"}" \
    | grep -oE '"state":"[A-Z]+"' || true
}

echo "Granting Delta Sharing metastore privileges to UAMI ${UAMI_APP_ID} on ${DBX_HOST}…"
run_sql "GRANT CREATE SHARE ON METASTORE TO \`${UAMI_APP_ID}\`"
run_sql "GRANT CREATE RECIPIENT ON METASTORE TO \`${UAMI_APP_ID}\`"
run_sql "GRANT CREATE PROVIDER ON METASTORE TO \`${UAMI_APP_ID}\`"
echo "Done. Re-test Marketplace → Data shares → Shared by me → New share."
