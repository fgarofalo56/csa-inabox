---
name: estate-power-C-pause-aware-consumers
status: backlog
priority: P2
order: 2
depends_on: [estate-power-A-commercial-receipts]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4876]
branch: chore/estate-power-c-consumers
---
# Lane C: pause-aware consumer lanes, verified

Program: [estate-power-receipts](PRP.md) · TRACKING ISSUES: #4876 (umbrella), #4243, #4235 (all OPEN, 2026-11-14). Program tracker: #5298 (created 2026-11-14).

## Goal
Show, per consumer workflow and per boundary, that a declared or detected pause makes the lane stand down visibly (skipped at 0 deploy steps) and that an unreadable state fails closed on schedule.

## Why
Incident 2026-10-24: a scheduled deploy rewrote paused Container Apps (min 0 -> 1). PRs #5113 and #5114 (merged) added `.github/workflows/estate-pause-gate.yml` and wired it into `deploy-fiab-commercial`, `deploy-fiab-gcc`, `deploy-fiab-gcch`, `deploy-fiab-il5`, `deploy-health`, `full-app-deploy-commercial`, `loom-dataplane-roll` (grep 2026-11-14). The Commercial stand-down was observed live (#5111 receipt). Not shown: the other consumers, and Gov. GCC and IL5 are supported-in-code never exercised: their stand-down is wiring-verified only.

## Scope / Non-goals
Verify each consumer by a read-only dispatch (`run_mode=whatif-only` where offered) while the estate is paused; fix gaps in the gate wiring only. Non-goals: new consumers beyond the list found by grep; Gov what-if (blind while Gov ADX Stopped, #5123).

## Acceptance criteria
Each names the value or output that would make it fail.
- A table in the receipt lists every workflow found by `grep -l estate-pause-gate .github/workflows/*.yml` with its observed result while paused: deploy job `skipped` with `steps=0` for standdown=true. Fails if any listed deploy job executed a step.
- `node --test scripts/ci/__tests__/estate-standdown-wiring.test.mjs` passes and covers every consumer in the grep list; it fails if a consumer workflow is added without the gate (prove by sandbox copy removing the `needs: estate-gate` from one named workflow).
- Scheduled-path fail-closed: with the state endpoint unreadable (dry test via the gate script `scripts/ci/estate-pause-state.mjs` against an invalid URL) the scheduled expression yields standdown, while a dispatch proceeds; the test names both outcomes.
- Any consumer found ungated is listed with a fix PR number or an issue; none is silently skipped.

## Read first
- `.github/workflows/estate-pause-gate.yml` (outputs state, standdown, paused_by, paused_at; the one expression for callers)
- `scripts/ci/estate-pause-state.mjs`, `scripts/ci/_estate-pause-declaration.mjs`
- `scripts/ci/__tests__/estate-standdown-wiring.test.mjs`
- `scripts/ci/estate-pause-declaration.json`

## Owns
- `.github/workflows/{deploy-fiab-commercial,deploy-fiab-gcc,deploy-fiab-gcch,deploy-fiab-il5,deploy-health,full-app-deploy-commercial,loom-dataplane-roll}.yml` (gate wiring lines only, if a gap is found)
- `scripts/ci/__tests__/estate-standdown-wiring.test.mjs`
- `docs/fiab/receipts/estate-power-consumers.md` (new, ASSUMPTION: path)

## Must NOT touch
Any file outside Owns. No resource deletion, ever (operator decision 2026-10-01: nothing is deleted). Never pause/resume from a workstation: estate actions run through `estate-power.yml` / `estate-idle-autopause.yml` as the deploy SP. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. Do not bypass image preflight, supply-chain gates, pause declarations or registry leases. `estate-power.yml`, `estate-idle-autopause.yml` (lane A/B). No change to deploy logic beyond the gate condition.

## Consumes
Lane A (a paused Commercial estate window); the operator for a Gov approval. Live-estate operations are SERIALIZED across all lanes of this program (one estate action at a time per boundary). Before any resume/pause: read `/build-marker.txt` for the live SHA, run `estate-power.yml action=state`, and dispatch manual Commercial or GCC-High deploy workflows only with `allow_existing_hub=true` (even `run_mode=whatif-only`).

## Provides
Per-consumer stand-down evidence; the receipt closes the "lanes honour pause" step of the original PRP-02.

## Steps
1. List consumers by grep; diff against the table in the receipt.
2. Pause Commercial (coordinate with lane A: reuse its paused window, do not pause twice).
3. Dispatch each Commercial consumer with its read-only mode (`allow_existing_hub=true` required) and record the jobs API result (job conclusion + step count).
4. GCC-High: same for `deploy-fiab-gcch.yml run_mode=whatif-only allow_existing_hub=true` only when the estate is paused and an approver is available.
5. GCC and IL5: record `supported-in-code, never exercised` and cite the wiring test.
6. Fix any gap; resume the estate; record.

## Validation
- `node --test scripts/ci/__tests__/estate-standdown-wiring.test.mjs scripts/ci/__tests__/estate-pause-state.test.mjs`
- `gh run view <id> --json jobs --jq '.jobs[] | "\(.name) | \(.conclusion) | steps=\(.steps|length)"'` for each dispatched consumer (the value that fails: a deploy job `success` with steps > 0 while standdown=true).
- Positive control first: the same query on a non-paused window shows the deploy job running (otherwise a skipped job proves nothing).
- Rule: wiring merged in PRs #5113/#5114 is "merged"; this lane supplies the live evidence.

## Rollback
Resume the estate (`estate-power.yml action=resume`). If a wiring fix PR misbehaves, revert it; the gate is additive.

## Docs to update
`docs/fiab/receipts/estate-power-consumers.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: estate-power-A-commercial-receipts · Branch: chore/estate-power-c-consumers · Worktree: E:/Repos/_estate-c

## Hot files
Deploy workflows listed under Owns (gate lines only); `deploy-fiab-gcch.yml` shared with other programs: coordinate if open PRs touch it. touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/estate-power-receipts/PRP.md and estate-power-C-pause-aware-consumers.md, then .github/workflows/estate-pause-gate.yml. With the Commercial estate paused (coordinate with lane A), dispatch each consumer read-only and record job conclusion + step count; positive control first. Done = every consumer row filled and estate-standdown-wiring tests green.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| estate-power-C-pause-aware-consumers | todo | chore/estate-power-c-consumers | sonnet | none yet | 2026-11-14 |
