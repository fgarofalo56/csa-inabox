---
name: W06a-bulk-export-import
status: backlog
priority: P1
order: 20
depends_on: [W02b-fhir-core-ops, W03b-dicom-core-b]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W6a — Bulk Data `$export` / `$import`, DICOM export, `ImagingStudy`, job operations surface

Split from the old W06 (14 sessions, 6 items): W06a is export/import; W06b is de-identification; W06c is the lakehouse sink. Shared rules: `PRP.md` section 5.

## Goal
`$export` (system, group, patient; Bulk Data IG) with parallel replica-backed workers, `$import`, DICOM export in the AHDS output layout, one `ImagingStudy` per stored study, and the Operations/Export tabs and Copilot status tools that expose them.

## Why
Analytics, de-identification (W06b) and the sink (W06c) all consume bulk reads; the PHI egress path is the highest-risk read path, so it is reviewed on its own. Operator decision 6 puts Bulk Data in v1.

## Scope / Non-goals
In: items W6-1, W6-2, W6-5, W6-7. Out: de-id (W06b), sink (W06c), full-scale export throughput characterisation (W13; small-scale parity only here).

## Acceptance criteria
- [ ] W6-1: Inferno Bulk Data kit reports 0 failures; export `count` equals `Bundle.total` for a 1,000-patient cohort. Fails if any resource type is dropped (e.g. delete `Observation` from the `_type` default and the parity count differs).
- [ ] W6-2: export, `$import`, re-export gives equal per-resource SHA-256. Fails on one flipped byte in the staged ndjson.
- [ ] W6-5: exported DICOM file hash equals the stored instance hash; `ImagingStudy` series/instance counts equal the QIDO counts. Fails if the consumer counts one series short.
- [ ] W6-7: a non-admin gets 403 on `/api/health/[tenant]/jobs/**`; Playwright walk of the Operations tab shows a running job and its final status.

## Read first
`adr/ADR-007-async-write-path-outbox.md`, `adr/ADR-003-fhir-persistence-sharding.md`, `CAPACITY-MODEL.md` section 7, `apps/loom-health-cp/src/jobs/runner.ts` (`runner`, job registration in `builtin.ts`), `apps/loom-health-fhir/plugin/src/` (outbox, from W2-4), `W0-RECEIPT.md` (DEV `$export` 2,629.76 res/s, orientation only).

## Owns
`apps/loom-health-cp/src/jobs/export-*.ts`, `apps/loom-health-cp/src/jobs/import-*.ts`, `apps/loom-health-cp/src/jobs/dicom-export.ts`, `apps/loom-health-cp/src/consumers/imagingstudy.ts`, `apps/loom-health-fhir/plugin/src/export/**`, `apps/fiab-console/app/api/health/[tenant]/jobs/**`, `tests/health/bulk/**`.

## Must NOT touch
`apps/loom-health-deid/**` (W06b), `apps/loom-health-sink/**` (W06c), `platform/fiab/bicep/**` (no bicep in this wave), other editors.

## Consumes
W02b: outbox, `Bundle.total`, replica routing. W03b: QIDO, change feed. W01: job runner, `apps/loom-health-cp/src/auth/**` roles.

## Provides
Job API `_operations` shape consumed by W06b (`$export?_deid=`), W06c (backfill) and W09a (`health_start_export`); `health_job_status` tool contract.

## Steps
1. W6-1 (Opus parallel-range design pass, then Sonnet implement). 2. W6-2 in parallel after W6-1 interface freezes. 3. W6-5 in parallel. 4. W6-7 last (editor tabs, BFF routes, Copilot tools, parity doc rows).

Work items:

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W6-1 | `$export` via HAPI Bulk Data + parallel workers (partition-range reads from replicas), `_since _till _type _typeFilter`, managed-identity destination, `_operations` shape | W2-4 | Opus design, Sonnet implement | required (PHI egress) | Inferno Bulk Data 0 failures; `_total` parity |
| W6-2 | `$import` InitialLoad/IncrementalLoad, soft-delete extension, post-import RI report | W2-2 | Sonnet | none | Round trip hash parity |
| W6-5 | DICOM export (AHDS layout) + `ImagingStudy` consumer | W3-4 | Sonnet | none | Hash and count parity |
| W6-7 | Operations/Export tabs, jobs BFF routes, Copilot `health_export_status`, `health_job_status`, parity rows | W6-1..W6-5 | Sonnet | none (G1) | Playwright walk |

### Integration step (serialized)
- `apps/fiab-console/lib/editors/health/fhir-service-editor.tsx` (Operations/Export tab sections; owner `W02b-fhir-core-ops`) and `dicom-service-editor.tsx` (owner `W03b-dicom-core-b`); both in `depends_on`.
- `apps/fiab-console/lib/copilot/health-tools.ts`: tools `health_export_status`, `health_job_status` only. Owner: `W02b-fhir-core-ops` (in `depends_on`).

## Validation
```
cd apps/loom-health-cp && npx vitest run src/jobs && npx tsc --noEmit -p tsconfig.test.json
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/copilot/__tests__/health-tools.test.ts
```
Plus the Inferno Bulk Data kit run against the Commercial dev stamp and, via a GitHub Actions run, GCC-High. Per-cloud receipts: Commercial and GCC-High run ids; IL5/DoD/GCC supported-in-code. Merged but not rolled is "merged, not deployed". Mutation receipt (sandbox copy): drop one `_type` from the export worker and the parity test goes red.

## Rollback
Jobs disabled by flag `LOOM_HEALTH_JOBS_ENABLED` (ASSUMPTION: name to be fixed at W6-1); staged export blobs expire by lifecycle; no schema change.

## Docs to update
`docs/fiab/health/index.md` (export section), `docs/fiab/parity/health-fhir-service.md` and `health-dicom-service.md` Operations rows, `TEST-STRATEGY.md` section 9 receipt list.

## Wave / Blocked-by / Branch / Worktree
`Wave: 5 · Blocked-by: W02b-fhir-core-ops, W03b-dicom-core-b · Branch: feat/lhds-w06a-bulk-export-import · Worktree: E:/Repos/_lhds-w06a`

## Hot files
`apps/fiab-console/lib/copilot/health-tools.ts` (two tools; W06c adds one after this merges), `fhir-service-editor.tsx`, `dicom-service-editor.tsx`. `touches_bicep: no`.

## Kickoff prompt
```
Wave W06a (LHDS bulk export/import). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w06a, branch feat/lhds-w06a-bulk-export-import.
Read first: PRPs/active/loom-health-data-services/PRP.md (section 5), this file, adr/ADR-007, adr/ADR-003, apps/loom-health-cp/src/jobs/runner.ts.
Own only the paths in Owns. No bicep. Use Opus only for the W6-1 parallel-range design pass.
Do W6-1, then W6-2/W6-5, then W6-7. Update Execution state after each PR.
Proof: cd apps/loom-health-cp && npx vitest run src/jobs ; Inferno Bulk Data kit 0 failures on the dev stamp.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-1 | todo | | opus | | 2026-11-14 |
| W6-2 | todo | | sonnet | | 2026-11-14 |
| W6-5 | todo | | sonnet | | 2026-11-14 |
| W6-7 | todo | | sonnet | | 2026-11-14 |
