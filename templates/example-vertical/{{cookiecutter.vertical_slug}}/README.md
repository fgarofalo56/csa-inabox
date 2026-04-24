# {{ cookiecutter.vertical_name }} Analytics

> [**Examples**](../README.md) > **{{ cookiecutter.vertical_name }}**


> [!TIP]
> **TL;DR** — {{ cookiecutter.description }}

---

## Table of Contents

- [Architecture](#architecture)
- [Streaming Patterns](#streaming-patterns)
- [Directory Structure](#directory-structure)
- [Deployment](#deployment)
- [Related Documentation](#related-documentation)

---

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full Mermaid diagram and a
walkthrough of the Bronze / Silver / Gold medallion flow.

High-level components:

- **Sources:** {{ cookiecutter.description }}
- **Ingestion:** {% if cookiecutter.uses_streaming == "yes" %}Azure Event Hub + batch ADF pipelines{% else %}Azure Data Factory batch pipelines{% endif %}{% if cookiecutter.uses_iot == "yes" %} and Azure IoT Hub for device telemetry{% endif %}.
- **Storage:** ADLS Gen2 with Bronze / Silver / Gold containers (Delta Lake).
- **Processing:** dbt medallion project under [`domains/dbt/`](./domains/dbt/).
- **Serving:** Power BI, REST APIs, and shared CSA portal.

---

## Streaming Patterns

{% if cookiecutter.uses_streaming == "yes" -%}
This vertical uses the shared streaming patterns defined under
[`examples/iot-streaming/`](../iot-streaming/README.md):

- **Hot path** — Event Hub to Azure Data Explorer for sub-second queries.
- **Warm path** — Stream Analytics windowed aggregation to Power BI.
- **Cold path** — Event Hub Capture to ADLS to dbt (cold medallion).

Edit this section with the specific event schemas and KQL queries for your
vertical once the streaming infrastructure is wired in.
{%- else -%}
This vertical is **batch-first**. Sources are refreshed every
{{ cookiecutter.sample_frequency_hours }} hour(s) via Azure Data Factory
pipelines that land raw files in ADLS Bronze. No streaming components are
provisioned. If real-time ingestion is added later, reuse the shared patterns
in [`examples/iot-streaming/`](../iot-streaming/README.md).
{%- endif %}

---

## Directory Structure

```text
examples/{{ cookiecutter.vertical_slug }}/
|-- README.md                              # This file
|-- ARCHITECTURE.md                        # Mermaid architecture diagram
|-- contracts/
|   `-- {{ cookiecutter.vertical_slug }}-primary.yaml   # Data product contract
|-- data/
|   `-- generators/
|       |-- generate_seed.py               # Deterministic --seed generator
|       `-- tests/test_generate_seed.py    # Determinism + sanity tests
|-- deploy/
|   `-- bicep/
|       `-- main.bicep                     # Starter Bicep (shared modules)
`-- domains/
    `-- dbt/
        |-- dbt_project.yml
        |-- models/
        |   |-- schema.yml                 # sources + model tests (CSA-0089)
        |   |-- bronze/brz_observations.sql
        |   |-- silver/slv_observations_cleaned.sql
        |   `-- gold/gld_observations_daily.sql
        `-- seeds/stations.csv
```

---

## Deployment

### Prerequisites

- Azure CLI 2.50+ logged in (`az login`), subscription selected.
- Bicep CLI 0.25+ (`az bicep version`).
- Python 3.11+ and `pip install -e ".[dev]"` from the repo root.

### Step 1: Generate seed data

```bash
python data/generators/generate_seed.py --days 7 --seed 42
```

### Step 2: Deploy infrastructure

```bash
az group create --name rg-{{ cookiecutter.vertical_slug }} --location eastus
az deployment group create \
    --resource-group rg-{{ cookiecutter.vertical_slug }} \
    --template-file deploy/bicep/main.bicep \
    --parameters \
        baseName={{ cookiecutter.vertical_slug | replace('-', '') }} \
        fedRampLevel={{ cookiecutter.fedramp_level }}
```

### Step 3: Run dbt

```bash
cd domains/dbt
dbt deps
dbt seed
dbt run
dbt test
```

### Step 4: Validate the vertical conforms to CSA conventions

```bash
bash ../../../scripts/lint-vertical.sh examples/{{ cookiecutter.vertical_slug }}
```

---

## Related Documentation

- [Examples Index](../README.md) — All CSA-in-a-Box verticals.
- [Platform Architecture](../../docs/ARCHITECTURE.md) — CSA platform reference.
- [Getting Started](../../docs/GETTING_STARTED.md) — Platform onboarding.
- [dbt CI Runbook](../../docs/runbooks/dbt-ci.md) — PR-gate dbt validation.
- [Great Expectations Tutorial](../../docs/tutorials/great-expectations.md) — Data quality.
- [IoT Streaming Patterns](../iot-streaming/README.md) — Shared streaming infra.

---

**Owner:** {{ cookiecutter.domain_owner }}
**FedRAMP target:** {{ cookiecutter.fedramp_level }}
