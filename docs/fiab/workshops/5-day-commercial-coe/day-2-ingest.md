# Day 2 — Ingest & Mirroring & Catalog (Commercial CoE)

**Track:** [5-Day Commercial CoE Workshop](index.md) · **Day 2 of 5** ·
Ingest & Mirroring & Catalog

Day 2 lands real data into the DLZ: ingest the synthetic IoT dataset, stand up a
mirrored operational source, and register everything in the Unity Catalog
managed catalog with a Purview overlay.

!!! info "Azure-native by default"
    Mirroring runs on the Loom Mirroring Engine (Debezium + Spark Structured
    Streaming + Delta MERGE) → ADLS Gen2 Bronze Delta. Catalog primary is **Unity
    Catalog managed** on Commercial. `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Learning objectives

1. Choose the right ingest pattern for a source.
2. Land the synthetic IoT dataset into Bronze Delta.
3. Configure a mirrored database to Bronze Delta.
4. Register tables in Unity Catalog managed + apply Purview-overlay tags.
5. Apply workspace identity + UC privilege patterns.

## Facilitator guide

### Timing (8-hour day)

| Time | Activity | Mode |
|---|---|---|
| 09:00 | Day-1 recap + ingest decision tree | Lecture |
| 09:30 | Ingest the synthetic IoT dataset (batch → Bronze) | Lab |
| 10:30 | Break | — |
| 10:45 | Mirroring Engine deep-dive (CDC, MERGE) | Lecture |
| 11:30 | Lunch | — |
| 12:30 | Configure a mirrored database → Bronze | Lab |
| 14:00 | UC managed catalog + Purview overlay tags | Lab |
| 15:00 | Break | — |
| 15:15 | Workspace identity + UC privileges | Lab |
| 16:15 | Wrap-up + homework | Plenary |

### Talking points

- **Ingest decision tree:** bulk → Copy Job / pipeline; continuous → Event Hubs
  + Stream Analytics; relational CDC → Mirroring Engine. All Azure-native.
- **UC managed catalog:** on Commercial, Unity Catalog managed is the primary
  governance plane (three-level namespace, fine-grained privileges, lineage),
  with Purview as the enterprise overlay for cross-estate discovery.
- **Mirroring honesty:** near-real-time CDC into Bronze; latency depends on
  source + checkpoint interval. It is the Azure-native 1:1 of Fabric Mirroring.

### Exercises

1. Group classifies sources into the ingest tree.
2. Each participant grants a UC privilege (SELECT on a schema) to a teammate and
   confirms enforcement.

### Common pitfalls

- Console UAMI missing Storage Blob Data Contributor → ingest 403; grant + retry.
- UC metastore admin not granted to the Loom UAMI → catalog writes fail; run the
  metastore-admin grant.

## Participant lab — ingest + mirror + catalog

1. **Land the IoT dataset.** From **Lakehouse → Get data** (`/lakehouse`), upload
   `sensor_readings.csv` from the
   [synthetic IoT dataset](../datasets/synthetic-iot.md) into
   `bronze.sensor_readings`.
2. **Verify.** In **Notebook** (`/notebook`), read the Bronze Delta table and
   confirm schema + row count.
3. **Mirror.** From **Items → New → Mirrored database** (`/items`), point at the
   pre-provisioned synthetic operational source and start the mirror to Bronze.
4. **Catalog.** In **Catalog** (`/catalog`), confirm tables in the UC managed
   namespace; apply a domain tag + a sensitivity label (Purview overlay).
5. **UC privileges.** In **Workspaces** (`/workspaces`), grant a teammate SELECT
   on the Bronze schema; confirm enforcement.

**Validation (Day-2 done):** IoT data in Bronze, a live mirror, tables in UC
managed catalog with tags, and a UC privilege granted + enforced.

## Datasets

- [Synthetic IoT](../datasets/synthetic-iot.md) — primary.
- [Synthetic financial transactions](../datasets/synthetic-financial-transactions.md)
  — for FSI customers.
- [Synthetic clinical encounters](../datasets/synthetic-clinical-encounters.md)
  — for healthcare (HIPAA) customers.

## Homework

- Identify a real customer workload as the week's case study (transformed Day 3).

## Commercial-specific emphasis

- **UC managed primary** with three-level namespace + fine-grained privileges.
- **Purview overlay** for enterprise-wide discovery across commercial estates.
- **Vertical data handling:** PHI (HIPAA), PCI, or GDPR tagging as applicable.

## Slide deck

`make loom-decks DECK=docs/fiab/workshops/5-day-commercial-coe/day-2-ingest.md`.

## Related

- [← Day 1](day-1-foundation.md) · [Day 3 — Transform →](day-3-transform.md)
- [Federal CoE Day 2](../5-day-federal-coe/day-2-ingest.md) — sibling variant
- [Mirroring parity workload](../../workloads/mirroring-parity.md)
