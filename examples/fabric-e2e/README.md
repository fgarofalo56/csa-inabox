# Fabric End-to-End — Retail Sales Lakehouse + Direct Lake Semantic Model

> **Status:** Real, deployable end-to-end Microsoft Fabric example. Workspace + Lakehouse + OneLake shortcuts to ADLS gold + Direct Lake semantic model (Power BI Project / TMDL format) + dbt medallion build-out + 4 data contracts + sample CSV data + ARCHITECTURE.md. Deploy in ~25 minutes if you have a Fabric capacity.

A turnkey reference for: **how does a real Fabric workload look on disk and in IaC?**

## What's in this folder

```
fabric-e2e/
├── README.md                      # this file
├── ARCHITECTURE.md                # mermaid diagrams + design rationale
├── deploy/
│   ├── bicep/
│   │   └── main.bicep             # Fabric capacity (F2/F4/F8 by env)
│   ├── fabric/
│   │   ├── deploy.sh              # az rest calls to provision workspace,
│   │   │                          # lakehouse, shortcut, and import semantic model
│   │   └── workspace.json         # workspace metadata
│   └── README.md                  # deployment walkthrough
├── semantic-model/                # POWER BI PROJECT (PBIP) — TMDL format
│   └── retail-sales.SemanticModel/
│       ├── definition.pbism
│       ├── diagramLayout.json
│       └── definition/
│           ├── model.tmdl
│           ├── relationships.tmdl
│           ├── tables/
│           │   ├── DimCustomer.tmdl
│           │   ├── DimProduct.tmdl
│           │   ├── DimDate.tmdl
│           │   └── FactSales.tmdl
│           └── cultures/
│               └── en-US.tmdl
├── dbt/                            # medallion transformation project
│   ├── dbt_project.yml
│   ├── profiles.yml
│   ├── models/
│   │   ├── bronze/
│   │   │   ├── _sources.yml
│   │   │   └── bronze_*.sql
│   │   ├── silver/
│   │   │   └── silver_*.sql
│   │   └── gold/
│   │       ├── _gold_schema.yml
│   │       ├── dim_customer.sql
│   │       ├── dim_product.sql
│   │       ├── dim_date.sql
│   │       └── fact_sales.sql
│   └── tests/
├── sample_data/                   # tiny synthetic data to bootstrap
│   ├── customers.csv
│   ├── products.csv
│   └── sales.csv
├── contracts/                     # data contracts for gold star schema
│   ├── dim_customer.yaml
│   ├── dim_product.yaml
│   ├── dim_date.yaml
│   └── fact_sales.yaml
└── notebooks/
    └── load_sample_data.ipynb    # Spark notebook: CSV → bronze Delta
```

## What this example shows you

✅ **Real Fabric workspace** provisioned end-to-end with Bicep (capacity) + REST (workspace/items)
✅ **OneLake shortcut** from a Fabric Lakehouse to ADLS gold (multi-cloud / hybrid pattern)
✅ **Real TMDL semantic model** in PBIP format — version-controlled, diffable, edit in VS Code or Power BI Desktop
✅ **Direct Lake mode** — import-tier perf with no refresh job
✅ **Star schema in gold** — done correctly (one fact + 3 dims, surrogate keys, role-playing date)
✅ **dbt medallion build-out** for bronze → silver → gold transformations
✅ **Data contracts** for every gold table (schema + GE rules + SLA)
✅ **Sample synthetic data** — 1000 customers, 500 products, 50K sales rows you can bring up in 5 minutes

## Prerequisites

- Azure subscription with **a Fabric capacity already created** (F2 minimum for dev — see Bicep below to provision one)
- Service principal with `Fabric Administrator` role (for REST calls during deploy)
- ADLS Gen2 storage account with sample data available at `abfss://gold@<storage>.dfs.core.windows.net/retail-sales/`
- Azure CLI ≥ 2.65, jq, `dbt-fabric` ≥ 1.7
- Power BI Desktop (Apr 2024+) if you want to edit the semantic model graphically

## 5-minute quickstart (POC)

```bash
# 1. Deploy the Fabric capacity (skip if you already have one)
cd deploy/bicep
az group create -n rg-fabric-e2e-dev -l eastus2
az deployment group create -g rg-fabric-e2e-dev \
  --template-file main.bicep \
  --parameters env=dev capacityAdminUpn=alice@contoso.com

# 2. Provision the workspace + lakehouse + shortcut + semantic model
cd ../fabric
./deploy.sh dev <capacity-name> <storage-account> <storage-key>

# 3. Run dbt to build the medallion
cd ../../dbt
dbt deps
dbt seed       # uploads sample CSVs to bronze
dbt run        # bronze → silver → gold
dbt test       # data quality

# 4. Open Fabric portal → workspace `csa-retail-sales-dev` → lakehouse → see gold tables
# 5. Open the semantic model → it's already wired to gold via Direct Lake
# 6. Open the included sample report (or build your own) → instant Direct Lake queries
```

## What it deploys (Azure resources)

| Resource | SKU | Why |
|----------|-----|-----|
| Fabric Capacity | F2 (dev), F8 (test), F64 (prod) | Hosts the workspace and Direct Lake compute |
| Workspace | one per env | Logical container for Fabric items |
| Lakehouse | one | OneLake-backed Delta storage + SQL endpoint |
| OneLake Shortcut | from lakehouse to ADLS gold | Zero-copy access to gold from external storage |
| Semantic Model (Direct Lake) | imported from `semantic-model/` PBIP | Power BI consumption |
| (Optional) Report | imported from `power-bi/reports/` | Pre-built sample report |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for full mermaid diagrams (data flow, identity, deployment topology).

## What this example deliberately does NOT include

- ❌ Real-time streaming (use the `streaming/` example or the [streaming-cdc pattern](../../docs/patterns/streaming-cdc.md))
- ❌ Cross-region disaster recovery (single region; see [DR.md](../../docs/DR.md))
- ❌ Workspace-level RBAC automation (provision identities + assign roles in your platform IaC, then `az rest` after deploy)
- ❌ Power BI Apps (publishing a packaged app — manual portal step)
- ❌ Real Fabric Deployment Pipelines (Dev → Test → Prod — see [Power BI Roadmap pattern](../../docs/patterns/power-bi-fabric-roadmap.md))

These are deliberately scoped out to keep the example understandable; pointers to where they live in the rest of the repo are above.

## Cost estimate (USD, ballpark)

| Item | Dev (F2) | Test (F4) | Prod (F64) |
|------|---------|-----------|-----------|
| Fabric capacity (24h pause off) | $263/mo | $526/mo | $8,410/mo |
| Fabric capacity (8hr/day, paused otherwise) | $88/mo | $175/mo | $2,803/mo |
| ADLS storage (50GB gold) | ~$1/mo | ~$1/mo | ~$1/mo |
| **Total dev (paused)** | **~$89/mo** | | |

**Cost lever:** F-SKUs can be paused. Schedule pause/resume via runbook for non-prod. Prod F64 typically runs 24/7.

## Production hardening checklist

Before pointing real users at it:

- [ ] Capacity assignment: prod workspace on its own F-SKU; don't share with dev
- [ ] Workspace identity: configure managed identity for OneLake shortcut auth (vs SAS in this dev sample)
- [ ] Private endpoints on the underlying ADLS (separate Bicep — see `shared/modules/storage.bicep`)
- [ ] Fabric Trusted Workspace Access for cross-workspace shortcuts (if applicable)
- [ ] Sensitivity labels on the semantic model (Microsoft Purview Information Protection)
- [ ] Row-level security in TMDL — see `tables/DimCustomer.tmdl` for the example pattern
- [ ] Object-level security — hide sensitive columns from non-privileged roles
- [ ] Backup/restore strategy — currently OneLake doesn't have point-in-time restore; rely on source-of-truth ADLS retention
- [ ] Eval suite for any Copilot-in-Power-BI usage on this model — see [LLMOps pattern](../../docs/patterns/llmops-evaluation.md)

## Related

- [Tutorial 06 — AI Analytics on Foundry](../../docs/tutorials/06-ai-analytics-foundry/README.md)
- [Migration — Databricks → Fabric](../../docs/migrations/databricks-to-fabric.md)
- [Pattern — Power BI & Fabric Roadmap](../../docs/patterns/power-bi-fabric-roadmap.md)
- [Reference Architecture — Fabric vs Synapse vs Databricks](../../docs/reference-architecture/fabric-vs-synapse-vs-databricks.md)
- [ADR 0010 — Fabric Strategic Target](../../docs/adr/0010-fabric-strategic-target.md)
- [ADR 0013 — dbt as Canonical Transformation](../../docs/adr/0013-dbt-as-canonical-transformation.md)
- [Use Case — Fabric Unified Analytics](../../docs/use-cases/fabric-unified-analytics.md)
- [Example — Fabric Data Agent](../fabric-data-agent/README.md) — sibling example, agent over Fabric
- TMDL reference: https://learn.microsoft.com/analysis-services/tmdl/tmdl-overview
- Direct Lake docs: https://learn.microsoft.com/fabric/get-started/direct-lake-overview
- PBIP format: https://learn.microsoft.com/power-bi/developer/projects/projects-overview
