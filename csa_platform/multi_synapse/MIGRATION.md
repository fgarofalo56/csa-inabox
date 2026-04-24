[← Multi-Synapse README](README.md)

# Multi-Synapse — Migration Playbook

> **Scope:** CSA-0139 / AQ-0034 — legacy posture change for `csa_platform/multi_synapse/`.

> [!IMPORTANT]
> **Read this first if you are on Synapse today and evaluating a move.**
> `csa_platform/multi_synapse/` remains deployable for existing footprints,
> but in 2026 the CSA-in-a-Box platform positioning is **Fabric-primary**
> (CSA-0063, Commercial + where GA) and **Databricks-primary for compute**
> (ADR-0002). Synapse is legacy / migration-only. This doc shows what each
> Synapse capability maps to on Databricks and Fabric so you can plan a
> phased exit.

## Table of Contents

- [Why this module is legacy](#why-this-module-is-legacy)
- [Capability mapping matrix](#capability-mapping-matrix)
- [Per-capability migration notes](#per-capability-migration-notes)
  - [Synapse Dedicated SQL Pool](#synapse-dedicated-sql-pool)
  - [Synapse Serverless SQL](#synapse-serverless-sql)
  - [Synapse Spark Pools](#synapse-spark-pools)
  - [Synapse Pipelines](#synapse-pipelines)
  - [Cross-workspace federation](#cross-workspace-federation)
  - [RBAC templates](#rbac-templates)
  - [Cost allocation](#cost-allocation)
  - [Network isolation & governance](#network-isolation--governance)
- [Phasing & sequencing](#phasing--sequencing)
- [Related references](#related-references)

---

## Why this module is legacy

Synapse Analytics was the standing "Fabric-equivalent-in-Gov" compute
pattern when CSA-in-a-Box first shipped. Since then:

- **ADR-0002** — Databricks selected as the primary Spark / ML / lakehouse
  engine over OSS Spark and Synapse Spark. MLflow + Unity Catalog + Photon
  are first-class.
- **ADR-0010 / CSA-0063** — Microsoft Fabric positioned as the strategic
  target for Commercial workloads where Fabric is GA; OneLake + Direct Lake
  + Data Activator + Fabric Data Factory replace the Synapse-centric
  control plane.
- **Decision tree** — [`docs/decisions/fabric-vs-databricks-vs-synapse.md`](../../docs/decisions/fabric-vs-databricks-vs-synapse.md)
  now lists Synapse as the recommendation only for (a) Azure Government at
  IL5/IL6, (b) existing dedicated-pool SQL DW estates, or (c) Gov tenants
  where Databricks is not yet authorized. Greenfield Commercial lakehouse
  workloads are explicitly anti-patterned.

The `multi_synapse` module stays in the repo because customers with
existing Synapse footprints still need the automation. It is not the
recommended path for new platforms.

---

## Capability mapping matrix

| Synapse capability (today) | Databricks target | Fabric target | Effort | Notes |
|---|---|---|---|---|
| Dedicated SQL Pool (MPP DW) | Databricks SQL Warehouse (serverless or pro) over Delta on ADLS Gen2 | Fabric Warehouse over OneLake | **L** | Schema + stored procedure rewrite. Photon handles most DW query shapes. |
| Serverless SQL over ADLS | Databricks Lakehouse Federation / SQL Warehouse over Delta external tables | Fabric SQL endpoint over OneLake shortcut to ADLS | **M** | Views and `OPENROWSET` become Delta external tables or Unity Catalog foreign tables. |
| Synapse Spark pools | Databricks (Unity Catalog + Delta + MLflow) | Fabric Spark notebooks | **M** | Databricks path preferred for production ML / streaming; Fabric for notebook-first mixed workloads. |
| Synapse Pipelines | Azure Data Factory + dbt Core (ADR-0001 / ADR-0008) | Fabric Data Factory pipelines | **M** | ADF is the Gov-available path; Fabric Data Factory for Commercial Fabric tenants. |
| Cross-workspace linked services / federation | Unity Catalog cross-catalog + Databricks Lakehouse Federation | OneLake shortcuts + Fabric workspace sharing | **M** | Unity Catalog replaces most linked-service patterns; Fabric shortcuts are zero-copy. |
| Workspace-level RBAC templates (analyst / engineer / admin) | Unity Catalog groups + SQL Warehouse permissions + workspace ACLs | Fabric workspace roles + item permissions | **S** | Role names map 1:1; enforcement surface moves to Unity Catalog / Fabric. |
| Per-workspace cost allocation by tag | Databricks cluster tags + Unity Catalog billable usage + Azure Cost Mgmt | Fabric capacity metering + Azure Cost Mgmt on F-SKU | **S** | Tag-based cost grouping is preserved on both targets. |
| Shared managed VNet + private endpoints | Databricks secure cluster connectivity (NPIP) + private endpoints + VNet injection | Fabric private link + managed private endpoints | **M** | Both targets support private-only; Databricks has longer track record in Gov. |
| Purview lineage from Synapse | Purview scan connectors for Databricks + Unity Catalog lineage | Fabric-Purview integration (native) | **S** | Purview remains the catalog of record; only the scanned system changes. |

**Effort legend:** XS < 1 sprint, S = 1–2 sprints, M = 2–6 sprints, L = 6+ sprints per workload.

---

## Per-capability migration notes

### Synapse Dedicated SQL Pool

**Databricks target (recommended default):**

1. Export DDL and stored procedures from the dedicated pool. Databricks SQL
   uses ANSI SQL + Delta-specific extensions; most T-SQL DDL translates
   with light tweaks (`DISTRIBUTION` / `CLUSTERED COLUMNSTORE` → Delta
   partitioning + Z-ORDER).
2. Land raw data in ADLS Gen2 Bronze (Delta). Use ADF or Databricks Auto
   Loader from the current Synapse storage account — no pool-to-pool data
   movement required if storage is already on ADLS.
3. Rebuild Silver / Gold as Delta tables registered in Unity Catalog.
4. Stand up a Databricks SQL Warehouse (serverless for bursty BI; pro for
   steady high concurrency). Photon handles MPP-style query shapes; tune
   with OPTIMIZE + ZORDER rather than CTAS distribution hints.
5. Point Power BI at the SQL Warehouse; Direct Lake mode reads Delta
   directly in Fabric and Databricks-SQL-backed semantic models work in
   Commercial + Gov.

**Fabric target (Commercial, Power BI-centric):**

1. Stand up OneLake via a Fabric workspace; shortcut existing ADLS Gen2
   Gold container if no data movement desired.
2. Recreate objects as Fabric Warehouse tables or lakehouse Delta tables.
3. Migrate stored procedures to T-SQL notebooks or Fabric Data Factory
   data flows.

**Anti-pattern checklist (do not do):**

- Do **not** run Synapse and Databricks on the same Delta tables with
  different metastores — pick one metastore (Unity Catalog) as source of
  truth before cutover.
- Do **not** keep dedicated-pool capacity running "just in case" more
  than 30 days past cutover; the reserved capacity is the primary cost
  saving.

**Reuse existing playbooks:** the Snowflake
([docs/migrations/snowflake.md](../../docs/migrations/snowflake.md)),
AWS Redshift ([docs/migrations/aws-to-azure.md](../../docs/migrations/aws-to-azure.md)),
and BigQuery ([docs/migrations/gcp-to-azure.md](../../docs/migrations/gcp-to-azure.md))
playbooks all walk the same "MPP SQL DW → Databricks SQL Warehouse + Delta"
path. The patterns transfer directly.

### Synapse Serverless SQL

- **Databricks target:** convert serverless SQL views on ADLS to Delta
  external tables registered in Unity Catalog; queries via SQL Warehouse
  are pay-per-query equivalent. For cross-system federation (e.g. Azure
  SQL, Postgres, Snowflake) use **Lakehouse Federation** rather than
  OPENROWSET.
- **Fabric target:** create shortcuts in OneLake pointing at existing
  ADLS containers; Fabric SQL endpoint exposes them as queryable tables
  without data movement.

### Synapse Spark Pools

- **Databricks target (recommended):** default for all production Spark.
  Get Unity Catalog, MLflow, Delta Live Tables, Photon, and mature
  streaming in one package. Re-home notebooks; minimal code change for
  standard PySpark.
- **Fabric target:** notebook-first Spark inside Fabric workspaces. Use
  when the workload is Power BI / OneLake-adjacent and the Spark surface
  is modest.
- **Anti-pattern:** keep Synapse Spark running for ML experimentation
  past the cutover — MLflow is substantially better tracking plane.

### Synapse Pipelines

- **Databricks + ADF path (Gov + Commercial):** ADF is the pipeline
  engine ([ADR-0001](../../docs/adr/0001-adf-dbt-over-airflow.md)); dbt
  Core ([ADR-0008](../../docs/adr/0008-dbt-core-over-dbt-cloud.md))
  handles transformations. Synapse Pipeline JSON translates to ADF
  pipeline JSON with minimal changes (same engine lineage).
- **Fabric path:** Fabric Data Factory is the evolution of ADF inside the
  Fabric control plane; lift-and-shift ADF pipelines via the built-in
  importer.
- Metadata-driven pipeline generation remains available in
  `csa_platform/metadata_framework/` and is the recommended replacement
  for hand-built Synapse Pipelines.

### Cross-workspace federation

The Synapse pattern ("CREATE EXTERNAL DATA SOURCE" pointing at another
workspace's ADLS) becomes:

- **Databricks:** Unity Catalog cross-catalog grants, or Delta Sharing
  across workspaces / tenants for looser coupling.
- **Fabric:** OneLake shortcuts — zero-copy logical pointers across
  workspaces and tenants, governed by Fabric workspace roles.

Both targets are stronger than the Synapse federation pattern because
the governance boundary and the query boundary align.

### RBAC templates

`rbac_templates/analyst_role.yaml`, `engineer_role.yaml`, and
`admin_role.yaml` in this module encode three personas. The same three
personas map directly to:

- **Databricks + Unity Catalog:** Unity Catalog groups + catalog/schema
  grants + SQL Warehouse ACLs. The
  [snowflake migration](../../docs/migrations/snowflake.md) and
  [aws-to-azure migration](../../docs/migrations/aws-to-azure.md) both
  cite these RBAC templates as the pattern to port.
- **Fabric:** Fabric workspace roles (Admin / Member / Contributor /
  Viewer) plus item-level permissions. Coarser than Unity Catalog; layer
  Purview policies where finer grain is needed.

### Cost allocation

Tagging strategy (`Organization`, `CostCenter`, `Environment`, `Project`)
moves verbatim:

- **Databricks:** tag clusters and SQL Warehouses with the same keys;
  Unity Catalog system tables expose billable usage by tag.
- **Fabric:** tag the F-SKU capacity resource at the Azure layer; Fabric
  capacity metrics app attributes CU consumption per workspace.

Cost Management KQL queries that group by `Organization` continue to
work after cutover — only the `ResourceType` filter changes.

### Network isolation & governance

| Control | Synapse (today) | Databricks target | Fabric target |
|---|---|---|---|
| Private-only networking | Managed VNet + private endpoints | VNet injection + NPIP + private endpoints | Private link + managed private endpoints |
| Data exfiltration prevention | `preventDataExfiltration: true` | NPIP + UDR + Azure Firewall egress | Tenant-wide outbound restrictions + workspace firewall |
| Diagnostic logging | Log Analytics via diagnostic settings | Same (workspace + cluster logs) | Fabric monitoring + Log Analytics export |
| Purview lineage | Synapse-Purview connector | Databricks-Purview connector + Unity Catalog system tables | Native Fabric-Purview integration |
| Policy enforcement | Azure Policy on Synapse resources | Azure Policy on Databricks workspaces + Unity Catalog policies | Fabric tenant / capacity policies + Azure Policy on F-SKU |

Tamper-evident audit logging (CSA-0016) is transport-agnostic and works
against all three targets.

---

## Phasing & sequencing

A typical exit from multi_synapse proceeds in four phases:

1. **Stand-up (1–2 sprints).** Deploy the Databricks workspace + Unity
   Catalog (or Fabric workspace + OneLake) alongside the existing Synapse
   footprint. No workloads moved. Validate networking, Purview scans, and
   RBAC.
2. **Shadow (2–4 sprints).** Rebuild Gold-layer Delta tables on the new
   target. Run Power BI semantic models against both sources; compare
   query results and performance. No production cutover yet.
3. **Cutover (per workload, 1–3 sprints).** Redirect BI consumers and
   downstream pipelines to the new target one workload at a time. Keep
   Synapse read-only as a fallback for one release cycle.
4. **Decommission (1 sprint).** Drop Synapse dedicated pools (reserved
   capacity ends), remove Spark pools, retire the Synapse workspaces.
   Keep the `csa_platform/multi_synapse/` module in the repo but stop
   applying its Bicep.

Do not try to cutover more than one workload per release. Keep the RBAC
template names stable across the cutover so downstream IAM automation
does not have to be re-audited.

---

## Related references

- [Multi-Synapse README](README.md) — module capabilities (for customers
  still operating Synapse)
- [ADR-0002: Databricks over OSS Spark](../../docs/adr/0002-databricks-over-oss-spark.md)
- [ADR-0010: Fabric as strategic target](../../docs/adr/0010-fabric-strategic-target.md)
- [Decision tree: Fabric vs. Databricks vs. Synapse](../../docs/decisions/fabric-vs-databricks-vs-synapse.md)
- [Decision tree YAML](../../decision-trees/fabric-vs-databricks-vs-synapse.yaml)
- [Migration: Snowflake → Azure](../../docs/migrations/snowflake.md)
- [Migration: AWS → Azure](../../docs/migrations/aws-to-azure.md)
- [Migration: GCP → Azure](../../docs/migrations/gcp-to-azure.md)
- [Migration: Palantir Foundry → Azure](../../docs/migrations/palantir-foundry.md)
- [Platform Services](../../docs/PLATFORM_SERVICES.md)
- [Architecture](../../docs/ARCHITECTURE.md)
- [Unity Catalog Pattern](../unity_catalog_pattern/README.md) — the
  primary lakehouse pattern replacing Synapse workspaces for new work
- [Semantic Model](../semantic_model/README.md) — Power BI semantic
  models over Databricks SQL (replaces Synapse-backed BI)
