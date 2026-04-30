# Migration Best Practices: GCP Analytics to Azure (csa-inabox)

**Lessons learned, common pitfalls, and proven patterns for successful GCP analytics migrations to Azure.**

---

## Pre-migration assessment checklist

Before committing to a migration, complete this assessment to scope the effort accurately and identify risks early.

### GCP inventory

- [ ] **BigQuery datasets:** Count all datasets, tables, views, and materialized views across all projects
- [ ] **Table sizes:** Total storage in TB; identify the top 20 tables by size (these drive transfer time)
- [ ] **Scheduled queries:** List all scheduled queries with their cron expressions and target tables
- [ ] **BigQuery ML models:** Inventory all `CREATE MODEL` statements and their serving patterns
- [ ] **Dataproc clusters:** List all clusters, their machine types, autoscaling policies, and job types (Spark, Presto, Flink)
- [ ] **Dataflow jobs:** Inventory all Beam pipelines (batch and streaming) with sources, sinks, and transform complexity
- [ ] **GCS buckets:** List all data-lake buckets with sizes, lifecycle policies, and retention requirements
- [ ] **Looker instances:** Count all LookML projects, models, explores, dashboards, and active users
- [ ] **Pub/Sub topics:** List all topics with message volume, subscriber count, and retention settings
- [ ] **Cloud Composer DAGs:** Inventory all Airflow DAGs that orchestrate data pipelines
- [ ] **Service accounts:** Map all service accounts to their roles and the resources they access
- [ ] **Cross-project dependencies:** Identify BigQuery datasets shared across projects or accessed via Authorized Views
- [ ] **Compliance requirements:** Document FedRAMP, DoD IL, CMMC, HIPAA requirements in scope
- [ ] **Data volumes:** Measure hot, warm, and archive data by tier
- [ ] **GCP egress budget:** Estimate total data to transfer and calculate egress costs ($0.12/GB from GCS)

### Risk register template

| Risk                                                         | Likelihood | Impact   | Mitigation                                                                                                   |
| ------------------------------------------------------------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| GCS egress costs exceed budget                               | High       | Medium   | Use OneLake shortcuts for bridge phase; batch transfers during off-peak; negotiate egress waiver with Google |
| BigQuery SQL dialect differences cause query failures        | High       | Medium   | Automated SQL linting + conversion table; run dialect tests before cutover                                   |
| LookML-to-DAX conversion takes longer than estimated         | High       | Medium   | Start with the simplest explores; allocate 2-4 weeks per LookML project                                      |
| BigQuery slot reservations cannot be released mid-commitment | Medium     | High     | Check commitment end dates; plan migration timeline around commitment boundaries                             |
| Streaming pipeline migration causes data gap                 | Medium     | High     | Run dual-publish to both Pub/Sub and Event Hubs during transition                                            |
| Users resist Power BI after years of Looker                  | High       | Medium   | Conduct UX previews early; provide training; highlight Copilot as new capability                             |
| Compliance gap during transition period                      | Low        | Critical | Maintain dual-run until Azure ATO is granted; document control inheritance                                   |

---

## Discovery phase best practices

### 1. Start with the consumers, not the data

The most common migration mistake is starting with BigQuery tables and hoping the BI layer will follow. Instead:

1. Identify the top 10 Looker dashboards by daily active users
2. Interview the analysts who use them
3. Understand the analytical workflows, not just the data
4. Design the Power BI reports first (even as wireframes)
5. Work backward to determine which Delta tables, dbt models, and ADF pipelines are needed

### 2. Profile BigQuery usage patterns

Run these queries against `INFORMATION_SCHEMA` to understand actual usage:

```sql
-- Most expensive queries by slot-hours (last 30 days)
SELECT
  user_email,
  query,
  total_slot_ms / 3600000 AS slot_hours,
  total_bytes_processed / POW(1024, 3) AS gb_processed
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND job_type = 'QUERY'
ORDER BY total_slot_ms DESC
LIMIT 50;

-- Most-read tables (last 30 days)
SELECT
  referenced_table.project_id,
  referenced_table.dataset_id,
  referenced_table.table_id,
  COUNT(*) AS query_count
FROM `region-us`.INFORMATION_SCHEMA.JOBS,
UNNEST(referenced_tables) AS referenced_table
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY 1, 2, 3
ORDER BY query_count DESC
LIMIT 50;
```

### 3. Map GCP IAM to Entra ID early

| GCP role                     | Azure equivalent                                              | Notes                     |
| ---------------------------- | ------------------------------------------------------------- | ------------------------- |
| `roles/bigquery.dataViewer`  | Unity Catalog `SELECT` + RBAC `Storage Blob Data Reader`      | Read access to data       |
| `roles/bigquery.dataEditor`  | Unity Catalog `MODIFY` + RBAC `Storage Blob Data Contributor` | Write access              |
| `roles/bigquery.jobUser`     | Databricks SQL Warehouse `CAN_USE`                            | Permission to run queries |
| `roles/bigquery.admin`       | Unity Catalog `ALL PRIVILEGES` + Workspace Admin              | Full control              |
| Service account              | User-assigned managed identity                                | No key management needed  |
| Workload Identity Federation | Managed identity federated credentials                        | For CI/CD (GitHub OIDC)   |

---

## BigQuery-specific migration challenges

### Challenge 1: Slot model to capacity model

BigQuery uses a slot-based compute model (autoscaling or reserved). Databricks uses DBU-based pricing (serverless or classic warehouses).

**Common mistake:** Trying to map slots directly to DBUs. The ratio is not linear because Photon is significantly more efficient per compute unit than BigQuery Dremel for many workloads.

**Best practice:** Run representative queries on both platforms and measure cost, not just compute units. A workload that consumes 500 slots on BigQuery may need only a Medium Databricks SQL Warehouse.

### Challenge 2: No direct SQL port

BigQuery StandardSQL and Databricks SQL are both ANSI SQL-based but have material dialect differences (see the [conversion table in the BigQuery tutorial](tutorial-bigquery-to-fabric.md#bigquery-sql-to-databricks-sql-conversion-reference)).

**Common mistake:** Assuming SQL will "just work" after replacing table names.

**Best practice:**

1. Run every scheduled query and view definition through a dialect linter
2. Address the top 10 most common conversions first: `DATE_SUB`, `SAFE_CAST`, `UNNEST`, `STRUCT`, `FORMAT_DATE`
3. Use dbt macros to abstract dialect-specific functions, making future migrations easier

### Challenge 3: BigQuery ML inline simplicity

BigQuery ML's `CREATE MODEL` and `ML.PREDICT()` in SQL is simpler than the MLflow workflow for basic models.

**Common mistake:** Trying to replicate the exact BigQuery ML workflow on Azure.

**Best practice:** Accept that the Azure ML workflow is different but more powerful:

- Simple models (linear regression, classification): Use Databricks AutoML or Azure AutoML
- Complex models: Use MLflow for experiment tracking and model registry
- SQL inference: Use `ai_query()` in Databricks SQL for hosted model inference

### Challenge 4: Materialized views refresh semantics

BigQuery materialized views refresh on write (automatic) or on schedule. Databricks materialized views and dbt incremental models have different refresh semantics.

**Best practice:**

- Automatic refresh-on-write MVs: Port to Delta Live Tables (DLT) expectations
- Schedule-refresh MVs: Port to dbt incremental models with a Databricks Workflow schedule
- Always-fresh MVs: Evaluate if a standard Delta table with `OPTIMIZE` is sufficient

---

## Looker LookML preservation strategies

### Strategy 1: Document before you delete

LookML represents institutional knowledge about your data model. Before migrating:

1. Export the full LookML repository
2. Generate documentation from LookML using `lookml-tools` or Spectacles
3. Create a mapping document: every dimension, measure, and derived table mapped to its Power BI equivalent
4. Preserve the LookML repo as a reference (do not delete until 3 months post-migration)

### Strategy 2: Port the semantic model, not the dashboards

Looker's power is in LookML (the semantic model), not in the dashboard tiles. Focus migration effort on:

1. **LookML views to Power BI tables** -- each view becomes a table in the semantic model
2. **LookML measures to DAX measures** -- use the [conversion reference](tutorial-looker-to-powerbi.md#lookml-to-dax-conversion-quick-reference)
3. **LookML explores to Power BI relationships** -- star-schema joins map directly
4. **Derived tables to dbt models** -- PDTs and SQL-derived tables become dbt SQL models

Dashboards can be rebuilt relatively quickly once the semantic model is correct.

### Strategy 3: Validate measures obsessively

The number one source of post-migration user complaints is measures that produce different numbers.

- Run parallel dashboards for 2 weeks minimum
- Compare every measure side-by-side with tolerance < 0.01%
- Pay special attention to: `percent_of_total`, `running_total`, filtered measures, and time-comparison measures

---

## Data transfer optimization

### GCP egress cost management

GCP charges $0.12/GB for standard egress to the internet (including to Azure). For a 100 TB migration, that is approximately $12,000 in egress alone.

**Strategies to reduce egress costs:**

| Strategy                                    | Savings                     | Complexity        | Best for                                 |
| ------------------------------------------- | --------------------------- | ----------------- | ---------------------------------------- |
| OneLake shortcuts (zero-copy bridge)        | 100% during bridge          | Low               | Bridge phase: query data in place        |
| Negotiate egress waiver with Google         | 50-100%                     | Low (contractual) | Migrations with existing Google contract |
| Transfer during off-peak                    | 10-20%                      | Low               | Large batch transfers                    |
| Compress before transfer (Snappy/ZSTD)      | 30-60% data reduction       | Low               | Parquet exports already compressed       |
| Google Transfer Appliance (physical)        | ~$0 egress per TB           | High              | > 50 TB datasets                         |
| Export to GCS Nearline first, then transfer | Lower storage while waiting | Low               | Multi-week staged migration              |

### Transfer parallelism recommendations

| Data volume | Recommended approach                             | Estimated time                  |
| ----------- | ------------------------------------------------ | ------------------------------- |
| < 1 TB      | AzCopy with GCS interop                          | 1-2 hours                       |
| 1-10 TB     | ADF Copy Activity (32-64 DIU)                    | 4-12 hours                      |
| 10-50 TB    | ADF Copy Activity (128 DIU) + parallel pipelines | 1-3 days                        |
| 50-200 TB   | ADF + Azure Data Box                             | 1-2 weeks (physical shipping)   |
| > 200 TB    | Google Transfer Appliance + Azure Data Box       | 2-4 weeks (physical both sides) |

---

## Parallel-run approach

### Phase 1: Shadow mode (weeks 1-4)

Run both platforms in parallel with GCP as primary:

```
GCS (source of truth)
  ├── BigQuery (primary queries)
  ├── Looker (primary dashboards)
  └── OneLake shortcut (read-only from Azure)
        ├── Databricks (shadow queries)
        └── Power BI (shadow dashboards)
```

- Users continue on Looker
- Engineers validate Azure output
- No user disruption

### Phase 2: Dual-run (weeks 5-8)

Both platforms serve production users:

- Power users migrate to Power BI
- Casual users stay on Looker
- All data refreshes run on both platforms
- Reconciliation reports run daily

### Phase 3: Cutover (weeks 9-10)

Azure becomes primary:

- Looker set to read-only
- All users on Power BI
- GCP BigQuery set to read-only
- OneLake shortcuts maintained for reference

### Phase 4: Decommission (weeks 11-14)

- Looker instance decommissioned
- BigQuery projects archived
- GCS archive buckets retained (Coldline) for compliance
- Final cost baseline published

---

## Common pitfalls

### Pitfall 1: Trying to replicate BigQuery SQL exactly

**Problem:** Teams spend weeks trying to make every BigQuery SQL query run unmodified on Databricks.

**Reality:** There are ~50 common dialect differences. Address them systematically with a conversion table and automated linting rather than ad-hoc fixing.

**Solution:** Use the [conversion reference](tutorial-bigquery-to-fabric.md#bigquery-sql-to-databricks-sql-conversion-reference). Write dbt macros for cross-dialect functions (e.g., a `safe_cast` macro that generates `TRY_CAST` on Databricks).

### Pitfall 2: Not accounting for GCP egress charges during migration

**Problem:** Teams budget for Azure costs but forget that Google charges $0.12/GB for data leaving GCS.

**Reality:** A 100 TB migration costs ~$12,000 in egress alone, before any Azure costs.

**Solution:** Include egress in the migration budget from day one. Use OneLake shortcuts during the bridge phase to avoid egress for read-only access. Negotiate an egress waiver with Google if you have an existing contract.

### Pitfall 3: Under-estimating LookML to DAX conversion effort

**Problem:** Teams assume LookML measures will port to DAX in hours.

**Reality:** Simple sum/count measures port quickly, but `percent_of_total`, `running_total`, filtered measures, Liquid parameters, and complex derived tables require significant DAX expertise.

**Solution:** Budget 2-4 weeks per LookML project with a medium-complexity explore set. Assign Power BI specialists (not generalist data engineers) to the DAX conversion work.

### Pitfall 4: Ignoring BigQuery BI Engine caching

**Problem:** Looker dashboards on BigQuery BI Engine load in sub-second. After migration, Power BI dashboards feel slow.

**Reality:** BI Engine provides up to 200 GB of in-memory caching. Without configuring Direct Lake correctly, Power BI will fall back to DirectQuery and be significantly slower.

**Solution:** Ensure the Power BI semantic model uses Direct Lake mode (not Import or DirectQuery). Direct Lake reads Delta files directly from OneLake with VertiPaq in-memory acceleration, providing equivalent or better performance to BI Engine for most workloads.

### Pitfall 5: Migrating everything at once

**Problem:** Teams try to migrate all BigQuery datasets, all Dataproc jobs, all Looker dashboards, and all Pub/Sub topics simultaneously.

**Reality:** This creates an unmanageable number of parallel workstreams and makes reconciliation nearly impossible.

**Solution:** Migrate one domain end-to-end first (the pilot). Prove the pattern, build confidence, then expand wave-by-wave. The [migration playbook](../gcp-to-azure.md) Phase 2 pilot approach is designed for this.

### Pitfall 6: Forgetting BigQuery slot commitments

**Problem:** Teams plan a migration timeline that starts before their BigQuery slot reservation commitment expires.

**Reality:** BigQuery Edition commitments (annual or 3-year) cannot be cancelled early. You will pay for both platforms during the overlap.

**Solution:** Check commitment end dates during discovery. Align the migration timeline so heavy compute moves to Azure after the BigQuery commitment expires. Use OneLake shortcuts to start reading data from Azure without moving compute off BigQuery.

### Pitfall 7: Not testing incremental model semantics

**Problem:** BigQuery scheduled queries that use `CREATE OR REPLACE TABLE` work differently from dbt incremental models.

**Reality:** A BigQuery `CREATE OR REPLACE` rewrites the entire table. A dbt `incremental` model with `merge` strategy only processes new/changed rows. If the source data has late-arriving updates, the incremental model may miss them.

**Solution:** Carefully configure the dbt incremental model's `WHERE` clause to include a lookback window (e.g., `DATE_SUB(CURRENT_DATE(), 3)` to reprocess the last 3 days). Test with late-arriving data explicitly.

---

## Team structure recommendations

### Minimum viable migration team

| Role                                | Count | Responsibilities                                                                  |
| ----------------------------------- | ----- | --------------------------------------------------------------------------------- |
| Migration lead / architect          | 1     | Overall plan, decision-making, stakeholder communication                          |
| Data engineer (BigQuery specialist) | 1-2   | BigQuery inventory, SQL conversion, dbt model authoring                           |
| Data engineer (Azure / Databricks)  | 1-2   | Databricks setup, Unity Catalog, ADF pipelines, Delta optimization                |
| BI engineer (Looker + Power BI)     | 1-2   | LookML-to-DAX conversion, dashboard rebuild, Direct Lake config                   |
| Streaming engineer                  | 0-1   | Event Hubs, Stream Analytics, Structured Streaming (if streaming workloads exist) |
| Platform / infra engineer           | 1     | Bicep IaC, networking (Private Link), CI/CD, Azure Monitor                        |
| Security / compliance               | 1     | ATO documentation, Purview classifications, access controls, audit evidence       |
| Change management                   | 1     | User training, communication plan, feedback collection                            |
| GCP SME                             | 1     | Knowledge transfer, BigQuery ML models, Dataflow pipelines, Looker LookML         |

### Scale for larger migrations

For migrations with 50+ BigQuery datasets, 10+ Looker projects, and streaming workloads:

- Add 1 data engineer per 20 BigQuery datasets
- Add 1 BI engineer per 3 LookML projects
- Add 1 streaming engineer per 5 Dataflow streaming pipelines
- Add a dedicated reconciliation engineer to run parallel validation

---

## Timeline estimation

| Migration scope | BigQuery datasets | Looker projects | Dataflow pipelines | Estimated duration |
| --------------- | ----------------- | --------------- | ------------------ | ------------------ |
| Small           | 5-15              | 1-2             | 0-3                | 12-18 weeks        |
| Medium          | 15-50             | 3-5             | 3-10               | 20-30 weeks        |
| Large           | 50-150            | 5-15            | 10-30              | 30-44 weeks        |
| Enterprise      | 150+              | 15+             | 30+                | 44-60 weeks        |

Multiply by 1.3x for federal/government deployments (ATO overhead, clearance requirements, procurement delays).

### Timeline accelerators

- Looker → Power BI conversion tools (emerging; monitor Fabric roadmap)
- dbt dialect-conversion macros (reduce SQL porting effort by ~30%)
- OneLake shortcuts (eliminate egress during bridge phase)
- Pre-built csa-inabox landing zone (weeks 3-7 of the playbook ship ready-to-use)

### Timeline risks

- GCP slot commitment overlap (cannot cancel early)
- LookML complexity (highly customized models take 2x longer)
- Data volume (> 100 TB requires physical transfer planning)
- Compliance re-authorization (ATO renewal on Azure may gate cutover)

---

## Risk mitigation

### Technical risks

| Risk                                                   | Probability | Mitigation                                                             |
| ------------------------------------------------------ | ----------- | ---------------------------------------------------------------------- |
| Query performance regression on Databricks             | Medium      | Benchmark top 50 queries before committing; tune Z-ordering and Photon |
| Data loss during transfer                              | Low         | Checksums on every Parquet file; row-count reconciliation per table    |
| dbt model produces different results                   | Medium      | 2-week parallel run with automated reconciliation reports              |
| Streaming data gap during Pub/Sub to Event Hubs switch | Medium      | Dual-publish pattern: send events to both during transition            |

### Organizational risks

| Risk                                           | Probability | Mitigation                                                                  |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------- |
| User resistance to Power BI                    | High        | Early UX previews; highlight Copilot; training sessions                     |
| Loss of Looker / GCP tribal knowledge          | Medium      | Document everything before decommission; retain GCP SME through Phase 7     |
| Budget overrun (egress + dual-run costs)       | Medium      | Include egress in budget; negotiate with Google; minimize dual-run duration |
| Timeline slip (cascading delays across phases) | High        | Phase gates with go/no-go criteria; pilot first to calibrate velocity       |

### Compliance risks

| Risk                                     | Probability | Mitigation                                                                       |
| ---------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| Gap in ATO during transition             | Low         | Maintain dual-run until Azure ATO granted; document control inheritance          |
| Audit evidence loss from GCP             | Medium      | Archive Cloud Audit Logs, IAM policies, VPC Service Controls before decommission |
| Data residency violation during transfer | Low         | Use Azure Government; verify data never transits non-compliant regions           |

---

## Related resources

- [GCP to Azure Migration Playbook](../gcp-to-azure.md) -- End-to-end phased plan
- [BigQuery to Fabric Tutorial](tutorial-bigquery-to-fabric.md) -- Hands-on table migration
- [Looker to Power BI Tutorial](tutorial-looker-to-powerbi.md) -- Semantic model conversion
- [Dataflow to ADF Tutorial](tutorial-dataflow-to-adf.md) -- Pipeline migration
- [Benchmarks](benchmarks.md) -- Performance and cost comparison data

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Playbook](../gcp-to-azure.md) | [Tutorials](tutorial-bigquery-to-fabric.md) | [Benchmarks](benchmarks.md)
