---
name: W09a-viewer-copilot
status: backlog
priority: P1
order: 26
depends_on: [W02b-fhir-core-ops, W03b-dicom-core-b, W06a-bulk-export-import, W06b-deid]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W9a — Imaging viewer item and Copilot write tools

Split from the old W09. W09b holds the editor A-grade pass, admin page and general docs. Shared rules: `PRP.md` section 5. Design: `adr/ADR-017-viewer-ohif.md`.

## Goal
The OHIF-based `health-imaging-viewer` item and editor (study list via QIDO, OHIF pane, series browser, patient banner from FHIR, archive-rehydration state, token via the BFF) and the Copilot write tools `health_create_tenant`, `health_start_export`, `health_start_deid_job` with confirm, capability checks, rate limit and audit.

## Why
Imaging is half of the first-class surface set; write tools let Copilot act safely on PHI-adjacent jobs only with explicit confirmation.

## Scope / Non-goals
In: W9-1, W9-4, W9-5a. Out: other editors and the admin page (W09b). Dependency repair: the viewer needs W2/W3 only, not W5 or W8.

## Acceptance criteria
- [ ] W9-1: Playwright loads a CT, scrolls, windows/levels, measures and switches series; the canvas checksum differs between two scroll positions (a frozen canvas fails); dark, light and narrow-width passes.
- [ ] W9-4: a non-admin is denied; a first call without `confirm:true` returns the confirm prompt and starts nothing; the 11th call in the window is rate-limited; every call emits an audit event (count equals calls). Fails if a write starts without the confirm.
- [ ] W9-5a: every file and command named in the viewer, export and de-id docs exists (hygiene rule); the walkthrough was executed.

## Read first
`adr/ADR-017-viewer-ohif.md`, `docs/fiab/ux-standards.md` section 7, `apps/fiab-console/lib/copilot/health-tools.ts` and its test `apps/fiab-console/lib/copilot/__tests__/health-tools.test.ts`, `apps/fiab-console/lib/gates/registry/` (the Fix-it pattern), W03 DICOM gateway token flow.

## Owns
`apps/fiab-console/lib/install/provisioners/health-imaging-viewer.ts`, `apps/fiab-console/lib/editors/health/viewer-editor.tsx`, `apps/fiab-console/app/api/health/[tenant]/viewer/**`, `apps/loom-health-viewer/**`, `apps/fiab-console/lib/copilot/__tests__/health-tools.test.ts`, `docs/fiab/parity/health-imaging-viewer.md`, `docs/fiab/health/viewer.md`, `docs/fiab/health/export-deid.md`.

## Must NOT touch
Other health editors, the admin page (W09b), bicep, the DICOM gateway.

## Consumes
W03b viewer smoke and QIDO/WADO; W02b `Patient` banner; W06a job API; W06b de-id contract; `SplitPane` primitive.

## Provides
Viewer item for the catalog; write-tool contract used by W12 evidence (audit events) and W09b parity doc.

## Steps
1. W9-1 viewer. 2. W9-4 write tools in parallel (different files). 3. W9-5a docs after both.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W9-1 | Viewer item + editor + parity doc | W3-7 | Sonnet | none (G1) | Playwright CT walk |
| W9-4 | Copilot write tools with confirm, rate limit, audit | W6-7, W6-6a | Sonnet | required (write tools + authorization) | Deny / confirm / rate-limit / audit tests |
| W9-5a | Docs: viewer, export, de-id pages with per-cloud status | W9-1, W9-4 | Sonnet | none | Named files and commands exist |

### Integration step (serialized)
- `apps/fiab-console/lib/copilot/health-tools.ts`: the write tools. Owner: `W02b-fhir-core-ops` (in `depends_on`). W06a, W06c and W08b also append; rebase on whichever merged first.

## Validation
```
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/copilot/__tests__/health-tools.test.ts lib/install/provisioners
cd apps/fiab-console && pnpm uat   # viewer spec once added
```
Receipts: Commercial live walk with screenshots (dark and light) and a GCC-High Actions Playwright run id (G1). Mutation receipt on a sandbox copy: remove the confirm check and the confirm test goes red. "Merged, not deployed" until then. IL5, DoD, GCC supported-in-code only.

## Rollback
Item type behind a feature flag; write tools disabled by removing them from the registered tool list; no data changes.

## Docs to update
`docs/fiab/health/viewer.md`, `docs/fiab/health/export-deid.md`, `docs/fiab/parity/health-imaging-viewer.md`, per-cloud table in `ARCHITECTURE.md` section 6.

## Wave / Blocked-by / Branch / Worktree
`Wave: 7 · Blocked-by: W02b-fhir-core-ops, W03b-dicom-core-b, W06a-bulk-export-import, W06b-deid · Branch: feat/lhds-w09a-viewer-copilot · Worktree: E:/Repos/_lhds-w09a`

## Hot files
`apps/fiab-console/lib/copilot/health-tools.ts` (sole owner this tier). `touches_bicep: no`.

## Kickoff prompt
```
Wave W09a (LHDS imaging viewer + Copilot write tools). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w09a, branch feat/lhds-w09a-viewer-copilot.
Read first: PRP.md (section 5), this file, adr/ADR-017, docs/fiab/ux-standards.md section 7, health-tools.ts and its test.
Do W9-1 and W9-4 (different files, may run in parallel), then W9-5a.
G1 needs a real browser walk with a synthetic CT, dark and light.
Proof: cd apps/fiab-console && npx vitest run lib/copilot/__tests__/health-tools.test.ts ; Playwright CT walk.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W9-1 | todo | | sonnet | | 2026-11-14 |
| W9-4 | todo | | sonnet | | 2026-11-14 |
| W9-5a | todo | | sonnet | | 2026-11-14 |
