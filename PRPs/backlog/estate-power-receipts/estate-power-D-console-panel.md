---
name: estate-power-D-console-panel
status: backlog
priority: P2
order: 3
depends_on: [estate-power-A-commercial-receipts]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4876, 4243]
branch: chore/estate-power-d-panel-g1
---
# Lane D: console Estate Power panel G1 walk and parity doc

Program: [estate-power-receipts](PRP.md) · TRACKING ISSUES: #4876 (umbrella), #4243, #4235 (all OPEN, 2026-11-14). New per-lane issues: to be created by orchestrator.

## Goal
Verify the console Estate Power panel end to end in a real browser on Commercial (and GCC-High if lane B shows it reachable), and bring `docs/fiab/parity/estate-power.md` to zero missing rows.

## Why
The panel exists (`apps/fiab-console/lib/components/admin-scaling/estate-power-panel.tsx` plus always-on, autopause and container-apps sections, and routes under `app/api/admin/estate/*` and `app/api/estate/*`) with unit tests, but `ux-baseline.md` G1 says tsc and vitest are not completion evidence. #4243 (Pause errored live) is the operator-reported failure the panel must now survive.

## Scope / Non-goals
G1 click-walk with real data, narrow-width badge pass, first-open pass, dark and light screenshots; fix defects found in the panel and its tests. Non-goals: new pause types; workflow edits.

## Acceptance criteria
Each names the value or output that would make it fail.
- Click-walk record lists every panel control (Pause, Resume, auto-pause setting, always-on disclosure, container-apps section, progress rows) with the observed backend call and result; fails if any control has no recorded effect.
- A Pause from the panel results in per-resource progress rows that reach `Paused/Stopped` and the panel shows `PAUSED` only after readback (a UI that shows `PAUSED` while ARM shows Online fails); then Resume returns `RUNNING`.
- On `RESUME_FAILED` state the panel still renders Resume (regression for #5024: the page must not 500).
- Narrow-width pass: no badge or row overlap at 360 px; first open of the panel on a never-paused estate shows no red banner.
- Parity doc `docs/fiab/parity/estate-power.md` shows zero rows marked missing.

## Read first
- `apps/fiab-console/lib/components/admin-scaling/estate-power-panel.tsx`, `estate-power-poll.ts`
- `apps/fiab-console/lib/estate/estate-power-handlers.ts`, `estate-console.tsx`
- `docs/fiab/parity/estate-power.md`
- `docs/fiab/ux-standards.md` section 7

## Owns
- `apps/fiab-console/lib/components/admin-scaling/estate-*.tsx` and `estate-power-poll.ts` and their tests under `lib/components/admin-scaling/__tests__/`
- `docs/fiab/parity/estate-power.md`
- `docs/fiab/receipts/estate-power-panel.md` (new, ASSUMPTION: path; screenshots referenced, not embedded)

## Must NOT touch
Any file outside Owns. No resource deletion, ever (operator decision 2026-10-01: nothing is deleted). Never pause/resume from a workstation: estate actions run through `estate-power.yml` / `estate-idle-autopause.yml` as the deploy SP. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. Do not bypass image preflight, supply-chain gates, pause declarations or registry leases. `lib/estate/pause-*.ts` backend (defects found there become issues, not edits in this lane). Browser automation was blocked once by another Chrome extension overlay (reads work, clicks fail): if that recurs ask the operator to click and record it.

## Consumes
Lane A estate window (shared live Commercial estate; serialized). Live-estate operations are SERIALIZED across all lanes of this program (one estate action at a time per boundary). Before any resume/pause: read `/build-marker.txt` for the live SHA, run `estate-power.yml action=state`, and dispatch manual Commercial or GCC-High deploy workflows only with `allow_existing_hub=true` (even `run_mode=whatif-only`).

## Provides
G1 receipt for the panel; a true parity doc.

## Steps
1. Open the panel on Commercial in a headed browser; first-open pass.
2. Walk every control against the live estate while lane A holds the window (do not pause twice).
3. Capture screenshots dark and light; narrow-width pass.
4. Fix panel defects with tests; update the parity doc.

## Validation
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/components/admin-scaling lib/estate`
- Sandbox mutation: make the panel render `PAUSED` on the POST response instead of the readback; the polling test must go RED (name the test).
- Browser walk receipt per `ux-baseline.md` G1 with screenshots in the PR.
- Rule: a panel fix merged is "merged, not deployed" until the console is rolled and re-walked.

## Rollback
Revert the panel PR. The live estate is returned to its declared state by Resume (lane A procedure).

## Docs to update
`docs/fiab/parity/estate-power.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: A · Branch: chore/estate-power-d-panel-g1 · Worktree: E:/Repos/_estate-d

## Hot files
`estate-power-panel.tsx` sole owner. touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/estate-power-receipts/PRP.md and estate-power-D-console-panel.md, then estate-power-panel.tsx and docs/fiab/parity/estate-power.md. Click-walk every control on the live Commercial console (coordinate the estate window with lane A), including first-open and narrow width. Done = walk record with screenshots, tsc + vitest for lib/components/admin-scaling pass, parity doc has zero missing rows.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| estate-power-D-console-panel | todo | chore/estate-power-d-panel-g1 | sonnet | none yet | 2026-11-14 |
