# Migration — Teradata → Synapse / Fabric

> **Audience:** Teams running Teradata (on-prem or VantageCloud) considering a move to Azure. Most large enterprises have a Teradata commitment of 10-20+ years and migrating is multi-year, not multi-quarter.

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete Teradata-to-Azure migration package — including white papers, deep-dive guides, tutorials, and benchmarks — visit the **[Teradata Migration Center](teradata/index.md)**.

    **Quick links:**

    - [Why Azure over Teradata (Executive Brief)](teradata/why-azure-over-teradata.md)
    - [Total Cost of Ownership Analysis](teradata/tco-analysis.md)
    - [Complete Feature Mapping (40+ features)](teradata/feature-mapping-complete.md)
    - [Tutorials & Walkthroughs](teradata/index.md#tutorials)
    - [Benchmarks & Performance](teradata/benchmarks.md)
    - [Best Practices](teradata/best-practices.md)

## Decide first: target architecture

Teradata workloads have characteristics that map differently:

| Workload type                                            | Best Azure target                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Classic EDW / SQL warehouse (BTEQ scripts, stored procs) | **Synapse Dedicated SQL Pool** or **Fabric Warehouse** (T-SQL native) |
| BI semantic layer + Power BI                             | **Fabric Lakehouse + Direct Lake**                                    |
| Heavy MPP joins / large aggregations                     | **Synapse Dedicated SQL Pool** (proven) or **Databricks Photon**      |
| Ad-hoc analyst SQL                                       | **Synapse Serverless SQL** over Delta                                 |
| ML feature engineering                                   | **Databricks** (better than any SQL warehouse)                        |
| Unstructured / semi-structured data                      | **ADLS Delta** + Synapse Spark / Databricks                           |

For most Teradata estates, the right target is **Fabric or Synapse + Databricks side by side**, with Teradata workloads decomposed by type.

## Phase 1 — Assessment (4-8 weeks)

### Inventory

For each Teradata system:

- **Tables**: count, size, partitioning (PI / PPI), compression
- **Views**: count, complexity (lines, depth)
- **Stored procedures + macros + UDFs**: count, dialect-specific features
- **BTEQ / TPT scripts**: count, downstream consumers
- **Workloads**: TASM workload classes, peak QPS, query latency p50/p95
- **Users / roles**: count, RBAC complexity
- **Data volumes**: total, hot vs cold, growth rate
- **Cost**: license + hardware/cloud + ops + people

### Tools that help

- **Microsoft SAMA** (Synapse Assessment & Migration Accelerator) — automated schema + workload analysis
- **Datametica Raven** — Teradata-specific migration accelerator (third-party, paid)
- **dbt + sqlglot** — for converting BTEQ/SQL to dbt models with auto-translation

### Migration tier per workload

| Tier                       | Description                                                            | Action                                   |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| **A** Direct migrate       | Pure SQL, standard ANSI features                                       | Use SAMA / sqlglot for translation       |
| **B** Refactor required    | Teradata-specific features (RECURSIVE views, MERGE behaviors, QUALIFY) | Manual rewrite to Spark SQL or T-SQL     |
| **C** Architectural rework | TASM-dependent workloads, custom UDFs in Java                          | Rewrite in dbt + Databricks/Synapse      |
| **D** Decommission         | Workloads no longer used                                               | Don't migrate; archive output and delete |

Plan for **20-40% of workloads to be Tier D** — most Teradata estates have significant zombie workloads.

## Phase 2 — Design (3-4 weeks)

### Schema mapping

| Teradata concept                          | Azure equivalent                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| **Database**                              | Synapse SQL DB / Fabric Lakehouse / Databricks catalog                  |
| **Primary Index (PI)**                    | Distribution column (Synapse) / Z-order (Delta) / Clustering (Fabric)   |
| **PPI (Partitioned PI)**                  | Partition column                                                        |
| **Secondary Index**                       | No equivalent — denormalize, materialize aggregates, or use star schema |
| **MERGE INTO ... WHEN MATCHED**           | Delta `MERGE INTO` (Spark) / T-SQL `MERGE` (Synapse / Fabric Warehouse) |
| **QUALIFY**                               | Window function in WHERE / CTE pattern                                  |
| **RECURSIVE VIEW**                        | CTE recursion (T-SQL or Spark SQL)                                      |
| **TASM workload management**              | Synapse resource classes / Databricks SQL warehouse sizing              |
| **Multivalue-compress / row compression** | Delta with Z-order + VACUUM; Synapse compression is automatic           |

### Network topology

Teradata is usually on-prem or in a private datacenter. Plan ExpressRoute (or a temporary Azure Data Box / Data Box Heavy for the initial bulk load):

| Volume        | Recommended path                                            |
| ------------- | ----------------------------------------------------------- |
| <1 TB         | ExpressRoute or VPN                                         |
| 1-100 TB      | ExpressRoute (allow 1-7 days)                               |
| 100 TB - 1 PB | Azure Data Box Heavy (multiple devices, 1-2 weeks shipping) |
| >1 PB         | Phased Azure Data Box Heavy + ExpressRoute for delta        |

## Phase 3 — Migration (12-52 weeks)

### Initial bulk load

Use **Teradata TPT (Parallel Transporter)** to extract to Parquet on local disk, then upload to ADLS:

```bash
# TPT script extracts to Parquet
tbuild -f extract_parquet.tpt

# Upload to ADLS
azcopy copy ./parquet_output/ \
  "https://<storage>.dfs.core.windows.net/raw/teradata-bulk/?<sas>" \
  --recursive
```

Then in Synapse / Databricks, convert Parquet → Delta with proper partitioning:

```sql
CREATE TABLE silver.orders
USING DELTA
PARTITIONED BY (order_date)
AS SELECT * FROM bronze.orders_parquet;
```

### Continuous sync during migration window

Pick one:

- **Qlik Replicate / Attunity** — paid CDC-based, mature for Teradata source
- **Custom CDC via journal tables** — if your Teradata is configured for it
- **Bulk re-extract daily** — only viable for small databases

Plan for 6-18 months of dual-running during the migration window.

### SQL translation

For each Tier-A workload:

```bash
# Convert Teradata SQL to Spark SQL using sqlglot
sqlglot transpile -r teradata -w spark "SELECT ... QUALIFY ROW_NUMBER() OVER ..."

# Convert to dbt model
dbt init my_migration
# ... add converted SQL as a model
dbt run --select my_migration_model
```

For each Tier-B/C workload:

- Manual rewrite by a senior data engineer + Teradata SME pair
- Test with sample data before running against full volume
- Reconcile output against Teradata source until 3 consecutive runs match within tolerance

### Workload class mapping (TASM → Azure)

Teradata's TASM workloads need explicit replacement:

| TASM concept                                        | Azure replacement                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Workload class** = priority + resource allocation | Synapse: separate SQL pools per workload tier OR resource classes within one pool. Databricks: separate SQL warehouses per tier with per-warehouse autoscale |
| **Throttle rules**                                  | Synapse: workload management rules + concurrency. Databricks: warehouse max-clusters cap                                                                     |
| **Filter rules**                                    | Application-level routing (BI tool sends Tier-1 queries to Pool-A, Tier-3 to Pool-B)                                                                         |

## Phase 4 — Cutover (per workload, 1-2 weeks)

For each migrated workload:

- [ ] 14-day parallel run; daily reconciliation reports
- [ ] BI consumers repointed (semantic model on Azure backend)
- [ ] Downstream API consumers repointed
- [ ] Teradata workload set to read-only
- [ ] After 30 days of stable Azure operation, decommission Teradata workload

## Phase 5 — Decommission (months 18-36)

- [ ] Final Teradata extract + archive to ADLS Cool/Archive tier (compliance retention)
- [ ] Teradata system shut down per LOB
- [ ] License termination
- [ ] Hardware decommission / cloud subscription cancellation

## Cost during migration

Plan for **3-5x your steady-state cost** during the migration window because:

- Teradata license + hardware still running
- Azure target running in parallel
- Migration tooling (Qlik Replicate, etc.)
- Migration team (often 10-30 FTE for 18+ months)

The ROI case must include the multi-year savings, not just year-1.

## Common pitfalls

| Pitfall                                                               | Mitigation                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Translating SQL line-by-line** without thinking about target idioms | Convert to **dbt** as the new modeling layer; don't preserve every BTEQ script              |
| **Keeping Teradata-style workload management**                        | TASM concepts don't map; use Azure-native workload separation (multiple pools / warehouses) |
| **Underestimating BI re-validation**                                  | Every dashboard + report needs to be re-validated; budget 30-50% of project effort here     |
| **Forgetting stored procs / macros**                                  | Often hidden business logic; plan inventory + rewrite explicitly                            |
| **No parallel-run window**                                            | Cutover-and-pray fails. Always 14-30 day parallel runs                                      |
| **Trying to move everything**                                         | 20-40% of workloads should be decommissioned, not migrated                                  |

## Trade-offs

✅ **Why migrate**

- Teradata licensing + hardware is the most expensive line in many EDW budgets
- Cloud elasticity for spiky workloads
- AI / ML / GenAI integration with the same data
- Talent — easier to hire Spark/SQL engineers than Teradata-specific specialists

⚠️ **Why be patient**

- Teradata's MPP performance on certain workloads is genuinely hard to match without significant Synapse/Databricks tuning
- Migrating is 18-36 months at enterprise scale; plan executive air cover for that long
- Operational maturity (resilience, support, ecosystem) is in Teradata's favor — Azure side requires investment

## Related

- [Migrations — Hadoop / Hive](hadoop-hive.md) — similar phased pattern
- [Migrations — Snowflake](snowflake.md) — sister cloud DW migration
- [Reference Architecture — Fabric vs Synapse vs Databricks](../reference-architecture/fabric-vs-synapse-vs-databricks.md)
- [Patterns — Power BI & Fabric Roadmap](../patterns/power-bi-fabric-roadmap.md)
- Microsoft SAMA: https://aka.ms/sama
- Azure for Teradata customers: https://learn.microsoft.com/azure/architecture/databases/idea/teradata-migration
