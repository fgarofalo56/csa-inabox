# Examples — Industry Vertical Implementations

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Data Engineers

This directory contains **complete, working implementations** of Cloud Scale Analytics
for specific federal agencies, tribal organizations, and commercial sectors.

Each vertical is a self-contained example that:
- Uses real open-source data from the respective agency (where available)
- Includes synthetic data generators for sensitive data types
- Provides complete dbt medallion models (Bronze → Silver → Gold)
- Defines data product contracts with quality enforcement
- Includes Databricks/Synapse analytics notebooks
- Has step-by-step deployment instructions
- Supports both Azure Commercial and Azure Government

## Available Verticals

### Federal Agencies

| Vertical | Agency | Data Sources | Key Analytics |
|---|---|---|---|
| [usda/](usda/) | USDA | NASS crop yields, SNAP enrollment, FSIS inspections | Crop forecasting, food safety risk |
| [dot/](dot/) | Dept. of Transportation | FARS crashes, FHWA highways, FAA airports, NTD transit | Safety hotspots, infrastructure aging |
| [usps/](usps/) | US Postal Service | ZIP code data, delivery performance | Route optimization, volume forecasting |
| [noaa/](noaa/) | NOAA | Weather stations, climate, fisheries, ocean buoys | Severe weather alerts, climate trends |
| [epa/](epa/) | EPA | AQI air quality, water systems, toxic releases, Superfund | Environmental justice, compliance monitoring |
| [commerce/](commerce/) | Dept. of Commerce | Census, BEA GDP/trade, NIST manufacturing | Economic resilience, trade analysis |
| [interior/](interior/) | Dept. of Interior | USGS earthquakes, NPS parks, BLM land, FWS species | Natural hazard risk, park capacity |

### Tribal Organizations

| Vertical | Domain | Data Sources | Key Analytics |
|---|---|---|---|
| [tribal-health/](tribal-health/) | BIA / IHS Health | IHS aggregate stats + synthetic patient data | Population health, chronic disease tracking |
| [casino-analytics/](casino-analytics/) | Tribal Gaming | Synthetic player tracking, slot telemetry, F&B, hotel | Real-time player engagement, floor optimization |

### Cross-Cutting

| Vertical | Domain | Description |
|---|---|---|
| [iot-streaming/](iot-streaming/) | Real-Time Analytics | IoT Hub → Event Hub → Stream Analytics → ADX patterns |

## Vertical Structure

Every vertical follows this standard layout:

```text
examples/{vertical}/
├── README.md              # Complete deployment guide
├── ARCHITECTURE.md        # Domain-specific architecture
├── deploy/
│   ├── bicep/             # Additional IaC (if needed)
│   ├── params.dev.json    # Environment parameters
│   └── params.gov.json    # Azure Government parameters
├── domains/
│   └── dbt/
│       ├── models/
│       │   ├── bronze/    # Raw ingestion models
│       │   ├── silver/    # Cleansed/conformed
│       │   └── gold/      # Analytics-ready
│       ├── seeds/         # Sample data CSVs
│       ├── tests/         # Data quality tests
│       └── dbt_project.yml
├── contracts/             # Data product contracts (YAML)
├── notebooks/             # Analytics notebooks (Databricks/Synapse)
├── data/
│   ├── generators/        # Python synthetic data generators
│   └── open-data/         # Scripts to fetch public data
├── pipelines/             # ADF pipeline definitions
└── reports/               # Power BI templates + KQL queries
```

## Getting Started

1. Deploy the base CSA platform (`make deploy-dev` or `deploy-platform.sh`)
2. Navigate to the vertical you want: `cd examples/usda/`
3. Follow the README.md in that directory
4. Load sample data: `python data/generators/generate_data.py`
5. Run dbt: `cd domains/dbt && dbt seed && dbt run && dbt test`
6. Open the analytics notebooks in Databricks

## Azure Government

Verticals that are specifically designed for government deployment:
- **tribal-health/** — Deploys to Azure Government, FedRAMP High compliant
- **interior/** — Uses Gov endpoints for USGS/BLM data
- **epa/** — Supports Gov deployment for environmental monitoring

All other verticals include `params.gov.json` for Government deployment.

---

## Related Documentation

- [Architecture](../docs/ARCHITECTURE.md) - Comprehensive architecture reference
- [Getting Started](../docs/GETTING_STARTED.md) - Prerequisites and deployment walkthrough
- [Quick Start](../docs/QUICKSTART.md) - 60-minute hands-on tutorial
