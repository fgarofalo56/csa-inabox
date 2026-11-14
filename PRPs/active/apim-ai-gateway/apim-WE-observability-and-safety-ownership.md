---
name: apim-WE-observability-and-safety-ownership
status: active
priority: P2
order: 66
depends_on: [apim-WD-service-families-and-sovereign-spend-control]
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave E: observability + per-boundary safety verdict ownership

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Add `llm-emit-token-metric` (token metrics to App Insights) where Gov authoring is confirmed, and record per boundary which layer (gateway vs console vs AOAI deployment filter) owns the content-safety verdict so nothing double-charges or double-blocks.

## Why
Cost attribution nearly for free. `llm-emit-token-metric` authoring is accepted on Commercial and GCC-High (apigw W0); IL5 unmeasured, so do not promise it there.

## Scope / Non-goals
**Scope:**
- Policy fragment + App Insights wiring in `apim.bicep`. - Verdict-ownership table per boundary in docs (IL5 row reflects the `/contentsafety` fallback and the open #4458 question).

**Non-goals:**
- No apigw usage rollups/pricing (apigw-W04 owns). - No change to console screening code.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Commercial: token metrics visible in App Insights from one live turn (customMetrics row with the namespace); fails if the row is absent.
- [ ] Policy is authored only where measured accepted; build for il5 contains none unless W0-RECEIPT says accepted at IL5.
- [ ] Verdict-ownership table has one row per boundary with exactly one owning layer; fails if any row names two.
- [ ] No double screening: one turn produces exactly one content-safety call (count in logs), value that breaks it: 2.

## Read first
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` policy fragments; `platform/fiab/bicep/modules/admin-plane/main.bicep` App Insights wiring; REFERENCE.md 3.4/3.4.1; `apps/fiab-console/lib/azure/foundry-client.ts` `shieldPrompt`.

## Owns
- `platform/fiab/bicep/modules/admin-plane/apim.bicep` (policy fragments, diagnostics).
- `docs/fiab/apim-ai-gateway.md`.

## Must NOT touch
- `loomBackends`, params, apigw files (`apim-client.ts` etc. belong to apigw). - `apps/**`.

## Consumes
- `apim-WD` (content-safety branch). - `W0-RECEIPT.md`.

## Provides
- Token-metric stream apigw-W04 may consume. - Safety-ownership table consumed by `apim-WG`.

## Steps
1. Bicep slot. 2. Add fragment gated on measured support. 3. Wire to App Insights. 4. Write ownership table. 5. Commercial live-turn receipt.

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
App Insights (Commercial): `customMetrics | where name has "Token" | take 5` after a Copilot turn.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
`git revert`; metrics stop, no data loss elsewhere. Verify the policy is gone with the apim policy read-back.

## Docs to update
`docs/fiab/apim-ai-gateway.md` observability + safety-ownership sections.

## Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: apim-WD · Branch: feat/apim-we · Worktree: E:/Repos/_apim-we

## Hot files
`platform/fiab/bicep/modules/admin-plane/apim.bicep`. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges.
`touches_bicep: yes`

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md and apim-WE-observability-and-safety-ownership.md, REFERENCE.md 3.4/3.4.1.
Goal: llm-emit-token-metric where measured available; per-boundary content-safety verdict owner table in docs/fiab/apim-ai-gateway.md.
Single bicep slot. Branch feat/apim-we in E:/Repos/_apim-we. Proof: build-params + a customMetrics row from a live Commercial turn.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WE-1 token-metric fragment | todo | | sonnet | | 2026-11-14 |
| WE-2 ownership table | todo | | sonnet | | 2026-11-14 |
| WE-3 Commercial receipt | todo | | | | 2026-11-14 |
