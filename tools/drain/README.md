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

If `--status` exits 2 saying **NO LEDGER**, the queue was never seeded or the
file was deleted — `python tools/drain/tick.py --bootstrap`. It is deliberately
not the same answer as an empty queue.

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
  1 GUARD      sanity-check the read  ->  refuse a wrong-repo or truncated list
  2 REFRESH    re-read live GitHub    ->  new issues appear; departed ones go to
                                          `needs-audit`, NEVER to `closed`
  3 REAP       --reap                 ->  return stranded in-flight lanes to ready
  4 SELECT     next lane set          ->  stream order, file-disjoint, WIP-capped
  5 EMIT       briefs + this runbook  ->  self-contained, regenerated every cycle

  agents run the briefs -> results go back into the ledger -> tick.py again
```

Every pass is independent. There is no state between passes.

**Step 1 is not ceremony.** `gh issue list` resolves the repository from the
working directory unless `--repo` is passed, so running the harness from another
checkout returns rc=0 and a large, plausible, entirely **disjoint** issue list —
which used to move every item out of the queue in one atomic save. The repo is
now a policy input, and the guard refuses a live set that does not overlap the
ledger (wrong repo) or that is a fraction of it (a truncated read).

**An issue that left GitHub does not get a receipt.** The cycle does not know
what closed it, so it does not get to say: the item lands in `needs-audit`,
which is **non-terminal**, and stays in the queue until something names what
closed it. Inventing a receipt to get past the receipt gate is the gate
defeating itself.

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
| `closed` | done | a receipt **of the kind its class requires**. `ledger.transition()` refuses any other |
| `parked` | genuinely blocked | a named **blocker AND owner**. Refused without both |
| `declined` | will not do | a recorded decision |

`deploy-integrity.md` R2 is enforced in code: **merged is never done.** "The PR
landed" is the single most common way a backlog lies about itself, so the ledger
will not let you say it.

**Presence is not enough — the KIND is checked.** The first version of this
module tested that a receipt was truthy, which closed a console surface on the
literal string `"merged"`: the one word R2 says is never a receipt. An item's
class comes from its stream (`W1-deploy` → `deploy-path`, `W4-receipts` →
`estate-behaviour`, …), the console lane overrides to `ui-surface`, and an
explicit `receipt_class` reaches `human-only`. `ci-green` does not close a UI
surface, and it does not close a deploy-path item either.

A park with no owner is indistinguishable from forgetting — that is how an item
leaves the queue without leaving the backlog.

`needs-audit` is the fifth state and is **non-terminal**: an item that left
GitHub with no receipt, or a terminal item seen open again (someone reopened it,
which is how a false close gets disputed). `drained()` is false while any exist.

**An empty ledger is NOT drained.** `all([])` is `True`, so without an emptiness
clause a fresh clone or a deleted scratch file reports the whole backlog drained
before any work is done — and `drained: true` is this program's documented exit
condition. `--status` now refuses outright when no ledger file exists, because
"no queue" and "an empty queue" are different answers.

---

## Receipts

| kind | closes | how it is obtained |
|---|---|---|
| `ci-green` | guard/test-only | every required context green at the merged sha, and none of them SKIPPED |
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

**What `ci-green` does NOT prove, stated rather than implied.**
`statusCheckRollup` publishes no per-check population — its entries carry
`__typename, completedAt, conclusion, detailsUrl, name, startedAt, status,
workflowName` and nothing else (measured). So a check that concluded SUCCESS
over **zero items** — the #4451 shape — is *not visible* to this gate. It
detects a required context that concluded SKIPPED, and says so in those words.
Detecting green-over-nothing needs a population source this API does not have,
and is an owed capability, not a claim.

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
refused, so adding a capability is a deliberate edit to `policy.json`. Matching
is EXACT — `merge-without-review` is not a prefix of a permission.

**How to write a verdict that registers — POSITION, not idiom.**

> The verdict is announced on the comment's **FIRST non-empty line**, at indent
> zero, and that line **begins with** `Independent review` or
> `Independent re-review` (heading marks and emphasis are stripped first).

That is the whole rule for granting an approval, and it is deliberately strict.
It replaced three rounds of "a marker line that is not *«the idioms I have
thought of»*" — first a blockquote, then fences / four-space indents /
`<details>` / HTML comments, then a **tab** indent and a nested fence delimiter
that flipped the state machine back to prose. Every one of those manufactured a
live APPROVE from a comment that said *do not merge*. Re-implementing a Markdown
block parser over a 200-character prefix is the wrong shape for a control this
load-bearing: each version is one idiom away from being wrong, and the failure
is silent. Position cannot be forged by formatting.

**The two directions are NOT symmetric.** Formatting may refuse to *grant* an
approval; it must never *reduce* a block. A blocking token anywhere in the
window — quoted, fenced, indented, collapsed — blocks, even with no announcing
line. Once citations became merely advisory, a reviewer who pasted a failing log
in a fence, forgot to close it, then wrote their header had their block silently
demoted to advisory. An unclosed fence is an ordinary typo.

Within the announcing line the tokens are read worst-first, so a hedged header
resolves to the block. Anything that *mentions* a verdict without announcing one
is reported as a near-miss — `cited-not-decided` for a relay, `not-the-first-line`
for a misplaced header — so it is visible rather than absent. Writing the
contract down is part of the fix: a silently-dropped verdict is the incident that
cost three rounds.

**The authority is checked against the code, mechanically.** Ten keys under
`merge_gate` and four under `verdict_parsing` were once read by no code at all —
including two that duplicated hardcoded constants, so editing the authority
changed nothing, and one (`require_hollow_check_clean`) that asserted a
capability the GitHub API cannot support. `gates.assert_policy_matches_code()`
now fails in BOTH directions: a key with no implementation, and an
implementation the policy does not declare. A dropped gate leaves a `_removed_*`
entry saying why, so nobody re-adds it from the PRP.

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

**Run the gate; do not re-derive it.** `merge_gate.py` is the caller that
composes all seven of PRP §6 from live GitHub data:

```bash
python tools/drain/merge_gate.py <PR>            # GO / NO-GO with the evidence
python tools/drain/merge_gate.py --audit-close <PR> --before <n> --intended <n,n>
```

Promoting `gates.py` out of `temp/` was necessary and not sufficient: at its
first review it had **no production caller**, four of the seven gates were named
in the spec and implemented nowhere, and five `policy.json` keys were read by
nothing. The briefs restated the gates as prose, so at run time GO/NO-GO was
still an agent's judgement. An unconsulted policy key is prose, not a control.

```bash
python -m pytest tools/drain/__tests__ -q    # 204 tests across every module
python tools/drain/mutate_gates.py           # 82 arms, must be 82 KILLED
```

If the mutation run reports a **survivor**, the suite has a blind spot and the
gate is not trustworthy — fix that before trusting a merge. Two caveats learned
the hard way:

- **A survivor can also mean a weak mutation.** One arm here "removed" three
  regex branches while leaving them in place; it survived because it changed
  nothing. Read the arm before believing the blind spot.
- **Authors mutate what they just fixed.** The first six arms all weakened a
  *check*. An independent reviewer wrote eight more and **six survived**, because
  the ones that work narrow the *population* instead — parse only the newest
  comment, scan only the last commit, scan only the first line, exempt fenced
  code, take a `startswith` fast path. A filter placed INSIDE the predicate beats
  a contract written about the predicate. Those are arms `N*`.

The harness mutates a **copy in a temp dir outside the repo**. It used to write
the mutation into the tracked `gates.py` and restore it in a `finally` — which
does not run on SIGKILL, on a host that memory-kills processes, in a checkout up
to four lanes share.

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

- **`gh` with no `--repo` resolves from the working directory.** It returns
  rc=0 and valid JSON for whatever repo you happen to be standing in. Every
  `gh` call the harness makes pins `--repo` from `policy.json` and `cwd` to the
  repo root.
- **Deleting `state.json` erases every receipt, silently.** The next refresh
  reseeds the same issues as `ready` with empty histories — the recorded
  237-item reset. Absence of a row is not absence of a verdict. `--status`
  refuses on a missing file rather than reporting an empty queue.
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
| `policy.json` | the autonomy contract — the authority, and the repo it governs |
| `ledger.py` | durable state; enforces receipt-of-the-right-KIND-before-close |
| `gates.py` | the seven gates (promoted, tracked, tested) |
| `merge_gate.py` | **the caller** — runs all seven against a live PR, prints GO/NO-GO |
| `tick.py` | one cycle |
| `build_inventory.py` | regenerates the workstream inventory; refuses a lossy partition |
| `mutate_gates.py` | 82 mutation arms against a sandbox copy; must be 82 KILLED |
| `state.json` | the ledger itself (gitignored — per-run state, not a control) |
| `__tests__/` | 204 tests; a negative control for every decision function |

Spec and the measured inventory: `PRPs/active/zero-backlog/`.
