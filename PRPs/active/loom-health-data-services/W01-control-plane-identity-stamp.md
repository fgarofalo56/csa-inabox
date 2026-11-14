---
name: W01-control-plane-identity-stamp
status: active
priority: P1
order: 2
depends_on: [W00-measurement-spike]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
started: 2026-10-24
allow_parallel: true
issues: [5151, 5149, 5123, 5161, 5162, 5163, 5217]
---
# W1 — Control plane, identity (SMART authorization server), tenancy, stamp bicep: BUILT RECORD

Status in one line: all 9 items are **merged, not deployed**. Nothing from W1 has been exercised through a route in any
cloud. This file is the record of what was built. Everything still open is in `W01b-close-deploy-receipts.md`; do not
add work here. This PRP stays `active` (not `shipped`) until W01b's receipts exist, per `deploy-integrity.md` R2.

## Goal
A stamp and a tenant can be created from bicep + the control plane in Commercial and GCC-High, with private networking,
per-tenant CMK, the authorization server issuing SMART v2 tokens, the PDP enforcing scopes, and the cross-tenant probe
green on an empty stamp. No FHIR/DICOM engine (W2/W3 deploy those onto this stamp).

## Why
Every later wave rides on this stamp, identity and routing. Scope sources: `ARCHITECTURE.md` sections 2-3, ADR-005/006/009/010/011/012,
`SECURITY-AND-COMPLIANCE.md` sections 2-5, `LOOM-INTEGRATION.md` sections 2, 5, 6.

## Scope / Non-goals
In scope: what the table below built. Non-goals: any new W1 code (goes to W01b), FHIR/DICOM engines, GCC (supported-in-code,
never exercised, `cloud-parity.md`), IL5/DoD (supported-in-code via params, never exercised).

## Acceptance criteria
Replaced by W01b. This wave's original done receipt (stamp + tenant from a clean RG, probe green, Inferno SMART green, pause
round-trip, Gov through Actions) is NOT met. It fails today because: no `deploy-health` What-If or apply in GCC-High, no
route response from any health endpoint, no Inferno report, no synthetic tenant readback.

## Read first
`apps/loom-health-cp/src/compose.ts`, `main.ts`; `platform/fiab/bicep/health.bicep`; `modules/health/{stamp,tenant,control-plane,ingress,engines}.bicep`;
`apps/loom-health-pdp/README.md`; `docs/fiab/health/` (index, greenfield, brownfield, runbooks); `adr/ADR-005/010/011`; `W0-RECEIPT.md` section 7.

## Owns
Frozen. Edits to W1 files now belong to the PRP that fixes them (W01b for deploy wiring; later waves for their own surfaces).

## Must NOT touch
Do not reopen W1 items in this file; do not edit `main.bicep` (the `boundary` enum PR #5146 is merged and independent).

## Consumes
W0 decisions (`W00-measurement-spike.md`, ADR-001/002 accepted).

## Provides
Stamp + tenant bicep, `apps/loom-health-cp` (registries, jobs, routing publisher, SLO API), LHDS Authorization Server (token contract
`lhds-at/1`), PDP v1 (`apps/loom-health-pdp`), APIM fragment + App Gateway ingress, `health-tenant` item, estate-power hooks, DoD enum,
`docs/fiab/health/`. Interfaces are frozen in `CONTRACT-FREEZE-W2.md`.

## Steps
Done (see Execution state). Remaining steps: `W01b-close-deploy-receipts.md`.

## Validation
Built-record checks, all runnable on a workstation:
```bash
cd apps/loom-health-cp && npm ci && npm test                      # vitest run; fails if any auth/jobs/routing test regresses
# PDP: fixtures are generated first (apps/loom-health-pdp/tools/gen-jwt-fixtures.mjs), then opa test; the exact order is the
# `opa-test` job in .github/workflows/health-pdp-opa.yml - run that job, do not guess the order.
az bicep build --file platform/fiab/bicep/health.bicep --stdout >/dev/null   # fails on a compile error
```
Deployed-and-verified evidence does NOT exist; see W01b. "Merged, not deployed" is the only accurate phrase.

## Rollback
`healthEnabled=false` removes nothing deployed; stamp destroy is an explicit confirmed job; the DoD enum PR is independently revertible.

## Docs to update
`docs/fiab/health/*` ("Not yet implemented" section shrinks as W01b lands items).

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (built) · Blocked-by: none (closed by W01b) · Branch: n/a · Worktree: n/a

## Hot files
`platform/fiab/bicep/health.bicep`, `admin-plane/main.bicep` env rows, `params/*.bicepparam`. `touches_bicep: no` (no further edits here).

## Kickoff prompt
Do not start a session on this file. Read `W01b-close-deploy-receipts.md` and run its kickoff prompt instead.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W1-1 stamp bicep | merged | feat/lhds-w1-1-stamp-bicep | sonnet | #5122; merged, not deployed in GCC-High; Commercial applied 2026-11-12 (run 43154633226, #5151) | 2026-11-14 |
| W1-2 tenant bicep + jobs | merged | feat/lhds-w1-2-tenant-bicep | sonnet | #5130, ARM adapter #5170; synthetic create/destroy UNMEASURED (#5162 open) | 2026-11-14 |
| W1-3 control plane | merged | feat/lhds-w1-3-cp-bicep | sonnet | #5121, #5126; Commercial deployed, replica crash-looped, revision deactivated | 2026-11-14 |
| W1-4 auth server | merged | feat/lhds-w1-4-scope-design | opus | #5127, #5131, #5160, #5216; wired in `main.ts`; Inferno SMART UNMEASURED; #5217 open | 2026-11-14 |
| W1-5 PDP | merged | feat/lhds-w1-5-pdp | sonnet | #5125, #5137, #5224 bundle publish; never run on a live stamp; p95 UNMEASURED | 2026-11-14 |
| W1-6 routing | merged | feat/lhds-w1-6-routing | sonnet | #5145, #5154, #5215 probe, #5277; probe never run on a real APIM (#5149 open) | 2026-11-14 |
| W1-7 health-tenant item | merged | | sonnet | #5139, #5159, #5172, #5214; NOT A-grade: 5 parity rows missing, no G1 walk (#5161 open) | 2026-11-14 |
| W1-8 estate power + DoD | merged | | sonnet | #5138, #5146; paused banner TODO; DoD supported-in-code, never exercised | 2026-11-14 |
| W1-9 docs | merged | | sonnet | #5148; walkthroughs never executed on any sub | 2026-11-14 |
