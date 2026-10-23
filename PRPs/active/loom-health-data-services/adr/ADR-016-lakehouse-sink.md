# ADR-016 — Continuous sink of FHIR and DICOM metadata into the Loom Delta lakehouse

Status: Proposed. Date: 2026-10-22. Evidence: `../research/ahds-feature-inventory.md` section 5 (FHIR-Analytics-Pipelines archived; FHIR-to-Parquet model).

## Decision
- Target: the tenant's Loom **lakehouse** item (ADLS Gen2, Delta) in the Loom
  workspace that owns the `health-tenant` — Bronze: raw ndjson per resource
  type (append-only, partitioned by date); Silver: flattened Delta tables per
  resource type using the FHIR-to-Parquet schema conventions of the archived
  Microsoft pipeline (as the model) with US Core-oriented column promotion;
  DICOM: `dicom_study`, `dicom_series`, `dicom_instance` metadata tables (no
  pixel data) plus extended query tags.
- Source: the outbox stream (ADR-007); the sink worker fetches the resource
  version from a read replica, applies PDP redaction for labeled data (tenant
  policy: exclude Part 2 rows entirely, or include with labels — D21), writes
  micro-batches every N minutes with the `delta-rs` writer (Apache-2.0) from
  the sink worker (no Spark cluster on the stamp); backfill is a CDC/outbox
  replay job.
- Consumers: Loom semantic models, Trino/Iceberg federation (via the existing
  Loom Unity catalog registration — the sink registers tables there), Copilot
  (read-only tools over the Silver tables, governance-aware), Fabric parity
  (the Fabric "Healthcare data solutions" lakehouse shape is the UX reference
  only; no Fabric dependency).
- Lineage: each row carries `_tenant, _stamp, _resource_id, _version_id,
  _last_updated, _sink_ts`; OpenLineage events to Loom's lineage ingest.
- Parity assertion: `../TEST-STRATEGY.md` section 8 (row counts equal FHIR
  totals at the watermark).

## Prerequisite
Loom lakehouse workspace isolation (GHSA-g7m7) must be fixed and deployed
before any health tenant's sink is enabled (`../RISKS-AND-OPEN-DECISIONS.md` Q7).

## Reversal cost
Low (rebuildable from the FHIR store).
