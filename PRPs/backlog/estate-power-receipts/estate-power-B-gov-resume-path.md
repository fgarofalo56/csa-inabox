---
name: estate-power-B-gov-resume-path
status: backlog
priority: P1
order: 2
depends_on: [estate-power-A-commercial-receipts]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4235, 4876, 4243]
branch: feat/estate-power-b-gov-resume
---
# Lane B: GCC-High (Gov) resume path and receipt (#4235)

Program: [estate-power-receipts](PRP.md) · TRACKING ISSUES: #4876 (umbrella), #4243, #4235 (all OPEN, 2026-11-14). Program tracker: #5298 (created 2026-11-14).

## Goal
Prove that the GCC-High estate can be paused and resumed through GitHub Actions with the same readback discipline as Commercial, and retire the stale statement that Gov has no resume path.

## Why
#4235: `scripts/measure/estate-resume.mjs` hard-coded the Commercial estate; the guard `scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs` (#4149) now refuses cross-cloud mutation, and `estate-power.yml` offers a GCC-High boundary option. But the 2026-10-19 status said GCC-High was BLOCKED on a Gov Entra grant (bootstrap could not create the app role), and `scripts/ci/estate-pause-declaration.json` (GCC-High entry) still says "Gov still has no pause/resume path". The GCC-High repo vars `CSA_LOOM_GCCH_CONSOLE_URL/AUDIENCE` were set 2026-10-22, which suggests the blocker moved; that is UNVERIFIED. GCC-High is an exercised estate; IL5 and GCC are not part of this scope (supported-in-code only).

## Scope / Non-goals
Verify first whether the Estate.Power role exists in the Gov tenant app registration and a `state` dispatch authenticates; only then pause/resume. Fix `estate-pause-declaration.json` TO RESUME text and any code defect found. Non-goals: IL5/GCC exercise, new pause types.

## Acceptance criteria
Each names the value or output that would make it fail.
- `estate-power.yml boundary=GCC-High action=state` (via Actions, after the approval gate) prints a real `state=` value; fails with exit 3 (cloud mismatch) or a 401/403 if the Estate.Power app role or console audience is wrong; either outcome is recorded by name.
- Pause then Resume on GCC-High each end with the CLI `VERIFIED` line and independent per-resource readbacks (Gov `az` run inside an Actions job); fails if any resource row lacks a readback.
- `scripts/ci/estate-pause-declaration.json` GCC-High TO RESUME text names `estate-power.yml` as the resume path; `node --test scripts/ci/__tests__/estate-preflight.test.mjs scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs` passes. Fails if the text still contains `no pause/resume path`.
- If the Gov Entra grant is still missing, the lane ends `blocked(owner: Gov tenant Entra administrator)` with the exact missing role (Application Administrator, or Graph Application.ReadWrite.All + AppRoleAssignment.ReadWrite.All with consent); it does not claim a receipt.

## Read first
- `.github/workflows/estate-power.yml` (GCC-High branch, approval environment)
- `.github/workflows/csa-loom-post-deploy-bootstrap.yml` steps `ensure-estate-power-role`, `set-console-repo-vars` and `scripts/ci/ensure-estate-power-role.mjs`
- `scripts/ci/estate-pause-declaration.json`
- `scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs`
- `scripts/measure/estate-resume.mjs`
- Issue #4235 and the #4876 GCC-High status comment

## Owns
- `scripts/ci/estate-pause-declaration.json` (GCC-High TO RESUME text only, plus `renewedOn` if the entry is renewed with a fresh read)
- `scripts/measure/estate-resume.mjs` ONLY if a defect is found (sandbox-prove first)
- `docs/fiab/receipts/estate-power-gcch.md` (new, ASSUMPTION: path)

## Must NOT touch
Any file outside Owns. No resource deletion, ever (operator decision 2026-10-01: nothing is deleted). Never pause/resume from a workstation: estate actions run through `estate-power.yml` / `estate-idle-autopause.yml` as the deploy SP. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. Do not bypass image preflight, supply-chain gates, pause declarations or registry leases. No change to Commercial lanes; deploy-fiab-gcch.yml edits belong to lane C.

## Consumes
Lane A receipt template; Gov deploy SP; the manual-approval environment (operator-held approver). Live-estate operations are SERIALIZED across all lanes of this program (one estate action at a time per boundary). Before any resume/pause: read `/build-marker.txt` for the live SHA, run `estate-power.yml action=state`, and dispatch manual Commercial or GCC-High deploy workflows only with `allow_existing_hub=true` (even `run_mode=whatif-only`).

## Provides
A GCC-High pause/resume receipt (or a precise blocker). Closes the Gov half of #4235, #4243, #4876.

## Steps
1. Dispatch `estate-power.yml boundary=GCC-High action=state dry_run=true`; classify the result (auth, role, audience, ok).
2. If auth/role fails: re-run `csa-loom-post-deploy-bootstrap.yml` for GCC-High to observe whether `Provision MSAL app registration` and `ensure-estate-power-role` pass; if they still fail with Insufficient privileges, stop and record `blocked(owner)`.
3. If state works: `action=preview`, then `pause` with `confirm`, then `resume`, reading each resource back in an Actions step (never from a workstation).
4. Update the declaration text and run the node tests.
5. Write the receipt; return the estate to the declared state (the declaration says GCC-High was deliberately held stopped; keep it so unless the operator says otherwise).

## Validation
- `gh workflow run estate-power.yml -f boundary=GCC-High -f action=state -f dry_run=true` (operator approves the environment; the approval is held by the operator, state it plainly when waiting)
- `node --test scripts/ci/__tests__/estate-preflight.test.mjs scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs scripts/ci/__tests__/estate-standdown-wiring.test.mjs`
- Sandbox-copy mutation: restore the string `no pause/resume path` in a copy of the declaration; the preflight test must go RED (name the test) and the tracked tree stays clean.
- Receipt cites the Actions run per leg; Gov what-if is BLIND while Gov ADX is Stopped (#5123): do not use what-if as evidence in this lane.
- Rule: a merged declaration edit is "merged, not deployed"; the receipt is the evidence.

## Rollback
Resume or re-pause to the declared state via `estate-power.yml` (GCC-High, approval-gated). If the console enters `RESUME_FAILED`, follow the unstick recipe in the hub. Nothing is deleted; the declaration edit reverts with the PR.

## Docs to update
`docs/fiab/parity/estate-power.md` (per-cloud status: GCC-High), `docs/fiab/receipts/estate-power-gcch.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: estate-power-A-commercial-receipts · Branch: feat/estate-power-b-gov-resume · Worktree: E:/Repos/_estate-b

## Hot files
`scripts/ci/estate-pause-declaration.json` (sole owner); touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/estate-power-receipts/PRP.md and estate-power-B-gov-resume-path.md. Gov actions run via Actions only. First dispatch estate-power.yml boundary=GCC-High action=state and classify the result before anything else; if the Entra grant is missing, stop and record the blocker. Done = a GCC-High pause+resume receipt with readbacks, or a recorded blocked(owner), plus node --test green.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| estate-power-B-gov-resume-path | todo | feat/estate-power-b-gov-resume | sonnet | none yet | 2026-11-14 |
