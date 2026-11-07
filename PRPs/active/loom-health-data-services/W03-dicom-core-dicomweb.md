---
name: W03-dicom-core-dicomweb
status: backlog
priority: P1
order: 4
depends_on: [W01-control-plane-identity-stamp]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W3 — DICOM core and DICOMweb (parallel track from wave 1)

**Goal**: dcm4chee-arc-light per tenant on the stamp with Azure Blob pixel
storage (flat namespace, per-tenant container, CMK, tiering), PostgreSQL
metadata, LHDS gateway exposing the AHDS-shaped DICOMweb surface (v1 paths,
change feed, extended query tags, partitions), PDP + audit in the path,
Valkey cache, the `health-dicom-service` item and editor, viewer smoke, per-
cloud receipts. Runs in parallel with W2 from the moment W1 lands; the
operator's sequencing decision (imaging is the biggest volume) is honoured by
starting W3 design in W1 time.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W3-1 | dcm4chee image build (pinned >= 5.35.2, hardened defaults per the 2026-10 CISA advisory: AE registration enforced, HL7 auth on, DIMSE listener off), LDAP StatefulSet with backup, Helm chart Loom-owned, SBOM + cosign | `apps/loom-health-dicom/**`, `.github/workflows/build-fiab-images-acr-tasks.yml` (matrix rows) | W0-7 | Sonnet | **required** (security defaults) | Trivy 0 CRITICAL; a STOW from an unregistered AE is rejected (positive control) |
| W3-2 | Storage: per-tenant Blob container + storage descriptor per tenant-year, CMK, versioning, soft delete, lifecycle policy (bicep), content-hash table at STOW | `platform/fiab/bicep/modules/health/tenant.bicep` (DICOM storage block), `apps/loom-health-dicom/config/**`, `apps/loom-health-cp/src/jobs/dicom-tenant-*.ts` | W3-1, W1-2 | Sonnet | **required** (bicep + irreversible layout) | STOW then WADO byte-equal; listing shows the expected path layout; CMK on; Gov endpoint suffix test |
| W3-3 | LHDS DICOMweb gateway: AHDS-shaped `/v1` paths, 4 GB STOW cap with streaming (memory assertion), QIDO caps, PDP filter (QIDO/WADO/STOW), audit, per-tenant routing, Valkey metadata cache | `apps/loom-health-dicom-gateway/**` | W3-1, W1-5 | Sonnet | **required** (authorization) | DICOMweb suite (`TEST-STRATEGY.md` section 3); cross-tenant QIDO probe 0 rows; RSS < 2x request size on a 2 GB STOW |
| W3-4 | Change feed + extended query tags + partitions: outbox for DICOM events, `/changefeed` with AHDS parameters, tag registration API with lifecycle statuses, partition = facility mapping | `apps/loom-health-dicom-gateway/src/{changefeed,tags,partitions}/**`, `apps/loom-health-cp/src/relay/dicom-*.ts` | W3-3, W2-4 (relay) | Sonnet | none | N STOWs -> N feed events in sequence; unregistered tag rejected; registered tag queryable after reindex |
| W3-5 | Soft delete + 30-day retention + purge job; archive rehydration flow (202 + ETA) | `apps/loom-health-dicom-gateway/src/lifecycle/**`, `apps/loom-health-cp/src/jobs/dicom-purge.ts` | W3-2, W3-3 | Sonnet | none | Delete -> 404 -> blob present (versioned) -> purge after retention -> blob absent |
| W3-6 | Loom item `health-dicom-service` + provisioner + editor (Overview, Partitions, Extended query tags, Change feed, Export jobs placeholder honest-gated until W6, Storage tiers, Audit, Metrics), BFF proxy, Copilot `health_imaging_study_search` | `apps/fiab-console/lib/install/provisioners/health-dicom-service.ts`, `lib/editors/health/dicom-service-editor.tsx`, `app/api/health/[tenant]/dicomweb/**`, `lib/copilot/health-tools.ts` (one tool), `docs/fiab/parity/health-dicom-service.md` | W3-3 | Sonnet | none (G1) | Playwright walk, screenshots, parity doc |
| W3-7 | OHIF smoke: viewer bundle built in the pool, viewer BFF proxy, synthetic study set (CT/MR/US/DX/MG), canvas checksum test (full viewer editor is W9) | `apps/loom-health-viewer/**` (build only), `tests/health/viewer-smoke.spec.ts` | W3-3 | Sonnet | none | Rendered-canvas checksum within tolerance; a blank canvas fails |
| W3-8 | Load L3/L4 on class S with synthetic DICOM; Blob 503 onset; per-cloud receipts via `health-load.yml` (Commercial) and the Gov Actions job | `.github/workflows/health-load.yml`, `tests/health/load/dicom-*.js` | W3-2..W3-5 | Sonnet | **required** (new Gov job) | Receipt tables with request counts and windows; Gov run id |

Lanes: L1 = W3-1 -> W3-2 (bicep lane, queued) -> W3-5; L2 = W3-3 -> W3-4;
L3 = W3-6; L4 = W3-7 -> W3-8. Shared: `tenant.bicep` is edited by W3-2 only
after W1-2 is merged; `health-tools.ts` rows are additive and sequenced after
W2-7.

## Done receipt (per cloud)
Commercial and GCC-High: DICOMweb suite 0 failures; pixel hash parity 100 %;
L3/L4 within targets on class S; probe 0; editor G1 walk; viewer smoke green.

## Rollback
Gateway + engine scaled to 0; Blob containers retained (data never deleted on
rollback); feature flag `LOOM_HEALTH_DICOM_ENABLED`.

## Cost / credit estimate
~14 Sonnet sessions; Azure: R1 stamps + ~2 TB synthetic pixel data (~$60/mo).

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-1 | todo | | sonnet | | 2026-10-22 |
| W3-2 | todo | | sonnet | | 2026-10-22 |
| W3-3 | todo | | sonnet | | 2026-10-22 |
| W3-4 | todo | | sonnet | | 2026-10-22 |
| W3-5 | todo | | sonnet | | 2026-10-22 |
| W3-6 | todo | | sonnet | | 2026-10-22 |
| W3-7 | todo | | sonnet | | 2026-10-22 |
| W3-8 | todo | | sonnet | | 2026-10-22 |
