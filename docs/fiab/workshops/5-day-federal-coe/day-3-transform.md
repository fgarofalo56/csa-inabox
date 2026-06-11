# Day 3 — Transform & Lakehouse & Warehouse (Federal CoE)

**Track:** [5-Day Federal CoE Workshop](index.md) · **Day 3 of 5** ·
Transform & Lakehouse & Warehouse

Day 3 is the heaviest hands-on day. Participants build a medallion
(Bronze → Silver → Gold) on the workload they chose for homework, run ad-hoc
SQL over the lakehouse, and explore real-time data with KQL.

!!! info "Azure-native by default"
    Transform runs on Databricks notebooks + dbt; the warehouse is a Synapse
    dedicated SQL pool (or Databricks SQL); real-time is Azure Data Explorer.
    **No Fabric Warehouse, no OneLake.** `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Learning objectives

1. Build a medallion pipeline (Bronze → Silver → Gold) on a real workload.
2. Use Databricks notebooks + dbt for transformations with Git source control.
3. Query Gold tables via the warehouse (Synapse dedicated SQL pool).
4. Explore streaming/event data with KQL over ADX.
5. Schedule transforms as recurring jobs.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-2 recap + medallion architecture | Lecture |
| 09:30 | Bronze → Silver: cleansing + conformance (notebook + dbt) | Lab |
| 10:45 | Break | — |
| 11:00 | Silver → Gold: business aggregates | Lab |
| 12:00 | Lunch | — |
| 13:00 | Warehouse query over Gold (Synapse dedicated SQL) | Lab |
| 14:00 | KQL exploration over the synthetic IoT stream (ADX) | Lab |
| 15:00 | Break | — |
| 15:15 | Schedule the medallion as a recurring job | Lab |
| 16:15 | Commit notebooks to Git + wrap-up | Plenary |

### Talking points

- **Medallion on Azure-native:** Bronze = raw Delta (Day 2), Silver = cleansed +
  conformed, Gold = business aggregates. Each layer is a Delta table in ADLS;
  the warehouse reads Gold via external tables / serverless or a dedicated pool.
- **dbt + Git:** transformations are code. The TMDL/dbt Git workflow is the same
  one used for forward-migration on Day 5 — port unchanged to Fabric later.
- **Warehouse backend:** the Loom warehouse is a **Synapse dedicated SQL pool**
  by default (`LOOM_WAREHOUSE_BACKEND`), or Databricks SQL on Commercial. There
  is no Fabric Warehouse dependency.

### Exercises

1. Pairs review each other's Silver layer for correct CUI handling (no raw
   identifiers promoted to Gold without masking).
2. Group compares a serverless vs dedicated-pool query plan on the same Gold
   table and discusses cost/perf trade-offs.

### Common pitfalls

- Dedicated SQL pool paused/not provisioned → the warehouse query gate names the
  pool to resume. Resume it (or use serverless) and retry.
- Writing Gold without partitioning → slow warehouse reads. Partition Gold by
  the natural query dimension (e.g., date).

## Participant lab — build the medallion

1. **Bronze → Silver.** In **Notebook** (`/notebook`), create a notebook that
   reads `bronze.sensor_readings`, drops malformed rows, conforms timestamps to
   UTC, and writes `silver.sensor_readings_clean` as Delta. Commit the notebook
   to the workspace Git repo.
2. **Silver → Gold (dbt).** Add a dbt model that aggregates Silver to hourly
   per-device rollups → `gold.device_hourly`. Run `dbt run` + `dbt test`.
3. **Warehouse query.** In **Warehouse** (`/warehouse`), run a SQL query against
   `gold.device_hourly` (top-10 noisiest devices last 24h). Confirm the result
   grid returns rows from the dedicated pool / serverless backend.
4. **KQL over ADX.** In **Realtime hub** (`/realtime-hub`) or the KQL queryset,
   run a KQL query over the ingested IoT events:
   ```kusto
   sensor_readings
   | where timestamp > ago(1h)
   | summarize avg(reading_value) by device_id, bin(timestamp, 5m)
   | render timechart
   ```
5. **Schedule.** Create a recurring job that runs the Bronze→Silver→Gold chain
   nightly. Confirm the schedule is saved and the next run time is shown.

**Validation (Day-3 done):** Silver + Gold Delta tables exist, dbt tests pass, a
warehouse query returns Gold rows, a KQL query renders over ADX, and the
medallion is scheduled.

## Datasets

- [Synthetic IoT](../datasets/synthetic-iot.md) — medallion source.
- [Synthetic financial transactions](../datasets/synthetic-financial-transactions.md)
  — optional second workload for FSI-adjacent agencies.

## Homework

- Commit your transform notebooks + dbt models to the customer Git repo (this is
  the artifact you forward-migrate on Day 5).

## Federal-specific emphasis

- **CUI in Silver/Gold:** apply masking/tokenization for controlled fields
  before promotion. Confirm classification tags propagate from Day 2.
- **Materialized Lake Views** run as scheduled Jobs in Gov (no managed Fabric
  scheduler). Document the schedule in the CoE charter.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-federal-coe/day-3-transform.md`.

## Related

- [← Day 2](day-2-ingest.md) · [Day 4 — BI & AI →](day-4-bi-ai.md)
- [Lakehouse workload](../../workloads/lakehouse.md) ·
  [Data warehouse workload](../../workloads/data-warehouse.md)
- [Tutorial 02 — First lakehouse](../../tutorials/02-first-lakehouse.md)
