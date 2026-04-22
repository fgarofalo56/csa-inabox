#!/usr/bin/env bash
# bootstrap-purview.sh — Bootstrap Purview governance for CSA-in-a-Box
#
# Usage:
#   ./scripts/governance/bootstrap-purview.sh \
#     --purview-account csadmlzdevpview \
#     --purview-rg rg-dmlz-dev \
#     --dlz-rg rg-dlz-dev \
#     --env dev
#
# Prerequisites:
#   - az CLI logged in with Purview Collection Admin
#   - az extension add --name purview
#   - jq installed

set -euo pipefail

# ─── Argument Parsing ──────────────────────────────────────────────────────
PURVIEW_ACCOUNT=""
PURVIEW_RG=""
DLZ_RG=""
ENV="dev"
GLOSSARY_FILE=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --purview-account) PURVIEW_ACCOUNT="$2"; shift 2 ;;
    --purview-rg)      PURVIEW_RG="$2"; shift 2 ;;
    --dlz-rg)          DLZ_RG="$2"; shift 2 ;;
    --env)             ENV="$2"; shift 2 ;;
    --glossary-file)   GLOSSARY_FILE="$2"; shift 2 ;;
    --dry-run)         DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: $0 --purview-account NAME --purview-rg RG --dlz-rg RG [--env dev] [--glossary-file path] [--dry-run]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$PURVIEW_ACCOUNT" || -z "$PURVIEW_RG" || -z "$DLZ_RG" ]]; then
  echo "ERROR: --purview-account, --purview-rg, and --dlz-rg are required"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOSSARY_FILE="${GLOSSARY_FILE:-$SCRIPT_DIR/glossary-terms.yaml}"

# ─── Setup ─────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        CSA-in-a-Box Purview Bootstrap                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Purview Account : $PURVIEW_ACCOUNT"
echo "Purview RG      : $PURVIEW_RG"
echo "DLZ RG          : $DLZ_RG"
echo "Environment     : $ENV"
echo "Glossary File   : $GLOSSARY_FILE"
echo "Dry Run         : $DRY_RUN"
echo ""

PURVIEW_ENDPOINT="https://$PURVIEW_ACCOUNT.purview.azure.com"
TOKEN=$(az account get-access-token --resource "https://purview.azure.net" --query accessToken -o tsv)
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ "$DRY_RUN" == true ]]; then
    echo "  [DRY RUN] $method $path"
    return 0
  fi
  if [[ -n "$body" ]]; then
    curl -sf -X "$method" "$PURVIEW_ENDPOINT$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" 2>/dev/null || true
  else
    curl -sf -X "$method" "$PURVIEW_ENDPOINT$path" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null || true
  fi
}

# ─── Step 1: Create Collection Hierarchy ───────────────────────────────────
echo "── Step 1: Creating collection hierarchy ──"

create_collection() {
  local name="$1" friendly="$2" parent="$3" desc="${4:-}"
  echo "  Creating collection: $friendly (under $parent)"
  api PUT "/account/collections/$name?api-version=2019-11-01-preview" '{
    "friendlyName": "'"$friendly"'",
    "parentCollection": { "referenceName": "'"$parent"'", "type": "CollectionReference" },
    "description": "'"${desc:-$friendly data assets}"'"
  }'
}

# Top-level environments
create_collection "production"  "Production"  "$PURVIEW_ACCOUNT" "Production environment assets"
create_collection "staging"     "Staging"      "$PURVIEW_ACCOUNT" "Staging environment assets"
create_collection "development" "Development"  "$PURVIEW_ACCOUNT" "Development environment assets"

# Domain collections under Production
for DOMAIN in Finance Healthcare Environmental Transportation; do
  DOMAIN_LOWER=$(echo "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  create_collection "prod-$DOMAIN_LOWER" "$DOMAIN" "production" "$DOMAIN domain production assets"
done

# Staging sub-collections
create_collection "stg-shared" "Shared" "staging" "Shared staging assets"

# Development sub-collections
create_collection "dev-sandbox" "Sandbox" "development" "Developer sandbox"

echo "  ✓ Collection hierarchy created"
echo ""

# ─── Step 2: Register Data Sources ────────────────────────────────────────
echo "── Step 2: Registering data sources ──"

STORAGE_ACCOUNT="csadlz${ENV}st"
DATABRICKS_WORKSPACE="csadlz${ENV}dbw"
SYNAPSE_NAME="csadlz${ENV}syn"
SQL_SERVER="csadlz${ENV}sql"
COSMOS_NAME="csadlz${ENV}cosmos"

register_source() {
  local name="$1" kind="$2" props="$3"
  echo "  Registering: $name ($kind)"
  api PUT "/scan/datasources/$name?api-version=2022-07-01-preview" '{
    "kind": "'"$kind"'",
    "properties": '"$props"'
  }'
}

register_source "adls-$STORAGE_ACCOUNT" "AzureStorage" '{
  "endpoint": "https://'"$STORAGE_ACCOUNT"'.dfs.core.windows.net/",
  "resourceGroup": "'"$DLZ_RG"'",
  "subscriptionId": "'"$SUBSCRIPTION_ID"'",
  "location": "eastus",
  "resourceName": "'"$STORAGE_ACCOUNT"'",
  "collection": { "referenceName": "production", "type": "CollectionReference" }
}'

register_source "databricks-$DATABRICKS_WORKSPACE" "Databricks" '{
  "workspaceUrl": "https://adb-0000000000000000.0.azuredatabricks.net",
  "resourceGroup": "'"$DLZ_RG"'",
  "subscriptionId": "'"$SUBSCRIPTION_ID"'",
  "location": "eastus",
  "collection": { "referenceName": "production", "type": "CollectionReference" }
}'

register_source "synapse-$SYNAPSE_NAME" "AzureSynapseWorkspace" '{
  "dedicatedSqlEndpoint": "'"$SYNAPSE_NAME"'.sql.azuresynapse.net",
  "serverlessSqlEndpoint": "'"$SYNAPSE_NAME"'-ondemand.sql.azuresynapse.net",
  "resourceGroup": "'"$DLZ_RG"'",
  "subscriptionId": "'"$SUBSCRIPTION_ID"'",
  "location": "eastus",
  "collection": { "referenceName": "production", "type": "CollectionReference" }
}'

register_source "sql-$SQL_SERVER" "AzureSqlDatabase" '{
  "serverEndpoint": "'"$SQL_SERVER"'.database.windows.net",
  "resourceGroup": "'"$DLZ_RG"'",
  "subscriptionId": "'"$SUBSCRIPTION_ID"'",
  "location": "eastus",
  "collection": { "referenceName": "production", "type": "CollectionReference" }
}'

register_source "cosmos-$COSMOS_NAME" "AzureCosmosDb" '{
  "accountEndpoint": "https://'"$COSMOS_NAME"'.documents.azure.com:443/",
  "resourceGroup": "'"$DLZ_RG"'",
  "subscriptionId": "'"$SUBSCRIPTION_ID"'",
  "location": "eastus",
  "collection": { "referenceName": "production", "type": "CollectionReference" }
}'

echo "  ✓ Data sources registered"
echo ""

# ─── Step 3: Create Initial Scan Schedules ────────────────────────────────
echo "── Step 3: Creating scan schedules ──"

create_scan() {
  local source="$1" scan_name="$2" ruleset="$3"
  echo "  Creating scan: $scan_name on $source"
  api PUT "/scan/datasources/$source/scans/$scan_name?api-version=2022-07-01-preview" '{
    "kind": "AzureStorageMsi",
    "properties": {
      "scanRulesetName": "'"$ruleset"'",
      "scanRulesetType": "Custom",
      "collection": { "referenceName": "production", "type": "CollectionReference" }
    }
  }'

  # Set weekly schedule
  api PUT "/scan/datasources/$source/scans/$scan_name/triggers/default?api-version=2022-07-01-preview" '{
    "properties": {
      "scanLevel": "Full",
      "recurrence": {
        "frequency": "Week",
        "interval": 1,
        "startTime": "2025-01-01T02:00:00Z",
        "timezone": "UTC",
        "schedule": { "hours": [2], "minutes": [0], "weekDays": ["Sunday"] }
      }
    }
  }'
}

# Create scan rulesets first
echo "  Creating scan rulesets..."
api PUT "/scan/scanrulesets/csa-adls-ruleset?api-version=2022-07-01-preview" '{
  "kind": "AzureStorage",
  "properties": {
    "description": "CSA-in-a-Box ADLS scan ruleset",
    "includedCustomClassificationRuleNames": [
      "CSA_PII_SSN", "CSA_PII_EMAIL", "CSA_PII_PHONE",
      "CSA_PHI_MRN", "CSA_FIN_ACCOUNT_NUMBER",
      "CSA_GOV_EIN", "CSA_GOV_TRIBAL_ENROLLMENT_ID"
    ],
    "scanRulesetType": "Custom"
  }
}'

api PUT "/scan/scanrulesets/csa-synapse-ruleset?api-version=2022-07-01-preview" '{
  "kind": "AzureSynapseWorkspace",
  "properties": {
    "description": "CSA-in-a-Box Synapse scan ruleset",
    "includedCustomClassificationRuleNames": [
      "CSA_PII_SSN", "CSA_PII_EMAIL", "CSA_FIN_ACCOUNT_NUMBER"
    ],
    "scanRulesetType": "Custom"
  }
}'

# Create scans
create_scan "adls-$STORAGE_ACCOUNT" "weekly-full-scan" "csa-adls-ruleset"

echo "  ✓ Scan schedules created"
echo ""

# ─── Step 4: Seed Business Glossary ───────────────────────────────────────
echo "── Step 4: Seeding business glossary ──"

if [[ -f "$GLOSSARY_FILE" ]]; then
  if command -v python3 &>/dev/null; then
    echo "  Running seed-glossary.py..."
    if [[ "$DRY_RUN" == true ]]; then
      python3 "$SCRIPT_DIR/seed-glossary.py" \
        --purview-account "$PURVIEW_ACCOUNT" \
        --glossary-file "$GLOSSARY_FILE" \
        --dry-run
    else
      python3 "$SCRIPT_DIR/seed-glossary.py" \
        --purview-account "$PURVIEW_ACCOUNT" \
        --glossary-file "$GLOSSARY_FILE"
    fi
  else
    echo "  WARNING: Python 3 not found. Skipping glossary seeding."
    echo "  Run manually: python scripts/governance/seed-glossary.py --purview-account $PURVIEW_ACCOUNT --glossary-file $GLOSSARY_FILE"
  fi
else
  echo "  WARNING: Glossary file not found at $GLOSSARY_FILE"
fi

echo "  ✓ Glossary seeded"
echo ""

# ─── Step 5: Create Custom Classifications ───────────────────────────────
echo "── Step 5: Creating custom classifications ──"

create_classification() {
  local name="$1" desc="$2" data_pattern="$3" col_pattern="$4" min_pct="${5:-60.0}"
  echo "  Creating classification: $name"
  api PUT "/scan/classificationrules/$name?api-version=2022-07-01-preview" '{
    "kind": "Custom",
    "properties": {
      "description": "'"$desc"'",
      "classificationName": "'"$name"'",
      "ruleStatus": "Enabled",
      "minimumPercentageMatch": '"$min_pct"',
      "dataPatterns": [{ "pattern": "'"$data_pattern"'" }],
      "columnPatterns": [{ "pattern": "'"$col_pattern"'" }]
    }
  }'
}

create_classification \
  "CSA_PII_SSN" \
  "US Social Security Number" \
  '\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b' \
  '(?i)(ssn|social_security|ss_number)' \
  60.0

create_classification \
  "CSA_GOV_EIN" \
  "US Employer Identification Number" \
  '\\b\\d{2}-\\d{7}\\b' \
  '(?i)(ein|employer_id|tax_id|fein)' \
  70.0

create_classification \
  "CSA_GOV_TRIBAL_ENROLLMENT_ID" \
  "Tribal Enrollment ID" \
  '\\b[A-Z]{2,4}-\\d{4,8}\\b' \
  '(?i)(tribal_id|enrollment_id|tribal_enrollment)' \
  60.0

create_classification \
  "CSA_PHI_MRN" \
  "Medical Record Number" \
  '\\b(MRN|mrn)[- ]?\\d{6,10}\\b' \
  '(?i)(mrn|medical_record|patient_id)' \
  50.0

create_classification \
  "CSA_FIN_ACCOUNT_NUMBER" \
  "Financial Account Number" \
  '\\b\\d{8,17}\\b' \
  '(?i)(account_number|acct_num|bank_account)' \
  70.0

echo "  ✓ Custom classifications created"
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        Bootstrap Complete                               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Configure managed identity permissions (see PURVIEW_SETUP.md Step 3)"
echo "  2. Approve ingestion private endpoints on data sources"
echo "  3. Run the first scan: az purview scan run ..."
echo "  4. Review classification results in Purview Studio"
echo "  5. Set up lineage (see DATA_LINEAGE.md)"
