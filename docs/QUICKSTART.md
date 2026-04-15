# CSA-in-a-Box: Quick Start Guide

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** New Users

Get a working Cloud-Scale Analytics platform deployed and flowing data in
about 60-90 minutes (assuming all prerequisites are met).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1: Deploy Infrastructure](#step-1-deploy-infrastructure)
- [Step 2: Load Sample Data](#step-2-load-sample-data)
- [Step 3: Run the dbt Pipeline](#step-3-run-the-dbt-pipeline)
  - [Expected Row Counts](#expected-row-counts)
- [Step 4: Run ADF Orchestration (Optional)](#step-4-run-adf-orchestration-optional)
- [Step 5: Explore the Data](#step-5-explore-the-data)
  - [Query Silver (validation results)](#query-silver-validation-results)
  - [Query Gold (business metrics)](#query-gold-business-metrics)
- [Step 6: Start Streaming (Optional)](#step-6-start-streaming-optional)
- [Step 7: Bootstrap Purview Catalog (Optional)](#step-7-bootstrap-purview-catalog-optional)
- [Project Structure](#project-structure)
- [Quick Start: Run a Vertical Example (USDA)](#quick-start-run-a-vertical-example-usda)
  - [Step A: Generate Seed Data](#step-a-generate-seed-data)
  - [Step B: Load Seeds and Run dbt](#step-b-load-seeds-and-run-dbt)
  - [Step C: Explore Results](#step-c-explore-results)
- [Quick Start: Deploy the Portal](#quick-start-deploy-the-portal)
  - [Step A: Start the Shared Backend](#step-a-start-the-shared-backend)
  - [Step B: Start a Frontend](#step-b-start-a-frontend)
  - [Step C: Register a Data Source](#step-c-register-a-data-source)
- [Quick Start: Platform Services](#quick-start-platform-services)
  - [Step A: Deploy Shared Services (Azure Functions)](#step-a-deploy-shared-services-azure-functions)
  - [Step B: Deploy the Data Marketplace](#step-b-deploy-the-data-marketplace)
  - [Step C: Configure AI Integration](#step-c-configure-ai-integration)
- [Quick Start: Azure Government](#quick-start-azure-government)
  - [Step A: Switch to Government Cloud](#step-a-switch-to-government-cloud)
  - [Step B: Deploy with Gov Parameters](#step-b-deploy-with-gov-parameters)
  - [Step C: Verify Compliance Tags](#step-c-verify-compliance-tags)
  - [Government-Specific Notes](#government-specific-notes)
- [Next Steps](#next-steps)

## Prerequisites

| Tool | Minimum Version | Check |
|------|----------------|-------|
| Azure CLI | 2.50+ | `az version` |
| Bicep CLI | 0.22+ | `az bicep version` |
| Python | 3.10+ | `python --version` |
| dbt | 1.7+ | `dbt --version` |
| git | 2.x | `git --version` |

```bash
# Validate all prerequisites at once:
bash scripts/deploy/validate-prerequisites.sh
```

## Step 1: Deploy Infrastructure

```bash
# Clone the repo
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox

# Set up Python environment
make setup  # or make setup-win on Windows

# Deploy to dev (what-if first)
bash scripts/deploy/deploy-platform.sh --environment dev --dry-run

# Deploy for real
bash scripts/deploy/deploy-platform.sh --environment dev
```

The deployment script deploys three landing zones in order:
1. **ALZ** (Management) - logging, monitoring, policies
2. **DMLZ** (Data Management) - Purview, Key Vault, shared services
3. **DLZ** (Data Landing Zone) - ADF, Databricks, Synapse, ADLS, Event Hub

## Step 2: Load Sample Data

CSA-in-a-Box ships with realistic seed data:

| Dataset | Rows | Quality Issues |
|---------|------|----------------|
| `sample_customers.csv` | 200 | ~5% (bad emails, missing names) |
| `sample_orders.csv` | 2,000 | ~5% (null customer_id, future dates, negative amounts) |
| `sample_products.csv` | 50 | Clean |
| `sample_invoices.csv` | 500 | ~3% (null order_id, negative amounts) |
| `sample_payments.csv` | 400 | Clean |
| `sample_inventory.csv` | 300 | ~3% (null product_id, negative qty, overreserved) |
| `sample_warehouses.csv` | 8 | Clean |
| `raw_sales_orders.csv` | 1,000 | ~5% (negative prices, future dates, invalid qty) |

```bash
# Option A: Upload to ADLS Gen2 (requires deployed storage account)
python scripts/seed/load_sample_data.py \
    --storage-account <your-storage-account> \
    --container raw

# Option B: Load via dbt seed (local or Databricks)
cd domains/shared/dbt
dbt seed --profiles-dir .
```

## Step 3: Run the dbt Pipeline

Each domain has its own dbt project. Run them in order:

```bash
# Shared domain (foundation — customers, orders, products)
cd domains/shared/dbt
dbt deps
dbt seed
dbt run --select tag:bronze
dbt run --select tag:silver
dbt run --select tag:gold
dbt test

# Finance domain (invoices, payments, reconciliation)
cd ../../finance/dbt
dbt deps
dbt seed
dbt run --select tag:bronze
dbt run --select tag:silver
dbt run --select tag:gold
dbt test

# Inventory domain (stock levels, warehouses, reorder alerts)
cd ../../inventory/dbt
dbt deps
dbt seed
dbt run --select tag:bronze
dbt run --select tag:silver
dbt run --select tag:gold
dbt test

# Sales domain (sales orders, metrics)
cd ../../sales/dbt
dbt deps
dbt seed
dbt run --select tag:bronze
dbt run --select tag:silver
dbt run --select tag:gold
dbt test
```

### Expected Row Counts

**Shared Domain:**

| Layer | Model | Expected Rows |
|-------|-------|--------------|
| Bronze | `brz_orders` | 2,000 |
| Bronze | `brz_customers` | 200 |
| Bronze | `brz_products` | 50 |
| Silver | `slv_orders` | 2,000 (all rows, ~100 flagged invalid) |
| Silver | `slv_customers` | 200 (all rows, ~10 flagged invalid) |
| Silver | `slv_products` | 50 |
| Gold | `fact_orders` | ~1,900 (valid orders only) |
| Gold | `dim_customers` | ~190 (valid customers only) |
| Gold | `dim_products` | 50 |
| Gold | `gld_daily_order_metrics` | ~1,095 (unique dates) |
| Gold | `gld_customer_lifetime_value` | ~190 |
| Gold | `gld_monthly_revenue` | ~36 (months x countries) |

**Finance Domain:**

| Layer | Model | Expected Rows |
|-------|-------|--------------|
| Bronze | `brz_invoices` | 500 |
| Bronze | `brz_payments` | 400 |
| Silver | `slv_invoices` | 500 (all rows, ~15 flagged invalid) |
| Silver | `slv_payments` | 400 |
| Gold | `gld_aging_report` | ~485 (valid invoices) |
| Gold | `gld_revenue_reconciliation` | ~2,000+ (full outer join orders↔invoices) |

**Inventory Domain:**

| Layer | Model | Expected Rows |
|-------|-------|--------------|
| Bronze | `brz_inventory` | 300 |
| Bronze | `brz_warehouses` | 8 |
| Silver | `slv_inventory` | 300 (all rows, ~11 flagged invalid) |
| Silver | `slv_warehouses` | 8 |
| Gold | `dim_warehouses` | 8 |
| Gold | `fact_inventory_snapshot` | ~289 (valid inventory) |
| Gold | `gld_reorder_alerts` | varies (products below reorder point) |
| Gold | `gld_inventory_turnover` | ~50 (one per product) |

**Sales Domain:**

| Layer | Model | Expected Rows |
|-------|-------|--------------|
| Bronze | `brz_sales_orders` | 1,000 |
| Silver | `slv_sales_orders` | 1,000 (all rows, ~45 flagged invalid) |
| Gold | `gld_sales_metrics` | varies (date × region × channel) |

## Step 4: Run ADF Orchestration (Optional)

If ADF is deployed, trigger the master pipeline:

```bash
az datafactory pipeline create-run \
    --factory-name <adf-name> \
    --resource-group <rg-name> \
    --name pl_medallion_orchestration \
    --parameters '{"domain":"shared","entities":["sample_customers","sample_orders","sample_products"]}'
```

The orchestration pipeline:
1. Ingests each entity to Bronze (parallel ForEach)
2. Runs dbt Bronze models
3. Runs dbt Silver models
4. Runs dbt Gold models
5. Sends alerts on failure

## Step 5: Explore the Data

### Query Silver (validation results)
```sql
-- See flagged records in Silver
SELECT order_id, is_valid, validation_errors
FROM silver.slv_orders
WHERE is_valid = FALSE
LIMIT 20;
```

### Query Gold (business metrics)
```sql
-- Daily revenue
SELECT order_date, total_orders, total_revenue, cancellation_rate_pct
FROM gold.gld_daily_order_metrics
ORDER BY order_date DESC
LIMIT 30;

-- Customer lifetime value
SELECT customer_id, first_name, last_name, lifetime_revenue,
       customer_segment, value_tier
FROM gold.gld_customer_lifetime_value
ORDER BY lifetime_revenue DESC
LIMIT 20;

-- Cross-domain reconciliation (finance)
SELECT reconciliation_status, COUNT(*) as count,
       SUM(ABS(amount_difference)) as total_discrepancy
FROM gold.gld_revenue_reconciliation
GROUP BY reconciliation_status;
```

## Step 6: Start Streaming (Optional)

```bash
# Produce sample events to Event Hub
python scripts/streaming/produce_events.py \
    --event-hub-namespace <namespace> \
    --event-hub-name events \
    --rate 50 \
    --duration 120
```

Events flow through: **Event Hub** -> **Event Processing Function** -> **Cosmos DB** + **ADX**

Monitor in real-time via ADX:
```kql
RawEvents
| where timestamp > ago(15m)
| summarize count() by type, bin(timestamp, 1m)
| render timechart
```

## Step 7: Bootstrap Purview Catalog (Optional)

```bash
python scripts/purview/bootstrap_catalog.py \
    --purview-account <purview-name> \
    --storage-account <storage-name>
```

This creates:
- Collection hierarchy (csa-inabox > shared, sales, finance)
- Business glossary terms (Customer, Order, Product, Invoice, Revenue, etc.)
- Scan sources for ADLS Bronze/Silver/Gold containers

## Project Structure

```text
csa-inabox/
  deploy/bicep/           # Infrastructure as Code (4 landing zones)
  domains/
    shared/               # Shared domain (customers, orders, products)
      dbt/                #   dbt models: Bronze -> Silver -> Gold
      notebooks/          #   Databricks notebooks
      pipelines/adf/      #   ADF pipeline definitions
      data-products/      #   Data product contracts
    finance/              # Finance domain (invoices, payments)
      dbt/                #   Finance-specific dbt models
      data-products/      #   Data product contracts
    inventory/            # Inventory domain (stock, warehouses)
      dbt/                #   Inventory-specific dbt models
      data-products/      #   Data product contracts
    sales/                # Sales domain (sales orders, metrics)
      dbt/                #   Sales-specific dbt models
      data-products/      #   Orders data product contract
      pipelines/adf/      #   Sales-specific ADF pipelines
  governance/             # Cross-cutting governance
    common/               #   Logging, validation, contracts
    contracts/            #   Contract validator + dbt test generator
    purview/              #   Catalog config, glossary, classification
    dataquality/          #   Great Expectations runner
  scripts/
    deploy/               # Deployment orchestration
    seed/                 # Sample data loader
    streaming/            # Event producer + ADX setup
    purview/              # Catalog bootstrap
  tests/                  # Unit tests (pytest)
```

## Quick Start: Run a Vertical Example (USDA)

Run the USDA agriculture analytics vertical end-to-end without deploying full
infrastructure (uses local Databricks or DuckDB adapter).

### Step A: Generate Seed Data

```bash
cd examples/usda

# Generate realistic USDA NASS-style seed data
python data/generators/generate_usda_data.py --output data/seeds/
```

### Step B: Load Seeds and Run dbt

```bash
cd examples/usda/domains/dbt

# Install dependencies
dbt deps

# Load seed CSVs into your warehouse
dbt seed --profiles-dir .

# Run the full medallion pipeline
dbt run --select tag:bronze
dbt run --select tag:silver
dbt run --select tag:gold

# Validate results
dbt test
```

### Step C: Explore Results

```sql
-- Crop production by state
SELECT state_name, commodity_desc, year,
       SUM(value) AS total_production
FROM gold.gld_crop_yield_forecast
WHERE year >= 2020
GROUP BY state_name, commodity_desc, year
ORDER BY total_production DESC
LIMIT 20;
```

---

## Quick Start: Deploy the Portal

Run the data onboarding portal locally with the shared backend and React
frontend.

### Step A: Start the Shared Backend

```bash
cd portal/shared

# Install Python dependencies
pip install -r requirements.txt

# Start the FastAPI backend
uvicorn api.app:app --reload --port 8000

# Verify: http://localhost:8000/docs (Swagger UI)
```

### Step B: Start a Frontend

**React/Next.js (recommended):**
```bash
cd portal/react-webapp
npm install
npm run dev
# Open http://localhost:3000
```

**Static Web App (lightweight):**
```bash
cd portal/static-webapp
npm install
npm run dev
# Open http://localhost:4280
```

**Docker Compose (both at once):**
```bash
cd portal
docker-compose up
# Backend: http://localhost:8000
# Frontend: http://localhost:3000
```

### Step C: Register a Data Source

1. Open the portal at `http://localhost:3000`
2. Click **Register New Source**
3. Fill in source details (name, type, connection, schedule)
4. The backend provisions a DLZ pipeline and registers the source in Purview

---

## Quick Start: Platform Services

Deploy shared platform services that provide Fabric-equivalent capabilities.

### Step A: Deploy Shared Services (Azure Functions)

```bash
cd platform/shared-services/functions

# Install dependencies
pip install -r requirements.txt

# Test locally
func start

# Deploy to Azure
func azure functionapp publish <your-function-app-name> --python
```

### Step B: Deploy the Data Marketplace

```bash
# Deploy infrastructure
az deployment group create \
  --resource-group rg-platform \
  --template-file platform/data_marketplace/deploy/marketplace.bicep

# Initialize the catalog
python platform/data_marketplace/api/marketplace_api.py --init
```

### Step C: Configure AI Integration

```bash
# Set environment variables
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
export AZURE_OPENAI_API_KEY=<your-key>
export AZURE_OPENAI_DEPLOYMENT=gpt-4

# Test document classification
python -c "
from platform.ai_integration.enrichment.document_classifier import classify
result = classify('This invoice contains patient health records...')
print(result)
"
```

See [PLATFORM_SERVICES.md](PLATFORM_SERVICES.md) for the full deployment guide.

---

## Quick Start: Azure Government

Deploy CSA-in-a-Box to Azure Government with FedRAMP-compliant configuration.

### Step A: Switch to Government Cloud

```bash
# Set Azure CLI to Government
az cloud set --name AzureUSGovernment
az login

# Verify you're in the right cloud
az cloud show --query name -o tsv
# Expected: AzureUSGovernment
```

### Step B: Deploy with Gov Parameters

```bash
# Deploy using Government parameter files
bash scripts/deploy/deploy-platform.sh \
  --environment gov-dev \
  --location usgovvirginia

# Or deploy individual templates
az deployment sub create \
  --location usgovvirginia \
  --template-file deploy/bicep/gov/main.bicep \
  --parameters deploy/bicep/gov/params.gov-dev.json
```

### Step C: Verify Compliance Tags

```bash
# Check that compliance tags were applied
az group list \
  --query "[?tags.FedRAMP_Level=='High']" \
  -o table

# Verify endpoints are using .us domains
az storage account show \
  --name <storage-account> \
  --query "primaryEndpoints.dfs" \
  -o tsv
# Expected: https://<name>.dfs.core.usgovcloudapi.net/
```

### Government-Specific Notes

- All services use `.us` / `.usgovcloudapi.net` endpoints
- Compliance tags are auto-applied: FedRAMP High, FISMA, NIST 800-53 Rev5
- Microsoft Fabric is NOT available in Gov — this repo provides the alternative
- See [GOV_SERVICE_MATRIX.md](GOV_SERVICE_MATRIX.md) for service availability

---

## Next Steps

- **Add a new domain**: Copy `domains/finance/` as a template, update `dbt_project.yml`
- **Add a data product**: Create `contract.yaml` under `data-products/`
- **Add quality rules**: Extend `governance/dataquality/` with Great Expectations checkpoints
- **Scale streaming**: Increase Event Hub partitions, add ADX scaling policies
- **Production hardening**: See [`docs/PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md)
- **Architecture deep-dive**: See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
- **Platform services**: See [`docs/PLATFORM_SERVICES.md`](PLATFORM_SERVICES.md)
- **Azure Government**: See [`docs/GOV_SERVICE_MATRIX.md`](GOV_SERVICE_MATRIX.md)

---

## Related Documentation

- [Getting Started](GETTING_STARTED.md) — Prerequisites and deployment walkthrough
- [Architecture](ARCHITECTURE.md) — Comprehensive architecture reference
- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and fixes
- [ADF Setup](../scripts/deploy/deploy-adf.sh) — ADF deployment helper script
