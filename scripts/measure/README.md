# `scripts/measure` — measurements that cannot silently return a fake zero

## Why this exists

On 2026-08-23, three separate "clean" results turned out to be **queries that never ran**, and
every one was indistinguishable from a real answer:

| # | What was reported | What was true |
|---|---|---|
| 1 | Seven container apps at **0 requests, rc=0** | `R=$(az … \| tr -d '\r'); RC=$?` read **`tr`'s** status. az had failed. |
| 2 | Metric values of **`null`**, read as zero | Git Bash rewrote the leading-slash ARM id into a Windows path; az answered *"usage error"* |
| 3 | Twenty PRs at **`0/0/0` checks** | `gh api` returned **HTTP 403** (secondary rate limit) and a jq default produced zeros |

A fourth shape showed up in a mutation harness: `spawnSync(shell:true)` with a forward-slash
`.CMD` **returned rc=1 without launching anything**, so two mutations read as "CAUGHT" over a
suite that never executed.

**Every one was caught only by a positive control.** Without one, *"no data"* and *"no activity"*
are the same string — and the wrong reading is always the more convenient one.

Discipline does not fix this; a type does.

## The rules the library enforces

| | Rule |
|---|---|
| **R1** | A failed command **never yields a value**. It throws. There is no default. |
| **R2** | Exit status comes from the **subject process**, never a pipeline. Nothing here pipes. |
| **R3** | **No shell**, so no MSYS path mangling. ARM ids pass through untouched. |
| **R4** | `null` / missing / unparseable is **`UNKNOWN`**, a distinct state from `0`. |
| **R5** | A **zero is refused** unless a positive control proves the query path works. |

R5 is the load-bearing one. `measureWithControl` will not return a number at all if the control
is zero, `UNKNOWN`, or throws:

```js
import { measureWithControl, metricTotal, UNKNOWN } from './measure.mjs';

measureWithControl({
  label: 'loom-activator requests',
  subject: () => metricTotal(activatorId, 'Requests', since),
  control: () => metricTotal(consoleId,   'Requests', since),  // known-live
  controlLabel: 'loom-console requests',
});
// -> { value: 0, control: { value: 2766 } }   a zero you can quote
// -> throws                                    if the control is also 0
```

## Files

| File | Purpose |
|---|---|
| `measure.mjs` | The library. `run`, `runJson`, `az`, `gh`, `metricTotal`, `checkRuns`, `measureWithControl`, `UNKNOWN`. |
| `measure.test.mjs` | Proves each rule fires. Carries positive controls so it cannot pass vacuously. |
| `measurement-guard.test.mjs` | Tests the PreToolUse hook (see below). |
| `mutate.mjs` | Breaks each guard and asserts the suite goes RED. **Not** named `*.test.mjs` on purpose — it rewrites files, so CI must not discover it as a suite. |
| `drain-status.mjs` | Worked example: PR merge-readiness. A failed read prints `QUERY-FAILED` **with the reason** and exits non-zero, so it cannot be quoted as a state. The bash version it replaced reported `0/0/0` for twenty PRs during an HTTP 403. |

```bash
node --test scripts/measure/measure.test.mjs scripts/measure/measurement-guard.test.mjs
node scripts/measure/mutate.mjs      # every arm must report CAUGHT
```

## The hook

`.claude/hooks/measurement-guard.mjs` is a **PreToolUse** hook (wired in `.claude/settings.json`)
that **denies** Bash commands carrying the three shapes above, naming the fix in each case. It
denies rather than warns because the entire failure mode is that the wrong answer looks fine —
a warning in a tool result is easy to skim past.

Detection is deliberately narrow, and the suite's **negative** cases carry equal weight: a false
denial is the pressure that gets a guard deleted.

It earned its keep within two minutes of being wired: it blocked a `2>/dev/null` on a `gh api`
call, and the un-discarded stderr then revealed an HTTP 403 that would otherwise have looked like
an empty file.

## Two things this module learned about itself

- Its own self-test **caught a real bug on first run** — `resolveExe` searched `PATH` and never
  handled an absolute path, so a binary that plainly existed reported "could not resolve".
- The hook's first version used `require()` inside an ESM module. It threw, a `catch` swallowed
  it, and the hook **silently allowed everything**. The unit tests passed, because they call
  `evaluate()` directly; only an end-to-end run through the real stdin path caught it. A guard
  that fails open is the exact defect this directory exists to prevent, so that path now reports
  the failure instead of swallowing it.

## Discovery

Both suites are named `*.test.mjs` and live under `scripts/` so that
`scripts/ci/check-node-test-suites.mjs` — the tree-wide `node:test` discovery that runs inside the
**required** `guardrails` check — actually executes them.

This was measured, not assumed. The original names (`selftest.mjs`, and one file under
`.claude/hooks/`) matched **neither** `TEST_FILE_RE` (`/\.test\.(mjs|cjs|js)$/`, which needs a
literal dot before `test`) **nor** the walker, since `.claude` is in `SKIP_DIRS`. They would have
rotted unrun — the same failure mode as a dispatch-only runbook nobody dispatches.
