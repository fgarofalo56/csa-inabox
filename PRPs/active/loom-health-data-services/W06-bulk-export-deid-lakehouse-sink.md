---
name: W06-bulk-export-deid-lakehouse-sink
status: backlog
priority: P1
order: 7
depends_on: [W02-fhir-core, W03-dicom-core-dicomweb]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W6 — Bulk Data export/import, de-identification, lakehouse sink, DICOM export and DICOM-to-FHIR

**Goal**: `$export` (system/group/patient, Bulk Data IG) with parallel
replica-backed workers, `$import`, de-identification jobs (FHIR, DICOM, text),
the continuous Delta sink into the tenant's Loom lakehouse with Loom Unity
registration and Copilot, DICOM export and `ImagingStudy` generation.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W6-1 | `$export` via HAPI Bulk Data + LHDS parallel export workers (partition-range reads from replicas), AHDS parameters (`_since _till _type _typeFilter`), managed-identity destination, job API `_operations` shape | `apps/loom-health-cp/src/jobs/export-*.ts`, `apps/loom-health-fhir/plugin/src/export/**` | W2-4 | **Opus** for the parallel-range design pass; Sonnet implement | **required** (PHI egress path) | Inferno Bulk Data kit 0 failures; count parity with `_total`; throughput receipt vs `CAPACITY-MODEL.md` section 7 |
| W6-2 | `$import` (InitialLoad / IncrementalLoad semantics, soft-delete extension, post-import RI report) | `apps/loom-health-cp/src/jobs/import-*.ts` | W2-2 | Sonnet | none | Round trip export -> import -> hash parity |
| W6-3 | De-id service: Tools-for-Health-Data-Anonymization + Presidio images in the pool (models baked), job runner, profiles (Safe Harbor, Expert Determination hook), date shift with per-tenant salt, DICOM PS3.15 profile, `tag`/`redact`/`surrogate` sync endpoint, `$export?_deid=` | `apps/loom-health-deid/**`, `apps/loom-health-cp/src/jobs/deid-*.ts` | W6-1 | Sonnet | **required** (correctness of PHI removal) | 18-identifier golden set absent + clinical content present; DICOM tag golden; k-anonymity report produced |
| W6-4 | Lakehouse sink: outbox consumer -> Bronze ndjson + Silver Delta via `delta-rs`, DICOM metadata tables, PDP redaction policy (D21), Loom Unity registration, OpenLineage, backfill job; the `health-lakehouse-isolation` gate enforced | `apps/loom-health-sink/**`, `apps/loom-health-cp/src/jobs/sink-*.ts` | W2-4, W3-4 | Sonnet | **required** (crosses into Loom workspace storage) | Row-count parity at the watermark; a Part 2-labelled resource absent from Silver under the default policy; gate blocks enablement when the isolation fix is not deployed (positive control by flag) |
| W6-5 | DICOM export job (AHDS output layout) and DICOM-to-FHIR `ImagingStudy` consumer | `apps/loom-health-cp/src/jobs/dicom-export.ts`, `apps/loom-health-cp/src/consumers/imagingstudy.ts` | W3-4 | Sonnet | none | Exported file hashes equal stored; one `ImagingStudy` per study with series/instance counts equal to QIDO |
| W6-6 | Loom items `health-deid-job`, `health-lakehouse-sink` + editors + BFF routes + Copilot `health_export_status`, `health_job_status`, `health_lakehouse_query` + parity docs; Operations/Export tabs on the FHIR and DICOM editors un-gated | `apps/fiab-console/lib/install/provisioners/health-{deid-job,lakehouse-sink}.ts`, `lib/editors/health/{deid,sink}-editor.tsx`, `lib/editors/health/{fhir,dicom}-service-editor.tsx` (Operations tab only), `app/api/health/[tenant]/jobs/**`, `lib/copilot/health-tools.ts` (three tools), `docs/fiab/parity/health-{deid-job,lakehouse-sink}.md` | W6-1..W6-5 | Sonnet | none (G1) | Playwright walks; Copilot query returns policy-filtered rows |

Lanes: L1 = W6-1 -> W6-2; L2 = W6-3; L3 = W6-4; L4 = W6-5 -> W6-6. Bicep:
none beyond `engines.bicep` workloads (one PR).

## Done receipt
Commercial + GCC-High: Bulk Data kit, Safe Harbor golden, sink parity, DICOM
export hash parity; Copilot walk; gate behaviour shown both ways.

## Rollback
Jobs disabled by flag; Silver tables retained; sink watermark resumable.

## Cost / credit estimate
~14 Sonnet sessions, 1 Opus pass; Azure: export staging + Silver storage for
the 100 k cohort (negligible).

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-1 | todo | | opus | | 2026-10-22 |
| W6-2 | todo | | sonnet | | 2026-10-22 |
| W6-3 | todo | | sonnet | | 2026-10-22 |
| W6-4 | todo | | sonnet | | 2026-10-22 |
| W6-5 | todo | | sonnet | | 2026-10-22 |
| W6-6 | todo | | sonnet | | 2026-10-22 |
