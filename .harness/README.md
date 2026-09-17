# `.harness/` — retired

**This harness is no longer the harness of record. `tools/drain/` is.**

The program that lived here — **FINISHLINE** — is retired as of **2026-09-17**
(`Refs #4495`). Its ledger was last advanced on **2026-08-08**, and its program
authority was superseded on 2026-08-22 by
`PRPs/active/omnibus-2026-08-22/PRP.md` (#3881).

Nothing was deleted.

| What | Where |
|---|---|
| FINISHLINE ledger — 56 tasks, 19 operator questions | `archive/2026-08-08/state.json` |
| FINISHLINE program config | `archive/2026-08-08/config.json` |
| The June 2026 program that preceded it | `archive/2026-06-05/` |
| FINISHLINE spec + audit | `PRPs/archive/2026-08-22-omnibus-consolidation/finishline/` |
| **Per-task dispositions — what was done, superseded, or filed** | `PRPs/active/finishline-retirement/README.md` |
| **The 19 unanswered operator decisions** | `PRPs/active/finishline-retirement/OPERATOR-QUESTIONS.md` |
| Work that survived re-measurement as still live | #4549, #4550 |

## Why `/harness:harness-next` could not select a task

`archive/2026-08-08/config.json` lists `PRPs/active/finishline/PRP.md` first in
its `read_first`. That path no longer resolves — not because the spec was
deleted, but because #3881 **moved** it to
`PRPs/archive/2026-08-22-omnibus-consolidation/finishline/PRP.md` while leaving
this ledger pointing at the old location. That is the whole of #4495.

## `session-notes.md`

Left in place, deliberately. It is modified in the primary checkout's working
tree, and moving a file out from under an uncommitted edit is the silent loss
this retirement exists to prevent. It can be archived alongside the rest once
that edit is committed or discarded.

## If `/harness:harness-next` sent you here — do NOT run `/harness-init`

`.claude/commands/harness/harness-next.md:38` reads `.harness/state.json` and,
finding nothing, prints *"No state file (run /harness-init first)"*; `:44` opens
the same path directly. Both paths moved into `archive/2026-08-08/` when this
program was retired, so that instruction now points at a retired ledger.

**Re-initialising would re-derive work that has already shipped.** Eleven of the
eighteen unmapped tasks were re-measured at head and found already done. Read
`PRPs/active/finishline-retirement/README.md` instead.

That command file is synced from `claude-tools` (see this repo's `CLAUDE.md`), so
the fix belongs upstream — a local edit here is overwritten on the next resync.

## Before reviving anything here

Read `PRPs/active/finishline-retirement/README.md` first. Eleven of the eighteen
unmapped tasks in that ledger were re-measured at head and found already done;
three are superseded by open issues; two more are partly done with the remainder
recorded at the site. A further six tasks — reached by no issue, only by merged
PRs — were dispositioned there too. Re-running this program against the
2026-08-06 ledger would re-derive work that has shipped.
