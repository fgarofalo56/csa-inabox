# Industry Examples on CSA Loom

These examples show how to build real-world analytics solutions
using CSA Loom workloads. Each example is fully ported from the
existing csa-inabox example set — source code, infrastructure-as-
code, sample data, and step-by-step documentation.

## v1 — 8 ported examples

<div class="grid cards" markdown>

-   :material-cart: **Retail E2E** *(already Loom-shaped)*

    Lakehouse + warehouse + semantic model + Direct-Lake-Shim refresh
    + Power BI report end-to-end.

    [→ Retail E2E](retail-e2e.md)

-   :material-robot: **Fabric Data Agent** *(already Loom-shaped)*

    Read-only Q&A pattern over a lakehouse with per-source few-shot
    examples + identity passthrough.

    [→ Fabric Data Agent](fabric-data-agent.md)

-   :material-bank: **Financial Fraud Detection**

    Real-time transaction scoring + Activator alerts + analyst Data
    Agent. ML lifecycle on Databricks. Power BI fraud-trend
    dashboards.

    [→ Financial Fraud Detection](financial-fraud-detection.md)

-   :material-hospital: **Healthcare Clinical Analytics**

    HIPAA-scoped patient data lakehouse + clinical Power BI reports.
    Sensitivity-label propagation. RLS for clinician roles.

    [→ Healthcare Clinical](healthcare-clinical.md)

-   :material-factory: **IoT Streaming**

    Manufacturing sensor data → ADX → Activator → predictive
    maintenance. Eventstream + Eventhouse parity.

    [→ IoT Streaming](iot-streaming.md)

-   :material-shield-search: **Cybersecurity (MITRE ATT&CK)**

    Endpoint telemetry + KQL detection rules + threat-hunting Data
    Agent. Sentinel integration. Per-workspace SOC patterns.

    [→ Cybersecurity](cybersecurity.md)

-   :material-cog: **Manufacturing IoT**

    CMMC L2-aligned defense-industrial-base sensor analytics in
    GCC-High. ITAR-eligible patterns.

    [→ Manufacturing IoT](manufacturing-iot.md)

-   :material-map: **GeoAnalytics**

    Spatial analytics for environmental + civil-engineering
    workloads. ADX geo functions. Loom Maps service (v2).

    [→ GeoAnalytics](geoanalytics.md)

</div>

## v1.1 — remaining 17 examples

The following examples ship in v1.1 (Q3-Q4 2026):

- AI Agents
- Casino Analytics (Tribal Government)
- Commerce Economic Analytics
- Data API Builder
- DOT Transportation Analytics
- EPA Environmental Analytics
- Interior Natural Resources
- ML Lifecycle (Loan Default)
- NASA Earth Science / API-First Multi-Model
- NOAA Climate & Ocean
- Retail Demand Forecasting
- Streaming
- Tribal Health
- USDA Agriculture
- USPS Postal Operations

See the existing csa-inabox [Examples index](../../examples/index.md)
for the original (non-ported) versions of all 25.

## Port pattern

Each example follows the structure:

1. **What you'll build** — diagram + components used
2. **Prerequisites** — capacity SKU + boundary
3. **Step-by-step** — Bicep → notebooks → semantic model → reports
4. **Forward migration** — what happens when Fabric reaches your
   boundary
5. **Per-boundary notes** — Commercial / GCC / GCC-High / IL5
6. **Cost estimate** — sample $/month
7. **Source code** — link to `examples/fiab-<name>/` folder

Per [PRP-14](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/PRPs/active/csa-loom/PRP-14-examples-port-wave1.md)
for the build plan.

## Source code

Per-example source folders at `examples/fiab-<name>/`:
- `infra/` — Bicep additions per workload
- `data/` — sample data generator + seed
- `notebooks/` — Databricks notebooks
- `dbt/` — dbt models
- `semantic-model/` — TMDL files
- `activator-rules/` — JSON rule definitions
- `data-agent/` — agent config + example queries
- `power-bi/` — Power BI Project (.pbip)
- `tests/` — E2E + validation

## Voice + framing

Per [[writing-voice-no-customer-framing]] memory rule: all example
pages use generic federal-mission or generic-industry framing.
Never customer-specific. Customer success stories belong in private
briefings, not in the public docs.

✅ "A federal financial services agency that monitors transaction
streams typically wants to detect fraudulent activity in real-time."

❌ "The IRS uses CSA Loom to detect fraudulent tax returns."
