# CSA Loom Autopilot — Crash Resume Runbook

The autonomous Loom program (audit → build → integrate → release → closeout) is
**crash-resilient**. If the terminal/computer/session dies, nothing is lost and
it resumes from where it left off. Three layers of durability:

1. **GitHub = the authoritative ledger** (survives total disk loss):
   - Open/merged PRs encode the work. `gh pr list --state open` = remaining.
   - The pinned **"CSA Loom Autopilot Ledger"** issue records the current phase +
     wave + checklist. Find it: `gh issue list --label autopilot --state open`.
2. **Local fast-resume state**: `.claude/loom-autopilot.json` (phase/wave/backlog
   pointer) + `.claude/loom-autopilot.heartbeat` (unix ts, refreshed by working
   agents — proves a run is alive).
3. **Durable cron watchdog** (`.claude/scheduled_tasks.json`, survives restart):
   fires on idle, checks liveness, resumes the right phase. See
   [[csa_loom_unleash_watchdog]] memory.

## Liveness guard (why it won't double-run anymore)

A run is **ALIVE** if ANY of: `loom-autopilot.heartbeat` < 20 min old, OR
`origin/main` last commit < 25 min, OR any open `csa-loom` PR `updatedAt` < 25 min.
Only when ALL are stale does the watchdog treat the run as dead and resume.
(Today's bug: the old guard used only main-advance, so a 30-min conflict
resolution looked dead and a competing integrator was spawned. Fixed.)

## Manual resume (if no watchdog / fresh clone)

```bash
cd /e/Repos/GitHub/csa-inabox && git fetch -q origin
cat .claude/loom-autopilot.json                      # phase + wave
gh issue list --label autopilot --state open         # the ledger issue
gh pr list --state open --search "csa-loom"          # remaining feature PRs
```

Then, by phase:
- **audit**: re-run `Workflow({name:'loom-audit-asks'})` → `docs/fiab/prp/AUDIT-2026-06-10.md`.
- **build(wave N)**: `Workflow({name:'loom-unleash', args:{files:[...AUDIT wave N files...]}})`.
- **integrate**: `Workflow({name:'loom-integrate-open-prs'})` (auto-discovers open PRs).
- **release**: merge the open `release-please` PR (`--squash --admin`; if 12-checks
  block it, run `gh workflow run release-please.yml` to re-post statuses).
- **closeout**: deploy roll + `csa-loom-validate.yml` + live UAT.

Always check liveness FIRST; never start a second integrator while one is alive.
Update `.claude/loom-autopilot.json` + the ledger issue at each phase boundary.
