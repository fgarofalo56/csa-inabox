# CSA Loom — Workloads

For every Microsoft Fabric workload (and Fabric-only capability), one
documentation page explains how CSA Loom delivers parity, where the
honest gaps are, and how the workload migrates forward when Fabric
reaches your audit boundary.

## Storage + namespace

<div class="grid cards" markdown>

-   :material-database: [**OneLake parity**](onelake-parity.md)

    ADLS Gen2 + unified path tree + cross-cloud shortcuts service.
    Engine-layer enforcement (vs Fabric's storage-protocol).

</div>

## Data Engineering + Warehouse + Data Science

<div class="grid cards" markdown>

-   :material-code-braces: [**Data Engineering**](data-engineering.md)

    Databricks lakehouse + Spark notebooks + environments +
    Materialized Lake Views (DLT in Commercial; scheduled Jobs in
    Gov).

-   :material-database-cog: [**Data Warehouse**](data-warehouse.md)

    Databricks SQL Warehouse (Commercial) or Synapse Serverless (Gov).
    T-SQL DML over Delta; cross-warehouse queries.

-   :material-flask: [**Data Science**](data-science.md)

    Databricks notebooks + MLflow + Vector Search (Commercial) or
    Azure AI Search vector (Gov) + custom AI Functions library.

</div>

## Real-Time + Activator

<div class="grid cards" markdown>

-   :material-flash: [**Real-Time Intelligence**](real-time-intelligence.md)

    Azure Stream Analytics + ADX (same engine as Fabric Eventhouse) +
    KQL Querysets + ADX dashboards.

-   :material-bell: [**Data Activator parity (Reflex)**](data-activator-parity.md)

    Loom Activator Engine: NRules + Redis state + Function dispatcher
    backed by ADX. All 8 Fabric Reflex primitives.

</div>

## Mirroring + Direct Lake

<div class="grid cards" markdown>

-   :material-database-sync: [**Mirroring parity**](mirroring-parity.md)

    OSS Debezium + Spark Structured Streaming + Delta MERGE. Honors
    Fabric's Open Mirroring publisher contract.

-   :material-chart-line: [**Direct Lake parity**](direct-lake-parity.md)

    Power BI Premium Import + warm-cache materializer (5-30s
    freshness). **Honest gap vs Fabric's sub-second documented
    openly.**

</div>

## Agents + Copilot

<div class="grid cards" markdown>

-   :material-robot: [**Data Agents parity**](data-agents-parity.md)

    Loom Data Agents extends `apps/copilot/` with NL2SQL / NL2DAX /
    NL2KQL tools + per-source few-shot examples + OBO identity.

-   :material-message-text: [**Copilot in CSA Loom**](copilot-parity.md)

    Per-pane Copilot personas (notebook, warehouse, DAX, KQL,
    activator, agent-config). Built on Loom Data Agents runtime.

</div>

## Future workloads

<div class="grid cards" markdown>

-   :material-graph: [**Fabric IQ family**](fabric-iq-family.md)

    Ontology / Graph / Plan / Operations Agent / Maps — **v2
    deferred** (Operations Agent ships in v1.1).

</div>

## Parity matrix at a glance

See [Parity matrix](../parity-matrix.md) for the keystone summary
table across all workloads.

## How to read each workload page

Each page follows this structure:

1. **What Fabric does** — one-paragraph summary of the Fabric capability
2. **CSA Loom parity design** — architecture + implementation notes
3. **Per-boundary behavior** — Commercial / GCC / GCC-High / IL5
4. **Honest gaps** — what we can't match; why
5. **Forward migration** — to Fabric when Gov GA arrives
6. **Related** — PRP that builds it, tutorial that demonstrates it,
   runbook for incidents

This ensures you can read any workload page in isolation and
understand the parity story end-to-end.
