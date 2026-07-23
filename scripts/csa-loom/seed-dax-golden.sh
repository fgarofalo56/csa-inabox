#!/usr/bin/env bash
# seed-dax-golden.sh — provision the DAX golden reference model into the live
# Synapse-serverless SQL pool used by the loom-ui-verify / dax-golden Playwright
# harness (A5, ws-lineage-depth.md).
#
# What it does (idempotent — safe to re-run):
#   1. Uploads the seeded star-schema CSVs
#      (apps/fiab-console/lib/azure/__tests__/dax-golden/data/{sales,date,customer}.csv)
#      to the lakehouse storage account under <filesystem>/dax-golden/.
#   2. Creates the serverless golden DATABASE (default: loom_dax_golden).
#   3. Creates dbo.Sales / dbo.Date / dbo.Customer VIEWS over those CSVs via
#      OPENROWSET, with explicit column types so the loom-native DAX->SQL fold
#      (SUM([Amount]) etc.) returns correct NUMBERS.
#
# The golden numbers the harness asserts are the SAME ones the offline vitest
# cross-check (dax-golden.test.ts) recomputes from these exact CSVs — so seeding
# them here makes the live numeric gate real, against a real backend (no mocks,
# no-vaporware).
#
# HONEST INFRA REQUIREMENTS (no-vaporware — this is an Azure requirement, not a
# Fabric one):
#   - `az login` as a principal (or run the in-VNet ACA job) that holds:
#       * Storage Blob Data Contributor on the lakehouse storage account
#         (to upload the CSVs AND for serverless OPENROWSET AAD passthrough), and
#       * db_owner on the serverless master (to CREATE DATABASE + views).
#   - sqlcmd (mssql-tools) on PATH.
#   - Network line-of-sight to the -ondemand PE endpoint (run in-VNet; the
#     gh-aca-runner / loom-uat job pattern proves this live).
#
# Usage:
#   LOOM_SYNAPSE_WORKSPACE=<ws> LOOM_DLZ_RG=<rg> ./seed-dax-golden.sh
# Optional:
#   LOOM_DAX_GOLDEN_DB=loom_dax_golden   (must match the harness env of the same name)
#   LOOM_DAX_GOLDEN_FS=bronze            (ADLS filesystem/container to stage CSVs in)
#   LOOM_STORAGE_ACCOUNT=<sa>            (else auto-discovered: saloom* in the DLZ RG)
#
# Per-cloud: cloud-neutral tooling. Gov uses the same script with the Gov
# subscription + `-ondemand.sql.azuresynapse.usgovcloudapi.net` endpoint
# (LOOM_SYNAPSE_HOST_SUFFIX override); AAS is NOT involved (loom-native path).

set -euo pipefail
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/../../apps/fiab-console/lib/azure/__tests__/dax-golden/data"

WORKSPACE="${LOOM_SYNAPSE_WORKSPACE:-}"
DLZ_RG="${LOOM_DLZ_RG:-}"
DB="${LOOM_DAX_GOLDEN_DB:-loom_dax_golden}"
FS="${LOOM_DAX_GOLDEN_FS:-bronze}"
STORAGE_ACCOUNT="${LOOM_STORAGE_ACCOUNT:-}"
HOST_SUFFIX="${LOOM_SYNAPSE_HOST_SUFFIX:-sql.azuresynapse.net}"
DFS_SUFFIX="${LOOM_STORAGE_DFS_SUFFIX:-dfs.core.windows.net}"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: set LOOM_SYNAPSE_WORKSPACE (the Synapse workspace name)." >&2
  exit 1
fi
if [[ -z "$STORAGE_ACCOUNT" ]]; then
  if [[ -z "$DLZ_RG" ]]; then
    echo "ERROR: set LOOM_STORAGE_ACCOUNT, or LOOM_DLZ_RG so the saloom* account can be discovered." >&2
    exit 1
  fi
  STORAGE_ACCOUNT=$(az storage account list -g "$DLZ_RG" --query "[?starts_with(name,'saloom')].name | [0]" -o tsv)
fi
if [[ -z "$STORAGE_ACCOUNT" ]]; then
  echo "ERROR: could not resolve the lakehouse storage account (saloom* in $DLZ_RG)." >&2
  exit 1
fi

ENDPOINT="${WORKSPACE}-ondemand.${HOST_SUFFIX}"
BASE_URL="https://${STORAGE_ACCOUNT}.${DFS_SUFFIX}/${FS}/dax-golden"

echo "==> DAX golden seed"
echo "    workspace (serverless): ${ENDPOINT}"
echo "    storage:                ${STORAGE_ACCOUNT}/${FS}/dax-golden"
echo "    golden database:        ${DB}"

# ---------------------------------------------------------------------------
# 1. Upload the seeded CSVs (idempotent overwrite)
# ---------------------------------------------------------------------------
echo "==> [1/3] Uploading reference CSVs to ADLS…"
for t in sales date customer; do
  src="${DATA_DIR}/${t}.csv"
  [[ -f "$src" ]] || { echo "ERROR: missing fixture $src" >&2; exit 1; }
  az storage fs file upload \
    --account-name "$STORAGE_ACCOUNT" \
    --file-system "$FS" \
    --path "dax-golden/${t}.csv" \
    --source "$src" \
    --auth-mode login \
    --overwrite true \
    -o none
  echo "    uploaded ${t}.csv"
done

# ---------------------------------------------------------------------------
# 2. Create the serverless golden database (against master)
# ---------------------------------------------------------------------------
echo "==> [2/3] Ensuring serverless database ${DB}…"
TOKEN=$(az account get-access-token --resource https://database.windows.net --query accessToken -o tsv)

sqlcmd -S "$ENDPOINT" -d master -G -P "$TOKEN" -I -b -Q \
  "IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = '${DB}') CREATE DATABASE [${DB}];"

# ---------------------------------------------------------------------------
# 3. Create the typed views over the CSVs (against the golden DB)
# ---------------------------------------------------------------------------
echo "==> [3/3] Creating dbo.Sales / dbo.Date / dbo.Customer views…"
cat <<SQL | sqlcmd -S "$ENDPOINT" -d "$DB" -G -P "$TOKEN" -I -b
CREATE OR ALTER VIEW dbo.Sales AS
SELECT [Date], [CustomerId], [Amount], [Quantity]
FROM OPENROWSET(
  BULK '${BASE_URL}/sales.csv',
  FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE, FIELDTERMINATOR = ','
) WITH (
  [Date] DATE 1,
  [CustomerId] VARCHAR(16) 2,
  [Amount] DECIMAL(18,2) 3,
  [Quantity] INT 4
) AS r;
GO
CREATE OR ALTER VIEW dbo.[Date] AS
SELECT [Date], [Year], [MonthNumber], [MonthName], [Quarter]
FROM OPENROWSET(
  BULK '${BASE_URL}/date.csv',
  FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE, FIELDTERMINATOR = ','
) WITH (
  [Date] DATE 1,
  [Year] INT 2,
  [MonthNumber] INT 3,
  [MonthName] VARCHAR(16) 4,
  [Quarter] VARCHAR(4) 5
) AS r;
GO
CREATE OR ALTER VIEW dbo.Customer AS
SELECT [CustomerId], [Name], [Region], [Segment]
FROM OPENROWSET(
  BULK '${BASE_URL}/customer.csv',
  FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE, FIELDTERMINATOR = ','
) WITH (
  [CustomerId] VARCHAR(16) 1,
  [Name] VARCHAR(64) 2,
  [Region] VARCHAR(32) 3,
  [Segment] VARCHAR(32) 4
) AS r;
GO
SQL

echo ""
echo "DONE. Golden model seeded."
echo "  Verify: sqlcmd -S ${ENDPOINT} -d ${DB} -G -Q \"SELECT SUM(Amount) FROM dbo.Sales;\"  -- expect 2940.00"
echo "  Harness: LOOM_DAX_GOLDEN_DB=${DB} pnpm exec playwright test e2e/dax-golden.spec.ts --project=dax-golden"
