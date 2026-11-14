---
name: apim-ai-gateway
status: active
priority: P2
order: 6
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-09-11
issues: [4442]
allow_parallel: true
started: 2026-10-28
---

# PRP: APIM AI Gateway as the day-one path for every Loom AI endpoint (hub)

**Status 2026-11-14: active-ready (greenlit 2026-10-28; Q5 answered 2026-10-29).** Recommend the orchestrator moves
this directory `PRPs/active/apim-ai-gateway/` to `PRPs/active/apim-ai-gateway/` (status is `active`; folder must match).
Parent issue #4442 (open). Related open: #4460 (sovereign LLM policies), #4458 (Content Safety adopt/BYO + IL5 audit-scope
question), #4432 (copilot, G1 walk pending). Rewritten 2026-11-14 from a single 990-line PRP into this hub + nine wave files.

## Goal
Loom AI traffic reaches Azure AI services through an APIM AI gateway by default in every supported boundary: an N-endpoint
priority pool (PTU primary, pay-go spillover, BYO), default-ON with opt-out, all four service families, spend control and
content-safety substitute declared per boundary, and greenfield and brownfield receipts. Operator intent (2026-09-10): "Have Loom
integrate directly with APIM for its AI endpoints so it's not tied to one Foundry endpoint ... Make sure the deployment scripts
and configuration settings cover all things day-one Loom deploy."

## Why
Greenlit on #4442 (2026-10-28). Sovereign customers need the gateway most. The sibling program `loom-api-gateway-plane`
(apigw-W00..W09, epic #5179) builds the control plane over this gateway; its W7 W7-5 needs Waves A and B1 here.

## Scope / Non-goals
**Scope:** the data plane of the gateway: pool, defaults, SKU/capacity contract, service families, spend control, observability,
semantic cache, readiness. **Non-goals:** the control plane (registry, publishing, entitlements, pricing, budgets, MCP) = apigw;
multi-vendor models (Q2); multi-region; Standard v2 (Q1, never); GCC real-tenant exercise.

## Acceptance criteria
- [ ] Every wave file's own acceptance is met and its Execution state row is `merged` with a deploy receipt named in Evidence.
- [ ] A Copilot turn on the live Commercial estate shows in `ApiManagementGatewayLogs`; same turn with routing OFF does not.
- [ ] GCC-High authored policy XML contains a spend ceiling (fails if it still has only `authentication-managed-identity` + `set-backend-service`).
- [ ] The readiness page shows per-boundary state with the declared gaps; any boundary without a receipt reads "unexercised".

## Read first
`PRPs/active/apim-ai-gateway/REFERENCE.md` (corrections, measurements, decisions; cite symbols not lines);
`PRPs/active/loom-api-gateway-plane/PRP.md` and `W0-RECEIPT.md`; `.claude/rules/cloud-parity.md`, `deploy-integrity.md`.

## Owns
This directory only, plus (docs) `docs/fiab/apim-ai-gateway*.md`, and the appended section in the apigw PRP.

## Must NOT touch
`PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`; any other `PRPs/active/loom-api-gateway-plane/` file.

## Consumes
apigw W0 (#5188) probes and receipt; operator decisions 2026-10-28/29 (Q5 = stay on PremiumV2, #4442 greenlit); #4458 determination.

## Provides
N-endpoint pool + default-ON gateway (consumed by apigw-W07 W7-5); per-boundary SKU/capacity contract; sovereign spend control (closes #4460 on deploy+verify).

## Steps
Run the waves in this order, one bicep PR at a time:
`W00 -> WA -> WB1 -> WC -> WD -> (WB2 after WD deployed to GCC-High) -> WE -> WF -> WG`. WA and WB1 gate apigw-W07, so they go first after Wave 0.
**Correction to the previous sequencing:** WA and WB1 were drawn parallel, but both edit `admin-plane/main.bicep` and the one-bicep-PR rule applies, so they serialize (A then B1).

| Wave | File | Title | Status | Blocked-by | Review |
|---|---|---|---|---|---|
| W00-prerequisite-measurements | `apim-W00-prerequisite-measurements.md` | Wave 0: the prerequisite measurements | active | - | none |
| WA-multi-endpoint-pool | `apim-WA-multi-endpoint-pool.md` | Wave A: the multi-endpoint pool | active | apim-W00-prerequisite-measurements | required |
| WB1-default-on-commercial-gcc | `apim-WB1-default-on-commercial-gcc.md` | Wave B1: default-ON for Commercial / GCC / DMLZ | active | apim-WA-multi-endpoint-pool | required |
| WC-sku-capacity-contract | `apim-WC-sku-capacity-contract.md` | Wave C: SKU contract and capacity threading | active | apim-WB1-default-on-commercial-gcc | required |
| WD-service-families-and-sovereign-spend-control | `apim-WD-service-families-and-sovereign-spend-control.md` | Wave D: other service families + sovereign spend control | active | apim-W00-prerequisite-measurements, apim-WC-sku-capacity-contract | required |
| WB2-default-on-sovereign | `apim-WB2-default-on-sovereign.md` | Wave B2: default-ON for GCC-High / IL5 / DoD | blocked | apim-WD-service-families-and-sovereign-spend-control | required |
| WE-observability-and-safety-ownership | `apim-WE-observability-and-safety-ownership.md` | Wave E: observability + per-boundary safety verdict ownership | active | apim-WD-service-families-and-sovereign-spend-control | none |
| WF-gov-capable-semantic-cache | `apim-WF-gov-capable-semantic-cache.md` | Wave F: Gov-capable semantic cache (Q4) | active | apim-WD-service-families-and-sovereign-spend-control | required |
| WG-day-one-readiness | `apim-WG-day-one-readiness.md` | Wave G: day-one deploy coverage + readiness | active | apim-WB1-default-on-commercial-gcc, apim-WE-observability-and-safety-ownership | required |

~9 sessions, one per wave. Estimated size is unchanged from the previous PRP; no wave exceeds ~5 work items.

## Validation
Per wave in the wave file. Common bar: `az bicep build-params` on every touched boundary file, `node scripts/ci/check-bicepparam-compiled.mjs`,
`make validate-bicep` (narrow), and for TypeScript waves `make validate`. A narrow gate passing is not `make validate` passing.
Boundary receipts (re-measured 2026-11-14):

| Boundary | Receipt required | State on 2026-11-14 |
|---|---|---|
| Commercial / DMLZ | deploy run with executed steps + live call | exercised (live DMLZ estate, `apim-csa-loom-centralus`, PremiumV2 x1, Internal) |
| GCC-High | Actions run in-boundary (never local `az`) | exercised 2026-09-01 (run 33519232492, 33 steps); latest 3 runs skipped at 0 steps (estate stand-down) - a fresh receipt needs the pause-declaration file lifted by the operator |
| GCC | `az bicep build-params` parity ONLY | supported-in-code, NEVER exercised (0 deploy steps ever; lane `disabled_manually`). Do not list as covered. |
| IL5 (+DoD via `effectiveBoundary`) | `az bicep build-params` parity; in-boundary receipt only if IL5 first deploys | supported-in-code, NEVER exercised: 10 runs, all `failure` with 0 jobs. DoD is supported-in-code, never exercised. |

IL5 content safety is UNDETERMINED (owned by #4458); IL5 must not be deployed while there is no determination.
Merged is not done: report "merged, not deployed" until a deploy job executed steps and behaviour was observed.

## Rollback
Each wave is independently revertable (see its Rollback section). `aoaiGateway` and `aoaiViaApim` stay separable so routing can be turned off without removing the gateway.

## Docs to update
`docs/fiab/apim-ai-gateway.md` (WA creates, every wave appends its section); greenfield/brownfield pages (WG).

## Wave / Blocked-by / Branch / Worktree
Hub. Waves: see table. Branch convention `feat/apim-<wave>`; worktree `E:/Repos/_apim-<wave>`.

## Hot files
`platform/fiab/bicep/modules/admin-plane/apim.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`, `platform/fiab/bicep/main.bicep`, seven `params/*.bicepparam`
(commercial, commercial-full, gcc, gcc-high, il5, dod, tenant-dmlz; the pre-rewrite text said six - `dod.bicepparam` is the seventh), and
`apps/fiab-console/lib/gates/registry*`. These are shared with apigw W1-2 / W7-5, LHDS and others: **one bicep PR in flight at a time**
(ledger `PRPs/reference/INTERLOCK.md`). apigw W1-2 already touched `apim.bicep` (merged #5191, not deployed); rebase every bicep wave on `main`.
`touches_bicep: yes` (all waves except W00 and WG).

## Relationship to the sibling program
Not a duplicate. `loom-api-gateway-plane` greenlit #4442 on 2026-10-28, adopted Q5 = PremiumV2, shares W0 probes and `apim.bicep`.
apigw-W07 (model pools) needs WA + WB1 merged. This program owns the data plane; apigw owns the control plane.

## Decisions and assumptions
- Q1 never Standard v2; Q2 multi-Azure only; Q3 all four families; Q4 Gov-capable cache on `redisOss`; Q5 PremiumV2 (answered 2026-10-29). Do not re-ask.
> ASSUMPTION: waves WA..WG keep their historic letters; file names use `apim-W<letter>-...` so they cannot collide with apigw `apigw-Wnn`.
> ASSUMPTION: "WB2 blocked" means spend control deployed to GCC-High, since authoring was measured accepted but runtime enforcement was not.
Unresolved: #4458 determination; whether the GCC-High stand-down will be lifted for WD/WB2 receipts (operator action).

## Kickoff prompt
```
Read PRPs/active/apim-ai-gateway/PRP.md (hub) then REFERENCE.md. Pick the first wave in the table whose Blocked-by are all merged.
Open that wave file and follow its Kickoff prompt. You take the single bicep slot: check open bicep PRs first.
Never run local az against Gov; Gov = GitHub Actions. Report "merged, not deployed" until a deploy job executed steps.
Proof for the hub: python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root E:/Repos/_prp-audit exits 0.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W00 | todo | feat/apim-w00 | sonnet | apigw W0 #5188 covers part | 2026-11-14 |
| WA | todo | feat/apim-wa | sonnet | | 2026-11-14 |
| WB1 | todo | feat/apim-wb1 | sonnet | | 2026-11-14 |
| WC | todo | feat/apim-wc | sonnet | | 2026-11-14 |
| WD | todo | feat/apim-wd | sonnet | | 2026-11-14 |
| WB2 | blocked | feat/apim-wb2 | sonnet | waits WD + #4460 | 2026-11-14 |
| WE | todo | feat/apim-we | sonnet | | 2026-11-14 |
| WF | todo | feat/apim-wf | sonnet | | 2026-11-14 |
| WG | todo | feat/apim-wg | sonnet | | 2026-11-14 |
