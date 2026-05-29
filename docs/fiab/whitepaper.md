# CSA Loom — Whitepaper

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


_Cloud Scale Analytics Loom — the Microsoft Fabric experience inside any Azure tenant where Fabric isn't yet available_

_Version 1.0 — 2026-05-22_

## Executive summary

Microsoft Fabric is the strategic unified analytics SaaS platform. As
of mid-2026 it is `Forecasted` in every US Government cloud and not
yet authorized at FedRAMP High, DoD IL4/IL5/IL6, or Secret. Federal,
DoD, intelligence-community, ITAR-bound, and many state + local
government customers cannot adopt Fabric today, and Microsoft has
not published a commitment date for Fabric Gov GA.

**CSA Loom** is the productized answer to that gap. It is an
Azure-native + open-source layer that delivers a Microsoft Fabric
parity experience inside any Azure tenant — Commercial, GCC,
GCC-High, IL4, IL5 (v1.1). It ships as a deployable pillar on Cloud
Scale Analytics in a Box: a Bicep platform, a Next.js Console that
mimics the Fabric workspace UX, a conversational Setup Wizard, and
parity services for the Fabric-only items that have no first-party
equivalent today (Direct Lake, Reflex, Data Agents, Mirroring).

Loom is designed for **forward migration first**: when Microsoft
Fabric reaches your audit boundary, your Delta tables become OneLake
shortcuts (zero data movement), your dbt models port 1:1, your KQL
queries port 1:1, your semantic models re-author with minimal effort,
and you can run hybrid (Fabric in Commercial + Loom in Gov) during
the transition. You are not trapped in Loom; you are bridged into
Fabric.

## The strategic context

### Where Fabric is

Microsoft Fabric has crystallized in the 2025–2026 wave into a true
unified SaaS data platform — OneLake as the storage namespace, F-SKU
capacities as the unified compute pool, and roughly a dozen workloads
sharing the same governance, identity, and lifecycle plane.

In Azure Commercial, Fabric is GA across the full surface area:

- OneLake unified storage namespace
- Data Factory pipelines, Dataflows Gen2, Copy Job, Mirroring
- Data Engineering / Lakehouse (Spark notebooks, environments, MLVs)
- Data Warehouse (Polaris engine, T-SQL over Delta)
- Real-Time Intelligence (Eventstream, Eventhouse, KQL, Real-Time
  Dashboards, Activator)
- Data Science (notebooks, MLflow, AI Functions, Semantic Link)
- Power BI in Fabric — including Direct Lake mode
- Copilot in Fabric (per-workload AI surfaces)
- Data Agents (formerly AI Skills; renamed/GA'd in 2026)
- Fabric Databases (SQL DB, Cosmos DB, HorizonDB preview)
- Fabric IQ family (Ontology, Graph, Plan, Operations Agent) — FabCon
  2026 first-class items

### Where Fabric isn't

In Azure Government and the M365 government tenants paired with it,
Fabric is **`Forecasted`** — Microsoft has set an internal GA date
but has not published it. Power BI is the only Fabric-platform
component that is already Gov-GA, and even Power BI carries
boundary-specific limits (no F-SKU in GCC; no Azure Maps visual in
any Gov boundary; etc.).

Microsoft's normal Gov authorization pattern is Commercial → GCC-H
→ IL5 → IL6, with 12–36 months between rungs. Even an optimistic
Fabric Gov rollout puts IL5 GA in 2027 at the earliest.

### What customers are doing today

The existing recommendation in [`docs/fabric-in-gov-cloud.md`](../fabric-in-gov-cloud.md)
Option 3 is to build on the Synapse + ADF + Databricks + Purview +
Power BI stack inside Azure Government. That recommendation works,
but it leaves customers with:

- Five separate operating surfaces (Azure portal + Databricks
  workspace + Synapse Studio + Power BI service + Purview Studio)
  instead of Fabric's single SaaS plane
- A Bicep + GitHub-Actions deployment path that needs platform-
  engineer skills — not the one-click-from-Marketplace experience
  commercial customers see for Fabric
- No equivalent for the Fabric-unique experiences customers
  explicitly ask for: OneLake unified namespace, Direct Lake sub-
  second Power BI, Reflex / Data Activator declarative rules, Fabric
  Data Agents over the lakehouse, Mirroring zero-ETL CDC, AI Skills
  (now subsumed into Data Agents), Fabric IQ family
- No forward-migration story when Fabric Gov GA finally arrives

CSA Loom is the answer to those gaps.

## Architecture overview

Loom deploys as a two-plane architecture aligned with Microsoft's
Cloud Adoption Framework Data Management Zone + Data Landing Zone
pattern:

- **Loom Admin Plane** — one subscription per organization. Hosts the
  Loom Console, Setup Wizard, MCP server, Copilot runtime, catalog
  overlay, AI Foundry / Azure ML Hub, AI Search, monitoring, Key
  Vault, and shared services.
- **Loom Data Landing Zones (DLZs)** — one subscription per domain /
  agency / mission area. Each carries a Databricks workspace + Synapse
  Serverless SQL pool + ADX database + ADLS Gen2 lakehouses + Power
  BI Premium workspaces + the per-DLZ parity services (Activator,
  Mirroring, Direct-Lake Shim).

Inside each DLZ, **Loom workspaces** (the per-team "data product"
unit) compose lakehouses, warehouses, notebooks, semantic models, KQL
DBs, activator rules, and data agents — mirroring the Microsoft
Fabric workspace concept.

### Per-boundary dispatch

Loom's Bicep is parameterized per audit boundary. The same `main.bicep`
deploys differently in Commercial vs Gov vs IL5 because the underlying
Azure services aren't uniform across boundaries:

| Component | Commercial / GCC | GCC-High / IL4 | DoD IL5 (v1.1) |
|---|---|---|---|
| Compute — Spark | Databricks Premium (Photon) | Databricks classic (no UC) | Databricks classic (no UC) |
| Compute — SQL | Databricks SQL Warehouse | Synapse Serverless SQL | Synapse Serverless SQL |
| Catalog | UC managed + Purview overlay | Purview primary | Self-hosted Atlas on AKS |
| Container compute | Container Apps | AKS | AKS |
| Agent orchestration | Foundry Agent Service | Microsoft Agent Framework + AOAI direct | MAF + AOAI direct |
| Direct Lake parity | Premium Import + warm-cache | Premium Import + warm-cache | Premium Import + warm-cache |

Per-boundary `.bicepparam` files (`commercial.bicepparam`,
`gcc.bicepparam`, `gcc-high.bicepparam`, `il5.bicepparam`) ship the
right values for each boundary.

## How Loom is built

### Compute (LD-2)

Hybrid by workload:

- **Azure Databricks** — primary Spark compute + (Commercial only)
  SQL Warehouse + Unity Catalog managed + MLflow
- **Synapse Serverless SQL** — ad-hoc SQL over Delta, primary SQL
  surface in Gov where Databricks SQL Warehouse is unavailable
- **Azure Data Explorer (Kusto)** — KQL DB / Real-Time Intelligence
  parity; the same engine Fabric Eventhouse runs on
- **Power BI Premium** — semantic models, reports, dashboards;
  F-SKU in GCC-H + IL5; P-SKU in GCC (Direct Lake unavailable in
  GCC even structurally because of the F-SKU rule)

### Catalog (LD-8)

Two-track architecture:

**Track A — Commercial / GCC (and Gov when UC managed Gov-GA arrives):**
Databricks Unity Catalog managed as the operational catalog +
Microsoft Purview as the sensitivity / sovereignty / audit overlay.
UC's Iceberg REST endpoint + Delta UniForm exposes the catalog to
non-Databricks engines (Synapse Serverless, ADX, Trino, DuckDB).

**Track B — Gov-IL4 interim (until UC managed Gov-GA):**
Microsoft Purview as the primary catalog. Databricks runs with
workspace-scoped Hive metastore. Lineage published from Spark / ADF
via Atlas REST API → Purview.

**Track C — DoD IL5 (v1.1):**
Self-hosted Apache Atlas on AKS as primary catalog (Purview is not in
IL5 audit scope). Solr + HBase + Kafka stack as Atlas dependencies.

### Direct Lake parity (LD-7)

This is the hardest single workload to match. Fabric's Direct Lake
mode uses the proprietary VertiPaq transcoder to read Delta-Parquet
files directly from OneLake at sub-second latency, with framing-not-
refresh sync semantics.

Loom delivers the **best tractable parity:** Power BI Premium Import
semantic models + a notification-driven warm-cache materializer
(`apps/fiab-direct-lake-shim`) that subscribes to Storage Event Grid
notifications on `_delta_log` writes and issues TOM partition-scoped
refreshes against the associated semantic model. Result:
**5–30 second freshness from new commit to refreshed model** for
partition-aware tables.

Loom is **honest about this gap**: sub-second freshness is not
achievable without owning the VertiPaq transcoder, and we document
that openly. Customers who need Fabric-native sub-second freshness
wait for Fabric Gov GA.

### Reflex / Data Activator parity (LD-N/A)

Per `research/03-fabric-only-internals.md`, Fabric's Activator is a
thin scheduling layer over Eventhouse (Kusto/ADX) + per-object state
tracking. Loom replicates with:

- **Azure Data Explorer** as the query engine (the same Kusto engine
  Eventhouse runs on)
- **NRules** (.NET production-grade Rete rules engine) for rule
  evaluation
- **Azure Cache for Redis Premium** for per-object state
- **Azure Functions** for action dispatch (Teams / Email / Power
  Automate / Logic App / Databricks job / ADF pipeline / UDF /
  webhook)

All 8 Fabric Reflex rule primitives are implemented:
`increasesAbove`, `decreasesBelow`, `is above`, `is below`,
`changesTo`, `andStays`, `noPresenceOfData`, `everyNthTime`.

End-to-end latency: 5–30 seconds, matching Fabric Reflex.

### Mirroring parity (LD-9)

Loom delivers zero-ETL CDC from operational databases into the
lakehouse using OSS Debezium + Event Hubs + Spark Structured Streaming
+ Delta MERGE. Sources covered in v1: Azure SQL, Azure SQL MI, SQL
Server 2016-2025, Postgres, MySQL, Cosmos DB, Snowflake, Oracle.

Loom **honors Fabric's Open Mirroring publisher contract**: partners
can drop Parquet files with the `__rowMarker__` column to a documented
landing zone path and Loom Mirroring picks them up — the same
protocol Fabric Mirroring exposes for SAP and partner sources.

### Data Agents parity (extends apps/copilot)

Fabric Data Agents (renamed from "AI Skills" in 2026) are NL-to-query
agents over Lakehouse, Warehouse, Power BI semantic models, and KQL
databases. Loom delivers parity by extending the existing csa-inabox
copilot scaffold (`apps/copilot/` PydanticAI agent +
`azure-functions/copilot-chat/` Function backend) with:

- `nl2sql(question, data_source_id, user_token)` — SQL over Databricks
  SQL Warehouse (Commercial) or Synapse Serverless (Gov)
- `nl2dax(question, semantic_model_id, user_token)` — DAX over Power
  BI Premium semantic model via XMLA
- `nl2kql(question, adx_cluster, database, user_token)` — KQL over ADX
- `graph_search` and `custom_search` for non-tabular sources

Identity passthrough (OBO) throughout — every tool call carries the
calling user's Entra token. Per-agent few-shot example queries.
Foundry integration in Commercial; AOAI-direct in Gov.

### Copilot orchestration (Wizard + runtime)

Two-tier:

- **Commercial / GCC:** Foundry Agent Service (GA Mar 2026) hosts the
  Loom Setup Wizard agent + Loom Copilot runtime. Wired to the
  self-hosted Azure MCP server + Azure Bicep MCP.
- **GCC-High / IL5:** Microsoft Agent Framework 1.0 (Apr 2026)
  orchestrator + Azure OpenAI direct (gpt-4o / gpt-4.1 in
  `usgovvirginia`). Same wizard UX, same MCP backend.

### Push-button deployment (LD-4)

Two-tier surface:

1. **`azd up` CLI** — power-user path; full Bicep visibility
2. **"Deploy to Azure" template button** — portal click; pre-rendered
   ARM template

Both deploy into the customer's own Azure subscription. Customer pays
only for Azure consumption underneath; Loom IP + Console + parity
services + Setup Wizard are free in v1. The Azure Marketplace Managed
Application path is **deferred to backlog** per LD-4 — to be revisited
once the product matures and a pricing model is decided.

## Forward migration

Loom is designed under [ADR fiab-0012](adr/0012-forward-migration.md)
to migrate forward into Microsoft Fabric with low rewrite cost.

| Loom artifact | Fabric equivalent | Migration mechanism |
|---|---|---|
| Loom lakehouse Delta tables | OneLake Delta tables | OneLake shortcut → **zero data movement** |
| dbt Core models | dbt in Fabric Data Factory | dbt-fabric adapter; change connection string |
| Databricks notebooks | Fabric Spark notebooks | Git binding port; runtime swap |
| Databricks SQL Warehouse tables | Fabric Warehouse | T-SQL DDL ports; light syntax adjustments |
| Synapse Serverless external tables | Fabric Warehouse / SQL endpoint | Re-create as Fabric Warehouse tables |
| ADX databases / KQL queries | Fabric Eventhouse | **Same engine**; databases attach as Eventhouse |
| Power BI semantic models | Power BI in Fabric (Direct Lake) | Re-author TMDL for Direct Lake on OneLake |
| Loom Activator rules | Fabric Reflex | JSON export from Loom → Reflex definition import |
| Loom Data Agents | Fabric Data Agents | Agent config JSON → Fabric Data Agents REST API |
| Loom Mirroring configs | Fabric Mirroring | Per-source case-by-case (some sources Fabric GA-mirrors today; some don't) |
| Purview catalog | Fabric Purview | **Same engine**; Fabric items auto-register |

The asymmetry is honest: Fabric-only artifacts (Direct Lake sub-
second freshness, Fabric IQ family) don't reverse-map cleanly back to
Loom. But the forward direction is clean enough that Loom is a
defensible head-start, not a detour.

## Hybrid topology — Fabric Commercial + Loom Gov

The most likely real-world pattern for federal customers with both
commercial and Gov estates:

- **Commercial tenant** runs Microsoft Fabric for public datasets,
  cross-agency analytics, executive Power BI dashboards
- **Gov tenant** runs CSA Loom for CUI / classified mission data,
  agency-internal analytics, ITAR-eligible workloads in GCC-High
- **Cross-cloud B2B** invitations bridge identity
- **APIM Premium** in each cloud brokers controlled cross-cloud API
  calls
- **Data residency** policies determine where each dataset lives

This pattern lets customers move at their own audit-review cadence
rather than a forced cutover. Full architecture detail in
[Hybrid Fabric Commercial + Loom Gov](use-cases/hybrid-topology.md).

## Compliance posture

Per-boundary deploy variants carry the inherited compliance
attestations of the underlying Azure services:

| Boundary | Attestations |
|---|---|
| Commercial | FedRAMP High + DoD IL2 (Azure public baseline) |
| GCC (Azure Commercial under M365 GCC) | FedRAMP High + DoD IL2 |
| GCC-High / IL4 (Azure Government) | FedRAMP High + DoD IL4 + ITAR-eligible |
| DoD IL5 (Azure Government — v1.1) | FedRAMP High + DoD IL5 + CNSSI 1253 |
| HIPAA BAA | Available in all boundaries via Microsoft Product Terms |

The single notable Gov gap is **Defender for Cloud AI Threat
Protection** (Commercial-only). Loom ships a manual SOC pipeline
(Sentinel + Content Safety log wiring + self-hosted Presidio for PII
detection) as the equivalent for Gov customers. Full detail in
[Defender AI workaround](compliance/defender-ai-workaround.md).

## Cost model

v1 pricing model is **pay-as-you-go with no Loom IP fee:**

- Underlying Azure consumption (Databricks DBU, Synapse Serverless DPU,
  ADX vCore-seconds, Power BI Premium memory, ADLS storage, AOAI
  tokens, Function invocations) bills directly to the customer's
  Azure subscription
- Loom IP (Console, Setup Wizard, parity services, Copilot runtime,
  documentation, workshop materials) is **free in v1**
- Marketplace Managed Application + pricing model deferred to backlog
  per LD-4; will be revisited once the product matures

This means Loom v1 has no procurement friction beyond the customer's
existing Azure agreement.

Cost-optimization patterns (pause-resume Databricks, ADX hot/cold
tiering, Power BI smoothing, AOAI provisioned vs PAYG) are documented
in [Cost management](operations/cost.md).

## Risks the design addresses

| Risk | Mitigation |
|---|---|
| Direct Lake's sub-second freshness genuinely can't be matched | Honest gap + best-effort parity via warm-cache materializer; documented openly in [Direct Lake parity](workloads/direct-lake-parity.md) |
| UC managed not in Gov today (CY2026 commitment, no quarter) | Two-track catalog (UC managed + Purview overlay Commercial; Purview-primary Gov until UC managed Gov-GA) |
| Container Apps not at IL4/IL5 | AKS dispatch for IL4+; same workload, different host |
| Foundry Agent Service not confirmed in Gov | Microsoft Agent Framework + AOAI direct as Gov orchestrator with identical wizard UX |
| Microsoft trademark risk on the name | Public brand CSA Loom (not "Fabric-in-a-Box"); fallback TapestryOne reserved |
| Fabric continues shipping new workloads | Quarterly Build / FabCon / Ignite freshness rescans; v2 catches up on Fabric IQ family |
| Customer adoption velocity | Marketing + workshop investment; framing as "head-start, not detour" |

## What's next

Loom is currently in **v1 build wave 0** (foundation + ADRs). The full
build plan:

- **v1 — Commercial + GCC + GCC-High (6-9 months)** — full Console,
  Setup Wizard, all parity services, 8 industry examples, dual
  workshops, full documentation
- **v1.1 (+3 months) — DoD IL5** — Marketplace Managed App, Power BI
  Embedded panes, remaining 17 industry examples, `fiab-migrate` CLI,
  Operations Agent
- **v2 (+6 months) — Fabric IQ family** — Ontology, Graph, Plan,
  Maps, HorizonDB-equivalent

Per [PRP-00 README](../../PRPs/active/csa-loom/PRP-00-README.md) for
the full PRP decomposition + wave schedule.

## Get involved

- **GitHub epic:** [#279 — CSA Loom v1 build roadmap](https://github.com/fgarofalo56/csa-inabox/issues/279)
- **Branch:** `csa-loom-pillar`
- **Source documents:** [PRD](../../temp/fiab-prd/00-README.md), [Research wave](../../temp/fiab-research/), [PRPs](../../PRPs/active/csa-loom/PRP-00-README.md)

## References

- [Microsoft Fabric in Azure Government — availability](../fabric-in-gov-cloud.md)
- [CSA-in-a-Box vs Microsoft Fabric — feature-by-feature](../comparison/csa-inabox-vs-fabric.md)
- [Fabric strategic target (ADR-0010)](../adr/0010-fabric-strategic-target.md)
- [Azure Government product GA roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)
- [Azure services in FedRAMP/DoD audit scope](https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope)
- [Power BI for US Government](https://learn.microsoft.com/fabric/enterprise/powerbi/service-government-us-overview)
