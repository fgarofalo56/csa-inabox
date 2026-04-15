# Data Product Template

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Developers

Use this template to create a new data product domain in the CSA-in-a-Box Data Mesh platform.

## Table of Contents

- [Quick Start](#-quick-start)
- [Template Contents](#-template-contents)
- [Data Mesh Principles](#-data-mesh-principles)
- [Related Documentation](#-related-documentation)

---

## 🚀 Quick Start

```bash
# 1. Copy the template
cp -r templates/data-product/scaffold domains/<your-domain>

# 2. Update configuration
# Edit domains/<your-domain>/dbt/dbt_project.yml
# Edit domains/<your-domain>/contracts/*.json

# 3. Define your sources
# Edit domains/<your-domain>/dbt/models/bronze/sources.yml

# 4. Build your medallion models
# Bronze: Raw ingestion
# Silver: Cleansed + enriched
# Gold: Business-ready metrics

# 5. Register with Purview
# Update governance/purview/scanning/register_sources.ps1
```

---

## 📁 Template Contents

```text
templates/data-product/
├── contract-template.json     # Data product contract schema
├── scaffold/                  # Copy this for new domains
│   ├── README.md
│   ├── dbt/
│   │   ├── dbt_project.yml
│   │   └── models/
│   │       ├── bronze/
│   │       │   └── sources.yml
│   │       ├── silver/
│   │       │   └── .gitkeep
│   │       └── gold/
│   │           └── .gitkeep
│   ├── notebooks/
│   │   └── .gitkeep
│   ├── pipelines/
│   │   └── .gitkeep
│   └── contracts/
│       └── .gitkeep
└── README.md                  # This file
```

---

## 🏗️ Data Mesh Principles

1. **Domain Ownership**: Each domain owns its data pipeline end-to-end
2. **Data as a Product**: Gold layer tables are published products with contracts
3. **Self-Serve Platform**: Use shared infrastructure (Databricks, ADF, ADLS)
4. **Federated Governance**: Purview provides global catalog; domains own quality

---

## 🔗 Related Documentation

- [Getting Started Guide](../../docs/GETTING_STARTED.md) — Platform setup and onboarding
- [USDA Example](../../examples/usda/README.md) — Reference domain implementation
