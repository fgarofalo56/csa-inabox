---
name: W10-device-ingest
status: backlog
priority: P2
order: 14
depends_on: [W01b-close-deploy-receipts]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W10 — Device ingest (MedTech model)

Shared rules: `PRP.md` section 5. Design: `adr/ADR-018-device-ingest-and-engine-upgrades.md`. The old edge W7 to W10 was false and is removed (`PRP.md` section 2): W10 needs the FHIR write path (W2) and the Event Hubs eventing already in `platform/fiab/bicep/modules/health/eventing.bicep`.

## Goal
Device telemetry from Event Hubs / IoT Hub to FHIR `Observation` using the AHDS MedTech mapping grammar (device mapping plus FHIR destination mapping), re-implemented rather than forked (AHDS MedTech is deprecated, support ends 2028-05-03, its OSS is archived), with Loom editor tabs and fixtures.

## Why
IoMT feeds are a v1 later-wave capability and have no data dependency on search scale or export.

## Scope / Non-goals
In: W10-1, W10-2, W10-3, W10-4. Out: AI on telemetry, device registry UI beyond mapping tabs.
> ASSUMPTION: the mapper lives in its own package `apps/loom-health-device-mapper/**`, not inside `apps/loom-health-converter/**`, so W10 does not share files with W05 (which creates the converter app). ADR-018 says "in the converter codebase": if the operator prefers that, W10-1 moves after W05-1 and gains a depends_on edge.
> ASSUMPTION: W10's live Observation receipt (W10-4) needs a deployed W02a FHIR image; W10-1..W10-3 do not, so W10 may run beside W02a and W10-4 waits for it.

## Acceptance criteria
- [ ] W10-1: fixture messages produce the expected `Observation` JSON (hash-pinned); a duplicate message produces no second Observation. Fails if dedupe keys on message id instead of (device, timestamp, code).
- [ ] W10-2: What-If receipt for the device block; the device hub, consumer group and identity exist after apply.
- [ ] W10-3: Playwright walk of the Device mappings, FHIR destination mappings and Monitor tabs; first open has no error banner.
- [ ] W10-4: a simulated device stream yields Observations in the stamp FHIR store with lag p95 <= 30 s at the fixture rate. Fails if the p95 is computed from enqueue time instead of device timestamp.

## Read first
`adr/ADR-018-device-ingest-and-engine-upgrades.md`, `research/ahds-feature-inventory.md` section 3, `platform/fiab/bicep/modules/health/eventing.bicep` and `tenant.bicep`, `CONTRACT-FREEZE-W2.md` (FHIR write contract), `AHDS-MODEL-MAP.md` (MedTech row).

## Owns
`apps/loom-health-device-mapper/**`, the device block in `platform/fiab/bicep/modules/health/tenant.bicep` (one bicep PR), `apps/fiab-console/lib/editors/health/conversion-device-tabs.tsx` (new file), a one-line tab registration in `apps/fiab-console/lib/editors/health/conversion-editor.tsx` (serialized: only after W05-3 merges), `docs/fiab/parity/health-conversion-pipeline.md` (device rows), `tests/health/device/**`.

## Must NOT touch
`apps/loom-health-converter/**` (W05), `engines.bicep`, FHIR plugin code (W02a/W02b).

## Consumes
FHIR write endpoint (W02a), `eventing.bicep` hub, MPI/Patient resolution (stub: lookup by identifier until W11b MPI), `CONTRACT-FREEZE-W2.md`.

## Provides
Device-to-Observation mapper and the device tabs for the conversion item.

## Steps
1. W10-1 mapper with fixtures. 2. W10-2 bicep (queued on the ledger). 3. W10-3 tabs. 4. W10-4 live receipt once W02a is deployed.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W10-1 | Mapper worker: normalize, group, transform, persist with dedupe | none (fixtures) | Sonnet | none | Hash-pinned Observations; dedupe |
| W10-2 | Event Hubs / IoT Hub bindings in `tenant.bicep` | W10-1 | Sonnet | none | What-If receipt |
| W10-3 | Device tabs on the conversion item (after W05-3) | W10-1, W5-3 | Sonnet | none (G1) | Playwright walk |
| W10-4 | Live stream receipt against a deployed FHIR service | W10-1, W10-2, W02a deployed | Sonnet | none | Lag p95 <= 30 s |

## Validation
```
cd apps/loom-health-device-mapper && npx vitest run
make lint-bicep
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/editors/health
```
Receipts: Commercial run id (stream receipt); GCC-High Actions run id; IoT Hub routing noted per cloud where unavailable. Mutation receipt on a sandbox copy: change the dedupe key and the duplicate test goes red. "Merged, not deployed" until a run id exists. IL5, DoD, GCC supported-in-code only.

## Rollback
Feature flag; consumer group deleted; no data loss (Observations stay).

## Docs to update
`docs/fiab/health/index.md` (device feeds), `docs/fiab/parity/health-conversion-pipeline.md`, `adr/ADR-018` status.

## Wave / Blocked-by / Branch / Worktree
`Wave: 2 · Blocked-by: W01b-close-deploy-receipts (W10-4 also needs a deployed W02a) · Branch: feat/lhds-w10-device-ingest · Worktree: E:/Repos/_lhds-w10`

## Hot files
`platform/fiab/bicep/modules/health/tenant.bicep` (ledger), `conversion-editor.tsx` (W05). `touches_bicep: yes`.

## Kickoff prompt
```
Wave W10 (LHDS device ingest). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w10, branch feat/lhds-w10-device-ingest.
Read first: PRP.md (sections 2 and 5), this file, adr/ADR-018, platform/fiab/bicep/modules/health/eventing.bicep, CONTRACT-FREEZE-W2.md.
Own only apps/loom-health-device-mapper and the listed files. One bicep PR at a time (INTERLOCK.md). Synthetic devices only.
Do W10-1 first, then W10-2/W10-3, then W10-4 when W02a is deployed.
Proof: cd apps/loom-health-device-mapper && npx vitest run ; duplicate message yields no second Observation.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W10-1 | todo | | sonnet | | 2026-11-14 |
| W10-2 | todo | | sonnet | | 2026-11-14 |
| W10-3 | todo | | sonnet | | 2026-11-14 |
| W10-4 | todo | | sonnet | | 2026-11-14 |
