# {{ cookiecutter.vertical_name }} Architecture

> [**Examples**](../README.md) > [**{{ cookiecutter.vertical_name }}**](README.md) > **Architecture**

> **Last Updated:** 2026-04-20 | **Status:** Scaffolded | **Audience:** Architects / Data Engineers

> [!TIP]
> **TL;DR** — {{ cookiecutter.description }}

---

## Overview

The {{ cookiecutter.vertical_name }} analytics pipeline follows the
CSA-in-a-Box medallion pattern: raw observations land in ADLS Bronze, are
cleaned and conformed in Silver, and aggregated for business analytics in
Gold. Owner: `{{ cookiecutter.domain_owner }}`. Target FedRAMP posture:
**{{ cookiecutter.fedramp_level }}**.

---

## Architecture Diagram

```mermaid
graph TD
    subgraph Sources["Data Sources"]
        S1["{{ cookiecutter.vertical_name }} API"]
        S2["Bulk CSV / Parquet<br/>(refreshed every {{ cookiecutter.sample_frequency_hours }}h)"]
        {% if cookiecutter.uses_iot == "yes" -%}
        S3["IoT Devices"]
        {%- endif %}
    end

    subgraph Ingestion["Ingestion"]
        {% if cookiecutter.uses_streaming == "yes" -%}
        EH["Azure Event Hub"]
        {%- endif %}
        {% if cookiecutter.uses_iot == "yes" -%}
        IoT["Azure IoT Hub"]
        {%- endif %}
        ADF["Azure Data Factory<br/>(batch pipelines)"]
    end

    subgraph Storage["ADLS Gen2"]
        Bronze["Bronze<br/>(raw)"]
        Silver["Silver<br/>(cleaned)"]
        Gold["Gold<br/>(aggregated)"]
    end

    subgraph Processing["Processing"]
        DBT["dbt on Databricks<br/>(medallion)"]
        {% if cookiecutter.uses_streaming == "yes" -%}
        ADX["Azure Data Explorer<br/>(hot queries)"]
        {%- endif %}
    end

    subgraph Consumers["Consumers"]
        PBI["Power BI"]
        API["REST APIs"]
    end

    S1 --> ADF
    S2 --> ADF
    {% if cookiecutter.uses_iot == "yes" -%}
    S3 --> IoT
    IoT --> EH
    {%- endif %}
    {% if cookiecutter.uses_streaming == "yes" -%}
    EH --> Bronze
    EH --> ADX
    {%- endif %}
    ADF --> Bronze
    Bronze --> DBT
    DBT --> Silver
    Silver --> DBT
    DBT --> Gold
    Gold --> PBI
    Gold --> API
    {% if cookiecutter.uses_streaming == "yes" -%}
    ADX --> PBI
    {%- endif %}
```

---

## Medallion Layers

| Layer  | Owns                                         | Tables (example)                             |
|--------|----------------------------------------------|----------------------------------------------|
| Bronze | Raw observations, no validation              | `brz_observations`                           |
| Silver | Deduped, validated, UTC-normalized           | `slv_observations_cleaned`                   |
| Gold   | Daily / weekly analytics ready for BI        | `gld_observations_daily`                     |

Extend this table as the vertical grows.

---

## Data Contracts

See [`contracts/{{ cookiecutter.vertical_slug }}-primary.yaml`](contracts/{{ cookiecutter.vertical_slug }}-primary.yaml)
for the primary data product contract (schema, SLA, quality rules).

---

## FedRAMP Posture

This vertical is scoped to **{{ cookiecutter.fedramp_level }}** controls.
See [`docs/compliance/`](../../docs/compliance/) for the baseline control
catalog. Notable defaults:

- Data at rest: Customer-managed keys via `deploy/bicep/shared/modules/security/cmkIdentity.bicep`.
- Data in transit: TLS 1.2+ enforced on all endpoints.
- Identity: Managed identity everywhere; no SAS tokens (CSA-0025).

---

## Next Steps

1. Fill in vertical-specific sections (data sources, analytics scenarios).
2. Add KQL query assets under `kql/` if the vertical uses hot-path ADX.
3. Expand the dbt model set beyond the scaffolded starters.
4. Wire up `deploy/bicep/main.bicep` to concrete shared modules.
