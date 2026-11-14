---
name: estate-power-receipts
status: backlog
priority: P1
order: 1
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4876, 4243, 4235]
---

# PRP (hub): Estate Power, verification-first (supersedes finish-2026-10 PRP-02)

Source: `PRPs/backlog/finish-2026-10/PRP-02-estate-power.md` (untracked, primary checkout only). That PRP described building Pause/Resume; the
building is now merged. What is owed is live evidence and the Gov resume path, so this program is verification-first with four lanes:

| Lane | PRP | Wave |
|---|---|---|
| A Commercial receipts-only run | [estate-power-A-commercial-receipts](estate-power-A-commercial-receipts.md) | 1 |
| B Gov resume path (#4235) | [estate-power-B-gov-resume-path](estate-power-B-gov-resume-path.md) | 2 |
| C Pause-aware consumer lanes | [estate-power-C-pause-aware-consumers](estate-power-C-pause-aware-consumers.md) | 2 |
| D Console panel G1 | [estate-power-D-console-panel](estate-power-D-console-panel.md) | 3 |

TRACKING ISSUES: #4876 (umbrella), #4243, #4235 (all OPEN on 2026-11-14); per-lane issues to be created by orchestrator.

## Goal
For Commercial and GCC-High, an Actions-run receipt of Pause (every resource read back stopped) then Resume (every resource read back running, console healthy), plus one unattended idle auto-pause firing, and lanes that stand down on a declared pause. #4243, #4235 and #4876 close only on those receipts.

## Why
Measured 2026-11-14: code present and merged (PRs #5100, #5104, #5109 pause types and discovery; #5112 wake guard; #5113/#5114 deploy stand-down; #5024 `RESUME_FAILED -> RUNNING` fix; #5026 console-side pipeline activity; #4970 image P0). Partial Commercial receipts exist: issue #4876 comments of 2026-10-19/20 (Actions pause/resume succeeded; idle auto-pause fired by `workflow_dispatch` with ARM readback) and #5111 (closed 2026-10-25, stand-down receipt). Not shown: an unattended cron firing, GCC-High anything, per-consumer stand-down beyond Commercial, and a G1 panel walk. GCC-High was BLOCKED on a Gov Entra grant (2026-10-19); the GCC-High repo vars were set 2026-10-22, current status UNVERIFIED. `scripts/ci/estate-pause-declaration.json` still claims Gov has no resume path. Merged is not done (`deploy-integrity.md` R2).

## Scope / Non-goals
In: running, recording and, where a defect appears, fixing. Out: new pausable types, deleting anything, IL5/GCC exercise (supported-in-code only: `deploy-fiab-il5.yml` has no recorded run; GCC has never exercised a deploy step), Gov what-if (BLIND while Gov ADX is Stopped, #5123), any cost-saving policy change.

## Acceptance criteria
- Lane A receipt file exists with every readback cell filled; the idle receipt cites a `schedule`-event run. Fails if the cited run is a `workflow_dispatch`.
- Lane B ends with a GCC-High pause+resume receipt or a recorded `blocked(owner)`; the declaration no longer says "no pause/resume path". Fails if the string `no pause/resume path` remains.
- Lane C table covers every workflow in `grep -l estate-pause-gate .github/workflows/*.yml`; any deploy job that ran steps while standdown=true fails the lane.
- Lane D parity doc has zero missing rows and a G1 walk record exists.
- `gh issue view 4876 4243 4235` states are CLOSED only after the above, never on merge.

## Read first
`.github/workflows/estate-power.yml`, `estate-idle-autopause.yml`, `estate-pause-gate.yml`; `apps/fiab-console/lib/estate/{estate-power-handlers,pause-actuator,pause-resume,pause-inventory,pause-container-apps,estate-autopause}.ts`;
`scripts/estate-power/*.mjs`; `scripts/ci/estate-pause-declaration.json`; `docs/fiab/parity/estate-power.md`; `.claude/rules/deploy-integrity.md`, `cloud-parity.md`.

## Owns
This directory. Product files are owned per lane (disjoint: A docs, B declaration + gov receipt, C consumer workflow gate lines + wiring test, D panel + parity doc).

## Must NOT touch
`PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`; `lib/estate/pause-*.ts` backend (defects become issues); anything that deletes a resource.

## Consumes
Operator decisions 2026-10-01 (pause everything that can stop without data loss; Commercial + GCC-High; Gov actions via GitHub Actions with the deploy identity, never a workstation; auto-pause after N idle hours, default 2). Deploy SP with `Estate.Power` role. Repo vars `CSA_LOOM_CONSOLE_URL/AUDIENCE`, `CSA_LOOM_GCCH_CONSOLE_URL/AUDIENCE`.

## Provides
Closing evidence for #4876/#4243/#4235; a receipt template reused per boundary; a true per-cloud status line in `docs/fiab/parity/estate-power.md`.

## Steps
1. Lane A (serial, holds the Commercial estate). 2. Lanes B and C in parallel (B holds GCC-High, C reuses A's Commercial paused window), disjoint files. 3. Lane D after A (reuses the live window).
Live estate operations are serialized across lanes. ASSUMPTION: receipt files live under `docs/fiab/receipts/` (no such dir exists; orchestrator may relocate).

## Validation
- `node --test scripts/estate-power/__tests__/*.test.mjs scripts/ci/__tests__/estate-pause-state.test.mjs scripts/ci/__tests__/estate-standdown-wiring.test.mjs scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs scripts/ci/__tests__/estate-preflight.test.mjs`
- `cd apps/fiab-console && pnpm exec vitest run lib/estate lib/components/admin-scaling app/api/admin/estate`
- `cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json`
- Live: `gh workflow run estate-power.yml -f boundary=<Commercial|GCC-High> -f action=<state|preview|pause|resume> -f confirm=<estate id> -f dry_run=false` (dry_run defaults to true; pause needs `confirm`); `gh run list --workflow estate-idle-autopause.yml --event schedule --limit 30`.
- Receipts per boundary named: Commercial (exercised), GCC-High (exercised estate; Estate.Power status to be verified), IL5 and GCC (not exercised; wiring only). Gov via Actions only.
- Rule: code on main is "merged"; only a receipt makes it "verified live".

## Rollback
Everything here is non-destructive: roll back by `estate-power.yml action=resume` to the declared state (or `pause` if the declared state was paused). Nothing is deleted. If the console reports `RESUME_FAILED` (every state read 500s on a build predating #5024), use the unstick recipe below, not repeated resume attempts.

**Unstick recipe (RESUME_FAILED, from the 2026-10-19 incident, #5024):** (1) read the real state of each resource via ARM (`az ... show`), never Resource Graph; (2) find the resource that disagrees with the stored state (the 10-19 cause was AAS paused out-of-band in the portal) and make the poll agree by re-suspending it; (3) dispatch `estate-power.yml action=resume dry_run=false` so the state goes RESUMING then RUNNING. Pause through the console, never the portal. A Resume cannot be triggered from a workstation. Full text: auto-memory note `csa_loom_cost_and_estate_power_findings_2026_10_19`.

Other traps: ARM reports billing state wrongly (read `billingProperty/default` per subscription); manual Commercial/GCC-High deploy dispatches need `allow_existing_hub=true` even for `run_mode=whatif-only`; the gate's `azure/login` can hang to the 10-minute timeout; the DLZ activity log needs `--max-events 5000`.

## Docs to update
`docs/fiab/parity/estate-power.md` (per-cloud status), new receipts under `docs/fiab/receipts/`. Retire `PRPs/backlog/finish-2026-10/PRP-02-estate-power.md` once this program is accepted (it is local-only and untracked; do not commit that folder, the repo is public).

## Wave / Blocked-by / Branch / Worktree
Wave: hub · Blocked-by: none (A needs an operator-quiet Commercial console for the idle window; B needs the Gov approval environment, held by the operator) · Branch: per lane · Worktree: `E:/Repos/_estate-{a,b,c,d}`

## Hot files
`scripts/ci/estate-pause-declaration.json` (B only), deploy workflows' gate lines (C only), `estate-power-panel.tsx` (D only). touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/estate-power-receipts/PRP.md, then estate-power-A-commercial-receipts.md and .github/workflows/estate-power.yml.
Run the Commercial Pause, Resume and a scheduled idle auto-pause through Actions only, reading every resource back via ARM, and write docs/fiab/receipts/estate-power-commercial.md.
Do not delete anything and finish with the estate in its declared state. Proof of done: every readback cell filled and the idle receipt cites a schedule-event run.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| Code: pause types, discovery, wake guard, stand-down, RESUME_FAILED fix | merged | n/a | sonnet | PRs #5100 #5104 #5109 #5112 #5113 #5114 #5024 #5026 | 2026-11-14 |
| Commercial pause/resume + idle autopause (dispatch) | merged | n/a | sonnet | issue #4876 comments 2026-10-19/20 (partial) | 2026-11-14 |
| A Commercial receipts | todo | chore/estate-power-a-commercial-receipts | sonnet | unattended cron firing not shown | 2026-11-14 |
| B Gov resume path | todo | feat/estate-power-b-gov-resume | sonnet | GCC-High status unverified; #4235 open | 2026-11-14 |
| C Pause-aware consumers | todo | chore/estate-power-c-consumers | sonnet | wiring merged #5113/#5114, live only Commercial | 2026-11-14 |
| D Console panel G1 | todo | chore/estate-power-d-panel-g1 | sonnet | none | 2026-11-14 |
