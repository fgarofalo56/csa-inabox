# Kick off the drain

Paste the block below as the first message of a fresh session. It is
self-contained — it assumes no memory of how the harness got here.

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
    must never buy a weaker gate. It relaxes on its own as items earn receipts.
    Run the gate from the PRIMARY checkout if you can; from a worktree it falls
    back to the primary's ledger via git's common dir, and if that fails it
    escalates.
  - G1 receipts come from Playwright against the live console; park the item
    only if auth fails.
  - policy.json is the authority for what you may not do. It fails closed.

FIRST TASK, before draining anything else: #4487 — the `ci-green` receipt names a
measurement the CI topology cannot produce, so NO guard/test-only issue can reach
a terminal state until it is fixed. Then #4468's remainder: port `unblock-git.py`
and `preflight-casedrop.py` out of temp/ into tools/drain with tests, and close
#4468 on its own checklist. Both are W0 — finish the gate before trusting it.
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
| **#4487** | `ci-green` names an unobtainable measurement | 10 of 15 required contexts can run at a merged sha; `validate.yml`'s `push:` trigger is path-filtered and one job is renamed on push. Until this is fixed no guard/test-only issue can close. |
| **#4468** | `unblock-git.py` (502 lines) and `preflight-casedrop.py` still untracked | the drain leans on the first across every merge, and it is one `rm -rf` from gone — the issue's own thesis |
| **#4485** | five residual review findings | all non-blocking, all measured, none a live defect today |

**Then W1-deploy**, because `deploy-integrity.md` R1 makes a broken deploy path
preempt all feature work.

## How to tell it is working

```bash
python tools/drain/tick.py --status      # counts move out of `ready`
python -m pytest tools/drain/__tests__   # 294 pass
python tools/drain/mutate_gates.py       # 144 KILLED / 0 survived
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
