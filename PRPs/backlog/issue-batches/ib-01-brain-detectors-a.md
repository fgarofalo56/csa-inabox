---
name: ib-01-brain-detectors-a
status: backlog
priority: P2
order: 101
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [3963, 3964, 3967, 3970, 4016]
branch: fix/ib-01-brain-detectors-a
---

# PRP: ib-01 Brain detector guard-strength, verify-and-close (batch A)

## Goal
Five open Loom Brain guard-strength issues (#3963, #3964, #3967, #3970, #4016) were filed against PRs that have since landed fixes. Main already carries most of each suggested fix. For each issue, re-run the mutation the issue measured against a sandbox copy, close what is genuinely witnessed, and fix only the residual that still survives. Done is a RED-under-mutation receipt per issue, not a merge.

## Why
These issues have no owner. Their bodies describe a pre-fix tree, so closing or working them from the title would repeat the earlier mistake of trusting an unverified grouping. Measured on main (ea1a38d72 lineage) while writing this PRP:
- #3967: `AZURE_NODE_ID_PREFIX` is exported from `lib/brain/graph/node-id.ts` and consumed by `agents/critic.ts` and `agents/correlator.ts`.
- #3964: a dispositions ledger and a `describe(... (#3964))` block exist in `__tests__/detectors/contract.test.ts`.
- #3970: `.github/workflows/brain-security.yml` runs `run-arms.mjs`; c6/c7/c8 specs carry a `POPULATION (#3970)` block.
- #4016: `app/api/admin/brain/history/route.ts` returns 409 `incomplete_collection` when `collection.stats.complete` is false.
- #3963: a `#3963 PRODUCTION CARDINALITY` block exists in `__tests__/graph/contract.test.ts`, but residual items A-F in the issue body were not located (purity guard respellings, extension filter, optional `describe`, `byProvenance` doc, phantom-source edge, test typecheck).

> ASSUMPTION: the residual list for #3963 (A-F) is still live; the implementer measures each before editing and records "already closed" where it is.

## Scope / Non-goals
In scope: verification mutations for all five issues; residual fixes in the owned files below; closing-ready evidence.
Non-goals: the "no detector has ever judged a real node" adapter noted at the end of #3970 (separate design, needs a graph-to-SecurityNodeKind adapter; deferred); ownership (#4255), scan restore (#4721), Gov parity (#3937), all owned by `PRPs/backlog/loom-brain/`; any change under `apps/fiab-console/lib/brain/run/**` or `app/admin/brain/**`.
Cloud scope: test and server-route logic only; no cloud-specific behaviour. Commercial and Gov behave identically; no boundary receipt applies beyond the console roll.

## Acceptance criteria
Per issue. Each names the input that turns it red.
- [ ] #3963 production cardinality: with `graph.ts` mutated so dangling edges count as inbound reachability only when `edges > 500`, `pnpm --dir apps/fiab-console vitest run lib/brain/__tests__/graph/contract.test.ts` is RED (fixture is about 2.4k nodes / 9.4k edges). Residual A: the purity guard in `__tests__/detectors/purity.test.ts` flags each of `import { writeFileSync } from 'fs'`, `import https from 'https'`, `await import('node:fs')`, `require('@azure/identity')`; a respelling that is not flagged fails this item.
- [ ] #3964 cleared-branch bypass: mutating `detectors/always-on-unused.ts` to `if (observed.length !== 0 || graph.nodes.length > 20) continue;` turns `__tests__/detectors/contract.test.ts` RED; same for `config-drift.ts` (`graph.edges.length > 50`). A mutation that stays green is a defect to fix, not to document.
- [ ] #3967 prefix drift: replacing `AZURE_NODE_ID_PREFIX` use in `agents/critic.ts` `azureSubjects()` with `'azur:'` turns `__tests__/agents/critic.test.ts` or `__tests__/agents/mutation.test.ts` RED. An empty Azure-subject population must be `indeterminate`, not a pass.
- [ ] #3970 population: for each of c6, c7, c8 the spec asserts `population.judged` equals `population.candidates` for its own class; a skip injected inside the predicate must turn the spec RED (arm `hollow-*` for each in `__tests__/security/mutation/mutations.mjs`). The workflow check: `grep -c run-arms .github/workflows/brain-security.yml` is at least 1.
- [ ] #4016 incomplete pull: a POST with `collection.stats.complete === false` returns HTTP 409 and calls `captureGraphVersion` zero times; deleting the `if (!collection.stats.complete)` branch turns `lib/brain/history/__tests__/route-authz.test.ts` or a new route spec RED. Deployed check: the live `/api/admin/brain/history` POST on a forced-incomplete pull stores no version.

## Read first
- `apps/fiab-console/lib/brain/__tests__/graph/contract.test.ts` (symbol: the `#3963` describe)
- `apps/fiab-console/lib/brain/__tests__/detectors/contract.test.ts` (`#3964` describe), `__tests__/detectors/purity.test.ts`
- `apps/fiab-console/lib/brain/agents/critic.ts` (`azureSubjects`, `checkOwnership`), `graph/node-id.ts`
- `apps/fiab-console/lib/brain/__tests__/security/mutation/{mutations.mjs,run-arms.mjs}`
- `apps/fiab-console/app/api/admin/brain/history/route.ts`, `lib/brain/history/capture.ts`
- `.claude/rules/assertion-design.md`

## Owns
- `apps/fiab-console/lib/brain/__tests__/graph/contract.test.ts`
- `apps/fiab-console/lib/brain/__tests__/graph/graph.test.ts`
- `apps/fiab-console/lib/brain/__tests__/detectors/contract.test.ts`
- `apps/fiab-console/lib/brain/__tests__/detectors/purity.test.ts`
- `apps/fiab-console/lib/brain/__tests__/agents/critic.test.ts`
- `apps/fiab-console/lib/brain/__tests__/agents/mutation.test.ts`
- `apps/fiab-console/lib/brain/__tests__/security/c6-credential-unbounded-sink.test.ts`
- `apps/fiab-console/lib/brain/__tests__/security/c7-synthesized-principal.test.ts`
- `apps/fiab-console/lib/brain/__tests__/security/c8-human-executed-command.test.ts`
- `apps/fiab-console/lib/brain/__tests__/security/mutation/mutations.mjs`
- `apps/fiab-console/lib/brain/history/__tests__/route-authz.test.ts`
- `apps/fiab-console/lib/brain/graph/graph.ts` (only residual E, phantom-source edges)
- `apps/fiab-console/lib/brain/cost/attribute.ts` (only residual C, optional `describe`)

## Must NOT touch
- `apps/fiab-console/lib/brain/run/**`, `apps/fiab-console/app/admin/brain/**`, `apps/fiab-console/lib/brain-actions/**`, `.github/workflows/loom-brain-scan.yml` (owned by `PRPs/backlog/loom-brain/`)
- `apps/fiab-console/lib/brain/security/extract/**`, `scripts/brain/**` and `security-graph.json` (owned by `ib-02-brain-detectors-b`)
- `apps/fiab-console/app/api/admin/brain/history/route.ts` unless a mutation survives; if so this PRP may edit it and says so in the PR.

## Consumes
- `PRPs/backlog/loom-brain/PRP.md` boundaries (file ownership only; no dependency).

## Provides
- A recorded verdict per issue (witnessed / fixed / residual) so the operator can close after deploy verification.

## Steps
1. Create a sandbox copy (`E:/Repos/_ib-01` worktree, then a scratch copy under `temp/`) and run each issue's named mutation there. Never mutate the tracked tree and revert; prove the tracked tree untouched with `git status --porcelain`.
2. Record RED or GREEN per mutation in the PR body table (issue, mutation, RC, executed test count).
3. Where GREEN, add the missing assertion, re-run the mutation, confirm RED.
4. Fix residuals A-F of #3963 that still hold; skip any already closed and say so.
5. Do not touch `security-graph.json`. If `--check` goes red, hand to ib-02.

## Validation
- `pnpm --dir apps/fiab-console vitest run lib/brain` (all brain specs green; read the executed count, not just RC)
- `node apps/fiab-console/lib/brain/__tests__/security/mutation/run-arms.mjs` (run serially, never beside another job in the same checkout)
- `make validate-typescript`
- Merged is not done: the history route change (if any) is "merged, not deployed" until the console is rolled and a forced-incomplete pull is shown to store nothing. Test-only changes need no roll.
- Clouds: logic is cloud-neutral; Commercial deploy receipt only if the route changes, Gov inherits on its next roll (supported-in-code; GCC never exercised).

## Rollback
Revert the PR; all changes are tests plus at most two small source edits.

## Docs to update
`docs/fiab/brain/graph-history.md` only if the history route behaviour changes.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-01-brain-detectors-a · Worktree: E:/Repos/_ib-01

## Hot files
None of the registry hot files. `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #3963 | todo | | sonnet | | |
| #3964 | todo | | sonnet | | |
| #3967 | todo | | sonnet | | |
| #3970 | todo | | sonnet | | |
| #4016 | todo | | sonnet | | |

Deferred candidates: #4029 and #4807 (required-check and roll-gate decisions, branch protection is operator-held, see ib-02 note); #4504, #4522, #4557, #4806, #4819, #4411 (security-graph extractor, `ib-02-brain-detectors-b` or deferred there).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-01-brain-detectors-a.md and .claude/rules/assertion-design.md. Work in a fresh worktree E:/Repos/_ib-01 on branch fix/ib-01-brain-detectors-a. For each of the five issues, run its named mutation on a sandbox copy first and record RED or GREEN; only add assertions or fix source where a mutation survives. Never touch scripts/brain, security-graph.json or lib/brain/run. Proof of done: `pnpm --dir apps/fiab-console vitest run lib/brain` plus the run-arms.mjs output, with the RC table in the PR body. Do not close issues; the operator closes after deploy verification.
