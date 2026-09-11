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
  - ALL 297 open issues. Done = every issue closed / parked / declined.
  - You may merge on gate GO, close on a receipt, re-run and APPROVE parked CI,
    and dispatch deploys and rolls against the live estate.
  - G1 receipts come from Playwright against the live console; park the item
    only if auth fails.
  - policy.json is the authority for what you may not do. It fails closed.

FIRST TASK, before anything else: PR #4483 is the harness itself and is open and
unreviewed. Get it independently reviewed and merged under its own gates. The
harness earning its own merge is W0, and nothing else should land until the gate
that decides merges is auditable on main.
```

---

## Before you fire

**Nothing is required.** The harness runs from the current branch. But two facts
are worth knowing:

1. **The repo is on `feat/zero-backlog-drain-harness`**, not `main`. That is
   fine — the harness lives on that branch and `state.json` is gitignored, so it
   survives a branch switch either way. The first cycle merges #4483, after
   which `main` carries it.

2. **`state.json` is seeded and clean**: 297 ready, 0 in-flight, 154
   unschedulable. If you ever want to start over:
   `python tools/drain/tick.py --bootstrap`.

## What the first cycle will do

`tick.py` selects from `W1-deploy` before `W0-harness`, because **every W0 item
is still unsized** and an unsized item is not schedulable. That is the design
working, not a bug: triage gates the parallelism.

So expect the run to spend its early cycles on triage — sizing and laning the
**153 unsized / 118 unlaned** items — because nothing else can be safely
parallelized until it does.

## How to tell it is working

```bash
python tools/drain/tick.py --status      # counts move out of `ready`
python -m pytest tools/drain/__tests__   # 25 pass
python tools/drain/mutate_gates.py       # 6 KILLED / 0 survived
```

**If `mutate_gates.py` ever reports a SURVIVOR, stop.** The gate suite has a
blind spot and nothing it approves should be trusted until that is fixed.

## How to stop it

Interrupt. The ledger is a transaction log — the run resumes from
`tick.py` with at most the in-flight cycle lost. Nothing is held in an agent's
context, which is the whole point.
