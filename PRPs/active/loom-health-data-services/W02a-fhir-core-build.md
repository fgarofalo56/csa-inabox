---
name: W02a-fhir-core-build
status: active
priority: P1
order: 4
depends_on: [W01b-close-deploy-receipts]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
started: 2026-11-14
issues: [5233, 5241]
pr: 5290
branch: feat/lhds-w2a-fhir-build
allow_parallel: true
---
# W2a — FHIR core, build half: engine image, per-tenant config, PDP + audit interceptors, log scrubber

## Goal
HAPI FHIR JPA runs per tenant on a stamp with partition mode, the PDP interceptor (calls the W1-5 decision API) and the audit interceptor in the request path, and a
log scrubber proving no PHI reaches any sink. Operations half (outbox, curated search, item/editor, conformance) is `W02b-fhir-core-ops.md`. FHIR is first-to-ship (operator decision 3).

## Why
Everything FHIR-shaped (W4 terminology, W5 conversion, W6 export, W7 search) needs a running, authorized, audited engine. Authorization and PHI-free logs are the two
parts that cannot be retrofitted. Split from the old W02 because 8 items exceeded one session.

## Scope / Non-goals
Items W2-1 (image; merged, follow-ups only), W2-2, W2-3, W2-5. Non-goals: outbox/relay, search parameter set, item/editor, Inferno (all W02b); terminology (W04); DICOM.
GCC: supported-in-code, never exercised. IL5/DoD: params only. FHIR stays Azure-native, no Fabric/Power BI dependency (`no-fabric-dependency.md`).

## Acceptance criteria
- [ ] W2-1: image `loom-health-fhir` in the Commercial ACR with a cosign signature verifiable by digest, Trivy CRITICAL = 0; fails if `cosign verify` returns non-zero or Trivy reports one CRITICAL.
- [ ] W2-1 SBOM: either an SBOM artifact exists for the image digest, or `apps/loom-health-fhir/README.md` no longer claims one. Measured 2026-11-14: `build-fiab-images-acr-tasks.yml` has 0 SBOM steps while the README says "SBOM" (README line ~27), so today the claim fails.
- [ ] W2-2: 50 parallel conditional creates produce exactly 1 resource (fails at 2); RI fixtures reject a dangling reference both on create and on delete of a referenced target; a history read of N versions issues a bounded number of SQL statements (the N+1 test fails if statements scale with N).
- [ ] W2-3: scope-matrix test generated from `apps/loom-health-cp/src/auth/role-scope-map.v1.json`; N requests produce exactly N `AuditEvent`s; with the interceptor removed the cross-tenant probe returns 200 (the red arm) and with it present 403; a PDP timeout returns 503, never 200.
- [ ] W2-5: sentinel surname `ZZ-SENTINEL-LHDS` appears in no log line, trace attribute or metric label after create/read/search/delete/`$everything`; a positive control proves the sentinel IS visible when the scrubber is bypassed.
- [ ] On-stamp rows are claimed only with W01b's receipt; otherwise "merged, not deployed".

## Read first
`apps/loom-health-fhir/{Dockerfile,README.md,scripts/verify-image.sh,check/check-validator.sh,tests/image-contract.test.mjs,plugin/pom.xml,plugin/src/main/java/ai/loom/health/fhir/LoomPlugin.java}`;
`apps/loom-health-pdp/README.md` + `input-contract.json`; `CONTRACT-FREEZE-W2.md` (sections 1, 3); `adr/ADR-001`, `ADR-003`; `W0-RECEIPT.md` (HAPI pins); `scripts/measure/health/fhir-engine-*.sh` (W0 harness to reuse); `TEST-STRATEGY.md` section 3.

## Owns
`apps/loom-health-fhir/**`; `apps/loom-health-cp/src/jobs/fhir-tenant-*.ts` (new); `platform/fiab/bicep/modules/health/engines.bicep` (HAPI workload only); `apps/loom-health-scrubber/**`; `tests/health/log-scrub.test.ts`;
`apps/loom-health-pdp/input-contract.json` + Rego (W2-3 only, to confirm the PROVISIONAL fields; same PR as the interceptor).

## Must NOT touch
`apps/loom-health-cp/src/auth/**`, `src/routing/**`; `lib/copilot/health-tools.ts`, `lib/gates/registry/health.ts`, `lib/catalog/item-types/health.ts` (W02b); `apps/loom-health-dicom*`; `tenant.bicep` (W03a); `main.bicep`; other `.github/workflows` matrix rows.

## Consumes
PDP decision API (frozen, `CONTRACT-FREEZE-W2.md` section 1); `tenant.create` job + tenant Postgres DB from W1-2; deployed stamp from W01b (for on-stamp acceptance only); W0 pins for HAPI and `org.hl7.fhir.core`.

## Provides
A signed engine image, per-tenant engine config + `fhir-tenant.*` jobs, the interceptor pair, the scrubber, and the confirmed PDP input fields that W03a/W3-3 consume.

## Steps
1. W2-1 follow-ups (merged as #5290): add or remove the SBOM claim; confirm the image has been built and signed by a real workflow run (the matrix row exists, no run is recorded here); add a scrubber-free baseline.
2. W2-2 engine config + `engines.bicep` HAPI workload (one bicep PR, queued per INTERLOCK): partition mode, datasource/pool per tenant, versioning, validation-on-write, RI, caps.
3. W2-3 interceptors (Java plugin): PDP call, response filtering from the decision + scopes, `AuditEvent` per interaction to audit store and `LhdsAudit_CL`. Fail closed.
4. W2-5 scrubber sidecar + sentinel test; OTel without bodies; matrix row last.
Order: W2-1 follow-ups -> W2-2 and W2-5 in parallel (W2-5 only needs the image) -> W2-3 (needs the W2-2 config shape).

### Integration step (serialized)
- `.github/workflows/build-fiab-images-acr-tasks.yml`: add the `loom-health-scrubber` matrix row only, as the last commit of W2-5 (freeze order). Owner: `W01b-close-deploy-receipts` (in the `depends_on` chain).

## Validation
```bash
node --test apps/loom-health-fhir/tests/                                   # W2-1 static contract; fails if base digest and fhir-engine-deploy.sh disagree
sh apps/loom-health-fhir/scripts/verify-image.sh <acr>/loom-health-fhir:<sha>   # plugin load probe + validator with --network none
cosign verify --certificate-identity-regexp 'https://github.com/fgarofalo56/csa-inabox/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com <acr>/loom-health-fhir@<digest>
mvn -f apps/loom-health-fhir/plugin/pom.xml -q test                         # interceptor unit tests (scope matrix, audit count)
cd apps/loom-health-cp && npm test -- fhir-tenant                            # W2-2 job tests
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null
node --test tests/health/log-scrub.test.ts   # or the vitest equivalent once the runner is chosen in W2-5; the choice is recorded in the PR
```
Mutation receipts on a sandbox copy (not the tracked tree): delete the PDP interceptor registration (probe must go red), delete the scrubber filter (sentinel test must go red); show both RED, then clean. Per-cloud: Commercial on-stamp receipt after W01b; GCC-High via Actions only, listed "not exercised" until a run exists. A merge is "merged, not deployed".

## Rollback
Scale the engine Deployment to 0; tenant databases retained; `LOOM_HEALTH_FHIR_ENABLED=false`. Scrubber and interceptors are image-level: revert the image tag.

## Docs to update
`apps/loom-health-fhir/README.md`, `docs/fiab/health/index.md` (per-cloud table), `ARCHITECTURE.md` section 6 run ids, `adr/ADR-001`, `ADR-003` status lines on measured values.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: W01b-close-deploy-receipts (live verification; code work may start earlier) · Branch: feat/lhds-w2a-fhir-build · Worktree: E:/Repos/_lhds-w2a

## Hot files
`engines.bicep`, `health.bicep` (module wiring), `build-fiab-images-acr-tasks.yml` matrix (`DEFAULT_APPS` is one long line; row added last and rebased), `apps/loom-health-pdp/input-contract.json`. `touches_bicep: yes` (W2-2 only).
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
Fresh session, Sonnet. Read `PRPs/active/loom-health-data-services/W02a-fhir-core-build.md`, `CONTRACT-FREEZE-W2.md`, `apps/loom-health-fhir/README.md` and `apps/loom-health-pdp/README.md`. W2-1 is merged (#5290; docs PR #5292).
Start with the SBOM claim vs `build-fiab-images-acr-tasks.yml`, then W2-2 and W2-5 in parallel worktrees (max 4 lanes). Review required on W2-2 and W2-3. Every test names the value that breaks it
(assertion-design). Proof of done: the Validation block, mutation receipts RED then green, and the W01b stamp receipt for on-stamp rows. Report merged vs deployed separately.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W2-1 HAPI image + plugin skeleton + baked US Core | merged | feat/lhds-w2-1-hapi-image | sonnet | #5290 = ea1a38d72, merged, not deployed; docs #5292 open; SBOM + cosign UNVERIFIED | 2026-11-14 |
| W2-2 engine config per tenant | todo | | sonnet | | 2026-11-14 |
| W2-3 PDP + audit interceptors | merged | feat/lhds-w2-3-interceptors | sonnet | #5310 = `da67b2691`, merged, not deployed (wired into an engine only by W2-2). Two review rounds: an update-over-existing bypass was found and fixed, and the plugin CI lane `health-fhir-plugin-test.yml` was added (125 mvn tests). Built against the frozen contract ahead of W2-2; the assumptions are in the PR body. Follow-ups #5316, including the real-JPA hook receipt. | 2026-11-15 |
| W2-5 log scrubber + sentinel | merged | feat/lhds-w2-5-scrubber | sonnet | #5312 = `ea0098278`, merged, not deployed. Real-HAPI capture fixture; the sentinel is visible unscrubbed in 4 channels and absent after scrubbing (22 tests). Image producer row added. The sidecar wiring beside the engine is NOT built (README). | 2026-11-15 |
