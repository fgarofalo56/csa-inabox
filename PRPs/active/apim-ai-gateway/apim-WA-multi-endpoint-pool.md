---
name: apim-WA-multi-endpoint-pool
status: active
priority: P1
order: 61
depends_on: [apim-W00-prerequisite-measurements]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave A: the multi-endpoint pool

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Replace the single-element backend pool (one Foundry/AOAI endpoint) with a pool built from every Loom-provisioned inference endpoint plus operator-supplied BYO endpoints, priority-ordered (PTU primary, pay-go spillover).

## Why
This is the literal ask of #4442 ("not tied to one Foundry endpoint"). Gates apigw-W07 W7-5 (adoption of the day-one gateway). Needs Wave 0 only so a negative measurement can redirect it.

## Scope / Non-goals
**Scope:**
- Derive `aoaiApimBackendEndpoints` (admin-plane `main.bicep`) from N endpoints: Loom-provisioned accounts + a new `aoaiApimExtraEndpoints` array param (BYO) with per-entry priority.
- `apim.bicep` pool params accept `{endpoint, priority, weight?}` objects and keep: per-endpoint backend + circuit breaker, empty pool never authored (`aoaiGatewayActive`).
- Priority 1 = PTU primary where present, rest priority 2.

**Non-goals:**
- Not default-ON (that is `apim-WB1`). - No multi-vendor (Anthropic/Vertex) - Q2 out of scope. - No capacity change (`apim-WC`). - Does not collapse `aoaiGateway` and `aoaiViaApim` (separability preserved).

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] A param set naming three endpoints yields a three-member pool with priorities [1,2,2]; value that breaks it: `az bicep build-params` output with 1 backend, or all priority 1.
- [ ] A param set naming ZERO endpoints authors NO pool and no gateway policy (value that breaks it: an authored pool resource with empty `backends`).
- [ ] An endpoint list with a duplicate host is rejected at build time or deduped with a recorded note (value: two backends with the same URL).
- [ ] Commercial deploy receipt: `az apim backend list` on the live instance shows three backends and the pool; the console still reaches `/api/health/aoai` with `aoaiViaApim` OFF (separability).
- [ ] Mutation proof (assertion-design): remove the BYO concat in a sandbox copy; the three-endpoint build check goes RED; tracked tree untouched.

## Read first
- `platform/fiab/bicep/modules/admin-plane/main.bicep` symbols `aoaiApimBackendEndpoints`, `loomAoaiEndpointValue`, `aoaiApimGatewayEnabled`, the `module apim` invocation (`aoaiBackendEndpoints:`).
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` symbols `aoaiBackendEndpoints`, `aoaiGatewayActive`, backend + circuit-breaker + pool resources.
- `apps/fiab-console/lib/azure/aoai-apim-gateway.ts` (consumer) and its test.
- REFERENCE.md section 3.3.

## Owns
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (the `aoaiApimBackendEndpoints` derivation, one new param, the `module apim` args only).
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` (pool params/resources only).
- `platform/fiab/bicep/main.bicep` ONLY if the new param must be threaded from the subscription-level template.
- `docs/fiab/apim-ai-gateway.md` (created here).

## Must NOT touch
- The `loomBackends` switches `aoaiGateway`/`aoaiViaApim` values (WB1). - `capacity` (WC). - Any `params/*.bicepparam` except adding the new param to NONE of them (default empty array). - `apps/**`. - `PRPs/active/loom-api-gateway-plane/**`.

## Consumes
- `apim-W00` receipt (no blocking negative). - Existing M4 pool/circuit-breaker (`PRPs/completed/model-strategy/PRP.md`).

## Provides
- N-endpoint pool contract consumed by apigw-W07 W7-5. - `docs/fiab/apim-ai-gateway.md` skeleton (pool contract section).

## Steps
1. Take the bicep slot (see Hot files). Worktree E:/Repos/_apim-wa from `origin/main`.
2. Add the BYO param + derivation; keep the empty-pool guard.
3. Extend `apim.bicep` pool to accept priority per endpoint.
4. Add a build-time test fixture (bicepparam under `temp/` or an existing test dir) for 0/1/3 endpoints.
5. Mutation-prove the 3-endpoint check in a sandbox copy.
6. Open PR with the receipt plan; after merge, run the Commercial deploy and capture `az apim backend list`.

## Validation
```bash
az bicep build-params --file platform/fiab/bicep/params/commercial.bicepparam --stdout > /dev/null && echo "commercial: OK"
az bicep build-params --file platform/fiab/bicep/params/commercial-full.bicepparam --stdout > /dev/null && echo "commercial-full: OK"
az bicep build-params --file platform/fiab/bicep/params/gcc.bicepparam --stdout > /dev/null && echo "gcc: OK"
az bicep build-params --file platform/fiab/bicep/params/gcc-high.bicepparam --stdout > /dev/null && echo "gcc-high: OK"
az bicep build-params --file platform/fiab/bicep/params/il5.bicepparam --stdout > /dev/null && echo "il5: OK"
az bicep build-params --file platform/fiab/bicep/params/dod.bicepparam --stdout > /dev/null && echo "dod: OK"
az bicep build-params --file platform/fiab/bicep/params/tenant-dmlz.bicepparam --stdout > /dev/null && echo "tenant-dmlz: OK"
node scripts/ci/check-bicepparam-compiled.mjs      # fails if any listed param file does not compile
node scripts/ci/check-bicep-param-cap.mjs           # fails above the ARM 256-param ceiling
node scripts/ci/check-bicep-sync.mjs                # fails when a new env var/resource lacks its bicep twin
make validate-bicep                                  # narrow gate; NOT `make validate`
```
az bicep build --file platform/fiab/bicep/modules/admin-plane/main.bicep --stdout > /dev/null
```
Commercial receipt (after merge): `gh workflow run deploy-fiab-commercial.yml` with `allow_existing_hub=true`; then
`az apim backend list --subscription e093f4fd-5047-4ee4-968d-a56942c665f3 -g rg-csa-loom-admin-centralus --service-name apim-csa-loom-centralus --query "[].{id:name,url:url}"` shows the expected members.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
`git revert` the PR. The pool reverts to the single derived endpoint; no state migration. If already deployed, re-run the Commercial deploy workflow on the reverted SHA; backends are removed by the incremental deployment (verify with `az apim backend list`).

## Docs to update
Create `docs/fiab/apim-ai-gateway.md` (pool contract, BYO param, priority semantics, per-cloud status table). Add one line to `mkdocs.yml` nav if the repo nav lists fiab pages.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (first bicep slot after Wave 0) · Blocked-by: apim-W00-prerequisite-measurements · Branch: feat/apim-wa · Worktree: E:/Repos/_apim-wa

## Hot files
`platform/fiab/bicep/modules/admin-plane/main.bicep`, `platform/fiab/bicep/modules/admin-plane/apim.bicep`, possibly `platform/fiab/bicep/main.bicep`. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges. `apim-WB1` also edits `platform/fiab/bicep/modules/admin-plane/main.bicep`, so A and B1 are SERIALIZED (A first) - they are NOT parallel as the pre-2026-11-14 PRP stated.
`touches_bicep: yes`

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md, then apim-WA-multi-endpoint-pool.md and REFERENCE.md section 3.3.
Goal: make the APIM backend pool take N endpoints (Loom-provisioned + BYO param), priority-ordered; empty pool still authors nothing.
Edit only admin-plane/main.bicep (aoaiApimBackendEndpoints + module apim args), admin-plane/apim.bicep, docs/fiab/apim-ai-gateway.md.
You take the single bicep slot: check open bicep PRs first. Branch feat/apim-wa in E:/Repos/_apim-wa.
Proof: az bicep build-params on all 7 boundary params + check-bicepparam-compiled.mjs green; 3-endpoint fixture builds 3 backends.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WA-1 pool derivation | todo | | sonnet | | 2026-11-14 |
| WA-2 apim.bicep priority params | todo | | sonnet | | 2026-11-14 |
| WA-3 fixtures + mutation proof | todo | | sonnet | | 2026-11-14 |
| WA-4 Commercial deploy receipt | todo | | | | 2026-11-14 |
