# Day 3 — Transform & Lakehouse & Warehouse (Commercial CoE)

**Track:** [5-Day Commercial CoE Workshop](index.md) · **Day 3 of 5** ·
Transform & Lakehouse & Warehouse

Day 3 builds a medallion (Bronze → Silver → Gold) on the chosen workload, runs
SQL over the lakehouse via a Databricks SQL Warehouse (Photon), and explores
real-time data with KQL over ADX.

!!! info "Azure-native by default"
    Transform = Databricks notebooks + dbt; warehouse = **Databricks SQL
    Warehouse (Photon)** on Commercial, or Synapse dedicated pool; real-time =
    Azure Data Explorer. **No Fabric Warehouse, no OneLake.**

## Learning objectives

1. Build a medallion pipeline on a real workload.
2. Use Databricks notebooks + dbt with Git source control.
3. Query Gold via Databricks SQL Warehouse (Photon).
4. Explore streaming data with KQL over ADX.
5. Schedule transforms as recurring jobs.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-2 recap + medallion architecture | Lecture |
| 09:30 | Bronze → Silver (notebook + dbt) | Lab |
| 10:45 | Break | — |
| 11:00 | Silver → Gold (dbt business aggregates) | Lab |
| 12:00 | Lunch | — |
| 13:00 | Databricks SQL Warehouse query over Gold (Photon) | Lab |
| 14:00 | KQL exploration over the IoT stream (ADX) | Lab |
| 15:00 | Break | — |
| 15:15 | Schedule the medallion as a recurring job | Lab |
| 16:15 | Commit to Git + wrap-up | Plenary |

### Talking points

- **Medallion on Azure-native:** same Bronze/Silver/Gold Delta pattern as the
  Federal track. On Commercial, Photon accelerates the SQL Warehouse reads over
  Gold.
- **dbt + Git:** transformations as code; identical to the Fabric forward-
  migration artifact (Day 5 — demonstrated live on Commercial).
- **Warehouse choice:** Databricks SQL Warehouse (Photon) is the commercial
  default; Synapse dedicated pool remains available. No Fabric Warehouse needed.

### Exercises

1. Pairs review each other's Silver layer for correct vertical data handling
   (PHI/PCI masking before Gold).
2. Group compares a Photon vs non-Photon query on the same Gold table.

### Common pitfalls

- SQL Warehouse stopped/auto-terminated → resume it (or rely on auto-start) and
  retry.
- Un-partitioned Gold → slow reads; partition by query dimension.

## Participant lab — build the medallion

1. **Bronze → Silver.** In **Notebook** (`/notebook`), read
   `bronze.sensor_readings`, cleanse, conform timestamps, write
   `silver.sensor_readings_clean`. Commit to Git.
2. **Silver → Gold (dbt).** Add a dbt model → `gold.device_hourly`; run
   `dbt run` + `dbt test`.
3. **Warehouse query.** In **Warehouse** (`/warehouse`), run a top-10 query over
   `gold.device_hourly` on the Databricks SQL Warehouse; confirm Photon plan.
4. **KQL over ADX.** In **Realtime hub** (`/realtime-hub`), run a KQL timechart
   over the ingested IoT events.
5. **Schedule.** Create a recurring nightly job for the medallion; confirm the
   schedule.

**Validation (Day-3 done):** Silver + Gold exist, dbt tests pass, a Photon
warehouse query returns Gold rows, a KQL chart renders, medallion scheduled.

## Datasets

- [Synthetic IoT](../datasets/synthetic-iot.md) — medallion source.
- [Synthetic financial transactions](../datasets/synthetic-financial-transactions.md)
  or [synthetic clinical encounters](../datasets/synthetic-clinical-encounters.md)
  — vertical-specific alternates.

## Homework

- Commit transform notebooks + dbt models to the customer Git repo.

## Commercial-specific emphasis

- **Databricks SQL Warehouse (Photon)** as the warehouse backend.
- **Vertical masking:** PHI (HIPAA), PCI, GDPR-controlled fields masked before
  Gold promotion.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-commercial-coe/day-3-transform.md`.

## Related

- [← Day 2](day-2-ingest.md) · [Day 4 — BI & AI →](day-4-bi-ai.md)
- [Federal CoE Day 3](../5-day-federal-coe/day-3-transform.md) — sibling variant
- [Lakehouse workload](../../workloads/lakehouse.md)
