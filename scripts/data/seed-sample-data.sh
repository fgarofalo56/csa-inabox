#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# seed-sample-data.sh — Upload seed CSVs and optionally generate synthetic data
# ---------------------------------------------------------------------------
# Uploads CSV seed files from domains/shared/dbt/seeds/ to ADLS Gen2 bronze
# layer paths for each domain. Optionally generates additional synthetic
# data using Python/faker for development and testing.
#
# Prerequisites:
#   - Azure CLI (az) logged in with storage permissions
#   - azcopy v10+ (for bulk upload)
#   - Python 3.9+ with faker (optional, for synthetic data generation)
#
# Usage:
#   ./seed-sample-data.sh \
#       --storage-account <NAME> \
#       --container bronze \
#       [--env dev] \
#       [--generate-synthetic] \
#       [--synthetic-rows 1000]
#
# Safety:
#   Only runs in dev or test environments. Will abort if --env is set to
#   staging or production.
# ---------------------------------------------------------------------------
set -euo pipefail

# ─── Defaults ───────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SEEDS_DIR="$REPO_ROOT/domains/shared/dbt/seeds"
ENVIRONMENT="dev"
CONTAINER="bronze"
STORAGE_ACCOUNT=""
GENERATE_SYNTHETIC=false
SYNTHETIC_ROWS=1000
LOG_DIR="./temp/seed-logs"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

# ─── Usage ──────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
Usage: $(basename "$0") --storage-account <NAME> [OPTIONS]

Required:
  --storage-account NAME    ADLS Gen2 storage account name

Options:
  --container NAME          Target container (default: bronze)
  --env ENV                 Environment: dev|test (default: dev)
  --generate-synthetic      Generate synthetic data using Python/faker
  --synthetic-rows N        Number of synthetic rows per table (default: 1000)
  --seeds-dir PATH          Override seeds directory
  -h, --help                Show this help

Safety:
  This script only runs in dev or test environments.
EOF
    exit 1
}

# ─── Parse Arguments ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --storage-account) STORAGE_ACCOUNT="$2"; shift 2 ;;
        --container)       CONTAINER="$2";       shift 2 ;;
        --env)             ENVIRONMENT="$2";     shift 2 ;;
        --generate-synthetic) GENERATE_SYNTHETIC=true; shift ;;
        --synthetic-rows)  SYNTHETIC_ROWS="$2";  shift 2 ;;
        --seeds-dir)       SEEDS_DIR="$2";       shift 2 ;;
        -h|--help)         usage                          ;;
        *)                 echo "Unknown option: $1"; usage ;;
    esac
done

[[ -z "$STORAGE_ACCOUNT" ]] && { echo "ERROR: --storage-account is required"; usage; }

# ─── Environment Safety Check ─────────────────────────────────────────────
ENVIRONMENT_LOWER=$(echo "$ENVIRONMENT" | tr '[:upper:]' '[:lower:]')
case "$ENVIRONMENT_LOWER" in
    dev|test|development|testing)
        echo "Environment: $ENVIRONMENT_LOWER (allowed)"
        ;;
    staging|stg|production|prod|prd)
        echo "ERROR: Seeding is not allowed in '$ENVIRONMENT_LOWER' environments."
        echo "This script is intended for dev/test only."
        exit 1
        ;;
    *)
        echo "WARNING: Unrecognized environment '$ENVIRONMENT_LOWER'. Treating as dev."
        ;;
esac

# ─── Pre-flight ────────────────────────────────────────────────────────────
command -v az >/dev/null 2>&1 || {
    echo "ERROR: Azure CLI (az) is not installed."
    exit 1
}

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/seed_${TIMESTAMP}.log"

log() {
    echo "[$(date -u +"%Y-%m-%d %H:%M:%S UTC")] $*" | tee -a "$LOG_FILE"
}

ADLS_BASE="https://${STORAGE_ACCOUNT}.dfs.core.windows.net/${CONTAINER}"

log "Seed data upload starting"
log "  Storage:   $STORAGE_ACCOUNT"
log "  Container: $CONTAINER"
log "  Seeds dir: $SEEDS_DIR"
log "  Env:       $ENVIRONMENT_LOWER"
log "  Synthetic: $GENERATE_SYNTHETIC (rows: $SYNTHETIC_ROWS)"

# ─── Upload Seed CSVs ─────────────────────────────────────────────────────
log "Uploading seed CSV files from $SEEDS_DIR..."

if [[ ! -d "$SEEDS_DIR" ]]; then
    log "ERROR: Seeds directory not found: $SEEDS_DIR"
    exit 1
fi

# Domain path mapping for each seed file
declare -A SEED_PATHS
SEED_PATHS["sample_customers.csv"]="shared/customers"
SEED_PATHS["sample_orders.csv"]="shared/orders"
SEED_PATHS["sample_products.csv"]="shared/products"

UPLOADED=0
for csv_file in "$SEEDS_DIR"/*.csv; do
    [[ -f "$csv_file" ]] || continue

    filename=$(basename "$csv_file")
    target_path="${SEED_PATHS[$filename]:-shared/$(basename "$filename" .csv)}"

    dest_url="${ADLS_BASE}/${target_path}/${filename}"
    log "  Uploading: $filename -> $dest_url"

    az storage fs file upload \
        --source "$csv_file" \
        --file-system "$CONTAINER" \
        --path "${target_path}/${filename}" \
        --account-name "$STORAGE_ACCOUNT" \
        --auth-mode login \
        --overwrite true \
        2>&1 | tee -a "$LOG_FILE"

    UPLOADED=$((UPLOADED + 1))
done

log "Uploaded $UPLOADED seed files"

# ─── Create Domain Bronze Paths ───────────────────────────────────────────
log "Ensuring bronze layer paths exist for each domain..."

DOMAINS=("shared" "finance" "inventory" "sales")
for domain in "${DOMAINS[@]}"; do
    dir_path="${domain}/.domain"
    log "  Creating path: $CONTAINER/$dir_path"

    # Create a marker file to ensure the directory exists in ADLS
    echo "domain=$domain" | az storage fs file upload \
        --file-system "$CONTAINER" \
        --path "${domain}/.domain_marker" \
        --account-name "$STORAGE_ACCOUNT" \
        --auth-mode login \
        --overwrite true \
        --source /dev/stdin \
        2>&1 | tee -a "$LOG_FILE" || log "  (path may already exist)"
done

# ─── Generate Synthetic Data ──────────────────────────────────────────────
if [[ "$GENERATE_SYNTHETIC" == "true" ]]; then
    log "Generating synthetic data with Python/faker..."

    python3 -c "import faker" 2>/dev/null || {
        log "WARNING: Python 'faker' package not installed."
        log "  Install with: pip install faker"
        log "  Skipping synthetic data generation."
        GENERATE_SYNTHETIC=false
    }
fi

if [[ "$GENERATE_SYNTHETIC" == "true" ]]; then
    SYNTHETIC_DIR="$LOG_DIR/synthetic_${TIMESTAMP}"
    mkdir -p "$SYNTHETIC_DIR"

    python3 << PYEOF
import csv
import random
from datetime import datetime, timedelta
from faker import Faker

fake = Faker()
Faker.seed(42)
random.seed(42)

ROWS = $SYNTHETIC_ROWS

# --- Synthetic Invoices (finance domain) ---
with open("$SYNTHETIC_DIR/synthetic_invoices.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["invoice_id", "order_id", "customer_id", "invoice_date",
                "due_date", "total_amount", "tax_amount", "status",
                "_ingested_at"])
    for i in range(1, ROWS + 1):
        inv_date = fake.date_between(start_date="-2y", end_date="today")
        due_date = inv_date + timedelta(days=random.choice([30, 45, 60]))
        amount = round(random.uniform(50, 5000), 2)
        tax = round(amount * 0.08, 2)
        status = random.choice(["PAID", "UNPAID", "OVERDUE", "PARTIAL"])
        w.writerow([
            i, random.randint(1, 500), random.randint(1, 200),
            inv_date.isoformat(), due_date.isoformat(),
            amount, tax, status, datetime.utcnow().isoformat(),
        ])

# --- Synthetic Inventory (inventory domain) ---
with open("$SYNTHETIC_DIR/synthetic_inventory.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["inventory_id", "product_id", "warehouse_id", "qty_on_hand",
                "qty_reserved", "reorder_point", "safety_stock",
                "last_restocked_at", "_ingested_at"])
    for i in range(1, ROWS + 1):
        qty = random.randint(0, 500)
        reserved = random.randint(0, min(qty, 100))
        reorder = random.randint(10, 100)
        w.writerow([
            i, random.randint(1, 50), random.randint(1, 10),
            qty, reserved, reorder, int(reorder * 0.5),
            fake.date_time_between(start_date="-6m").isoformat(),
            datetime.utcnow().isoformat(),
        ])

# --- Synthetic Sales Orders (sales domain) ---
with open("$SYNTHETIC_DIR/synthetic_sales_orders.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["order_id", "customer_id", "product_id", "quantity",
                "unit_price", "order_date", "sales_region",
                "sales_channel", "_ingested_at"])
    regions = ["EAST", "WEST", "SOUTH", "CENTRAL"]
    channels = ["ONLINE", "RETAIL", "WHOLESALE", "PARTNER"]
    for i in range(1, ROWS + 1):
        w.writerow([
            i, random.randint(1, 200), random.randint(1, 50),
            random.randint(1, 20),
            round(random.uniform(5, 500), 2),
            fake.date_between(start_date="-1y").isoformat(),
            random.choice(regions), random.choice(channels),
            datetime.utcnow().isoformat(),
        ])

print(f"Generated {ROWS} rows each for invoices, inventory, and sales_orders")
PYEOF

    # Upload synthetic data
    log "Uploading synthetic data..."

    declare -A SYNTH_PATHS
    SYNTH_PATHS["synthetic_invoices.csv"]="finance/invoices"
    SYNTH_PATHS["synthetic_inventory.csv"]="inventory/inventory"
    SYNTH_PATHS["synthetic_sales_orders.csv"]="sales/sales_orders"

    for synth_file in "$SYNTHETIC_DIR"/*.csv; do
        [[ -f "$synth_file" ]] || continue
        filename=$(basename "$synth_file")
        target_path="${SYNTH_PATHS[$filename]:-shared/synthetic}"

        log "  Uploading: $filename -> $CONTAINER/$target_path/"
        az storage fs file upload \
            --source "$synth_file" \
            --file-system "$CONTAINER" \
            --path "${target_path}/${filename}" \
            --account-name "$STORAGE_ACCOUNT" \
            --auth-mode login \
            --overwrite true \
            2>&1 | tee -a "$LOG_FILE"
    done

    log "Synthetic data upload complete"
fi

# ─── Summary ───────────────────────────────────────────────────────────────
log "Seed data upload finished"
log "  Files uploaded: $UPLOADED seed CSVs"
if [[ "$GENERATE_SYNTHETIC" == "true" ]]; then
    log "  Synthetic data: $SYNTHETIC_ROWS rows per domain table"
fi
log "  Log file: $LOG_FILE"
