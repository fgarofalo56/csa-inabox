#!/usr/bin/env bash
# CSA Loom — DAX golden reference-model seeder (loom-next-level ws-lineage-depth A5).
#
# Provisions the deterministic Sales/Date/Customer star schema the DAX golden
# harness asserts against, as `dbo.{Sales,Date,Customer}` views in the
# `loom_dax_golden` database on the env-bound Synapse SERVERLESS SQL endpoint.
#
# The views are pure metadata over a T-SQL VALUES table constructor generated
# from the reference CSVs
# (apps/fiab-console/lib/azure/__tests__/dax-golden/reference-data/*.csv) — NO
# ADLS / OPENROWSET / external table, so NO storage data-plane is needed (this
# estate seals storage data-planes) and the numbers are perfectly deterministic.
# The CSVs are the single source of truth shared with the golden fixtures.
#
# WHERE TO RUN: in-VNet (the serverless endpoint is private-endpoint-locked —
# same context as the loom-ui-verify gh-aca-runner). Auth is the running
# identity's AAD token; that identity MUST be a Synapse SQL admin on the
# workspace (the Console UAMI is — grant a human/SP the same to run this by
# hand). This is an honest Azure prerequisite (no-vaporware), not a Fabric one.
#
# Idempotent: CREATE DATABASE is guarded; views use CREATE OR ALTER.
#
# Usage (in-VNet, after `az login` as a Synapse SQL admin):
#   LOOM_SYNAPSE_WORKSPACE=<workspace> scripts/csa-loom/seed-dax-golden.sh
#
# Env:
#   LOOM_SYNAPSE_WORKSPACE          (required) Synapse workspace name
#   LOOM_SYNAPSE_HOST_SUFFIX        default: sql.azuresynapse.net
#   LOOM_SYNAPSE_SQL_TOKEN_RESOURCE default: derived from the active az cloud
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

WORKSPACE="${LOOM_SYNAPSE_WORKSPACE:-}"
if [[ -z "$WORKSPACE" ]]; then
  echo "::error::LOOM_SYNAPSE_WORKSPACE is required (the Synapse workspace hosting the serverless pool)." >&2
  exit 1
fi

SUFFIX="${LOOM_SYNAPSE_HOST_SUFFIX:-sql.azuresynapse.net}"
SERVER="${WORKSPACE}-ondemand.${SUFFIX}"
DB="loom_dax_golden"

# --- resolve the SQL token resource for the active cloud (Commercial vs Gov) ---
RESOURCE="${LOOM_SYNAPSE_SQL_TOKEN_RESOURCE:-}"
if [[ -z "$RESOURCE" ]]; then
  CLOUD="$(az cloud show --query name -o tsv 2>/dev/null || echo AzureCloud)"
  case "$CLOUD" in
    AzureUSGovernment) RESOURCE="https://database.usgovcloudapi.net/" ;;
    *)                 RESOURCE="https://database.windows.net/" ;;
  esac
fi

echo "==> Seeding DAX golden reference model"
echo "    server:   $SERVER"
echo "    database: $DB"
echo "    token:    $RESOURCE (identity: $(az account show --query user.name -o tsv 2>/dev/null || echo unknown))"

# --- acquire an AAD access token for the SQL endpoint (masked in CI) ----------
TOKEN="$(az account get-access-token --resource "$RESOURCE" --query accessToken -o tsv)"
if [[ -z "$TOKEN" ]]; then
  echo "::error::Failed to acquire a SQL access token for $RESOURCE (is 'az login' current?)." >&2
  exit 1
fi
echo "::add-mask::$TOKEN"

# --- 1. CREATE DATABASE (against master) --------------------------------------
echo "==> [1/2] ensuring database $DB (master)"
node "$HERE/gen-dax-golden-ddl.mjs" --db-only \
  | SQL_SERVER="$SERVER" SQL_ACCESS_TOKEN="$TOKEN" \
    node "$HERE/run-serverless-sql.mjs" --database master --ignore-errors

# --- 2. CREATE OR ALTER VIEWs (against loom_dax_golden) -----------------------
echo "==> [2/2] seeding dbo.{Sales,Date,Customer} views ($DB)"
node "$HERE/gen-dax-golden-ddl.mjs" --views-only \
  | SQL_SERVER="$SERVER" SQL_ACCESS_TOKEN="$TOKEN" \
    node "$HERE/run-serverless-sql.mjs" --database "$DB"

echo ""
echo "DONE. The DAX golden harness can now assert numeric results against real"
echo "Synapse serverless: pnpm -C apps/fiab-console exec playwright test --project=dax-golden"
echo "(the harness passes database=$DB on every /dax-query)."
