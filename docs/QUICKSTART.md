# CSA-in-a-Box: Quick Start Guide

Get a working Cloud-Scale Analytics platform deployed and flowing data in
under 30 minutes.

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
git clone https://github.com/your-org/csa-inabox.git
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

```bash
cd domains/shared/dbt

# Build all layers in sequence
dbt run --select tag:bronze    # Bronze: raw ingestion
dbt run --select tag:silver    # Silver: validation + dedup
dbt run --select tag:gold      # Gold: dimensions + facts + metrics

# Run all tests
dbt test
```

### Expected Row Counts

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

```
csa-inabox/
  deploy/bicep/           # Infrastructure as Code (4 landing zones)
  domains/
    shared/               # Shared domain (customers, orders, products)
      dbt/                #   dbt models: Bronze -> Silver -> Gold
      notebooks/          #   Databricks notebooks
      pipelines/adf/      #   ADF pipeline definitions
    finance/              # Finance domain (invoices, payments)
      dbt/                #   Finance-specific dbt models
      data-products/      #   Data product contracts
    sales/                # Sales domain
      data-products/      #   Orders data product contract
      pipelines/adf/      #   Sales-specific ADF pipelines
  governance/             # Cross-cutting governance
    common/               #   Logging, validation, contracts
    purview/              #   Catalog config, glossary, classification
    dataquality/          #   Great Expectations runner
  scripts/
    deploy/               # Deployment orchestration
    seed/                 # Sample data loader
    streaming/            # Event producer + ADX setup
    purview/              # Catalog bootstrap
  tests/                  # Unit tests (pytest)
```

## Next Steps

- **Add a new domain**: Copy `domains/finance/` as a template, update `dbt_project.yml`
- **Add a data product**: Create `contract.yaml` under `data-products/`
- **Add quality rules**: Extend `governance/dataquality/` with Great Expectations checkpoints
- **Scale streaming**: Increase Event Hub partitions, add ADX scaling policies
- **Production hardening**: See `docs/PRODUCTION_CHECKLIST.md`
