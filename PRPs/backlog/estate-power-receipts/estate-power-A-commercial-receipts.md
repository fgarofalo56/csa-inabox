---
name: estate-power-A-commercial-receipts
status: backlog
priority: P1
order: 1
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4876, 4243]
branch: chore/estate-power-a-commercial-receipts
---
# Lane A: Commercial receipts-only run

Program: [estate-power-receipts](PRP.md) · TRACKING ISSUES: #4876 (umbrella), #4243, #4235 (all OPEN, 2026-11-14). Program tracker: #5298 (created 2026-11-14).

## Goal
Produce one dated, complete Commercial receipt set (Pause with per-resource readback, Resume with readback and a healthy console, and one UNATTENDED idle auto-pause cron firing) against current main, and record it as the closing evidence for the Commercial half of #4876/#4243.

## Why
Partial receipts exist (issue #4876 comments 2026-10-19/20: pause/resume via Actions, an idle auto-pause fired by workflow_dispatch; #5111 closed 2026-10-25 with a stand-down receipt). Still missing per those comments: an unattended cron-fired auto-pause and a Resume leg after that same pause. The code is merged (PRs #5100, #5104, #5109, #5112, #5024, #5026); merged is not done (`deploy-integrity.md` R2). No code is written in this lane.

## Scope / Non-goals
Run and record. Commercial only. Non-goals: any code change; GCC-High (lane B); consumer lanes (C); UI walk (D). If a run exposes a defect, stop, file an issue, and hand the fix to a separate item.

## Acceptance criteria
Each names the value or output that would make it fail.
- Receipt file `docs/fiab/receipts/estate-power-commercial.md` (ASSUMPTION: new path; no receipts dir was found) lists, for the Pause leg, each resource in the pause set with its ARM readback state (`Paused`/`Stopped`/min replicas 0). Fails if any resource row lacks an independent ARM read (not Resource Graph, which can read stale Online).
- Resume leg: every resource is back at its recorded prior state (Container Apps min replicas equal the pre-pause value, named in the receipt) and `/api/admin/estate/state` reports `RUNNING`; fails if any app is at min 0 or the state is `RESUME_FAILED`/`RESUMING`.
- Idle auto-pause receipt is a `schedule` event run of `estate-idle-autopause.yml` (not workflow_dispatch) whose summary says `PAUSE (idle)`; fails if the cited run `event` is `workflow_dispatch`.
- The receipt states the live SHA from `/build-marker.txt` and `git log --oneline <live>..origin/main | wc -l`; fails if the live estate is behind a merge that changes `lib/estate/*` and that is not named.
- The estate is returned to its declared state (running or paused per the operator) and read back.

## Read first
- `.github/workflows/estate-power.yml` (inputs: boundary, action state|preview|pause|resume, confirm, dry_run default true)
- `.github/workflows/estate-idle-autopause.yml`
- `scripts/estate-power/estate-power.mjs`, `autopause.mjs`, `idle-policy.mjs`
- `apps/fiab-console/lib/estate/estate-power-handlers.ts`, `pause-actuator.ts`, `pause-resume.ts`
- Issue #4876 comments (receipt style)
- `docs/fiab/parity/estate-power.md`

## Owns
- `docs/fiab/receipts/estate-power-commercial.md` (new)
- issue comments on #4876/#4243 (orchestrator posts; implementer drafts)

## Must NOT touch
Any file outside Owns. No resource deletion, ever (operator decision 2026-10-01: nothing is deleted). Never pause/resume from a workstation: estate actions run through `estate-power.yml` / `estate-idle-autopause.yml` as the deploy SP. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. Do not bypass image preflight, supply-chain gates, pause declarations or registry leases. No console code, no workflow edits.

## Consumes
Live Commercial estate; deploy SP with Estate.Power role; repo vars `CSA_LOOM_CONSOLE_URL`, `CSA_LOOM_CONSOLE_AUDIENCE` (both set 2026-10-19).

## Provides
The Commercial receipt set that lets #4876/#4243 close for Commercial; the template lane B reuses for GCC-High.

## Steps
1. Read live SHA and `action=state`; confirm state is `RUNNING` (if `RESUME_FAILED`, use the unstick recipe in the hub before anything else).
2. `estate-power.yml` boundary=Commercial action=preview; record the pause set and the estate id to type as `confirm`.
3. Dispatch `action=pause dry_run=false confirm=<estate id>`; capture the CLI `VERIFIED` line; independently read each resource via `az` (explicit subscription) and record.
4. Dispatch `action=resume dry_run=false`; capture readback; confirm console healthy (GET `/api/admin/estate/state` and a signed-in page load).
5. Idle auto-pause: leave the console untouched for the configured idle window (`idleHours`, default 2); locate the next `schedule` run of `estate-idle-autopause.yml` that decides PAUSE; read back; resume.
6. Write the receipt file; hand the draft to the orchestrator to post on the issues.

## Validation
- `gh workflow run estate-power.yml -f boundary=Commercial -f action=state` then `gh run watch <id>`; the job summary prints `state=RUNNING` (value that would fail it: any other state).
- `gh run list --workflow estate-idle-autopause.yml --event schedule --limit 20 --json conclusion,createdAt,displayTitle` and open the summary of the firing run (cite run number in the receipt; the population is all scheduled runs in the window, not the last page).
- ARM readbacks via `az synapse sql pool show`, `az kusto cluster show`, `az containerapp show` per resource (not `az graph`; Resource Graph read `loompool` Online while ARM said Paused).
- After the run: `gh issue view 4876 --json state` stays OPEN until lane B also holds (Commercial-only receipts do not close a program whose scope is Commercial + GCC-High).
- Rule: report as "receipts recorded" only after the file exists with every cell filled; code is already "merged"; this lane makes it "verified live" for Commercial.

## Rollback
Resume to the declared state: `estate-power.yml action=resume dry_run=false`. If the state is `RESUME_FAILED` do not retry blindly: follow the unstick recipe (hub). The lane never deletes anything, so rollback is Resume (or Pause if the declared state was paused).

## Docs to update
`docs/fiab/receipts/estate-power-commercial.md`; update `docs/fiab/parity/estate-power.md` status line only if it contradicts the receipt.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: none · Branch: chore/estate-power-a-commercial-receipts · Worktree: E:/Repos/_estate-a

## Hot files
None (docs only). touches_bicep: no. Live-estate lock: this lane holds the Commercial estate while running.

## Kickoff prompt
Read PRPs/backlog/estate-power-receipts/PRP.md and estate-power-A-commercial-receipts.md, then .github/workflows/estate-power.yml. Run state, preview, pause, resume and one scheduled idle auto-pause on Commercial through Actions only, reading each resource back via ARM. Write docs/fiab/receipts/estate-power-commercial.md. Done = every readback cell filled and the idle receipt cites a schedule-event run.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| estate-power-A-commercial-receipts | todo | chore/estate-power-a-commercial-receipts | sonnet | none yet | 2026-11-14 |
