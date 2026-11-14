---
name: W06b-deid
status: backlog
priority: P1
order: 21
depends_on: [W06a-bulk-export-import]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W6b — De-identification service, DICOM PS3.15 profile, `$export?_deid=`, `health-deid-job` item

Split from the old W06. Shared rules: `PRP.md` section 5. Design: `adr/ADR-015-deidentification.md`.

## Goal
Tools-for-Health-Data-Anonymization and Presidio images in the pool with models baked, a de-id job runner (Safe Harbor, Expert Determination hook, date shift with a per-tenant salt, DICOM PS3.15 profile, sync `tag`/`redact`/`surrogate` endpoint), `$export?_deid=`, and the `health-deid-job` Loom item and editor.

## Why
The 18 HIPAA identifiers must be removed from exports and DICOM without removing clinical content. That is PHI-removal correctness, so it is reviewed on its own. Operator decision 6 puts de-identification in v1.

## Scope / Non-goals
In: W6-3, W6-3b, W6-6a. Out: Expert Determination statistical certification (only the hook), k-anonymity beyond a report, free-text de-id beyond the baked Presidio models.

## Acceptance criteria
- [ ] W6-3: on the 18-identifier golden set none of the 18 survives AND clinical codes are unchanged. Fails if the date-shift salt is shared across tenants (two tenants must produce different shifts for one date).
- [ ] W6-3b: the DICOM tag golden file matches the expected tag set; a `PatientName` left in a private tag fails it. `$export?_deid=safe-harbor` output has zero golden identifiers.
- [ ] W6-6a: a Playwright walk creates a de-id job from the editor, sees it complete and the k-anonymity report; first open of a new item has no error banner.

## Read first
`adr/ADR-015-deidentification.md`, `SECURITY-AND-COMPLIANCE.md` (PHI-free logs), `apps/loom-health-cp/src/jobs/runner.ts`, the job API from W06a (`apps/loom-health-cp/src/jobs/export-*.ts`), `research/` de-id notes.

## Owns
`apps/loom-health-deid/**`, `apps/loom-health-cp/src/jobs/deid-*.ts`, `apps/fiab-console/lib/install/provisioners/health-deid-job.ts`, `apps/fiab-console/lib/editors/health/deid-editor.tsx`, `apps/fiab-console/app/api/health/[tenant]/deid/**`, `docs/fiab/parity/health-deid-job.md`, `tests/health/deid/**`, the de-id workload block in `platform/fiab/bicep/modules/health/engines.bicep` and the matrix row in `.github/workflows/build-fiab-images-acr-tasks.yml` (serialized bicep PR).

## Must NOT touch
`apps/loom-health-sink/**` (W06c), the `export-*.ts` job files beyond the `_deid` call-through (W06a is merged first), `apps/fiab-console/lib/copilot/health-tools.ts`.

## Consumes
W06a job API and export pipeline; W02b read path; `engines.bicep` and the image build matrix.

## Provides
`$export?_deid=` and the de-id job contract used by W09a (`health_start_deid_job`) and W09b (editor A-grade pass).

## Steps
1. W6-3 service, images, profiles, runner. 2. W6-3b DICOM profile, sync endpoint and `_deid=` hook (after the W6-3 interface freezes). 3. W6-6a item, editor, BFF, parity doc. 4. One small bicep PR for the workload, queued behind the bicep ledger.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W6-3 | De-id service images (models baked), runner, Safe Harbor, date shift salt, k-anonymity report | W6-1 | Sonnet | required (PHI removal correctness) | 18-identifier golden set absent, clinical content present |
| W6-3b | DICOM PS3.15 profile, `tag`/`redact`/`surrogate` sync endpoint, `$export?_deid=` | W6-3 | Sonnet | required | DICOM tag golden; export golden |
| W6-6a | `health-deid-job` item, editor, BFF routes, parity doc | W6-3, W6-3b | Sonnet | none (G1) | Playwright walk |

## Validation
```
cd apps/loom-health-cp && npx vitest run src/jobs/deid && npx tsc --noEmit -p tsconfig.test.json
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/install/provisioners
make lint-bicep
```
Plus the golden-set run on the Commercial dev stamp and a GCC-High Actions run id. Mutation receipt on a sandbox copy: set the salt to a constant and the cross-tenant shift test goes red. Per-cloud receipts named; "merged, not deployed" until a run id exists. IL5, DoD and GCC are supported-in-code only.

## Rollback
De-id jobs disabled by flag; workload scaled to 0; golden fixtures retained; no data mutation (outputs only).

## Docs to update
`docs/fiab/health/index.md` (de-id section), `docs/fiab/parity/health-deid-job.md`, the de-id row status in `SECURITY-AND-COMPLIANCE.md`.

## Wave / Blocked-by / Branch / Worktree
`Wave: 5 · Blocked-by: W06a-bulk-export-import · Branch: feat/lhds-w06b-deid · Worktree: E:/Repos/_lhds-w06b`

## Hot files
`platform/fiab/bicep/modules/health/engines.bicep` (shared with W06c: serialized), `.github/workflows/build-fiab-images-acr-tasks.yml` (matrix row). `touches_bicep: yes`.

## Kickoff prompt
```
Wave W06b (LHDS de-identification). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w06b, branch feat/lhds-w06b-deid.
Read first: PRPs/active/loom-health-data-services/PRP.md (section 5), this file, adr/ADR-015, SECURITY-AND-COMPLIANCE.md (PHI logging).
Synthetic data only. One bicep PR at a time: check PRPs/reference/INTERLOCK.md before opening the engines.bicep PR.
Do W6-3, W6-3b, W6-6a in that order.
Proof: cd apps/loom-health-cp && npx vitest run src/jobs/deid ; golden set shows 0 of 18 identifiers.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W6-3 | todo | | sonnet | | 2026-11-14 |
| W6-3b | todo | | sonnet | | 2026-11-14 |
| W6-6a | todo | | sonnet | | 2026-11-14 |
