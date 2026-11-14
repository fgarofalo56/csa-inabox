---
name: apim-WC-sku-capacity-contract
status: active
priority: P1
order: 63
depends_on: [apim-WB1-default-on-commercial-gcc]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave C: SKU contract and capacity threading

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
Document the per-boundary SKU contract (Q5 answered: PremiumV2 in Commercial/GCC/DMLZ, Premium classic in GCC-High/IL5) and thread `capacity` from `main.bicep` through admin-plane to `apim.bicep` so the single gateway path is not pinned at one unit.

## Why
Q5 answered 2026-10-29, so Wave C reduces to docs + capacity. There is no `Developer` flip: `apimSku` has no default and allows only PremiumV2/Premium; `apimSkuName` is a cost-estimator knob no deployment reads (REFERENCE.md section 2.2).

## Scope / Non-goals
**Scope:**
- `capacity` param threaded and set per boundary (default 1 preserved where not set). - Per-boundary SKU/capacity contract in docs, matching `az apim list`. - Real cost delta in the PR body, measured from the deployed SKU.

**Non-goals:**
- No SKU change, no migration, no new instance. - No multi-region (its own dated epic if evidenced). - Does not edit the cost estimator `apimSkuName` knob.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] `apim.bicep` `capacity` receives a value from params; value that breaks it: build output where capacity is 1 with a param file setting 2.
- [ ] Docs table per boundary equals live: Commercial `az apim show` reports sku PremiumV2 and the chosen capacity; fails if the doc says a SKU the instance does not report.
- [ ] GCC-High `az apim show` equivalent is obtained via an Actions run, not local `az`; if no fresh run is possible, row reads "not re-measured, last W0-RECEIPT 2026-10-29".
- [ ] PR body states the cost delta in USD/month from the deployed SKU; fails if computed from a Developer baseline.
- [ ] Central US PremiumV2 new-creation caveat is recorded (REFERENCE.md section 2.4) so nobody plans a new instance there.

## Read first
- `platform/fiab/bicep/main.bicep` params `apimSku`, `apimSkuName`; `platform/fiab/bicep/modules/admin-plane/main.bicep` `apimSku`, `module apim`; `platform/fiab/bicep/modules/admin-plane/apim.bicep` `capacity`.
- REFERENCE.md sections 2.1-2.4.

## Owns
- `platform/fiab/bicep/main.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`, `platform/fiab/bicep/modules/admin-plane/apim.bicep` (capacity threading only).
- `platform/fiab/bicep/params/{commercial,commercial-full,gcc,gcc-high,il5,dod,tenant-dmlz}.bicepparam` (seven files; `dlz-attach.bicepparam` is a different template and is never edited) (add `apimCapacity` only where it differs from 1).
- `docs/fiab/apim-ai-gateway.md` (SKU contract).

## Must NOT touch
- Pool derivation, `loomBackends` defaults. - `apps/fiab-console/lib/components/deploy-planner/**` (cost estimator). - Any `apimSku` VALUE.

## Consumes
- `apim-WB1` merged (traffic is now through the gateway, so capacity matters). - Q5 answer (done).

## Provides
- Per-boundary SKU+capacity contract; capacity param for apigw W1-2 and later to consume.

## Steps
1. Take bicep slot after WB1 merges. 2. Thread `capacity` (default 1). 3. Decide per-boundary values with the operator via the PR (default stays 1 where no load evidence). 4. Write the docs table from live `az apim list`/Actions output. 5. Deploy Commercial; read back capacity.

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
az apim list --subscription e093f4fd-5047-4ee4-968d-a56942c665f3 --query "[].{n:name,sku:sku.name,cap:sku.capacity}" -o table
```
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
`git revert`; capacity returns to the module default of 1. A capacity DEcrease on a deployed instance is a service-side scale-in: verify `az apim show ... --query sku.capacity` after redeploy.

## Docs to update
`docs/fiab/apim-ai-gateway.md` SKU/capacity table; `docs/fiab/` cost page if one lists APIM.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: apim-WB1-default-on-commercial-gcc · Branch: feat/apim-wc · Worktree: E:/Repos/_apim-wc

## Hot files
`platform/fiab/bicep/main.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`, `platform/fiab/bicep/modules/admin-plane/apim.bicep`, 7 params. **Takes the bicep slot.** Exactly one bicep-touching PR may be in flight across apim-ai-gateway, `loom-api-gateway-plane` (apigw W1-2 / W7-5), LHDS and any other program (ledger: `PRPs/reference/INTERLOCK.md`). Before opening the PR, `gh pr list --state open --search "bicep in:title,body"` and confirm none is in flight; rebase on `main` after it merges.
`touches_bicep: yes`

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md, apim-WC-sku-capacity-contract.md, REFERENCE.md sections 2.1-2.4.
Goal: thread apim capacity param main.bicep -> admin-plane main.bicep -> apim.bicep (default 1), document per-boundary SKU/capacity matching live.
No SKU value changes. Take the single bicep slot. Branch feat/apim-wc in E:/Repos/_apim-wc.
Proof: az bicep build-params x7 + check-bicepparam-compiled.mjs; az apim list capacity equals doc table.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WC-1 capacity threading | todo | | sonnet | | 2026-11-14 |
| WC-2 SKU/capacity docs table | todo | | sonnet | | 2026-11-14 |
| WC-3 Commercial readback | todo | | | | 2026-11-14 |
