# CSA Loom Harness — Session Notes

## Session 0 — 2026-06-05 (manual init)

**Agent:** operator + claude (manual initialization)
**Status:** completed — harness wired, ready for autonomous run

**Completed:**
- Authored the phased PRP (`.harness/spec.md`) — 9 phases, operator-excluded #17 image-gen.
- Generated `.harness/state.json` — 22 tasks ordered by `task_order` (99 → 12).
- Wrote `.harness/config.json` — live IDs, build/test gates, merge + git-bash gotchas, BLOCKING rules.
- Pre-run hygiene: merged the session's 18 feature PRs (#691–#705); merged #660 (SHIR idle-stop) + safe dependabot patches; closed the risky major dependabot bumps (vitest 4 / eslint 10 / redis) for deliberate handling; closed stale issues #589/#587/#428/#429 (kept #655 → folded into task-016); removed ~80 archived agent-worktree dirs.

**Context for the coding agent (read `.harness/config.json` first):**
- The console is `apps/fiab-console` (Next.js, Fluent v9). Gate on `tsc --noEmit`
  (filter pre-existing makeStyles-px errors) + the required `next build (node 20)` CI check; the vitest harness is broken — do not gate on unit tests.
- Per feature: branch off fresh `origin/main` → implement → tsc → focused PR →
  `gh pr merge <n> --squash --admin` (update-branch first if BEHIND; wait for `next build`) → console auto-rolls → live-verify → update state.json + append here + commit.
- Prefix az/gh commands that take `/subscriptions/...` with `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`. Verify diagnostic settings with `az rest`, not `az monitor diagnostic-settings list --resource`.

**Next steps:**
- Coding agent picks the highest-`task_order` `todo` (task-001, Phase 0 baseline),
  implements one task per session, then continues down the ledger.
- If a task needs an operator decision (one-time grant, support-ticket gate,
  destructive action) → set status `blocked`, write the exact ask here, move on.

**Open items flagged for the operator (do not guess):**
- (none yet — the run will append blockers here as it hits them)
