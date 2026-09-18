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
  5 EMIT       per-lane briefs        ->  self-contained, regenerated every cycle
                                          (KICKOFF.md is NOT: it is hand-kept)

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
GitHub with no receipt, or a `closed`/`declined` item seen open again (someone
reopened it, which is how a false close gets disputed). `drained()` is false
while any exist.

**A park is SUPPOSED to stay open on GitHub, and the refresh leaves it alone.**
The reopen branch keys on `REOPEN_DISPUTES` — `closed` and `declined` — not on
`TERMINAL`. It used to key on all three, so every refresh demoted every park to
`needs-audit` (#2874 lasted 13 seconds) and `drained()` was unreachable for
anything genuinely blocked. `declined` is *in* that tuple by decision, not by
inheritance: "will not do" leaves nothing to track, so its disposal is `gh issue
close --reason not-planned`, and an item still open after a decline wants a
look. That demotion has a legal escape — close the issue and the decline stands.
A park has none: closing a blocked item's issue is how a backlog lies about
itself (`deploy-integrity.md` R2).

**A ledger close now REACHES GitHub, which is the precondition that branch
always assumed** (#4545). `tools/drain/` used to contain no `gh issue close` at
all, so an item the harness closed on its own evidence stayed open upstream, the
next refresh read that as a reopen, and the receipt recorded minutes earlier was
**voided**. Measured on #4535 — the first item the harness ever closed itself —
which bounced to `needs-audit` on the very next cycle, so `drained()` was
unreachable for anything the drain closed rather than inherited.

`record_receipt_from_evidence` closes the issue **before** it writes the ledger,
and the order is not arbitrary. The two writes fail independently:

| ordering | if the second write fails |
|---|---|
| **GitHub, then ledger** (what runs) | issue closed upstream, item still non-terminal here → next refresh flags it `departed` → `needs-audit`, loudly, holding **no** receipt (nothing was written) — the upstream evidence is untouched, so `--record-receipt` re-measures it and succeeds |
| ledger, then GitHub | item `closed` here, open there → **#4545 verbatim**: false reopen, receipt destroyed next cycle |

Only `CLOSES_ON_GITHUB` — `closed`, and nothing else — gets a close. A park is
blocked, not done. `declined` is deliberately out too, although it is *in*
`REOPEN_DISPUTES`: there is no unattended decline path, and its disposal carries
a `--reason not-planned` resting on a judgement no program made. The close is
idempotent (an already-closed issue is read first and left alone — which is how
#4535's hand-closed workaround is met), is gated on `close-on-receipt` in
`permitted_unattended`, and is verified **by reading the state back**, not by
`gh`'s exit code — which establishes that the issue *is* closed, but not by
whom; see the paragraph below. A close that cannot be observed raises
`IssueCloseFailedError`, nothing is written, and the item stays non-terminal.

**Reading the state back is not enough on its own, and the note says so.**
A read-back establishes a property of the *world* — the issue is closed — not an
effect of *this* invocation. If a human or a second lane closes the issue in the
window between the pre-read and the close, `gh` exits 0 having posted **nothing**
(cli/cli v2.100.0 `close.go` re-fetches at `:112` and returns at `:117-120`,
above the comment block at `:148`), and the read-back sees CLOSED because
somebody else made it so. So the returned note is keyed on `gh`'s own stderr
sentence for which of the two things it did — three outcomes, and the third is
`unknown`:

| what `gh` said | what the note reports |
|---|---|
| `Closed issue …` (`close.go:169`) | `#N closed on GitHub` — unqualified; the receipt comment was posted |
| `… is already closed` (`close.go:118`) | this run did **not** close it, and **no** receipt comment was posted (#4579) |
| neither sentence | the issue **is** closed, and this run cannot tell which of the two happened, so the comment **may not** have been posted |

The third exists so that a future `gh` rewording fails **honest** rather than
open: keying only on the already-closed sentence would let a changed string fall
through to "I closed it", which is the false claim this whole section exists to
prevent.

**Each failure says which half of the pair moved.** Three outcomes, three
messages, because the operator's next action differs:

| what failed | what it prints | the world |
|---|---|---|
| anything before the close | `RECEIPT REFUSED - NOTHING WRITTEN, ON GITHUB OR IN THE LEDGER` | both records untouched |
| the close itself | `GITHUB CLOSE NOT CONFIRMED - NOTHING WRITTEN TO THE LEDGER` | ledger untouched; the upstream state is whatever the message says. It claims neither direction: a read-back that 502s means the close **landed** and cannot be observed, and `gh issue close` also posts the comment, so even a non-zero exit does not establish that nothing happened |
| the ledger write, after the close | `LEDGER NOT WRITTEN - THE ISSUE IS CLOSED UPSTREAM`, with the exception TYPE | issue settled upstream, ledger untouched, nothing saved — **re-run the same command**, the closer short-circuits on the already-closed issue |

The third is not hypothetical: a lost CAS against another lane is the realistic
failure, because the drain runs four. It used to print `RECEIPT NOT RECORDED` —
the wording for "nothing happened" — and a ledger refusal after the same close
used to print `RECEIPT REFUSED`, the wording for "your evidence was rejected".
Both were false in the half that matters, which is the R7 defect inside the R7
fix. Everything after the close is now wrapped in `LedgerWriteAfterCloseError`,
which is also what makes "nothing was written" true in the first row: a bare
refusal can only escape from *before* the close. That claim covers the call and
**not** `main()`'s save step, which is why the save arm is bound to `Exception`
and not to `LedgerChangedError`: with the narrow bound, `os.replace` raising
`PermissionError` escaped `main()` uncaught while the issue was closed
upstream — the silent failure this whole split exists to prevent, one layer
down. **Correction (round 7):** this paragraph, and five other sites, used to
say the escape left an **empty stderr**. It does not. `tick.py` ends in
`raise SystemExit(main())`, so the exception reaches the interpreter and prints
a traceback; the emptiness was an artifact of measuring through pytest's
`capsys`. Measured as a real process against a sandbox copy carrying arm GH12:
exit 1 and **~650 bytes of traceback** naming `os.replace`, against **~520 bytes**
of the intended message unmutated. Those totals are **environment-dependent** —
they move with sandbox path length and run id, and an independent reviewer
re-measuring on a different sandbox got 647 / 579 — so read them as orders of
magnitude, not constants. What is invariant is **exit 1 either way**, which is
the whole point: what the width actually buys is the
difference between those two texts — under the narrow bound the operator gets a
file-rename traceback that never mentions the upstream close, at the *same* exit
code, so neither the status nor the message says the two records disagree. The
width is safe to claim because the save is a temp file plus an `os.replace`:
either the replace happened and nothing after it can raise, or the file is
untouched.

The third row says "settled", not "the GitHub write LANDED", because the closer
may have found the issue **already closed** and left it alone. The note it
quotes says which.

**On that already-closed route nothing is published at all**, and the note says
so rather than leaving the operator to infer it. That route issues `gh issue
view` and no other command, so no receipt comment is posted — and
`tools/drain/state.json` is untracked, which leaves the receipt existing solely
in a local gitignored file. It is not a corner: all 7 items the live ledger
currently holds as `closed` are in exactly that state, and it is the route
`close_issue_on_github` was written for (#4535 was hand-closed). The
short-circuit conflates *the harness already commented here*, where skipping is
right, with *a human closed it silently*, where no comment exists and none ever
will. Posting the receipt there too — read the comments, `gh issue comment` when
none begins `Drain harness: receipt verified` — is tracked as #4579 and is
deliberately not done here: it adds two `gh` calls, hence two new failure
routes, to the one route the whole current population takes, and that route's
seven-shape failure behaviour was independently measured clean.

**An empty ledger is NOT drained.** `all([])` is `True`, so without an emptiness
clause a fresh clone or a deleted scratch file reports the whole backlog drained
before any work is done — and `drained: true` is this program's documented exit
condition. `--status` now refuses outright when no ledger file exists, because
"no queue" and "an empty queue" are different answers.

---

## Receipts

| kind | closes | how it is obtained |
|---|---|---|
| `ci-green` | guard/test-only | every required context that **can** run at the merged sha is green and is accounted for by one of three routes — it **executed its declared substantive step**; or it skipped that step and executed a declared **alternative**, the other half of a job gated on more than one output, with the merged files outside the *primary's* scope; or it skipped that step, ran **nothing at all**, and the merged files are outside **every** scope the job gates work on. Every context that cannot run there is **named**, with its reason and its PR-head result over an identical tree. `python tools/drain/merge_gate.py --ci-green-receipt <PR>` |
| `deploy-run` | deploy-path | a run whose deploy job **executed steps** against a live subscription |
| `estate` | estate behaviour | live `build-marker.txt` carries the merged sha, plus the asserted behaviour |
| `g1-browser` | any UI surface | Playwright walk on the live console: screenshot + an assertion **unreachable from an error path** |
| `operator` | genuinely human | parked with an exact click-script |

**A run-backed receipt is bound to the issue by NOTHING, and the comment it
posts says so.** `verify_run_backed_receipt` matches the producer workflow,
`status`, `conclusion` and every declared step — and compares the run to the
item on no axis at all. `_run_evidence` does not request `createdAt`, and
`headSha` is read only to be interpolated into the ref. Measured: run
`33238747458` (`loom-roll-and-validate`, 2026-08-29, headSha `70ca3d1`) passes
every check today, and **147 of the 351 issues open on 2026-09-18 were filed
after it**. So the receipt establishes *the declared producer ran green*, not
*the estate was observed carrying this change* — the comment no longer cites
deploy-integrity R2 as **satisfied**, only as the reason the class takes a run
rather than a merge, and it discloses the time and sha gap in terms. Binding it
is #4578 (fetch the run's date, compare it to the item's, refuse a run that
predates it); the sha half waits on #4489 with the rest of the binding.

**The G1 trap, recorded because it already happened.** An assertion advertised
as "requires a real answer" was satisfied by `Error: HTTP 500`, because the pane
fills its streaming placeholder with the error text on any non-ok response. The
corrected assertion keyed on `copilot-agent-badge`, a testid set *only* by an SSE
`agent` step — unreachable from an error path. **Every `g1-browser` receipt must
name why its assertion cannot be satisfied by a failure.**

**`ci-green` was redefined because the first attempt to take it failed (#4487).**
The original text said *every required context green **at the merged sha***. That
measurement is **unobtainable for most PRs in this repo**, and nobody noticed
until the receipt was taken for the first time — on the harness's own merge,
`a02cd41e6d42`:

```
15 required contexts (branch protection)
10 green at the merged sha
 5 absent at the merged sha
 0 RED
```

None of the five is a failure or a flake. Four (`Python Lint`, `PowerShell
Lint`, `Secret Scan`, `Repo Hygiene`) come from `validate.yml`, whose `push:`
trigger is **path-filtered** to bicep/deploy/workflow paths that merge did not
touch — so they are NEVER-CREATED there, not pending and not failing. The fifth
is a **rename**: `commit-message-parses.yml` gives its job a conditional
`name:`, so on `push` it publishes `changelog parser can read what landed on
main` while branch protection requires the `pull_request` spelling. It ran, and
it was green.

A definition the topology cannot satisfy leaves two outcomes: every
guard/test-only issue is unclosable, or somebody quietly accepts 10-of-15 as
"green" and the receipt stops meaning what it says. The second is the failure
mode this whole toolchain exists to prevent.

So the receipt now reads: **every required context that CAN run at the merged
sha is green; every one that cannot is NAMED, with the reason it could not and
its result on the PR head over an IDENTICAL TREE.** The load-bearing word is
*named* — an absence is excused only when the harness can say why, from
evidence, and every branch that cannot say why **fails closed**: an untraceable
producer, an unreadable `on.push`, a workflow that *should* have run and did
not, a merged sha carrying zero check-runs at all, an empty required set, and a
deferral to a head whose tree differs from the merged tree.

Nothing in it is keyed to a context's **spelling**. The producer of each context
is measured at the PR head (where it ran) through `check_suite_id`, and the
rename case is resolved by **workflow identity** at the merged sha. An alias
table would be one conditional `name:` expression away from being wrong,
silently.

**A green conclusion is not evidence the check did its WORK**, and fixing that
nearly made the receipt unobtainable for the only class it closes. `policy.json`
declares, per context, the step that IS the check
(`receipts.ci_green_rule.substantive_steps`), and a context concluding SUCCESS
with that step `skipped` fails. Correct — and it took the receipt to **0 of 2**
on the population it serves, because `next build (node 20)` and
`vitest (node 20)` gate their work behind an **in-job change detector**, and a
guard/test-only PR by construction does not touch `apps/fiab-console`. Both
drain merges in the window, #4483 and #4488, returned NOT GREEN for exactly
those two.

That is this file's own thesis one branch along, so the answer is the same
measurement rather than an exception: `receipts.ci_green_rule.scope_paths`
declares each such context's **scope**, read off the producing workflow's own
detector, and the skip is excused only when the merged commit's changed files —
the same list the on-push detector computes for itself — fall outside **every**
output that detector drives. The state is reported as
`scope-untouched-at-merge`, never folded into `green-at-merge`. Every
unanswered question fails closed: no declared row, a gate step that is absent
or did not succeed, a declared step that concluded anything other than
`skipped`, an empty changed-file list, a delegated scope that will not resolve.

**Round 6 found the sentence that used to sit here false.** It read: *a scope
that **matches** a merged file is a FAILURE, loudly — that is a detector that
missed a change (#3783).* That holds only of a job that then did **nothing**.
`vitest (node 20)`'s one detector drives two outputs, and a drain PR touching
`tools/` matches the `infra` one — so the job skips `Run vitest` and runs `Run
vitest (infra-reading suites only)` instead. There, a matching scope is exactly
*why* the other half ran; refusing it as a missed change indicts the detector
for working. The corroboration and the acceptance are therefore two halves of
one predicate, asking two different questions:

- the **excuse** (`scope-untouched-at-merge`) asks every output the detector
  drives, and demands the job ran **nothing**. A work step that ran — success
  or failure — is refused in those words: a job that did work is not a job with
  nothing to do.
- the **alternative** (`alternative-work-at-merge`) applies only when the job
  ran the *other half* of its own declared work. It requires the gate step to
  have succeeded, the primary step to be cleanly skipped, a declared
  `alternatives` step to have succeeded, and the merged files to fall outside
  the scope of **every output whose work did not run** — never outside every
  output, which an alternative that ran matches by construction.

Round 8 moved that last clause. It used to read "the **primary's** output only",
which is selection by *identity*, and identity and outcome are the same set only
while a row has exactly two outputs. With a third — declared correctly, gating a
step that skipped, with a merged file inside its scope — the excuse branch
refused the job and the alternative branch accepted it, because that output
gated neither the primary nor the alternative and so was never asked. Selection
is by outcome for that reason.

The #3783 defect is refused by whichever branch can see it: a job whose detector
matched a merged file, where the work that output gates did not run, is granted
neither route. Read that as the general form — an earlier draft said "and which
then ran no work **at all**", and that qualifier was the hole.

**An output nobody declared is never asked**, so the receipt is only as honest
as `policy.json`'s `outputs` list is complete. That completeness is enforced in
two places rather than asserted: the drift guard walks *workflow → declared* as
well as declared → workflow, failing when a job gates work on an output no row
names; and mutation arms R17/R18 delete a declared output and must be killed.
Both reviewers in round 8 found this missing, by different methods, and round 6
had already shipped the same defect once.

The difference between a `on.push.paths` filter and a shell-step filter is where
GitHub lets you write a filter, not how much the merge was checked. Treating the
first as structural and the second as hollow was the asymmetry.

**It is not only the console.** Measured on #4401, a console-only merge:
`Python Tests (3.10|3.11|3.12)` hit the same wall — `test.yml` is path-filtered
out at the merged sha, and its PR-head job skipped `Run pytest with coverage`
behind *its* in-job detector. Same family, one workflow over. Those three rows
declare their scope as the string `"on.push.paths"` rather than a copy of it,
because `test.yml`'s detector does not carry a path list at all: it delegates to
`scripts/ci/python_trigger_scope.py`, which parses `on.push.paths` **out of
`test.yml`**, and that file's own comment says *"ONE list … READ OUT OF THIS
FILE — not a second copy of it that has to be kept in agreement by review."*
Copying those fifteen globs into `policy.json` would build exactly the second
copy it refuses to have. So the row points at the trigger this receipt already
parses, and `test_the_declared_scope_matches_the_workflows_own_change_detector`
asserts the delegation itself rather than a list.

```bash
python tools/drain/merge_gate.py --ci-green-receipt <PR>   # GREEN / NOT GREEN, per context
```

**What `ci-green` does NOT prove, stated rather than implied.**
`statusCheckRollup` publishes no per-check population — its entries carry
`__typename, completedAt, conclusion, detailsUrl, name, startedAt, status,
workflowName` and nothing else (measured). So a check that concluded SUCCESS
over **zero items** — the #4451 shape — is *not visible* to this gate. It
detects a required context that concluded SKIPPED, and says so in those words.
Detecting green-over-nothing needs a population source this API does not have,
and is an owed capability, not a claim.

**And a `scope-untouched-at-merge` says nothing about coverage.** It says a
context's declared scope excluded every merged file — which is true, and is
*also* true when the repo has no required context covering what the PR changed
at all. Measured over the 12 most recent merges: the `apps/loom-vscode` and
`apps/loom-mcp` dependency bumps score **5** scope-untouched contexts each,
because none of the fifteen required contexts builds those packages. That is a
gap in the required set, not in the receipt, and the receipt is not the place to
fix it — but a reader counting states should know which of the two they are
looking at.

**How a receipt actually gets recorded.** There is now one instrumented way:

```bash
# guard-or-test-only -> ci-green, RE-MEASURED from the merged PR
python tools/drain/tick.py --record-receipt <ITEM> --from-pr <PR>
# ui-surface / estate-behaviour / deploy-path -> verified against the run
python tools/drain/tick.py --record-receipt <ITEM> --from-run <RUN_ID>
```

It lives in `tick.py` because `tick.py` owns the ledger. #4489 blocked the same
write in `merge_gate` twice: once because the worktree fallback resolves
`state.json` from the **primary checkout**, so a lane running the gate from its
own worktree rewrote a ledger it does not own; and once because it was an
unlocked read-modify-write on the only durable record with up to four lanes
live, where `Ledger.save()` serialises the whole document from memory and the
loser's transitions simply vanish.

**It verifies rather than accepts.** The KIND is derived from the item's class
and is never a flag — a `--kind` option would let a `ui-surface` item close on a
`ci-green`, and the R2 invariant cannot catch that, because R2 compares the
class a receipt was *taken under* against the class at the decision and a caller
who names the wrong kind up front is consistent with itself. `ci-green` is
re-measured by `gates.ci_green_receipt` at record time, so this path cannot
record a receipt `--ci-green-receipt` would not print. Run-backed kinds must
match the workflow named in `policy.receipt_producers`, must have *concluded*
success (status and conclusion checked separately, so an in-progress run is
refused as unfinished rather than as failed), and — where
`policy.receipt_required_steps` names one — that step must itself have concluded
success. That last check is `receipts.g1_assertion_rule` in code: a
`loom-ui-verify` run with a blank `target_route` **skips the capture step** and
concludes green having captured nothing.

**What it does not establish.** That the evidence is *about* the item. Nothing
stops a green roll being recorded against a second deploy-path item it never
touched; the operator supplies that pairing, and the harness cannot check it
until `Item.pr` has a writer (#4489). A refused receipt writes nothing — the
ledger is byte-identical afterwards, verified by digest, **and no GitHub write
happens either**, because the close runs only after every refusal has been
passed.

`receipt_class` still has no production writer, so the `human-only` class is
reachable only by hand — and `operator` is deliberately **absent** from
`receipt_producers`, because a human-only receipt a program can record is not
human-only.

That is also why the R2 check is an **invariant**, not an event observer.
`record_receipt` stamps the class the receipt was taken under, and
`_refuse_unless_receipted` compares it at the decision. It therefore does not
care *how* the class moved, or whether anything watched it move — including the
two routes `upsert` structurally cannot see, since `RECEIPT_CLASS_BY_STREAM` and
`LANE_RECEIPT_CLASS` are module constants rather than fields. A reviewer closed
a `ui-surface` item on a `ci-green` that had been refused moments earlier, by
editing one line of a map.

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
python -m pytest tools/drain/__tests__ -q    # every test across every module
python tools/drain/mutate_gates.py           # every arm must be KILLED
```

Neither total is written down here on purpose. Both move — the arm count went
155 → 205 → 209 → 213 → 247 across #4487 and #4491 — and a number in prose that
nothing enforces goes stale silently, which is the same defect this package
exists to refuse. (That series itself stopped at 213 for five rounds while the
count kept climbing, which is the defect demonstrating itself inside the
sentence describing it.) Each command prints its own total and **fails closed**:
`mutate_gates.py` exits non-zero on any survivor, skip, error, or a sandbox
whose file set changed under it.

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
- **The same lesson, ignored one round later.** The author of the declared-step
  rule wrote arms that weakened its *checks*; the reviewer wrote six that
  narrowed its *populations* — `matches[:1]`, `work[:50]`, one reason per
  receipt, one run per job join, a fallback to the PR-head job — and **all six
  survived**. Having recorded the lesson above is not the same as applying it.
  Those are arms `CB4h`–`CB4k`, `CB14`, `P13`.
- **A kill that does not depend on the arm is not a kill.** The sandbox is a
  copy in a temp dir, so a test that reads a repo file it does not copy raises
  in *every* arm and scores every one KILLED. Three did, briefly. `COPIED` is
  the fix for a package file; a test that needs the wider tree skips when the
  tree is not reachable.

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
| `mutate_gates.py` | mutation arms against a sandbox copy; every arm must be KILLED |
| `required_contexts.json` | snapshot of `main`'s required contexts, so the declaration check can assert SET equality offline (`merge_gate.py --refresh-required-contexts`) |
| `state.json` | the ledger itself (gitignored — per-run state, not a control) |
| `__tests__/` | a negative control for every decision function |

Spec and the measured inventory: `PRPs/active/zero-backlog/`.
