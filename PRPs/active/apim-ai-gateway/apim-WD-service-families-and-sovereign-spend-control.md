---
name: apim-WD-service-families-and-sovereign-spend-control
status: active
priority: P1
order: 64
depends_on: [apim-W00-prerequisite-measurements, apim-WC-sku-capacity-contract]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave D: other service families + sovereign spend control

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Route AI Search, Document Intelligence / Speech / Vision through the gateway (backend + circuit breaker, not token limiting); add `llm-content-safety` gated on `contentSafetyEnabled`; and resolve #4460 by removing the `!isSovereign` exclusion on `llm-token-limit` (if Wave 0 says policies are available) or wiring a declared request-counting substitute.

## Why
Q3 (all four service families). Resolving #4460 is the highest-priority item because it unblocks `apim-WB2`. GCC-High authoring of `llm-token-limit` is already measured accepted (apigw W0); runtime enforcement is not.

## Scope / Non-goals
**Scope:**
- D1 (first): sovereign spend control. Per `W0-RECEIPT.md`: remove `!isSovereign` for `llm-token-limit` in GCC-High/IL5 OR author `rate-limit-by-key`/`quota-by-key` labelled request-counting.
- D2: Search / Document Intelligence / Speech / Vision APIs + backends + circuit breaker + routing.
- D3: `llm-content-safety` on the `contentSafetyEnabled` branch only (never `boundary == 'IL5'`); substitute (AOAI default content filter) surfaced per boundary.
- D4: IL5 `/contentsafety` fallback (admin-plane `LOOM_CONTENT_SAFETY_ENDPOINT` expression): change NOTHING until the #4458 determination exists; then follow REFERENCE.md section 3.4.1.

**Non-goals:**
- No token limiting for non-OpenAI families (say so). - No semantic cache (WF). - No default-ON for sovereign (WB2). - Does not decide #4458.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] GCC-High and IL5 authored policy XML contains a rate/token ceiling; value that breaks it: authored XML with only `authentication-managed-identity` + `set-backend-service` (the current state).
- [ ] The substitute (if used) is labelled "requests, not tokens" in docs and in the readiness row; fails if the label says tokens.
- [ ] `llm-content-safety` is authored iff `contentSafetyEnabled` is true: build with `contentSafetyEnabled=false` (il5) has none, `true` (commercial) has one; a build keyed on boundary name fails this test.
- [ ] D4: with no #4458 determination the diff to the `LOOM_CONTENT_SAFETY_ENDPOINT` expression is empty; fails on any change there.
- [ ] Commercial receipt: one real call through each of the four families (status 200, first 300 chars of body in PR). GCC-High receipt through Actions showing the content-safety branch taking the substitute path without error; IL5/GCC named unexercised.

## Read first
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` `aoaiLlmPoliciesSupported`, `isSovereign`, policy vars, API definitions.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` `LOOM_CONTENT_SAFETY_ENDPOINT`, `contentSafetyEnabled`, `loomAiEnrichEndpoint`.
- REFERENCE.md sections 3.1, 3.2, 3.4, 3.4.1; `W0-RECEIPT.md` (apim folder) and #4460.

## Owns
- `platform/fiab/bicep/modules/admin-plane/apim.bicep`.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (new family backend params only).
- `docs/fiab/apim-ai-gateway.md` (families + per-boundary safety-layer table).

## Must NOT touch
- `loomBackends` defaults and the 7 params (WB1/WB2/WG). - The `LOOM_CONTENT_SAFETY_ENDPOINT` expression unless D4 conditions hold. - `apps/**` except none.

## Consumes
- `W0-RECEIPT.md` (policy availability, Prompt Shields, #4458). - `apim-WC` merged (bicep slot order).

## Provides
- Sovereign spend control (unblocks `apim-WB2`, closes #4460 on deploy+verify). - Four-family routing. - Per-boundary safety-layer table consumed by WE and WG.

## Steps
1. Take bicep slot after WC. 2. D1 first, own commit; open PR early so WB2 can start its prep. 3. D2 families. 4. D3 policy gated on `contentSafetyEnabled`. 5. D4 only if determination exists. 6. Receipts: Commercial live calls; GCC-High via Actions.

## Validation
```bash
az bicep build-params --file platform/fiab/bicep/params/commercial.bicepparam --stdout > /dev/null && echo "commercial: OK"
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
```
Assert policy shape (positive AND negative): build il5 and commercial, grep the authored policy XML for `llm-token-limit|rate-limit-by-key` (must match for both) and `llm-content-safety` (must match commercial, must NOT match il5).
GCC-High: `gh workflow run deploy-fiab-gcch.yml` (needs the estate stand-down lifted by the operator) then read back the policy via Actions.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
`git revert`; sovereign policy reverts to no ceiling, which is the current state - so BLOCK `apim-WB2` again if reverted after it merged. Commercial families: remove API objects by redeploy; verify with `az apim api list`.

## Docs to update
`docs/fiab/apim-ai-gateway.md`: families table, per-boundary safety-layer table, declared gaps (IL5 content safety, Prompt Shields) with owner and review date 2026-12-11.

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: apim-W00-prerequisite-measurements, apim-WC-sku-capacity-contract · Branch: feat/apim-wd · Worktree: E:/Repos/_apim-wd

## Hot files
`platform/fiab/bicep/modules/admin-plane/apim.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges.
`touches_bicep: yes`
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md, apim-WD-service-families-and-sovereign-spend-control.md, W0-RECEIPT.md, REFERENCE.md 3.2/3.4/3.4.1.
Goal order: (1) sovereign spend control in apim.bicep (#4460), (2) Search/DocIntel/Speech/Vision families, (3) llm-content-safety gated on contentSafetyEnabled.
Do NOT touch the LOOM_CONTENT_SAFETY_ENDPOINT expression unless the #4458 determination exists. Single bicep slot. Branch feat/apim-wd in E:/Repos/_apim-wd.
Proof: build-params x6 + policy-XML positive/negative greps; Commercial live call per family.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WD-1 sovereign spend control (#4460) | todo | | sonnet | | 2026-11-14 |
| WD-2 four service families | todo | | sonnet | | 2026-11-14 |
| WD-3 llm-content-safety gated | todo | | sonnet | | 2026-11-14 |
| WD-4 IL5 fallback decision | blocked | | | needs #4458 | 2026-11-14 |
| WD-5 receipts | todo | | | | 2026-11-14 |
