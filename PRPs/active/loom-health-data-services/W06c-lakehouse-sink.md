---
name: W06c-lakehouse-sink
status: backlog
priority: P1
order: 22
depends_on: [W06a-bulk-export-import]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W6c — Lakehouse sink: outbox to Bronze/Silver Delta, Loom Unity registration, `health-lakehouse-sink` item

Split from the old W06. Shared rules: `PRP.md` section 5. Design: `adr/ADR-016-lakehouse-sink.md`.

## Goal
A continuous sink from the FHIR outbox and DICOM change feed into the tenant's Loom lakehouse (Bronze ndjson, Silver Delta via `delta-rs`, DICOM metadata tables), Part 2 redaction by default, Loom Unity registration, OpenLineage, backfill, and the `health-lakehouse-sink` item and editor with Copilot `health_lakehouse_query`.

## Why
Operator decision 6 puts analytics in v1. The sink crosses from health storage into Loom workspace storage, so a defect there leaks PHI across workspaces.

## Scope / Non-goals
In: W6-4, W6-4b, W6-6b. Out: OMOP (D25), full-scale sink throughput (W13).

## Acceptance criteria
- [ ] W6-4: row-count parity at the watermark; a Part 2-labelled resource is absent from Silver under the default policy. Fails if a resource labelled `SUD` appears in Silver with the default policy.
- [ ] W6-4: the `health-lakehouse-isolation` gate blocks enablement when the isolation fix is not deployed and passes when it is (positive control by flag). Fails if the gate reads "deployed" with the flag off.
- [ ] W6-4b: backfill resumes from its watermark after a kill with zero duplicate Silver rows (distinct key count equals row count).
- [ ] W6-6b: `health_lakehouse_query` returns policy-filtered rows only; Playwright walk of the editor with real Silver data.

## Read first
`adr/ADR-016-lakehouse-sink.md`, `RISKS-AND-OPEN-DECISIONS.md` Q7 and R7, `apps/loom-health-cp/src/jobs/runner.ts`, `apps/loom-health-pdp/policies/lhds/`, `apps/fiab-console/lib/gates/registry/` (category files, e.g. `azure-services.ts`, for the entry pattern). The lakehouse isolation advisory is private: do not quote it in this public repo.

## Owns
`apps/loom-health-sink/**`, `apps/loom-health-cp/src/jobs/sink-*.ts`, `apps/fiab-console/lib/install/provisioners/health-lakehouse-sink.ts`, `apps/fiab-console/lib/editors/health/sink-editor.tsx`, `apps/fiab-console/app/api/health/[tenant]/sink/**`, `apps/fiab-console/lib/copilot/health-tools.ts` (tool `health_lakehouse_query` only, after W06a merges), the `health-lakehouse-isolation` gate entry (ASSUMPTION: a new `lib/gates/registry/health.ts` plus one export line in the registry index, serialized), `docs/fiab/parity/health-lakehouse-sink.md`, the sink workload block in `engines.bicep`.

## Must NOT touch
`apps/loom-health-deid/**`, the export job files (W06a), other registry category files.

## Consumes
W02b outbox; W03b DICOM change feed; W06a job API; Loom Unity and lakehouse clients (`LOOM-INTEGRATION.md`); the PDP redaction policy (D21).

## Provides
Silver tables and the `health-lakehouse-sink` item for W09b; the isolation gate for W12 evidence.

## Steps
1. Resolve Q7 (owner and decide-by in `RISKS-AND-OPEN-DECISIONS.md` section 5). Code may land behind the gate; the sink stays disabled until confirmed. 2. W6-4. 3. W6-4b. 4. W6-6b. 5. One small bicep PR for the workload.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W6-4 | Outbox consumer, Bronze/Silver, PDP redaction (D21), isolation gate | W2-4, W3-4 | Sonnet | required (crosses workspace storage) | Parity at watermark; Part 2 absent; gate positive control |
| W6-4b | DICOM metadata tables, Loom Unity registration, OpenLineage, backfill job | W6-4 | Sonnet | none | Backfill resume without duplicates |
| W6-6b | Item, editor, BFF, Copilot `health_lakehouse_query`, parity doc | W6-4, W6-4b | Sonnet | none (G1) | Playwright walk; policy-filtered rows |

## Validation
```
cd apps/loom-health-cp && npx vitest run src/jobs/sink && npx tsc --noEmit -p tsconfig.test.json
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/copilot/__tests__/health-tools.test.ts
make lint-bicep
```
Receipts: a Commercial run id and a GCC-High Actions run id for sink parity; gate shown both ways. Mutation receipt on a sandbox copy: remove the redaction rule and the Part 2 absence assertion goes red. "Merged, not deployed" until then. IL5, DoD and GCC are supported-in-code only.

## Rollback
Sink disabled by flag; Silver tables retained; the watermark is resumable; no source mutation.

## Docs to update
`docs/fiab/health/index.md` (sink section), the parity doc, `ARCHITECTURE.md` section 6 status.

## Wave / Blocked-by / Branch / Worktree
`Wave: 5 · Blocked-by: W06a-bulk-export-import (health-tools.ts ordering) and open decision Q7 · Branch: feat/lhds-w06c-lakehouse-sink · Worktree: E:/Repos/_lhds-w06c`

## Hot files
`engines.bicep` (with W06b: serialized), `health-tools.ts` (one tool), the gate registry. `touches_bicep: yes`.

## Kickoff prompt
```
Wave W06c (LHDS lakehouse sink). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w06c, branch feat/lhds-w06c-lakehouse-sink.
Read first: PRP.md (section 5), this file, adr/ADR-016, RISKS-AND-OPEN-DECISIONS.md (Q7, section 5).
The isolation gate must block the sink until the fix is confirmed deployed. Never quote advisory details in public files.
Do W6-4, W6-4b, W6-6b; one bicep PR at a time (INTERLOCK.md).
Proof: cd apps/loom-health-cp && npx vitest run src/jobs/sink ; Part 2 resource absent from Silver.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-4 | todo | | sonnet | | 2026-11-14 |
| W6-4b | todo | | sonnet | | 2026-11-14 |
| W6-6b | todo | | sonnet | | 2026-11-14 |
