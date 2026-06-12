#!/usr/bin/env bash
# CSA Loom — Weave (Semantic Ontology) PostgreSQL + Apache AGE data-plane bootstrap.
#
# Bicep (modules/landing-zone/postgres-weave.bicep) provisions the PG flexible
# server + the required server params (shared_preload_libraries=AGE,
# azure.extensions=AGE) + the loom-weave database. But the DATA-PLANE setup —
# registering the Console UAMI as a PG principal, CREATE EXTENSION AGE, and
# create_graph — cannot be done in bicep. This script does it, idempotently.
#
# Steps (each idempotent):
#   1. Wait for the server to report state == 'Ready' (setting
#      shared_preload_libraries triggers an automatic restart — Microsoft Learn:
#      azure/postgresql/extensions/concepts-extensions-considerations).
#   2. Open a temporary firewall rule for this runner's egress IP.
#   3. Connect as the deploy SP (PG Entra admin) and:
#        - SELECT pgaadauth_create_principal('<uami-name>', false, false);
#        - GRANT CONNECT on the db + USAGE/CREATE on the graph schema to the UAMI.
#        - CREATE EXTENSION IF NOT EXISTS AGE CASCADE;
#        - SELECT ag_catalog.create_graph('<graph>')   (skipped if it exists).
#        - GRANT USAGE on ag_catalog + the graph schema to the UAMI principal.
#   4. Remove the temporary firewall rule.
#
# Required env:
#   SUB                       — subscription id
#   DLZ_RG                    — resource group holding the Weave PG server
#   WEAVE_PG_SERVER           — PG flexible-server name (psql-loom-weave-*)
# Optional:
#   WEAVE_PG_DB    (loom-weave)        — database name
#   WEAVE_GRAPH    (loom_ontology)     — AGE graph name
#   CONSOLE_UAMI_NAME (loom-console)   — Entra principal name (matches LOOM_POSTGRES_AAD_USER)
#   PG_HOST_SUFFIX (postgres.database.azure.com)
#   PG_AAD_RESOURCE (https://ossrdbms-aad.database.azure.com) — token audience (no /.default)
#
# Auth: runs as the logged-in az principal, which MUST be the PG Entra admin
# (the deploy SP — bicep sets the Console UAMI as admin, so to bootstrap the
# UAMI principal the deploy SP must ALSO be added as an admin once, OR run this
# as the UAMI. The workflow adds the deploy SP as a co-admin via ARM first.)

set -uo pipefail

: "${SUB:?SUB (subscription id) is required}"
: "${DLZ_RG:?DLZ_RG (resource group) is required}"
: "${WEAVE_PG_SERVER:?WEAVE_PG_SERVER (PG flexible-server name) is required}"
WEAVE_PG_DB="${WEAVE_PG_DB:-loom-weave}"
WEAVE_GRAPH="${WEAVE_GRAPH:-loom_ontology}"
CONSOLE_UAMI_NAME="${CONSOLE_UAMI_NAME:-loom-console}"
PG_HOST_SUFFIX="${PG_HOST_SUFFIX:-postgres.database.azure.com}"
PG_AAD_RESOURCE="${PG_AAD_RESOURCE:-https://ossrdbms-aad.database.azure.com}"

# Validate identifiers (defence-in-depth — these flow into SQL below).
if ! [[ "$WEAVE_GRAPH" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  echo "::error::WEAVE_GRAPH '$WEAVE_GRAPH' is not a valid identifier"; exit 1
fi
if ! [[ "$CONSOLE_UAMI_NAME" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  echo "::error::CONSOLE_UAMI_NAME '$CONSOLE_UAMI_NAME' is not a valid principal name"; exit 1
fi

FQDN="${WEAVE_PG_SERVER}.${PG_HOST_SUFFIX}"
echo "== Weave PG bootstrap: server=$WEAVE_PG_SERVER db=$WEAVE_PG_DB graph=$WEAVE_GRAPH uami=$CONSOLE_UAMI_NAME =="

# 1. Wait for Ready (shared_preload_libraries change restarts the server).
for i in $(seq 1 30); do
  STATE=$(az postgres flexible-server show -g "$DLZ_RG" -n "$WEAVE_PG_SERVER" --query state -o tsv 2>/dev/null || echo "")
  echo "  server state: ${STATE:-unknown} (attempt $i/30)"
  [ "$STATE" = "Ready" ] && break
  sleep 20
done

# 2. Temp firewall rule for this runner.
GHA_IP=$(curl -sS https://ifconfig.me 2>/dev/null || echo "")
FW_RULE="bootstrap-weave-$(date +%s)"
if [ -n "$GHA_IP" ]; then
  echo "  opening temp firewall rule $FW_RULE for $GHA_IP"
  az postgres flexible-server firewall-rule create -g "$DLZ_RG" -n "$WEAVE_PG_SERVER" \
    --rule-name "$FW_RULE" --start-ip-address "$GHA_IP" --end-ip-address "$GHA_IP" -o none 2>/dev/null || true
  sleep 10
fi

cleanup() {
  if [ -n "$GHA_IP" ]; then
    az postgres flexible-server firewall-rule delete -g "$DLZ_RG" -n "$WEAVE_PG_SERVER" \
      --rule-name "$FW_RULE" --yes -o none 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 3. Acquire an Entra token for PostgreSQL (the password in the PG wire protocol).
PG_TOKEN=$(az account get-access-token --resource "$PG_AAD_RESOURCE" --query accessToken -o tsv)
if [ -z "$PG_TOKEN" ]; then echo "::error::Failed to acquire PG Entra token"; exit 1; fi

# Install psql if missing.
if ! command -v psql >/dev/null 2>&1; then
  echo "  installing postgresql-client"
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client || {
    echo "::error::Could not install psql"; exit 1; }
fi

# The connecting Entra principal name == the az logged-in identity's display name.
# psql connects: user = that name, password = the token. We discover it from the
# token's upn/appid is non-trivial in bash; instead the workflow passes the deploy
# SP display name via PG_ADMIN_USER. Default to the UAMI name (works when this
# script runs AS the UAMI).
PG_ADMIN_USER="${PG_ADMIN_USER:-$CONSOLE_UAMI_NAME}"
export PGPASSWORD="$PG_TOKEN"
export PGSSLMODE=require

run_sql() {
  local db="$1"; shift
  psql "host=$FQDN port=5432 dbname=$db user=$PG_ADMIN_USER sslmode=require" \
    -v ON_ERROR_STOP=0 -c "$1"
}

echo "== registering Console UAMI '$CONSOLE_UAMI_NAME' as a PG principal =="
run_sql "$WEAVE_PG_DB" "SELECT * FROM pgaadauth_create_principal('$CONSOLE_UAMI_NAME', false, false);" \
  || echo "  (principal may already exist — continuing)"

echo "== CREATE EXTENSION AGE + create_graph('$WEAVE_GRAPH') =="
run_sql "$WEAVE_PG_DB" "CREATE EXTENSION IF NOT EXISTS age CASCADE;"
# create_graph errors if the graph exists; guard via ag_graph lookup.
run_sql "$WEAVE_PG_DB" "
LOAD 'age';
SET search_path = ag_catalog, \"\$user\", public;
DO \$do\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '$WEAVE_GRAPH') THEN
    PERFORM ag_catalog.create_graph('$WEAVE_GRAPH');
  END IF;
END
\$do\$;"

echo "== granting the Console UAMI principal access to ag_catalog + the graph schema =="
run_sql "$WEAVE_PG_DB" "
GRANT CONNECT ON DATABASE \"$WEAVE_PG_DB\" TO \"$CONSOLE_UAMI_NAME\";
GRANT USAGE ON SCHEMA ag_catalog TO \"$CONSOLE_UAMI_NAME\";
GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO \"$CONSOLE_UAMI_NAME\";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ag_catalog TO \"$CONSOLE_UAMI_NAME\";
GRANT USAGE, CREATE ON SCHEMA \"$WEAVE_GRAPH\" TO \"$CONSOLE_UAMI_NAME\";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA \"$WEAVE_GRAPH\" TO \"$CONSOLE_UAMI_NAME\";
ALTER DEFAULT PRIVILEGES IN SCHEMA \"$WEAVE_GRAPH\" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$CONSOLE_UAMI_NAME\";
" || echo "  (some grants may have failed if the principal was just created — re-run is idempotent)"

echo "== Weave PG bootstrap complete =="
echo "   The Console (LOOM_WEAVE_PG_FQDN=$FQDN) can now write object/link/action instances to graph '$WEAVE_GRAPH'."
