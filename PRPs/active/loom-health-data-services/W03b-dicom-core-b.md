---
name: W03b-dicom-core-b
status: backlog
priority: P1
order: 7
depends_on: [W03a-dicom-core-a, W02b-fhir-core-ops]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/lhds-w3b-dicom-ops
allow_parallel: true
---
# W3b — DICOM core, part B: change feed, query tags, partitions, lifecycle, item/editor, viewer smoke, load

## Goal
The DICOMweb service gains the AHDS change feed, extended query tags and partitions, soft-delete/retention/rehydration, the `health-dicom-service` item and editor, an OHIF smoke test and measured load receipts on a class-S stamp in both clouds.

## Why
Completes the DICOM track started in W03a; the editor and load receipts are what make it a Loom product surface and a sized one.

## Scope / Non-goals
Items W3-4..W3-8. Non-goals: the full viewer item (W09), DICOM export (W06), the DICOMcast `ImagingStudy` (W06). GCC never exercised; IL5/DoD params only.
Edge: only W3-4 has a real code dependency on W02b (the W2-4 outbox relay). W3-5..W3-8 do not; they sit behind W02b because they share this PRP. Run W2-4 first inside W02b so this wave is released early.
> ASSUMPTION: if the operator wants W3-5..W3-8 to start before W2-4 lands, W3-4 can be split into its own PRP; not done here to keep one PRP per session.

## Acceptance criteria
- [ ] W3-4: N STOWs produce N change-feed events in sequence (fails on a missing or reordered seq); an unregistered extended tag is rejected (4xx), a registered tag becomes queryable only after reindex; partition = facility mapping returns only that facility's studies.
- [ ] W3-5: delete -> 404 -> blob still present (versioned) -> after the retention window purge -> blob absent; archive rehydration returns 202 with an ETA header (fails on 200).
- [ ] W3-6: Playwright walk of `health-dicom-service` (all tabs real data, narrow-width 0 badge overlap, first-open 0 errors, Export tab honest-gated with Fix-it until W06); minted-session probe returns real `{ok:true}`; parity doc 0 MISSING; Copilot `health_imaging_study_search` returns a real count.
- [ ] W3-7: rendered-canvas checksum of the synthetic CT/MR/US/DX/MG set within tolerance; a blank canvas FAILS the test (positive control: assert the checksum of an all-black canvas is outside tolerance).
- [ ] W3-8: L3/L4 load receipt tables on class S with request counts and windows, Blob 503 onset recorded; Gov run id or "not exercised". Cost stays within the existing cap; no class-M run.

## Read first
`W03a-dicom-core-a.md`, `CONTRACT-FREEZE-W2.md` (sections 2, 3, 4), `adr/ADR-004`, `adr/ADR-007`, `adr/ADR-017-viewer-ohif.md`, `AHDS-MODEL-MAP.md`, `TEST-STRATEGY.md` sections 3, 5, `CAPACITY-MODEL.md` (L3/L4 targets), `apps/loom-health-dicom-gateway/` (from W03a), the `health-tenant` provisioner/editor exemplar.

## Owns
`apps/loom-health-dicom-gateway/src/{changefeed,tags,partitions,lifecycle}/**`; `apps/loom-health-cp/src/relay/dicom-*.ts`, `src/jobs/dicom-purge.ts`; `lib/install/provisioners/health-dicom-service.ts`; `lib/editors/health/dicom-service-editor.tsx`; `app/api/health/[tenant]/dicomweb/**`;
`lib/catalog/item-types/health.ts` and `lib/copilot/health-tools.ts` (append one block each, freeze order after W02b); `docs/fiab/parity/health-dicom-service.md`; `apps/loom-health-viewer/**` (build only); `tests/health/viewer-smoke.spec.ts`; `.github/workflows/health-load.yml`; `tests/health/load/dicom-*.js`.

## Must NOT touch
`apps/loom-health-dicom/**` (image, W03a); gateway root `src/` files and `tenant.bicep` (W03a); the relay worker core and `src/relay/` non-`dicom-` files (W02b); `lib/gates/registry/health.ts` (not needed; an export-gate entry belongs to W06); `main.bicep`; any matrix row except the viewer build row (last commit).

## Consumes
W03a gateway + storage; W2-4 relay and ADR-007 row shape (`kind=dicom`, freeze section 2); PDP decision API; W01b stamp; synthetic DICOM generator `scripts/measure/health/dicom-engine-gen.py`.

## Provides
DICOM change feed/tags/partitions API (W06 export, W09 viewer consume), `health-dicom-service` item, load receipts feeding W07/W11.

## Steps
1. W3-4 change feed/tags/partitions (needs the W2-4 relay merged).
2. W3-5 lifecycle and purge (parallel with W3-4; no relay dependency).
3. W3-6 item/editor (needs the W3-3 gateway contract only); G1 walk is its gate.
4. W3-7 viewer smoke (parallel).
5. W3-8 load + Gov job last, after W3-2..W3-5.

## Validation
```bash
cd apps/loom-health-dicom-gateway && npm test                               # changefeed ordering, tag lifecycle, purge timing
cd apps/loom-health-cp && npm test -- relay/dicom dicom-purge
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/install lib/editors/health lib/copilot
cd apps/fiab-console && npx playwright test health-dicom-service            # G1 walk, dark + light + narrow
npx playwright test tests/health/viewer-smoke.spec.ts                       # canvas checksum; blank canvas must fail
gh workflow run health-load.yml -f boundary=Commercial                      # Gov through the Actions job; receipts attached
node scripts/ci/check-env-sync.mjs
```
Mutation receipts on a sandbox copy: skip an outbox event on STOW (N-events test RED); make purge ignore retention (purge test RED). Commercial and GCC-High receipts are separate; merged is "merged, not deployed".

## Rollback
Gateway scaled to 0; blobs retained; `LOOM_HEALTH_DICOM_ENABLED=false`; relay `dicom-*.ts` handlers unregistered by flag.

## Docs to update
`docs/fiab/parity/health-dicom-service.md`, `docs/fiab/health/index.md` per-cloud table, `ARCHITECTURE.md` section 6, `adr/ADR-017` status line.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: W03a-dicom-core-a, W02b-fhir-core-ops (W2-4 only) · Branch: feat/lhds-w3b-dicom-ops · Worktree: E:/Repos/_lhds-w3b

## Hot files
`lib/catalog/item-types/health.ts`, `lib/copilot/health-tools.ts`, `apps/loom-health-cp/src/relay/`, new workflow `health-load.yml`, build matrix (viewer row). `touches_bicep: no`.

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W03b-dicom-core-b.md`, `CONTRACT-FREEZE-W2.md`, `W03a-dicom-core-a.md`, and `adr/ADR-007-async-write-path-outbox.md`. Confirm W03a is merged and W2-4 (relay) is merged before W3-4; W3-5..W3-8 may start now.
Append your `health-tools.ts` and item-type blocks after W02b's. Proof of done: the Validation block, the G1 walk screenshots, and load receipt tables. Never claim Gov without an Actions run id.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W3-4 change feed + tags + partitions | todo | | sonnet | | 2026-11-14 |
| W3-5 soft delete, retention, rehydration | todo | | sonnet | | 2026-11-14 |
| W3-6 health-dicom-service item + editor | todo | | sonnet | | 2026-11-14 |
| W3-7 OHIF viewer smoke | todo | | sonnet | | 2026-11-14 |
| W3-8 load L3/L4 + per-cloud receipts | todo | | sonnet | | 2026-11-14 |
