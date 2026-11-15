---
name: apim-WB1-default-on-commercial-gcc
status: active
priority: P1
order: 62
depends_on: [apim-WA-multi-endpoint-pool]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave B1: default-ON for Commercial / GCC / DMLZ

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Default `aoaiGateway` and `aoaiViaApim` ON in the four param files whose boundaries get the full LLM policy set (commercial, commercial-full, gcc, tenant-dmlz), with explicit documented opt-out and the two switches still separable.

## Why
#4442 greenlit default-ON (2026-10-28). Splitting B1/B2 keeps GCC-High and IL5 from being routed through a gateway with no spend control (REFERENCE.md section 0 C12). Gates apigw-W07 W7-5 together with Wave A.

## Scope / Non-goals
**Scope:**
- Set the two `loomBackends` defaults and the four named param files. - Keep author-then-cutover: one deploy with gateway ON and routing OFF must work. - State at the line any boundary that differs.

**Non-goals:**
- `gcc-high.bicepparam`, `il5.bicepparam`, `dod.bicepparam` (those are `apim-WB2`). - `dlz-attach.bicepparam` (never). - No capacity/SKU change.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Each of the four files builds and resolves `aoaiGateway = 'apim'` and `aoaiViaApim = 'true'`; value that breaks it: a build output with either empty.
- [ ] A fifth build with `aoaiViaApim` explicitly OFF and `aoaiGateway` ON authors the gateway and leaves the console URL env empty (separability). Fails if turning routing off also drops the gateway.
- [ ] Commercial receipt: a live Loom AI turn whose APIM request log (Log Analytics `ApiManagementGatewayLogs`) shows the call; the same turn with routing OFF shows none. Fails if the log row is absent.
- [ ] GCC: build-params parity only, labelled supported-in-code, never exercised.
- [ ] G1: in-browser walk of one AI-using surface (Copilot) with real answer, not "answer OR honest gate".

## Read first
- `platform/fiab/bicep/modules/admin-plane/main.bicep` `loomBackends` object (`aoaiGateway`, `aoaiViaApim`, `redisOss`).
- The four param files and `il5.bicepparam` for the "differs at the line" precedent.
- `apps/fiab-console/lib/azure/aoai-apim-gateway.ts` `LOOM_AOAI_VIA_APIM`, `LOOM_AOAI_APIM_URL`.

## Owns
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (`loomBackends` default values only).
- `platform/fiab/bicep/params/{commercial,commercial-full,gcc,tenant-dmlz}.bicepparam`.
- `docs/fiab/apim-ai-gateway.md` (opt-out section).

## Must NOT touch
- The pool derivation (WA). - `gcc-high`, `il5`, `dod`, `dlz-attach` params. - `apim.bicep`. - `apps/**` unless a test fixture needs the new default (then only the test).

## Consumes
- `apim-WA` merged (N-endpoint pool). - `W0-RECEIPT.md` (no blocking negative on Commercial/GCC).

## Provides
- Default-ON gateway in Commercial/GCC/DMLZ. - The precondition apigw-W07 W7-5 waits on (with WA).

## Steps
1. Confirm WA merged; take the bicep slot; worktree E:/Repos/_apim-wb1.
2. Flip the two defaults; set the four params explicitly (explicit beats default for audit).
3. Add the opt-out documentation.
4. Build all seven params (proves nothing else moved).
5. After merge: deploy Commercial twice (routing off, then on) and capture both receipts + the Log Analytics row.

## Validation
```bash
az bicep build-params --file platform/fiab/bicep/params/commercial.bicepparam --stdout > /dev/null && echo "commercial: OK"
az bicep build-params --file platform/fiab/bicep/params/commercial-full.bicepparam --stdout > /dev/null && echo "commercial-full: OK"
az bicep build-params --file platform/fiab/bicep/params/gcc.bicepparam --stdout > /dev/null && echo "gcc: OK"
az bicep build-params --file platform/fiab/bicep/params/tenant-dmlz.bicepparam --stdout > /dev/null && echo "tenant-dmlz: OK"
node scripts/ci/check-bicepparam-compiled.mjs      # fails if any listed param file does not compile
node scripts/ci/check-bicep-param-cap.mjs           # fails above the ARM 256-param ceiling
node scripts/ci/check-bicep-sync.mjs                # fails when a new env var/resource lacks its bicep twin
make validate-bicep                                  # narrow gate; NOT `make validate`
```
```
Commercial: `gh workflow run deploy-fiab-commercial.yml` (allow_existing_hub=true), then a Copilot turn; query
`ApiManagementGatewayLogs | where ApiId has "openai" | take 5` in the admin Log Analytics workspace.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
`git revert` the PR, or set `aoaiViaApim` to empty in the params and redeploy: the console falls back to the direct endpoint (`aoai-apim-gateway.ts` graceful fallback). The gateway can stay authored. Verify with `curl <console>/api/health/aoai` after the redeploy.

## Docs to update
`docs/fiab/apim-ai-gateway.md` (default-ON + opt-out per boundary); `CHANGELOG.md` only if not release-please managed.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: apim-WA-multi-endpoint-pool · Branch: feat/apim-wb1 · Worktree: E:/Repos/_apim-wb1

## Hot files
`platform/fiab/bicep/modules/admin-plane/main.bicep`, four `params/*.bicepparam`. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges.
`touches_bicep: yes`
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md, apim-WB1-default-on-commercial-gcc.md and apim-WA (must be merged).
Goal: default aoaiGateway=apim and aoaiViaApim=true in commercial, commercial-full, gcc, tenant-dmlz params + loomBackends defaults; keep them separable.
Do NOT touch gcc-high/il5/dod params (WB2). Take the single bicep slot first. Branch feat/apim-wb1 in E:/Repos/_apim-wb1.
Proof: az bicep build-params x4 + check-bicepparam-compiled.mjs green; after deploy, ApiManagementGatewayLogs shows a Copilot call.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WB1-1 loomBackends defaults | todo | | sonnet | | 2026-11-14 |
| WB1-2 four param files | todo | | sonnet | | 2026-11-14 |
| WB1-3 Commercial receipts (on/off) | todo | | | | 2026-11-14 |
