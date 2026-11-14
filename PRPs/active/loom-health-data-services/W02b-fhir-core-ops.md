---
name: W02b-fhir-core-ops
status: backlog
priority: P1
order: 5
depends_on: [W02a-fhir-core-build]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/lhds-w2b-fhir-ops
allow_parallel: true
---
# W2b — FHIR core, operations half: outbox + change feed, curated search, `health-fhir-service` item/editor, conformance

## Goal
The running FHIR engine (W02a) emits a gap-free change stream, advertises only search parameters that work, has a Loom item + editor at baseline grade, and passes Inferno US Core + SMART and the HL7 validator
in Commercial and (through Actions) GCC-High. This closes the FHIR first-to-ship capability.

## Why
Downstream waves (W6 sink/export, W7 search, W8 audit) consume the outbox and the curated search set; the item/editor is the first user-visible FHIR surface; conformance is the only proof the engine is a FHIR server.

## Scope / Non-goals
Items W2-4, W2-6, W2-7, W2-8. Non-goals: terminology ops (W04), bulk export (W06), index v2 (W07), consent (W08), the DICOM change feed (W03b adds `dicom-*.ts` onto this relay). GCC never exercised; IL5/DoD params only.

## Acceptance criteria
- [ ] W2-4: N writes produce N events in `seq` order on the tenant hub; deleting one outbox row raises the gap alert within 60 s (fails if no alert); relay lag p95 <= 5 s measured; event body has no payload fields (a test asserts a patient surname never appears in a message).
- [ ] W2-6: every parameter in the CapabilityStatement changes a result set on the 100 k cohort (a parameter that advertises and changes nothing fails the test); reindex duration measured and recorded; the Fix-it reindex gate runs the job.
- [ ] W2-7: Playwright walk: create `health-fhir-service` -> editor opens on Overview (progress state while provisioning, no bind form), all tabs render real data, narrow-width pass has 0 badge overlap, first-open has 0 error banners; minted-session probe returns `{ok:true,...}` with a real search count (fails on `[]` mock); parity doc has zero MISSING rows.
- [ ] W2-8: Inferno US Core and SMART reports with 0 failures attached; the validator run counts 0 errors over the Synthea cohort; Gov run id recorded, or "not exercised" stated.
- [ ] Verified with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (`no-fabric-dependency.md`).

## Read first
`W02a-fhir-core-build.md`, `CONTRACT-FREEZE-W2.md` (sections 2-5), `adr/ADR-007`, `adr/ADR-008`, `apps/fiab-console/lib/install/provisioners/health-tenant.ts` and `lib/editors/health/health-tenant.ts` (exemplar),
`lib/azure/auto-bind.ts` (`healthTenantAutoBindOnCreate`), `docs/fiab/ux-standards.md` section 7, `apps/loom-health-cp/src/jobs/{builtin,tenant-jobs}.ts`, `.github/workflows/deploy-health.yml` (Gov job pattern), `TEST-STRATEGY.md` sections 3 and 9.

## Owns
`apps/loom-health-fhir/plugin/src/**/outbox/**`; `apps/loom-health-cp/src/relay/**` (new; fhir half) and `src/jobs/reindex-*.ts`; `apps/loom-health-fhir/config/search-params.json`; `lib/gates/registry/health.ts` (one entry);
`lib/catalog/item-types/health.ts` (one entry); `lib/install/provisioners/health-fhir-service.ts`; `lib/editors/health/fhir-service-editor.tsx`; `app/api/health/[tenant]/fhir/**`; `lib/copilot/health-tools.ts` (created here; read tools `health_fhir_search_count`, `health_patient_summary_codes`);
`docs/fiab/parity/health-fhir-service.md`; `.github/workflows/health-conformance.yml`; `tests/health/conformance/**`. Registration order per the freeze.

## Must NOT touch
W02a files (image, interceptors, scrubber); `apps/loom-health-pdp/**`; `apps/loom-health-cp/src/auth/**`; `tenant.bicep`; `apps/loom-health-cp/src/relay/dicom-*.ts` (W03b); `main.bicep`; `.github/workflows/build-fiab-images-acr-tasks.yml`.

## Consumes
W02a engine + interceptors; ADR-007 outbox row shape (frozen); PDP decision API; W01b deployed stamp and control plane; Synthea cohort (`scripts/measure/health/synthea-*.sh`).

## Provides
Outbox table + relay + change-feed endpoint (W3-4, W6, W7 consume), the curated search set, `health-tools.ts` aggregator file (W3-6, W4-4, W6 append), the item/editor, the conformance workflow.

## Steps
1. W2-4 first (it releases W03b): outbox DDL + HAPI interceptor writing in-transaction, relay worker, change feed.
2. W2-6 curated parameters + reindex job + gate.
3. W2-7 provisioner/editor/BFF/tools/parity doc (after W2-2 contract is stable; G1 walk is its gate).
4. W2-8 conformance workflow and reports (needs all of the above deployed).

## Validation
```bash
cd apps/loom-health-cp && npm test -- relay reindex                        # fails if event count != write count or gap goes undetected
mvn -f apps/loom-health-fhir/plugin/pom.xml -q test                        # outbox writes in the same transaction (rollback test: no row on a failed write)
cd apps/fiab-console && npx tsc --noEmit && npx vitest run lib/install lib/gates lib/editors/health lib/copilot   # item, gate, tool registration
cd apps/fiab-console && npx playwright test health-fhir-service            # the walk; screenshots dark + light + narrow
node scripts/ci/check-env-sync.mjs
gh workflow run health-conformance.yml -f boundary=Commercial              # then GCC-High via the Actions job; reports attached
```
Mutation receipts on a sandbox copy: drop the outbox insert (N-events test RED); remove a parameter from `search-params.json` while leaving it advertised (advertised-vs-working RED). Commercial and GCC-High are separate receipts; merged is "merged, not deployed".

## Rollback
Outbox is additive; stop the relay. `LOOM_HEALTH_FHIR_ENABLED=false` hides the item type. Disable `health-conformance.yml`.

## Docs to update
`docs/fiab/parity/health-fhir-service.md`, `docs/fiab/health/index.md` per-cloud table, `ARCHITECTURE.md` section 6, `adr/ADR-007` and `ADR-008` status lines.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: W02a-fhir-core-build · Branch: feat/lhds-w2b-fhir-ops · Worktree: E:/Repos/_lhds-w2b

## Hot files
`lib/gates/registry/health.ts`, `lib/catalog/item-types/health.ts`, `lib/copilot/health-tools.ts`, `apps/loom-health-cp/src/{jobs,relay}`, new workflow `health-conformance.yml`. `touches_bicep: no` (the relay runs in the control plane image; env rows, if any, go through the freeze's bicep rule).

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W02b-fhir-core-ops.md`, `CONTRACT-FREEZE-W2.md`, `adr/ADR-007-async-write-path-outbox.md`, and the `health-tenant` provisioner/editor as the exemplar.
Do W2-4 first so W03b can start. Confirm W02a is merged and the stamp is live (W01b receipt) before any on-stamp claim. Proof of done: the Validation block plus the Playwright walk and Inferno reports. Never mark an item done on tsc + vitest alone (ux-baseline G1).

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-4 outbox + relay + change feed | todo | | sonnet | | 2026-11-14 |
| W2-6 curated search + reindex gate | todo | | sonnet | | 2026-11-14 |
| W2-7 health-fhir-service item + editor | todo | | sonnet | | 2026-11-14 |
| W2-8 conformance (Inferno, validator) | todo | | sonnet | | 2026-11-14 |
