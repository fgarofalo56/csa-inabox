---
name: W10-device-ingest
status: backlog
priority: P2
order: 11
depends_on: [W07-search-performance-at-scale]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W10 — Device ingest (MedTech model, later wave)

**Goal**: device telemetry from Event Hubs / IoT Hub to FHIR `Observation`
using the AHDS MedTech mapping grammar (device mapping + FHIR destination
mapping), re-implemented in the converter codebase (ADR-018), with Loom
editor tabs and fixtures. AHDS MedTech is deprecated (support ends
2028-05-03) and its OSS is archived; this wave reimplements the model, it
does not fork the archived service.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W10-1 | Mapper worker: normalize (device mapping: JSONPath/JMESPath expressions), group (period 0/60/1440), transform (FHIR destination mapping: SampledData/Quantity/CodeableConcept/String, components), persist with dedupe; IoT Hub routing where available per cloud | `apps/loom-health-converter/src/devices/**` | W5-2 | Sonnet | none | Fixture messages -> expected `Observation` JSON (hash-pinned); duplicate message -> no second Observation |
| W10-2 | Event Hubs / IoT Hub bindings in `tenant.bicep` (device hub, consumer group, identity) | `platform/fiab/bicep/modules/health/tenant.bicep` (device block) | W10-1 | Sonnet | none | What-If receipt; a message published to the hub appears as an Observation within 30 s |
| W10-3 | Editor tabs on `health-conversion-pipeline`: Device mappings, FHIR destination mappings, Monitor; parity doc rows | `apps/fiab-console/lib/editors/health/conversion-editor.tsx` (device tabs), `docs/fiab/parity/health-conversion-pipeline.md` | W10-1 | Sonnet | none (G1) | Playwright walk |

Lanes: L1 = W10-1 -> W10-3; L2 = W10-2 (bicep queued).

## Done receipt
Commercial + GCC-High: a simulated device stream yields Observations with lag
p95 <= 30 s; parity rows built.

## Rollback
Flag; consumer group deleted; no data loss.

## Cost / credit estimate
~5 Sonnet sessions.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W10-1 | todo | | sonnet | | 2026-10-22 |
| W10-2 | todo | | sonnet | | 2026-10-22 |
| W10-3 | todo | | sonnet | | 2026-10-22 |
