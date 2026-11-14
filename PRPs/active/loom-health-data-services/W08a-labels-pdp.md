---
name: W08a-labels-pdp
status: backlog
priority: P1
order: 24
depends_on: [W02b-fhir-core-ops, W03b-dicom-core-b, W04-terminology]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W8a — Security labelling and the consent PDP bundle v2

Split from the old W08. W08b holds break-glass, audit chain and SIEM. Shared rules: `PRP.md` section 5. Design: `adr/ADR-011-consent-pdp.md`.

## Goal
Security labels applied at write (ValueSet-membership and source-tag rules to `meta.security`, DICOM extended label tags, relabel job) and a PDP policy bundle v2 that evaluates `Consent` (purpose, recipient, period, revocation), redacts by label, emits the redisclosure obligation, carries the break-glass rules, and caches decisions with outbox invalidation.

## Why
42 CFR Part 2 segmentation and consent-driven access are v1 requirements (operator decision 8). Labels from here feed the sink's default exclusion (W06c) and the evidence pack.

## Scope / Non-goals
In: W8-1, W8-2. Out: the break-glass flow and audit chain (W08b), patient-facing consent UI, probabilistic matching.

## Acceptance criteria
- [ ] W8-1: a `Condition` coded in the SUD ValueSet gets `SUD`; one coded outside it does not. Fails if membership uses a text match instead of the ValueSet (a lookalike code with the same display text must stay unlabelled).
- [ ] W8-2: the consent suite (`TEST-STRATEGY.md` section 7) passes for absent consent, present consent, and break-glass-with-audit; with the PDP down every request is denied (fail closed). Fails if one revoked-consent read returns data.
- [ ] W8-2: cached decision invalidates on an outbox `Consent` write within the documented bound (a stale-cache fixture must fail).

## Read first
`adr/ADR-011-consent-pdp.md`, `SECURITY-AND-COMPLIANCE.md` (Part 2 and consent sections), `apps/loom-health-pdp/policies/lhds/`, `apps/loom-health-pdp/input-contract.json`, `apps/loom-health-pdp/tests/authz_test.rego`, `apps/loom-health-pdp/tools/build-bundle.sh`, `.github/workflows/health-pdp-opa.yml`, `adr/ADR-013-terminology-service.md` (ValueSet expansion).

## Owns
`apps/loom-health-fhir/plugin/src/labeling/**`, `apps/loom-health-cp/src/jobs/relabel.ts`, `apps/loom-health-dicom-gateway/src/labels/**` (ASSUMPTION: the gateway app path is set by W03; if it differs, use W03's path), `apps/loom-health-pdp/policies/**`, `apps/loom-health-pdp/tests/**`, `tests/health/consent/**`.

## Must NOT touch
`apps/loom-health-cp/src/auth/**` (W1-4 server), audit and break-glass files (W08b), the sink (W06c), `.github/workflows/health-pdp-*.yml` (W1-5), bicep.

## Consumes
W04 (`$expand`/`$validate-code` for ValueSet membership), W02b (interceptor decision API, outbox), W03b (gateway), W1-5 bundle publishing (`apps/loom-health-pdp/tools/publish-bundle.mjs`).

## Provides
Labels on resources and DICOM; PDP bundle v2 with break-glass rule hooks consumed by W08b; label vocabulary for W06c/W12.

## Steps
1. W8-1 labeling service and relabel job. 2. W8-2 policy design pass (Opus), then implementation and the consent suite. 3. Publish bundle v2 through the existing pipeline on a dev stamp.

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W8-1 | Labeling service, relabel job, DICOM label tags | W4-2 | Sonnet | required | ValueSet in vs out |
| W8-2 | PDP consent bundle v2 | W8-1, W1-5 | Opus design, Sonnet implement | required | Consent suite; fail closed |

## Validation
```
opa test apps/loom-health-pdp/policies apps/loom-health-pdp/tests -v
cd apps/loom-health-cp && npx vitest run && npx tsc --noEmit -p tsconfig.test.json
```
Plus the consent suite against the Commercial dev stamp and a GCC-High Actions run id. Mutation receipt on a sandbox copy: delete the revocation rule and the revoked-consent test goes red. "Merged, not deployed" until a run id exists. IL5, DoD, GCC supported-in-code only.

## Rollback
Bundle version pinned per tenant; roll back to the previous bundle; labels are additive metadata.

## Docs to update
`docs/fiab/health/security.md` (consent and labels), `adr/ADR-011-consent-pdp.md` status, `TEST-STRATEGY.md` section 7.

## Wave / Blocked-by / Branch / Worktree
`Wave: 4 · Blocked-by: W02b-fhir-core-ops, W03b-dicom-core-b, W04-terminology · Branch: feat/lhds-w08a-labels-pdp · Worktree: E:/Repos/_lhds-w08a`

## Hot files
`apps/loom-health-pdp/policies/**` (sole owner this tier). `touches_bicep: no`.

## Kickoff prompt
```
Wave W08a (LHDS labels and consent PDP v2). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w08a, branch feat/lhds-w08a-labels-pdp.
Read first: PRP.md (section 5), this file, adr/ADR-011, apps/loom-health-pdp/policies/lhds/.
Opus for the W8-2 policy design pass only. No bicep.
Do W8-1 then W8-2.
Proof: opa test apps/loom-health-pdp/policies apps/loom-health-pdp/tests -v ; consent suite green and PDP-down fails closed.
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W8-1 | todo | | sonnet | | 2026-11-14 |
| W8-2 | todo | | opus | | 2026-11-14 |
