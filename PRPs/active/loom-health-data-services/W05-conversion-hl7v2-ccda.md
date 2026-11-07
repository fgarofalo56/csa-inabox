---
name: W05-conversion-hl7v2-ccda
status: backlog
priority: P1
order: 6
depends_on: [W02-fhir-core, W04-terminology]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W5 — Conversion: HL7 v2 and C-CDA to FHIR, `$convert-data`, VistA and RPMS adapter specs

**Goal**: FHIR-Converter (MIT) per stamp with versioned templates, an MLLP
(TLS) and REST ingest path through Service Bus, validation, enrichment,
`Provenance`, dead-letter + reprocess, the `health-conversion-pipeline` item
and monitor editor, and the VistA/RPMS adapter specifications (documents;
cannot be proven here, stated as such).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W5-1 | Converter Deployment + template OCI artifacts in ACR; `$convert-data` endpoint with the AHDS parameter shape | `apps/loom-health-converter/**`, `platform/fiab/bicep/modules/health/engines.bicep` (converter workload) | W2-2 | Sonnet | none | Sample messages (FHIR-Converter MIT fixtures) convert to validator-clean bundles; a known-bad message yields an OperationOutcome (positive control) |
| W5-2 | Ingest pipeline: MLLP/TLS listener (private), REST batch, Service Bus queue, raw-message store (PHI retention class), validate -> enrich (`$translate`, MPI) -> transaction bundle -> `Provenance`; dead-letter + reprocess API | `apps/loom-health-converter/src/pipeline/**`, `apps/loom-health-cp/src/jobs/convert-*.ts` | W5-1, W4-2 | Sonnet | **required** (PHI raw store + MLLP surface) | L2 flood test: sent = converted + dead-lettered; ingest lag p95 <= 5 s at the per-stamp rate |
| W5-3 | Loom item `health-conversion-pipeline` + editor (Templates versioned editor, Endpoints, Monitor, Fixtures tester), BFF routes, parity doc | `apps/fiab-console/lib/install/provisioners/health-conversion-pipeline.ts`, `lib/editors/health/conversion-editor.tsx`, `app/api/health/[tenant]/convert/**`, `docs/fiab/parity/health-conversion-pipeline.md` | W5-2 | Sonnet | none (G1) | Playwright walk; a template edit changes the fixture output in the tester |
| W5-4 | VistA adapter spec and RPMS adapter spec (documents): interfaces, message types, segment-to-template mappings, identifier systems, security, throughput assumptions, unverifiable items listed | `docs/fiab/health/adapters/vista.md`, `docs/fiab/health/adapters/rpms.md` | none | Sonnet | **required** (one reviewer: accuracy against the public VistA VDL / IHS docs) | Each spec cites its public source per section and carries an "Unverified without agency access" list |
| W5-5 | Template fixture suite with semantic assertions (ORU with 3 OBX -> 3 Observations with the right LOINC; ADT A01 -> Encounter + Patient; C-CDA CCD -> problems/meds/allergies counts) | `tests/health/conversion/**` | W5-1 | Sonnet | none | Every fixture hash-pinned; mutation receipt on one template |

Lanes: L1 = W5-1 -> W5-2; L2 = W5-5 then W5-3; L3 = W5-4.

## Done receipt
Commercial + GCC-High: L2 flood receipt, fixture suite green, editor walk;
adapter specs reviewed.

## Rollback
Flag `LOOM_HEALTH_CONVERT_ENABLED`; queues drained before disable (jobs guard).

## Cost / credit estimate
~9 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W5-1 | todo | | sonnet | | 2026-10-22 |
| W5-2 | todo | | sonnet | | 2026-10-22 |
| W5-3 | todo | | sonnet | | 2026-10-22 |
| W5-4 | todo | | sonnet | | 2026-10-22 |
| W5-5 | todo | | sonnet | | 2026-10-22 |
