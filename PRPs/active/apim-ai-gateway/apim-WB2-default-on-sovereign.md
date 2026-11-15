---
name: apim-WB2-default-on-sovereign
status: blocked
priority: P1
order: 65
depends_on: [apim-WD-service-families-and-sovereign-spend-control]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
blocked_by: "apim-WD deployed to GCC-High (spend control) and #4460 resolved"
---

# PRP: APIM AI Gateway - Wave B2: default-ON for GCC-High / IL5 / DoD

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Turn `aoaiViaApim` ON in the sovereign param files once a spend control exists in the authored policy there.

## Why
Refusal to ship Gov a gateway worse than the direct path it replaces (REFERENCE.md section 0 C12). `aoaiGateway` MAY be ON earlier for smoke-testing without routing.

## Scope / Non-goals
**Scope:**
- `gcc-high.bicepparam`, `il5.bicepparam`, `dod.bicepparam` set `aoaiViaApim`; each differing line explains why. - `dod.bicepparam` is kept in step with `il5.bicepparam` (its own header demands it).

**Non-goals:**
- Commercial/GCC/DMLZ files (WB1). - Any policy authoring (WD). - IL5 stand-up decisions (#4458).

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] The three files build; `aoaiViaApim = 'true'` resolved. Value that breaks it: any of the three left empty or il5 and dod disagreeing.
- [ ] Authored policy XML for GCC-High from an Actions run contains a ceiling element (from WD); fails if XML lacks it.
- [ ] GCC-High in-boundary receipt: Copilot turn routed via gateway, request visible in gateway logs (W0 found GCC-High has no `GatewayLlmLogs`; use `ApiManagementGatewayLogs` or state the gap).
- [ ] IL5/DoD: named supported-in-code, never exercised; NOT listed as covered.

## Read first
- `W0-RECEIPT.md` (this folder) and `apim-WD`; the three param files; `il5.bicepparam` `contentSafetyEnabled` comment block.

## Owns
- `platform/fiab/bicep/params/{gcc-high,il5,dod}.bicepparam` only.

## Must NOT touch
- Every other params file, every `*.bicep`. - `apps/**`.

## Consumes
- `apim-WD` merged AND deployed to GCC-High (spend control present). - #4460 resolution. - #4458 determination before any IL5 deploy.

## Provides
- Sovereign parity with Commercial for AI routing.

## Steps
1. Confirm WD deployed to GCC-High and policy XML read back. 2. Flip the three params. 3. Build. 4. Operator lifts the GCC-High stand-down; run the lane; capture receipt.

## Validation
```bash
az bicep build-params --file platform/fiab/bicep/params/gcc-high.bicepparam --stdout > /dev/null && echo "gcc-high: OK"
az bicep build-params --file platform/fiab/bicep/params/il5.bicepparam --stdout > /dev/null && echo "il5: OK"
az bicep build-params --file platform/fiab/bicep/params/dod.bicepparam --stdout > /dev/null && echo "dod: OK"
node scripts/ci/check-bicepparam-compiled.mjs      # fails if any listed param file does not compile
node scripts/ci/check-bicep-param-cap.mjs           # fails above the ARM 256-param ceiling
node scripts/ci/check-bicep-sync.mjs                # fails when a new env var/resource lacks its bicep twin
make validate-bicep                                  # narrow gate; NOT `make validate`
```
```
GCC-High: `gh workflow run deploy-fiab-gcch.yml`; jobs API must show `Deploy + validate CSA Loom in GCC-High` with steps>0.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
Set `aoaiViaApim` back to empty in the three files and redeploy; console falls back to direct (graceful fallback). `git revert` is equivalent.

## Docs to update
`docs/fiab/apim-ai-gateway.md` per-boundary routing status.

## Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: apim-WD-service-families-and-sovereign-spend-control (apim-WD deployed to GCC-High; also #4460) · Branch: feat/apim-wb2 · Worktree: E:/Repos/_apim-wb2

## Hot files
3 sovereign `params/*.bicepparam`. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges.
`touches_bicep: yes`
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md and apim-WB2-default-on-sovereign.md. Precondition: apim-WD merged AND deployed to GCC-High with a ceiling in the policy XML. If not, stop.
Goal: set aoaiViaApim in gcc-high, il5, dod bicepparam only (keep il5/dod in step). Single bicep slot. Branch feat/apim-wb2 in E:/Repos/_apim-wb2.
Proof: az bicep build-params x3 + check-bicepparam-compiled.mjs; GCC-High Actions run with deploy steps>0.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WB2-1 three sovereign params | blocked | | sonnet | waits on WD + #4460 | 2026-11-14 |
| WB2-2 GCC-High receipt | blocked | | | operator lifts stand-down | 2026-11-14 |
