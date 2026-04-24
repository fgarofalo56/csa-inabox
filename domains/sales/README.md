# Sales Domain — Data Mesh Domain Template

[domains](../README.md) / **sales**


This is a sample business domain showing the **Data Mesh** pattern for CSA-in-a-Box. Copy this structure to onboard new domains.

## Table of Contents

- [Structure](#-structure)
- [Domain Ownership](#-domain-ownership)
- [Data Products Published](#-data-products-published)
- [Getting Started](#-getting-started)
- [Related Documentation](#-related-documentation)

---

## 📁 Structure

```text
domains/sales/
├── dbt/                    # Domain-specific dbt models
│   ├── models/
│   │   ├── bronze/         # Raw ingestion
│   │   ├── silver/         # Cleansed/enriched
│   │   └── gold/           # Business-ready aggregations
│   └── dbt_project.yml     # Domain dbt config (inherits shared)
├── notebooks/              # Databricks notebooks
│   └── exploration.py      # Ad-hoc analysis
├── pipelines/              # ADF pipeline definitions
│   └── ingest_sales.json   # Batch ingestion pipeline
├── contracts/              # Data product contracts
│   └── sales_orders.json   # Published data product schema
└── README.md               # This file
```

---

## 📋 Domain Ownership

| Role | Responsibility |
|------|---------------|
| Domain Owner | Business requirements, data quality SLAs |
| Data Engineer | Pipeline development, dbt models |
| Data Steward | Purview classifications, access policies |

---

## ✨ Data Products Published

| Product | Layer | Format | SLA |
|---------|-------|--------|-----|
| `gld_sales_orders` | Gold | Delta | Daily by 06:00 UTC |
| `gld_sales_metrics` | Gold | Delta | Daily by 07:00 UTC |

---

## 🚀 Getting Started

1. Copy this domain folder: `cp -r domains/sales domains/<your-domain>`
2. Update `dbt_project.yml` with your domain name
3. Define sources in `models/bronze/sources.yml`
4. Create bronze → silver → gold models
5. Register data products in `contracts/`
6. Set up ADF pipeline for ingestion

---

## 🔗 Related Documentation

- [Architecture Overview](../../docs/ARCHITECTURE.md) — Platform architecture reference
- [Examples](../../examples/README.md) — Sample data pipelines and use cases
