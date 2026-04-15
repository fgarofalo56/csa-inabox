# DOMAIN_NAME Data Product

[templates](../../../templates/) / [data-product](../) / **scaffold**

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Data Engineers / Domain Owners

## Table of Contents

- [Overview](#-overview)
- [Data Products](#-data-products)
- [Ownership](#-ownership)
- [Directory Structure](#-directory-structure)
- [Related Documentation](#-related-documentation)

---

## 📋 Overview
<!-- Replace DOMAIN_NAME with your domain (e.g., "Sales", "Finance").
     Describe the business purpose, key entities, and data sources. -->

This domain manages **DOMAIN_NAME** data products within the CSA-in-a-Box
Data Mesh.  It owns the full lifecycle from raw ingestion (Bronze) through
curated tables (Silver) to business-ready datasets (Gold).

---

## 🗄️ Data Products

| Product | Layer | Format | SLA |
|---------|-------|--------|-----|
| `gld_TABLE_NAME` | Gold | Delta | Daily by 06:00 UTC |

<!-- Add rows for each Gold-layer data product exposed by this domain. -->

---

## 📋 Ownership
<!-- Fill in your team's contacts before merging. -->

| Role | Contact |
|------|---------|
| Domain Owner | *(your domain lead)* |
| Data Engineer | *(engineer responsible for pipelines)* |
| Data Steward | *(steward responsible for quality & governance)* |

---

## 📁 Directory Structure

```text
DOMAIN_NAME/
├── data-products/
│   └── TABLE_NAME/
│       └── contract.yaml     # Schema, SLA, quality rules
├── dbt/
│   ├── models/
│   │   ├── bronze/           # Raw ingestion models
│   │   ├── silver/           # Cleansed, validated models
│   │   └── gold/             # Business-ready aggregations
│   └── dbt_project.yml
├── notebooks/                # Databricks / exploratory notebooks
└── README.md                 # This file
```

---

## 🔗 Related Documentation

- [Getting Started Guide](../../../docs/GETTING_STARTED.md) — Platform setup and onboarding
- [USDA Example](../../../examples/usda/README.md) — Reference domain implementation
