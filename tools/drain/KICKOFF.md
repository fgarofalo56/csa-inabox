# Kick off the drain

Paste the block below as the first message of a fresh session. It is
self-contained — it assumes no memory of how the harness got here.

**This file is HAND-MAINTAINED, not generated.** `README.md` says KICKOFF is
"regenerated every cycle"; `tick.py` contains no reference to it (`grep -n
KICKOFF tools/drain/tick.py` returns nothing). That claim is prose, and this
note exists so the next reader does not trust a freshness the program does not
provide. **Re-read the FIRST TASK section against `--status` before pasting** —
it was stale once already, naming work that had since been done.

Last hand-updated: 2026-09-15 (re-checked against live state: PR #4491 on round 16; #4492 PARKED as draft — the migration premise did not hold, see its thread). This line read "2026-09-13 … round 5" for eleven rounds, three lines below the warning that it goes stale — which is the warning demonstrating itself. A reviewer caught it. Prefer `--status` over this line; it is hand-maintained and will be wrong again.

---

```
Run the zero-backlog drain harness autonomously until the queue is 100% drained.

Read tools/drain/README.md first, then PRPs/active/zero-backlog/PRP.md. They are
self-contained and carry the scope, the autonomy contract and the traps. The
ledger at tools/drain/state.json is the only durable state — trust it over
anything you remember or infer.

Start with:
    python tools/drain/tick.py --status
    python tools/drain/tick.py

Then execute the lanes it prints, return results into the ledger, and tick again.
Repeat until `--status` reports drained: true.

Scope and autonomy are already decided — do not re-ask them:
  - ALL open issues. Done = every issue closed / parked / declined.
  - You may merge on gate GO, close on a receipt, re-run and APPROVE parked CI,
    dispatch deploys and rolls, and RESUME/PAUSE the estate on demand.
  - ONE independent reviewer is the DEFAULT; in practice most items escalate to
    two, and the brief tells you which and why. Escalation is not only "the diff
    touches a guard": it also fires on a blocking FIRST verdict (even one a push
    has since voided — the block still happened), on the item's STREAM
    (W0/W1/W2/W3/W5/W6/W7), and whenever the footprint or the stream cannot be
    resolved, which FAILS CLOSED. merge_gate gate 3b re-decides on real evidence
    — the actual changed files, the first posted verdict, and the stream read
    from the ledger via the issues your PR references — and it can RAISE the
    count, not only confirm it.
  - EXPECT TWO REVIEWERS ON EVERYTHING, for now. The one-reviewer path needs a
    DECLARED close (`Closes #N` + `--allow-close N`) of an item the harness has
    IN FLIGHT — and `--allow-close` is itself refused until that item holds its
    receipt, which none of the 299 do yet. So `Refs #N` plus two reviewers is
    the normal path today, and it always works. This is a measured consequence,
    not an oversight: a bare `Refs #N` is an aside, good enough to raise the
    count and not good enough to lower it, because a stale copy-pasted number
    must never buy a weaker gate. It relaxes as items start carrying receipts —
    and a receipt is now RECORDED BY A PROGRAM rather than by hand:

        python tools/drain/tick.py --record-receipt <ITEM> --from-pr <PR>
        python tools/drain/tick.py --record-receipt <ITEM> --from-run <RUN_ID>

    It VERIFIES before it writes — `ci-green` is re-measured from the merged PR,
    run-backed kinds must match the workflow declared in
    `policy.receipt_producers` and have CONCLUDED success, and where
    `policy.receipt_required_steps` names a step, that step must have concluded
    success too (a `loom-ui-verify` run with a blank `target_route` skips the
    capture step and is green having captured nothing). A refusal writes
    nothing. It CLOSES THE GITHUB ISSUE in the same transaction, before the
    ledger write (#4545) — until that landed, the ledger close never reached
    GitHub, so the next refresh read the harness's own close as a REOPEN and
    voided the receipt; every self-closed item un-closed itself one cycle later.
    Only `closed` gets a GitHub close: a park is supposed to stay open. If the
    close cannot be confirmed, the command prints `GITHUB CLOSE NOT CONFIRMED -
    NOTHING WRITTEN TO THE LEDGER`, writes nothing, and the item stays
    non-terminal — re-run it, the closer reads the state first. If the close
    settles and the ledger write then fails (a lost CAS against another lane is
    the realistic one, but ANY failure is caught — a narrow bound once let a
    `PermissionError` escape with an empty stderr), it prints `LEDGER NOT
    WRITTEN - THE ISSUE IS CLOSED UPSTREAM` with the exception type and says to
    re-run: the closer sees CLOSED and short-circuits, so there is no second
    close and no second comment.
    It does NOT check the evidence is ABOUT the item — that binding
    needs `Item.pr`, which still has no writer (#4489). Measure the operating
    point with `python tools/drain/operating_point.py --merge-gate`.
    Run the gate from the PRIMARY checkout if you can; from a worktree it falls
    back to the primary's ledger via git's common dir, and if that fails it
    escalates.
  - G1 receipts come from Playwright against the live console; park the item
    only if auth fails.
  - policy.json is the authority for what you may not do. It fails closed.

FIRST TASK, before draining anything else — check each against live state, because
this list is hand-maintained and was stale once already:

  1. #4487 (W0) — PR #4491 is OPEN and has reached its SIXTEENTH round of
     independent review. Read the PR's own comments for the live state rather
     than trusting a sha or a round number written here — this entry said
     "FIFTH" for eleven rounds. Every round so far found its blocker
     INSIDE the previous round's fix, which is the pattern to expect. Round 5's
     were: a sibling gate step could answer for a skipped detector (`any()` over
     a substring-matched population), and a job with TWO work-gating outputs was
     reported as having "nothing to do" when its second half had actually run.
     Until this lands, NO guard/test-only issue can reach a terminal state, so
     it gates the whole drain.
  2. #4468's remainder — port `unblock-git.py` and `preflight-casedrop.py` out of
     `temp/` into `tools/drain` with tests, then close #4468 on its own checklist.
  3. PR #4492 (CI runners) is PARKED as a draft — do not pick it up without
     reading its thread. It moved CI onto in-VNet Azure Container Apps runners
     behind a `CI_RUNNER` repo variable, to remove a CI billing blocker. **There
     is no CI billing blocker**: this repo is PUBLIC, so GitHub-hosted runners
     are free, and the ACA fleet costs ~$0.62/node-hour in use. The migration
     added cost rather than removing it. Measured 2026-09-13: `CI_RUNNER` unset,
     0 runners registered, `gh-aca-runner` at `maxExecutions: 0`, D8 profile at
     `minimumCount: 0` — so the fleet is off and costs nothing to leave in place.
     Two independent reviews also found it not ready (network axis unmeasured,
     the body's "CI_RUNNER is set" claim false, `provision-gh-runner.sh` unable
     to reproduce the fleet). If an in-VNet driver appears later — CI needing
     private endpoints or Key Vault that GitHub-hosted runners cannot reach —
     that branch is the starting point and its thread is the fix list.

Both #4487 and #4468 are W0 — finish the gate before trusting it.
```

---

## Where this stands

**The harness is on main.** PR #4483 merged at `a02cd41e6d42` after **eight
posted** independent review rounds — count them yourself with
`gh pr view 4483 --json comments`; an earlier draft of this file said nine,
which is the kind of unverifiable number a cold start should not inherit.
`tools/drain/` is tracked, tested and CI-enforced;
`merge_gate.py` is the production caller that decides GO/NO-GO, and it refused
its own PR twice before letting it through.

**W0 is not finished.** Three things are owed, and the first two are what the
kickoff block names:

| # | what | why it matters |
|---|---|---|
| **#4487** | `ci-green` named an unobtainable measurement, twice | first "green at the merged sha", which only 10 of 15 required contexts can satisfy; then, after the substantive-step rule closed the hollow-green hole, a definition no guard/test-only merge could satisfy either — 4 of the 12 most recent merges could take the receipt. PR #4491, round 4, fixes the second. |
| **#4468** | `unblock-git.py` (502 lines) and `preflight-casedrop.py` still untracked | the drain leans on the first across every merge, and it is one `rm -rf` from gone — the issue's own thesis |
| **#4485** | five residual review findings | all non-blocking, all measured, none a live defect today |

**Then W1-deploy**, because `deploy-integrity.md` R1 makes a broken deploy path
preempt all feature work.

## How to tell it is working

```bash
python tools/drain/tick.py --status      # counts move out of `ready`
python -m pytest tools/drain/__tests__   # all pass
python tools/drain/mutate_gates.py       # every arm KILLED / 0 survived
python tools/drain/merge_gate.py <PR>    # the gate, as a program, on a real PR
```

**If `mutate_gates.py` ever reports a SURVIVOR, stop** — but read the arm first.
A survivor means the suite is blind **or** the mutation was a no-op, and those
are different problems. Three arms here have already turned out to be the second
kind, and one of those was dead code that deserved deleting.

## Two things that cost a whole cycle each

1. **A verdict RETURNED is not a verdict POSTED.** The harness's own merge came
   back NO-GO because two approvals had been handed to the coordinator and never
   posted to the PR. The gate reads PR comments. `gh pr comment` it.
2. **A verdict is pinned to the head it measured.** Any push voids every
   approval on the PR. That is deliberate; budget for it rather than pushing a
   "tiny" fix after an approval lands.

## The ledger

`state.json` is gitignored, so what it holds depends on the machine — ask it
(`tick.py --status`) rather than trusting a number written here. If it does not
exist, `--status` exits 2 and tells you to seed:
`python tools/drain/tick.py --bootstrap`, which backs the old one up first.

Starting over is not free: the ledger is the only record of what has already
been verified, and GitHub does not carry it.

## How to stop it

Interrupt. The ledger is a transaction log — the run resumes from `tick.py` with
at most the in-flight cycle lost, and `--reap` returns stranded lanes to `ready`.
Nothing is held in an agent's context, which is the whole point.
