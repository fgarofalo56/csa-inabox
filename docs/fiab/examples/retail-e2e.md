# Retail E2E on CSA Loom

End-to-end retail sales analytics. Already Loom-shaped from the
existing `examples/fabric-e2e/` — lifts directly into Loom Tutorial
+ Example pattern.

## What you'll build

```
Source: Cosmos DB (transactions) + Azure SQL (products / customers)
    ↓ Loom Mirroring Engine
Bronze: raw_transactions, raw_products, raw_customers (Delta)
    ↓ Databricks Spark notebooks
Silver: cleaned + conformed
    ↓ dbt models
Gold: dim_customer, dim_product, dim_date, fact_sales
    ↓ Loom Direct-Lake-Shim
Power BI Premium semantic model (warm-cache; 5-30s refresh)
    ↓
Power BI reports: Sales by Region, Top Customers, Product Trend
    ↓
Loom Data Agent: NL Q&A over the semantic model
```

## Components

| Loom capability | Used for |
|---|---|
| Lakehouse | Bronze / Silver / Gold layers |
| Mirroring Engine | CDC from Cosmos + Azure SQL |
| Notebooks (Databricks) | Bronze → Silver transforms |
| dbt | Silver → Gold star schema |
| Warehouse (Synapse Serverless or Databricks SQL) | Ad-hoc query |
| Direct-Lake-Shim | Semantic model refresh on Delta commits |
| Power BI Premium | BI surface |
| Data Agent | NL Q&A for executives |

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Databricks SQL Warehouse + UC + Foundry Agent Service |
| GCC | P-SKU Power BI (no Direct Lake parity); rest same |
| GCC-High / IL4 | F-SKU + Direct Lake parity; Synapse Serverless instead of Databricks SQL Warehouse |
| IL5 (v1.1) | Same as GCC-H + Atlas catalog + HSM-CMK |

## Cost (F8 Commercial baseline)

~$3,200/mo:
- Power BI Premium F8: $1,050
- Databricks (medium usage): $1,000
- Synapse Serverless (light): $30
- ADLS Gen2: $150
- AOAI (Data Agent): $300
- Misc: $670

## Source code

[`examples/fiab-retail-e2e/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-retail-e2e)

## Forward migration

When Fabric reaches your boundary:
- Bronze / Silver / Gold Delta tables → OneLake shortcuts (zero data
  movement)
- dbt models → dbt-fabric adapter
- Semantic model → re-author for Direct Lake on OneLake
- Power BI reports rebind automatically

## Related

- [Tutorial 02 — First lakehouse](../tutorials/02-first-lakehouse.md)
- [Tutorial 03 — Direct Lake parity](../tutorials/03-direct-lake-parity.md)
- [Tutorial 05 — Data Agent](../tutorials/05-data-agent.md)
- Existing source: [`examples/fabric-e2e/`](../../examples/fabric-e2e.md)
