---
name: apim-WF-gov-capable-semantic-cache
status: active
priority: P2
order: 67
depends_on: [apim-WD-service-families-and-sovereign-spend-control]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave F: Gov-capable semantic cache (Q4)

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
A semantic cache that works in Gov, built on the existing `redisOss` app with RediSearch, per-tenant, honest about similarity-not-exact-match semantics.

## Why
Q4: do not ship a Commercial-only cache. Azure Managed Redis is Public-only; Azure Cache for Redis is in IL6 audit scope but retires 2028-10-01, so `redisOss` is the long-lived answer (state this comparison in one line in docs).

## Scope / Non-goals
**Scope:**
- RediSearch capability on `redisOss`. - Policy wiring: `llm-semantic-cache-lookup/-store` must be authored in sovereign too, which depends on the `aoaiLlmPoliciesSupported` gate being resolved by WD and `aoaiSemanticCacheEnabled` being ANDed with it. - Per-tenant isolation. - UI/doc statement of similarity semantics.

**Non-goals:**
- No multi-region counter aggregation (state that counters are per gateway). - No Commercial-only shortcut.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] A cache HIT and a MISS observed on a live turn in a Gov boundary receipt (GCC-High via Actions); fails if only Commercial is shown.
- [ ] Two tenants issuing the identical prompt never share a cached answer; value that breaks it: tenant B receiving tenant A's cached body.
- [ ] Policy XML in GCC-High contains `llm-semantic-cache-lookup`; fails if `aoaiLlmPoliciesSupported` still blanks it.
- [ ] Docs state "similarity, not exact match; may return incorrect, outdated or unsafe answers".

## Read first
- `platform/fiab/bicep/modules/admin-plane/main.bicep` `redisOss`, `aoaiSemanticCacheEnabled`; `platform/fiab/bicep/modules/admin-plane/apim.bicep` `aoaiSemanticLookup`, `aoaiSemanticStore`; REFERENCE.md 3.2, 3.4 (Q4 paragraph); W0-RECEIPT.md.

## Owns
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` (cache policy wiring). - `platform/fiab/bicep/modules/admin-plane/main.bicep` (`redisOss` backend config only). - the `redisOss` app definition file found by `grep -rn redisOss platform/fiab/bicep/modules/admin-plane platform/fiab/bicep/modules`. - `docs/fiab/apim-ai-gateway.md`.

## Must NOT touch
- Params, `loomBackends` defaults other than `redisOss` internals, `apps/**`.

## Consumes
- `apim-WD` (sovereign policy gate resolved). - W0 residual on semantic-cache authoring in Gov.

## Provides
- Gov-capable cache; closes Q4 on deploy+verify.

## Steps
1. Bicep slot. 2. Confirm `redisOss` RediSearch support (module/image). 3. Per-tenant keying. 4. Wire policies. 5. Hit/miss receipt in GCC-High via Actions.

## Validation
```bash
az bicep build-params --file platform/fiab/bicep/params/commercial.bicepparam --stdout > /dev/null && echo "commercial: OK"
az bicep build-params --file platform/fiab/bicep/params/gcc-high.bicepparam --stdout > /dev/null && echo "gcc-high: OK"
az bicep build-params --file platform/fiab/bicep/params/il5.bicepparam --stdout > /dev/null && echo "il5: OK"
node scripts/ci/check-bicepparam-compiled.mjs      # fails if any listed param file does not compile
node scripts/ci/check-bicep-param-cap.mjs           # fails above the ARM 256-param ceiling
node scripts/ci/check-bicep-sync.mjs                # fails when a new env var/resource lacks its bicep twin
make validate-bicep                                  # narrow gate; NOT `make validate`
```
```
GCC-High via Actions only; Commercial miss/hit via two identical Copilot prompts and gateway logs.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
Set `aoaiSemanticCacheEnabled` false and redeploy; `redisOss` stays. `git revert` otherwise.

## Docs to update
`docs/fiab/apim-ai-gateway.md` cache section (one-line redisOss vs Azure Cache for Redis comparison; per-boundary status).

## Wave / Blocked-by / Branch / Worktree
Wave: 7 · Blocked-by: apim-WD · Branch: feat/apim-wf · Worktree: E:/Repos/_apim-wf

## Hot files
`platform/fiab/bicep/modules/admin-plane/apim.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges.
`touches_bicep: yes`

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md, apim-WF-gov-capable-semantic-cache.md, REFERENCE.md 3.2 and 3.4.
Goal: RediSearch-backed per-tenant semantic cache on redisOss, policies authored in sovereign too; hit/miss receipt in a Gov boundary.
Single bicep slot. Branch feat/apim-wf in E:/Repos/_apim-wf. Proof: build-params + GCC-High Actions run showing a hit and a miss.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WF-1 redisOss RediSearch | todo | | sonnet | | 2026-11-14 |
| WF-2 policy wiring + tenant keying | todo | | sonnet | | 2026-11-14 |
| WF-3 Gov hit/miss receipt | todo | | | | 2026-11-14 |
