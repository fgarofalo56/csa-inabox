#!/bin/sh
# In-VNet one-shot: create/reuse a Databricks SQL warehouse in the bound Gov
# workspace (reachable only from inside the CAE VNet), then wire the console env.
set -e
echo "[dbx-init] start"
az cloud set -n AzureUSGovernment
az login --service-principal -u "$SP_ID" -p "$SP_SECRET" --tenant "$TENANT" -o none
az account set -s "$SUB"
HOST=$(az containerapp show -n loom-console -g "$RG" --query "properties.template.containers[0].env[?name=='LOOM_DATABRICKS_HOSTNAME'].value | [0]" -o tsv)
HOST=$(echo "$HOST" | sed -e 's#^https://##' -e 's#/.*$##')
echo "[dbx-init] host=$HOST"
TOK=$(az account get-access-token --resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d --query accessToken -o tsv)
# Databricks SQL Warehouses can return TEMPORARILY_UNAVAILABLE while the DBSQL
# service warms on the workspace. Retry the list a few times with backoff before
# concluding the service is unavailable.
LIST='{}'
i=0
while [ "$i" -lt 8 ]; do
  LIST=$(curl -sS -m 40 -H "Authorization: Bearer $TOK" "https://$HOST/api/2.0/sql/warehouses" || echo '{}')
  echo "[dbx-init] list[$i]=$(echo "$LIST" | head -c 200)"
  echo "$LIST" | grep -q "TEMPORARILY_UNAVAILABLE" || break
  i=$((i+1)); sleep 20
done
WID=$(printf '%s' "$LIST" | python3 -c "import json,sys; d=json.load(sys.stdin); ws=d.get('warehouses',[]); m=[w for w in ws if str(w.get('name','')).lower().startswith('loom')]; print((m[0] if m else (ws[0] if ws else {})).get('id',''))" 2>/dev/null || echo "")
if [ -z "$WID" ]; then
  RESP='{}'
  j=0
  while [ "$j" -lt 8 ]; do
    RESP=$(curl -sS -m 60 -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{"name":"loom-governance","cluster_size":"2X-Small","min_num_clusters":1,"max_num_clusters":1,"auto_stop_mins":10,"warehouse_type":"PRO"}' "https://$HOST/api/2.0/sql/warehouses" || echo '{}')
    echo "[dbx-init] create[$j]=$(echo "$RESP" | head -c 200)"
    echo "$RESP" | grep -q "TEMPORARILY_UNAVAILABLE" || break
    j=$((j+1)); sleep 20
  done
  WID=$(printf '%s' "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
fi
if [ -z "$WID" ]; then
  echo "[dbx-init] NO_WAREHOUSE_ID (last list=$(echo "$LIST" | head -c 120) last create=$(echo "${RESP:-}" | head -c 120))"
  exit 1
fi
echo "[dbx-init] warehouse_id=$WID"
az containerapp update -n loom-console -g "$RG" --set-env-vars "LOOM_DATABRICKS_SQL_WAREHOUSE_ID=$WID" -o none
echo "[dbx-init] WIRED_OK $WID"
