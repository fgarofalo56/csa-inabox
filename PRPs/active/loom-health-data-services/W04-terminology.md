---
name: W04-terminology
status: backlog
priority: P1
order: 8
depends_on: [W02a-fhir-core-build, W02b-fhir-core-ops]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
branch: feat/lhds-w4-terminology
allow_parallel: true
---
# W4 — Terminology service and bundled vocabularies

## Goal
Per-stamp terminology service (HAPI terminology module, ADR-013) with the free vocabularies packaged, versioned and attributed; a customer loader for licensed content (SNOMED, full RxNorm, CPT) behind a genuine, disclosed
licence gate; `$lookup`, `$validate-code`, `$expand`, `$translate` within SLO; the `health-terminology` item and editor.

## Why
FHIR validation, search by code and the conversion pipeline's enrichment need terminology. Dependency note: W4 needs only the W02a engine and per-tenant config (W2-2); it does NOT need W02b (outbox, search set, editor) or W06. The earlier graph put W4 after all of W2; that serial edge was false.

## Scope / Non-goals
Items W4-1..W4-4. Non-goals: bundling any licensed content (nothing licensed ships; SNOMED/UMLS stay customer-licensed, operator Q4 no affiliate); conversion (W05). GCC never exercised; IL5/DoD params only. No Fabric dependency.

## Acceptance criteria
- [ ] W4-1: every package carries a notice file; the builder exits non-zero on a checksum mismatch (positive control: a tampered file fails, an untouched file passes); no runtime egress in the stamp (packages come from the per-cloud Blob feed).
- [ ] W4-2: 1 % sample parity per code system equals 100 % on the sample (fails on any mismatch); `$validate-code` p95 < 50 ms at the measured load; tenant version pinning: a tenant pinned to version A does not see version B codes.
- [ ] W4-3: loading SNOMED's public example RF2 files succeeds and `$lookup` returns a known code; the licence gate `health-terminology-licensed` shows the exact licence needed and its Fix-it launches the loader wizard; nothing licensed exists in the repo (a grep for RF2/CPT payloads in `tools/health-terminology` and `apps/` returns 0).
- [ ] W4-4: Playwright walk (Packages, Loader, tester, Notices) with a real `$expand` result in the tester; parity doc 0 MISSING; narrow-width 0 badge overlap; first-open 0 errors.
- [ ] Commercial and GCC-High receipts separate; GCC-High through Actions; unexercised clouds named.

## Read first
`adr/ADR-013-terminology-service.md`, `CONTRACT-FREEZE-W2.md` (sections 3-4), `W02a-fhir-core-build.md`, `apps/loom-health-fhir/config/**` (per-tenant config shape from W2-2), `TEST-STRATEGY.md` section 8, `research/` terminology facts file, `docs/fiab/health/`, the `health-tenant` item exemplar.

## Owns
`tools/health-terminology/**`; `apps/loom-health-terminology/**`; `platform/fiab/bicep/modules/health/engines-terminology.bicep` (NEW file; one `module` line in `health.bicep`); `apps/loom-health-cp/src/jobs/terminology-load-*.ts`; `lib/install/provisioners/health-terminology.ts`;
`lib/editors/health/terminology-editor.tsx`; `app/api/health/[tenant]/terminology/**`; `docs/fiab/parity/health-terminology.md`, `docs/fiab/health/terminology.md`.

> ASSUMPTION: a new `engines-terminology.bicep` rather than editing `engines.bicep` (listed in the old PRP), to avoid colliding with W2-2 and W5-1 on `engines.bicep`.

## Must NOT touch
`engines.bicep`; `apps/loom-health-fhir/**`; `apps/loom-health-converter/**`; `apps/loom-health-pdp/**`; relay and outbox files; `main.bicep`; the build matrix except the terminology row (last commit).

## Consumes
W2-2 engine config + tenant DB; PDP decision API; W01b stamp; W2-7's `health-tools.ts` and gates file existing (append order). If W2-7 has not merged, W4-4 creates nothing in those files: it lands after.

## Provides
`$lookup/$validate-code/$expand/$translate` per tenant, terminology item/editor, package feed. W05 consumes `$translate` through an interface only.

## Steps
1. W4-1 builder (no dependency; can start in W02a time).
2. W4-2 workload + loader job + version pinning (one bicep PR, queued).
3. W4-3 loader + licence gate.
4. W4-4 item/editor after the W4-2 contract.

### Integration step (serialized)
- `apps/fiab-console/lib/gates/registry/health.ts` (owner `W01b-close-deploy-receipts`), `apps/fiab-console/lib/copilot/health-tools.ts` and `apps/fiab-console/lib/catalog/item-types/health.ts` (owner `W02b-fhir-core-ops`, now in `depends_on`): append one block each, freeze order. Concurrent appenders in wave 4 (W03b, W05) rebase on whichever merged first.

## Validation
```bash
node --test tools/health-terminology/tests/                                # builder: checksum mismatch must exit non-zero
python tools/health-terminology/verify_notices.py                          # (or equivalent in W4-1) fails if any package lacks a notice file
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null && node scripts/ci/check-bicep-sync.mjs
cd apps/loom-health-cp && npm test -- terminology-load
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/install lib/gates lib/editors/health lib/copilot
cd apps/fiab-console && npx playwright test health-terminology            # G1 walk
curl -s -H "Authorization: Bearer <minted>" "<stamp>/fhir/CodeSystem/\$lookup?system=http://loinc.org&code=<known>"   # known code returns display; unknown returns an OperationOutcome
```
Mutation receipt on a sandbox copy: break one concept in a package (parity sample RED). Merged is "merged, not deployed".

## Rollback
Feature flag `LOOM_HEALTH_TERMINOLOGY_ENABLED=false`; packages are immutable artifacts; the workload scales to 0.

## Docs to update
`docs/fiab/health/terminology.md` (notices), `docs/fiab/parity/health-terminology.md`, `adr/ADR-013` status, `docs/fiab/health/index.md` per-cloud table.

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: W02a-fhir-core-build, W02b-fhir-core-ops · Branch: feat/lhds-w4-terminology · Worktree: E:/Repos/_lhds-w4

## Hot files
`health.bicep` (one module line), `lib/gates/registry/health.ts`, `lib/copilot/health-tools.ts`, `lib/catalog/item-types/health.ts`, build matrix row. `touches_bicep: yes` (W4-2 only).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W04-terminology.md`, `CONTRACT-FREEZE-W2.md`, `adr/ADR-013-terminology-service.md`, and `W02a-fhir-core-build.md`. Start with W4-1 (no dependency). Never bundle licensed content.
Append to `health-tools.ts` and the gates file only after W02b's versions are merged. Proof of done: the Validation block, the G1 walk, sample parity output. Report merged vs deployed separately.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W4-1 package builder + notices | todo | | sonnet | | 2026-11-14 |
| W4-2 terminology workload per stamp | todo | | sonnet | | 2026-11-14 |
| W4-3 licensed loader + licence gate | todo | | sonnet | | 2026-11-14 |
| W4-4 health-terminology item + editor | todo | | sonnet | | 2026-11-14 |
