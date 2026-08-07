# FINISHLINE session notes

## Session 1 — 2026-08-06/07 (initializer → Wave 0/1/2 → Actions incident → merge queue)

### What is merged to main

| PR | What |
|---|---|
| #3050 | ledger seed (39 AUDIT rows → PIV tasks) |
| #3045 | release 0.88.1 (standing approval) |
| #3059 | Wave-0 ledger update |
| **#3055** | **D9 — loom-uat CVE-2025-68121 root fix** (vite ^7; unblocks `full-app-deploy-commercial`, measured at 13 consecutive failures / 47 days undeployed) |
| **#3054** | **D1 — risingwave probe caps + netns port-seal scoping** (app Running live for the first time ever) |

`#3072` is release-please 0.88.2, cut from the above.

### THE INCIDENT (shaped most of this session)

GitHub "Incident with Actions", opened 15:22Z. Its 20:34Z update is the load-bearing
detail: **webhooks throttled to ~15%**, so pushes and PRs often never created runs
at all. Separately the Actions **API surface was load-shed** (`actions/runs` 403,
run-cancel 502) while PR/GraphQL APIs worked. Recovery began ~23:13Z.

**Do not mistake absent checks for passing checks.** Nine PRs had ZERO check runs;
they were repaired by close+reopen. If a future incident throttles webhooks, that
re-trigger is mandatory.

**Blockers removed by the orchestrator:**
- **Disabled 3 permanently-failing workflows** — `copilot-auto-fix.yml`,
  `csa-loom-spark-livy-probe.yml`, `csa-loom-spark-probe2.yml`. Invalid YAML means
  GitHub records a failed run on EVERY push (it must parse each file to decide
  triggering) — 24 today. **#3061 fixes all three; re-enable with
  `gh workflow enable <file>` once it lands.** All three are dispatch/label-gated,
  so no scheduled monitoring was lost. `copilot-auto-fix` has NEVER executed, so its
  5-layer defense-in-depth is untested — watch its first labelled run.
  `csa-loom-spark-probe2.yml` differs from the livy probe by ONE line (`name:`) →
  retire candidate (OP-16).
- Cancelled 4 non-essential queued runs to free constrained capacity.

### EVERY post-recovery CI failure was a real guard catching a real gap

None flaky, none incident debris:
- **route-toolkit** boy-scout ratchet ×4 — #3064/#3051 cleared with mutation-verified
  TOUCH_EXEMPT; #3062 MIGRATED cleanly; #3068 handed back.
- **deploy-paths-coverage** (#3067) — `full-app-deploy-commercial` now deploys from
  the new mirror manifest but its WATCHED entry doesn't watch those paths. A mirror
  change could go undeployed unnoticed. *This program's target class.*
- **file-size monolith-creep** (#3069) — real split requested, not an allowlist entry.
- **vitest failure-taxonomy** (#3058) — the new `capacity` retryable class trips a
  deliberation gate. Extend the exhaustive set WITH justification; never soften
  deep-equal to `.includes()`.
- **deploy-template-sync** (#3054/#3052/#3057) — compiled ARM artifact not
  regenerated, caught AFTER reviewers passed those PRs.

### C22 — found by mutation, then INDEPENDENTLY CORROBORATED

While justifying a TOUCH_EXEMPT I claimed `check-route-guards` protected the
workspaces route. It does not: its remit is authorization on routes taking an `[id]`
from the URL, so on a **collection** route you can delete the 401 entirely and it
stays GREEN. The D10 agent reproduced this independently (auth removed → contract
test 5/5 red, route-guards 0 violations across 1424 routes). **Admin/collection
routes have no CI control on their 401/403.** Task C22.

### Evals-gate circularity (governs merge order)

"Run + gate Copilot quality evals" is a required check firing on docs/PRPs/content
changes. It is legitimately RED until **#3053 (E1 judge)** and **#3069 (E2 surfaces)**
land — and it currently blocks **#3057, #3061, #3065, #3066, #3070**. So:

**MERGE ORDER: #3053 → #3069 → everything else.**

### Open PRs (13)

3053 E1 · 3057 D2 · 3058 D4-D6 · 3061 D13 · 3062 D10 · 3064+3065 C7 · 3066 C1 ·
3067 D14 · 3068 C3 · 3069 E2-E4 · 3070 P2-DOCS · 3071 C14 · 3073 C19 · 3072 release

### Owed after the queue drains

1. `full-app-deploy-commercial` dispatch (D9's V4 — closes #3024/#3036).
2. **C13 first**: `loom-ui-verify` has been red since 2026-08-04, so EVERY V3 receipt
   in this program is blocked. Anything closed on a G1 basis since 08-04 lacks its
   stated evidence.
3. An admin-plane deploy (C3's bicep half, D14's s3-gateway default-ON, D2's console
   `LOOM_UNITY_*` wiring).
4. Re-enable the 3 disabled workflows once #3061 lands.

### Operator queue — 19 items in `state.json.operator_queue`

Highest leverage: **OP-13** (attended D4-D6 proving deploy, with the #3056
token-overwrite watch) · **OP-1** (#2643 Gov unity auth still DISABLED live) ·
**OP-19** (disable the 2 enabled Function timers duplicating live ACA crons — cheap
double-execution mitigation; plus 7 Function Apps billing while executing nothing) ·
**OP-6/#2330** (Gov SP UAA grant) · **OP-18** (#2970 must be re-titled — its stated
hypothesis is falsified) · **OP-16** (3 D13 decisions).

### Hazards confirmed this session

Never `git stash`. Every agent in its OWN worktree. `git show <ref>:<path>` needs
`MSYS_NO_PATHCONV=1`. `json.load` needs `encoding='utf-8'`. Junctions: `cmd //c mklink`
is mangled — use PowerShell `New-Item -ItemType Junction`. Direct push to main is
rule-blocked. Never run a `--family=` codemod (scope creep); use `--file=`.
`--admin` ONLY to drain strict BEHIND-staleness on a PR whose own checks are green.
