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

**How a receipt actually gets recorded, and the gap in it.** `record_receipt()`
and `transition(CLOSED)` have **no production caller**. `tick.py` writes only
what a refresh writes; `merge_gate.py` only *reads*, through `receipt_ok()`.
Recording a receipt today is a hand edit to `state.json` — which is gitignored —
or a call from a lane's own script. Nothing in this file used to say that, and
it is the operational gap behind the whole "a stale ledger evaluates against a
weaker class" family: the write path is outside the instrumented code.

That is also why the R2 check is an **invariant**, not an event observer.
`record_receipt` stamps the class the receipt was taken under, and
`_refuse_unless_receipted` compares it at the decision. It therefore does not
care *how* the class moved, or whether anything watched it move — including the
two routes `upsert` structurally cannot see, since `RECEIPT_CLASS_BY_STREAM` and
`LANE_RECEIPT_CLASS` are module constants rather than fields. A reviewer closed
a `ui-surface` item on a `ci-green` that had been refused moments earlier, by
editing one line of a map.

`receipt_class` likewise has no production writer, so the `human-only` class is
currently reachable only by hand. Stated here rather than implied, because by
this package's own standard an unreachable path is prose.

**If you hand-edit a receipt, set `receipt_taken_under` too.** A ledger written
before that field existed — or a hand edit that sets `receipt_kind` and
`receipt_ref` and stops — produces an item that **cannot close**, with its own
message naming the remedy. That is deliberate and it is not backfilled on load:
inferring the stamp from the item's *current* class would manufacture the exact
evidence the check exists to demand, which is "invent a receipt to get past the
receipt gate" wearing a migration's clothes. Re-take the receipt (or set the
field by hand to the item's `effective_receipt_class`). Nothing is stuck today —
the live ledger holds zero receipts — and `tick.py --status` will show any item
this affects as non-terminal rather than silently closable.

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

**Fails closed is not a figure of speech.** `resume-estate` and `pause-estate`
were absent until 2026-09-12, so the check refused them — which made every
`deploy-run` receipt unreachable, and W1 is the stream R1 says preempts
everything. A capability the operator has granted and the file does not list is
a capability the harness does not have.

**Independent review: one reviewer, escalating.** W0 took eight posted rounds with two
reviewers because it *was* the merge gate; at ~296 issues that is not the
default. `gates.review_requirement()` returns 2 on **four** independent
triggers, and it is worth reading all four because the two obvious ones account
for the smaller share of the live population:

1. **The first verdict blocks** — REQUEST-CHANGES or CANNOT-ASSESS, matched by
   shape, so a spelling cannot reduce a block. This asks about the review's
   HISTORY and deliberately does not pin to the head: after a push the earlier
   block is correctly no longer *live*, but it is still true that the first
   reviewer blocked, and that is what raises the count.
2. **The item's STREAM is listed** — W0/W1/W2/W3/W5/W6/W7. A lane is a guess
   about the footprint; a stream is a fact about the work, and a relabel
   decouples the two.
3. **The diff touches a listed PATH** — twelve fragments in `policy.json`, read
   from the file, not hardcoded. Guards, deploy, bicep, both front-ends, and the
   files that decide the rules themselves: `.gitignore`, `CODEOWNERS`,
   `Makefile`, `pyproject.toml`.
4. **The footprint or the stream could not be resolved** — both **fail closed**.
   At brief time the stream is a fact and the paths are a guess (every unlaned
   item — **119** of the live 299 carry no lane); at merge time the paths are a
   fact and the stream has to come from the ledger via the issues the PR
   references.

   **A mention may only escalate; a declared close may also explain.** `Closes
   #N` is an assertion about what the PR *is*, and gate 6 refuses it unless it
   is also declared with `--allow-close`, so it is corroborated. `Refs #N` is an
   aside: enough to raise the count when it names an escalating item, not enough
   to lower it. Without that split, referencing a stale issue number bought a
   *weaker* gate than referencing nothing at all — measured, one reviewer versus
   two, on the same diff. Both reviewers found it independently, in the feature
   that had just been added.

   From a worktree the ledger is resolved against the primary checkout via
   git's common dir, because `state.json` is gitignored and exists in exactly
   one of this machine's 371 worktrees. Without that fallback the stream never
   resolved anywhere a lane actually works, and *every* PR escalated.

Listed in the order `review_requirement` checks them, which is also roughly
their strength. They are independent ORs, so the order has no effect on the
answer — but the doc reads as a walkthrough of the function and should not
disagree with it.

Measured over the live 299: **279 escalate**. The stream drivers are W5-console
84, W1-deploy 26, W6-ci 22, W2-security 20, W7-bicep 18, W0-harness 4; then 100
items attributed to *footprint not known* (that is the count remaining AFTER the
stream trigger takes precedence, not the 119 unlaned — quote which population
you mean), then 3 console-path and 2 bicep-path. Most of it is W9-rest, the
triage stream, which is not schedulable until laned anyway. See
`_operating_point` in `policy.json` for the arithmetic and the standing
instruction to re-measure after triage rather than tune the list on a
pre-triage snapshot.

Every brief states its own requirement rather than leaving the lane to infer
it, and **`merge_gate` gate 3b re-decides on real evidence and can raise the
count as well as confirm it** — the real changed files, the first posted
verdict, and the stream resolved from the ledger. For three rounds it passed
only the path set, so two of the four triggers were live in `gates.py`,
described in the brief, and enforced by nothing: a `csa_platform/security/`
diff on a W2-security item and an `azure-functions/` diff on a W1-deploy item
both returned GO on one approval. An unconsulted *argument* is the same defect
as an unconsulted policy key.

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
approval; it must never *reduce* a block. **In a comment whose first line
announces no verdict**, a blocking token anywhere in the window — quoted,
fenced, indented, collapsed — blocks. Once citations became merely advisory, a
reviewer who pasted a failing log in a fence, forgot to close it, then wrote
their header had their block silently demoted to advisory. An unclosed fence is
an ordinary typo.

The qualifier is load-bearing and is stated because the unqualified sentence was
wrong: when the first line **does** announce a token, that verdict decides and
the rest of the comment is not re-scanned. Without that, a reviewer approving
with the words *"nothing that warrants REQUEST-CHANGES"* would block their own
approval — the round-2 defect, rebuilt.

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
composes PRP §6's gates from live GitHub data:

```bash
python tools/drain/merge_gate.py <PR>            # GO / NO-GO with the evidence
python tools/drain/merge_gate.py --audit-close <PR> --before <n> --intended <n,n>
```

Promoting `gates.py` out of `temp/` was necessary and not sufficient: at its
first review it had **no production caller**, four of them were named
in the spec and implemented nowhere, and five `policy.json` keys were read by
nothing. The briefs restated the gates as prose, so at run time GO/NO-GO was
still an agent's judgement. An unconsulted policy key is prose, not a control.

```bash
python -m pytest tools/drain/__tests__ -q    # 300 tests across every module
python tools/drain/mutate_gates.py           # 155 arms, must be 155 KILLED
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

At open: **118 of 297** issues carried no lane and **153** no size. Re-measured
2026-09-12 over 299: **119** carry no lane. Two different populations a week
apart — say which one a number is over, every time. (The `_operating_point`
figure of *100* is a third thing again: the count still attributed to
"footprint not known" **after** the stream trigger has already taken those
items, not the unlaned total.)

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
| `gates.py` | the merge gates (promoted, tracked, tested) |
| `merge_gate.py` | **the caller** — runs them all against a live PR, prints GO/NO-GO |
| `tick.py` | one cycle |
| `build_inventory.py` | regenerates the workstream inventory; refuses a lossy partition |
| `mutate_gates.py` | 155 mutation arms against a sandbox copy; must be 155 KILLED |
| `state.json` | the ledger itself (gitignored — per-run state, not a control) |
| `__tests__/` | 300 tests; a negative control for every decision function |

Spec and the measured inventory: `PRPs/active/zero-backlog/`.
