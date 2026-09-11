# The drain harness — cold-start runbook

You are reading this because a session is picking up a 297-issue backlog with no
memory of how it got here. **That is the design.** Everything the harness knows
lives in `state.json` next to this file; nothing important is in anyone's
context.

Start here and ignore the rest until you need it:

```bash
python tools/drain/tick.py --status     # what is the queue holding right now?
python tools/drain/tick.py              # advance one cycle, then launch what it prints
```

---

## What this replaces

An operator asking an agent to "keep going" across a backlog, where the agent
holds the plan in its head. That fails two ways: the context fills and the plan
is summarized into vagueness, or the session dies and the plan dies with it.

Here **the plan is a file**, one cycle is one **transaction** against it, and a
dead session costs at most the cycle that was in flight.

---

## The loop

```
tick.py                              ledger (state.json)
  1 APPLY      last cycle's results   ->  items change bucket
  2 REFRESH    re-read live GitHub    ->  new issues appear, departed ones close
  3 RECONCILE  park what shipped      ->  reopen anything auto-closed w/o a receipt
  4 SELECT     next lane set          ->  stream order, file-disjoint, WIP-capped
  5 EMIT       briefs + this runbook  ->  self-contained, regenerated every cycle

  agents run the briefs -> results go back into the ledger -> tick.py again
```

Every pass is independent. There is no state between passes.

---

## Context rotation — the contract

The failure this prevents: an agent carries the plan, context fills, the plan is
summarized into vagueness, and the run degrades without anyone noticing.

- The **ledger is the only durable state**.
- Briefs are **generated from it every cycle**, never carried forward. A brief
  restates its own traps, gates and acceptance, so an agent never needs the
  previous transcript.
- Prose that matters goes into **the issue or the PR**, where the next reader
  is — not into a handoff document.
- Agent output returns as **structured results**, not narrative.

---

## Terminal states — and why `closed` is hard to reach

| state | means | requires |
|---|---|---|
| `closed` | done | a **receipt**. `ledger.transition()` REFUSES to close without one |
| `parked` | genuinely blocked | a named **blocker AND owner**. Refused without both |
| `declined` | will not do | a recorded decision |

`deploy-integrity.md` R2 is enforced in code: **merged is never done.** "The PR
landed" is the single most common way a backlog lies about itself, so the ledger
will not let you say it.

A park with no owner is indistinguishable from forgetting — that is how an item
leaves the queue without leaving the backlog.

---

## Receipts

| kind | closes | how it is obtained |
|---|---|---|
| `ci-green` | guard/test-only | required contexts green **and** hollow-check clean at the merged sha |
| `deploy-run` | deploy-path | a run whose deploy job **executed steps** against a live subscription |
| `estate` | estate behaviour | live `build-marker.txt` carries the merged sha, plus the asserted behaviour |
| `g1-browser` | any UI surface | Playwright walk on the live console: screenshot + an assertion **unreachable from an error path** |
| `operator` | genuinely human | parked with an exact click-script |

**The G1 trap, recorded because it already happened.** An assertion advertised
as "requires a real answer" was satisfied by `Error: HTTP 500`, because the pane
fills its streaming placeholder with the error text on any non-ok response. The
corrected assertion keyed on `copilot-agent-badge`, a testid set *only* by an SSE
`agent` step — unreachable from an error path. **Every `g1-browser` receipt must
name why its assertion cannot be satisfied by a failure.**

---

## Autonomy

`policy.json` is the authority — not this table, and not habit.

**Unattended:** open PRs/issues · merge on gate **GO** · close on a receipt ·
re-run and **approve parked CI** · dispatch deploys and rolls against the live
estate · Playwright walks on the live console.

**Stop and ask:** publishing a security advisory · anything moving live ACR
`:latest`/`:v0.1` tags · data/schema deletion · force-push to a shared branch ·
weakening or baselining a guard · `.trivyignore` additions · any skip valve.

`gates.action_is_permitted()` **fails closed**: an action in neither list is
refused, so adding a capability is a deliberate edit to `policy.json`.

---

## Gates, and why they are tracked

`gates.py` was promoted out of gitignored `temp/` (#4468). The tooling that
decided GO/NO-GO for every merge used to exist in one machine's scratch
directory: one `rm -rf` and it was gone with no history, and no reviewer could
read it. Every "merged on gate GO" claim was a claim about a program nobody
could audit.

Every gate ships with a **negative control**. A gate never observed failing is
not known to watch anything — #4451 is the standing example: `pass=4 fail=4`
printed "UAT-verified roll", four separate measurements, no observed input for
which it returned anything else.

```bash
python -m pytest tools/drain/__tests__/test_gates.py -q   # 25 tests
python temp/mutate-gates.py                               # 6 arms, must be 6 KILLED
```

If the mutation run reports a **survivor**, the suite has a blind spot and the
gate is not trustworthy — fix that before trusting a merge.

---

## Triage gates the parallelism

At open: **118 of 297** issues carried no lane and **153** no size.

Lanes partition by **FILE**. A shared-file conflict must serialize, never
parallelize — so an unlaned item is not merely unsized, it is *unsafe to
schedule alongside anything*. `select_cycle()` will not pick one.

That is why `tick.py` prints a triage queue and why `W9-rest` runs continuously
alongside every other stream. If a cycle reports **NOTHING SCHEDULABLE**, the
answer is triage, not a bigger WIP cap.

---

## Traps that cost real time — do not rediscover these

- **Clear a conflict BEFORE pushing.** A commit pushed while the PR reads
  CONFLICTING gets **zero check-runs, permanently** — GitHub cannot compute
  `refs/pull/N/merge`, and clearing it afterwards does not create them
  retroactively. `total_count == 0` is the discriminator; it is NOT the parked
  run case, and `--admin`-ing past it ships code CI never saw.
- **`closingIssuesReferences` is not a complete oracle.** It read empty while a
  squash commit carrying `fixed: #4361` closed that issue. Scan **body and
  commit trail**, and audit the open-issue count before/after every merge.
- **Never `python - <<'EOF'`.** If the heredoc misses stdin it becomes an
  interactive REPL and, with `2>` to a file, grows it without bound — one
  reached **65 GB** while stdout stayed empty. Write scripts to files.
- **Never walk `temp/`.** `du -sh temp` does not time out, it gets **killed**.
  Use `shutil.disk_usage`.
- **The host is memory-committed before you start** — `vmmemWSL` ~48 GB and
  `llama-server` ~18 GB were measured. A kill usually says something about the
  host, not about what the killed command was doing. `wip.max_lanes` is a policy
  input; lower it before blaming a command.
- **Never `npm ci` from a worktree** — it empties MAIN's `node_modules`. Copy
  `typescript` in if a worktree needs it; never junction.
- **`.git/index.lock` goes stale constantly.** Prove it unheld by RENAMING it
  (Windows refuses to rename a held file), never blind-delete.

---

## Files

| file | what |
|---|---|
| `policy.json` | the autonomy contract — the authority |
| `ledger.py` | durable state; enforces receipt-before-close |
| `gates.py` | merge/verdict/closing-keyword gates (promoted, tracked, tested) |
| `tick.py` | one cycle |
| `build_inventory.py` | regenerates the workstream inventory; refuses a lossy partition |
| `state.json` | the ledger itself |
| `__tests__/` | unit tests + a negative control per gate |

Spec and the measured inventory: `PRPs/active/zero-backlog/`.
