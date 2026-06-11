# Day 2 — Ingest & Mirroring & Catalog (Federal CoE)

**Track:** [5-Day Federal CoE Workshop](index.md) · **Day 2 of 5** ·
Ingest & Mirroring & Catalog

Day 2 lands real data into the DLZ deployed on Day 1. Participants ingest the
synthetic IoT dataset, stand up a mirrored operational source, and register
everything in the catalog overlay.

!!! info "Azure-native by default"
    Mirroring runs on the Loom Mirroring Engine (Debezium + Spark Structured
    Streaming + Delta MERGE) writing ADLS Gen2 Bronze Delta — **no Fabric
    Mirroring required.** Catalog is Purview-primary in Gov (UC tags where
    available). `LOOM_DEFAULT_FABRIC_WORKSPACE` stays unset.

## Learning objectives

1. Choose the right ingest pattern (batch copy, streaming, CDC mirroring) for a
   given source.
2. Land the synthetic IoT dataset into Bronze Delta in the DLZ.
3. Configure a mirrored database from an operational source to Bronze Delta.
4. Register tables in the catalog overlay and apply domain tags.
5. Apply workspace identity + RBAC patterns for a domain team.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-1 recap + ingest-pattern decision tree | Lecture |
| 09:30 | Ingest the synthetic IoT dataset (batch → Bronze) | Lab |
| 10:30 | Break | — |
| 10:45 | Mirroring Engine deep-dive (CDC, MERGE semantics) | Lecture |
| 11:30 | Lunch | — |
| 12:30 | Configure a mirrored database → Bronze Delta | Lab |
| 14:00 | Catalog overlay — register tables + domain tags | Lab |
| 15:00 | Break | — |
| 15:15 | Workspace identity + RBAC patterns | Lab |
| 16:15 | Wrap-up + homework | Plenary |

### Talking points

- **Ingest decision tree:** one-time/scheduled bulk → Copy Job / data pipeline;
  continuous append → Event Hubs + Stream Analytics; relational source kept in
  sync → Mirroring Engine (CDC). Map each to its Azure-native backend per the
  [no-Fabric-dependency rule](../../../index.md).
- **Mirroring honesty:** the Mirroring Engine gives near-real-time CDC into
  Bronze Delta. It is *not* Fabric Mirroring's managed control plane — it is the
  Azure-native 1:1 (ADF CDC / Synapse Link copy patterns). Latency depends on
  the source and the streaming checkpoint interval.
- **Catalog in Gov:** Purview is the primary catalog in Gov boundaries. Unity
  Catalog managed tags are used where Databricks UC is present; otherwise the
  Purview Data Map carries domain/classification tags.

### Exercises

1. Group classifies three sample sources into the ingest decision tree.
2. Each participant tags their ingested tables with a domain + a CUI-handling
   classification and confirms the tag appears in the catalog pane.

### Common pitfalls

- Forgetting to grant the Console UAMI **Storage Blob Data Contributor** on the
  DLZ storage → ingest writes fail with 403. The Console surfaces the exact RBAC
  gate; grant it and retry.
- Mirroring against a source without CDC enabled — enable CDC on the source
  first (the lab uses a pre-CDC-enabled synthetic source).

## Participant lab — ingest + mirror + catalog

1. **Land the IoT dataset.** From **Lakehouse → Get data** (`/lakehouse`),
   upload `sensor_readings.csv` from the
   [synthetic IoT dataset](../datasets/synthetic-iot.md) into a new Bronze Delta
   table `bronze.sensor_readings`.
2. **Verify the Delta write.** Open **Notebook** (`/notebook`), attach to the
   DLZ Spark/Synapse compute, and run:
   ```python
   df = spark.read.format("delta").load("abfss://bronze@<dlz_account>.dfs.core.windows.net/sensor_readings")
   df.printSchema(); df.count()
   ```
3. **Configure a mirrored database.** From **Items → New → Mirrored database**
   (`/items`), point at the workshop's pre-provisioned synthetic operational
   source (connection string provided by the facilitator). Map source tables to
   Bronze targets and start the mirror. Confirm rows land in Bronze Delta.
4. **Register in the catalog.** In **Catalog** (`/catalog`), confirm the new
   Bronze tables are discoverable; apply a domain tag and a CUI classification.
5. **Apply RBAC.** In **Workspaces** (`/workspaces`), grant a teammate the
   domain steward role on your workspace and confirm they can read but not
   administer.

**Validation (Day-2 done):** IoT data in Bronze Delta, a live mirror writing
Bronze, tables registered + tagged in the catalog, and RBAC applied to a
teammate.

## Datasets

- [Synthetic IoT](../datasets/synthetic-iot.md) — primary for Day 2.
- Operational mirror source: pre-provisioned synthetic table (facilitator
  supplies the connection).

## Homework

- Identify a **real** customer workload to use as the week's case study (you
  will transform it on Day 3). Document its source system and rough volume.

## Federal-specific emphasis

- **Purview-primary catalog:** in GCC/GCC-High, Unity Catalog managed catalog
  may be unavailable — Purview Data Map is authoritative. Confirm classification
  tags map to your agency's CUI marking scheme.
- **Identity passthrough:** workspace identities are Entra Gov managed
  identities; no cross-cloud B2B for ITAR workloads.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-federal-coe/day-2-ingest.md`.

## Related

- [← Day 1](day-1-foundation.md) · [Day 3 — Transform →](day-3-transform.md)
- [Mirroring parity workload](../../workloads/mirroring-parity.md)
- [Tutorial 06 — Mirroring Cosmos DB](../../tutorials/06-mirroring-cosmos.md)
