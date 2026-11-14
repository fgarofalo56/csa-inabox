---
name: apim-WG-day-one-readiness
status: active
priority: P2
order: 68
depends_on: [apim-WB1-default-on-commercial-gcc, apim-WE-observability-and-safety-ownership]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
---

# PRP: APIM AI Gateway - Wave G: day-one deploy coverage + readiness

Hub: `PRPs/active/apim-ai-gateway/PRP.md`. Shared measured context (read the cited section only):
`PRPs/active/apim-ai-gateway/REFERENCE.md`. Rules: no-vaporware, cloud-parity, auto-bind-by-default, deploy-integrity, assertion-design (`.claude/rules/`).

## Goal
A readiness gate for gateway health registered in the gate registry, showing per-boundary capability state including the declared gaps; greenfield AND brownfield walkthroughs with receipts; brownfield discovers and offers an existing APIM.

## Why
A gap the operator cannot see is the deploy-integrity R3 failure; greenfield and brownfield each need their own receipt (R4/R5/R8).

## Scope / Non-goals
**Scope:**
- Gate registry row (Fix-it action per ux-baseline G2) + Admin gate page entry + Copilot discoverability. - Per-boundary state: pool size, routing on/off, spend control, content-safety layer, cache, declared gaps (IL5 content safety, Prompt Shields, GCC/IL5 unexercised). - Docs: separate greenfield and brownfield pages. - Brownfield: use `adoptMode(adopt,'apim')`, discover, offer, never silently adopt/duplicate.

**Non-goals:**
- Does not edit the bicep params (WB1/WB2 own those) unless a day-one value is missing, which is then a PR to the owner wave. - apigw gateway registry (apigw-W01) is separate; link, do not duplicate.

## Acceptance criteria
Each criterion names the value or output that would make it fail.
- [ ] Gate row appears on `/admin/readiness` and the Admin gate page; value that breaks it: row absent from `lib/gates/registry` or showing green with the pool empty.
- [ ] Fix-it button launches a wizard that sets the missing value; fails if the gate is a bare MessageBar.
- [ ] Greenfield receipt (empty subscription, three-step path from `no-vaporware.md`) naming boundary; brownfield receipt against an existing APIM naming boundary.
- [ ] Brownfield: discovered APIM is OFFERED; value that breaks it: a second APIM deployed next to the existing one without a prompt.
- [ ] Screenshot per boundary state (dark + light); G1 in-browser walk with real data.

## Read first
- `apps/fiab-console/lib/gates/registry*` (grep `gates/registry`); `/admin/readiness` page; `main.bicep` `adoptMode`; `docs/fiab/ux-standards.md` section 9; `apps/fiab-console/lib/azure/aoai-apim-gateway.ts`.

## Owns
- New gate file under `apps/fiab-console/lib/gates/` (new registry entry; the registry index is a hot file - this is its ONE owner this wave). - `docs/fiab/apim-ai-gateway-greenfield.md`, `docs/fiab/apim-ai-gateway-brownfield.md` (new). - the matching vitest file.

## Must NOT touch
- All bicep/bicepparam. - `apim-client.ts` (apigw owns). - Other waves' docs sections except linking.

## Consumes
- WB1 (+WB2 where merged), WD, WE tables. - `loom-api-gateway-plane` apigw-W01 gateway registry for the final link.

## Provides
- Operator-visible per-boundary state; the closing receipts for #4442.

## Steps
1. Register gate + Fix-it. 2. Read state from live APIM/env. 3. Docs pages. 4. Greenfield deploy receipt; brownfield receipt. 5. Browser walk, screenshots.

## Validation
```bash
cd apps/fiab-console && pnpm vitest run lib/gates && pnpm tsc --noEmit
make validate        # this wave touches TypeScript: full gate is the bar, not a narrow one
```
Live: G1 browser walk on `/admin/readiness` against the Commercial estate; greenfield + brownfield deploy runs.
Per-cloud receipts:
| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

Merged is not done (`deploy-integrity.md` R2): until a deploy job EXECUTED steps and the behaviour was observed, report "merged, not deployed". Never write "fixed" on a merge.

## Rollback
`git revert`; the gate disappears, gateway behaviour unchanged (read-only wave). Verify `/admin/readiness` no longer lists it.

## Docs to update
Two walkthrough pages above; `mkdocs.yml` nav; `docs/fiab/apim-ai-gateway.md` final status table.

## Wave / Blocked-by / Branch / Worktree
Wave: 8 (last) · Blocked-by: apim-WB1, apim-WE · Branch: feat/apim-wg · Worktree: E:/Repos/_apim-wg

## Hot files
`apps/fiab-console/lib/gates/registry*` (hot, single owner this wave), new docs.
`touches_bicep: no`

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md and apim-WG-day-one-readiness.md; docs/fiab/ux-standards.md section 9 (G1/G2).
Goal: register an APIM AI gateway readiness gate (with Fix-it) showing per-boundary state + declared gaps; write greenfield and brownfield docs; get both receipts.
No bicep edits. Branch feat/apim-wg in E:/Repos/_apim-wg.
Proof: vitest + tsc green, make validate, browser walk of /admin/readiness with screenshots.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| WG-1 gate + Fix-it | todo | | sonnet | | 2026-11-14 |
| WG-2 greenfield/brownfield docs | todo | | sonnet | | 2026-11-14 |
| WG-3 receipts + G1 walk | todo | | | | 2026-11-14 |
