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
| **R6** | A **saturated page is not a complete set.** `checkRuns` paginates and refuses to report counts from a short read against a known `total_count`. |
| **R7** | A **green check may have executed nothing.** `checkRunHollowness` answers that separately from the conclusion. |

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
| `red-tally.mjs` | Names the red checks across PRs to expose a shared cause. Reports `cancelled` **separately** from `failed` — a cancelled check did not finish, so it is UNKNOWN, not a verdict. Flattening them made a one-file docs PR look broken. |
| `estate-resume.mjs` | Undoes the 2026-08-23 Commercial pause. `--dry-run` by default; `--apply` to act. Scope is a **fixed list**, never discovered — only 1 of the 13 Container App environments in these subscriptions is Loom's. Every action verifies its own outcome and it is idempotent. |

## Launching `az` / `gh` on Windows — three ways to get a fake result

The library exists for `az` and `gh`, which are `.cmd` shims. Getting them launched is fiddly
enough that it shipped **broken**, and the tests did not catch it because they all spawn
`node.exe`:

| approach | what happens |
|---|---|
| `shell:false` on a `.cmd` | Node ≥ 20 throws **EINVAL** (CVE-2024-27980 mitigation) |
| `shell:true` with a **forward-slash** path | fails to launch and **still returns rc=1** — reads as a genuine non-zero verdict |
| `shell:true` with args | Node **DEP0190**: args are concatenated, not escaped, so a value with a space silently changes the command |

The working form is `cmd.exe /d /s /c` with a hand-quoted command line and
`windowsVerbatimArguments`. The quoting lives in `cmd-quote.mjs` — a pure module with no
process execution — so this path has coverage that does not depend on `az` being installed,
or on running Windows at all. `spawnPlan` is deliberately **not** exported: exporting it made
the parameter an external taint source and was itself a defect.

```bash
node --test scripts/measure/measure.test.mjs \
             scripts/measure/cmd-quote.test.mjs \
             scripts/measure/measurement-guard.test.mjs
node scripts/measure/mutate.mjs      # every arm must report CAUGHT
```

## The hook

`.claude/hooks/measurement-guard.mjs` is a **PreToolUse** hook (wired in `.claude/settings.json`)
that **denies** Bash commands carrying the three shapes above, naming the fix in each case. It
denies rather than warns because the entire failure mode is that the wrong answer looks fine —
a warning in a tool result is easy to skim past.

Note the scope: wiring it in `.claude/settings.json` means it runs on **every** Bash call for
anyone who clones this repo, not only its author. That is intentional — the failure modes it
catches are repo-wide — but it is an operational change, not a personal preference.

Detection matches by **shape**, not by spelling. An earlier version tested the literal
`2>/dev/null` and nothing else, so `&>/dev/null` (which discards both streams and is strictly
worse), the canonical `>/dev/null 2>&1`, `2>>/dev/null`, and `2>&-` all passed. A guard keyed to
one spelling is one keystroke from useless. The suite's **negative** cases carry equal weight —
a plain `>/dev/null`, which silences stdout while leaving stderr readable, must stay allowed;
a false denial is the pressure that gets a guard deleted.

It earned its keep within two minutes of being wired: it blocked a `2>/dev/null` on a `gh api`
call, and the un-discarded stderr then revealed an HTTP 403 that would otherwise have looked like
an empty file.

## What this module learned about itself

- Its own self-test **caught a real bug on first run** — an early `resolveExe` searched `PATH`
  and never handled an absolute path, so a binary that plainly existed reported "could not
  resolve". That function no longer exists: the allowlist rewrite removed path handling
  entirely, which is a better answer than fixing the resolution.
- The hook's first version used `require()` inside an ESM module. It threw, a `catch` swallowed
  it, and the hook **silently allowed everything**. The unit tests passed, because they call
  `evaluate()` directly; only an end-to-end run through the real stdin path caught it.
- **Fail-open is now split by case, and one case still fails open on purpose.** An unreadable
  fd 0 means no command arrived, so there is nothing to judge — that path allows, and says so
  loudly on stderr, because denying every Bash call on a harness fault is worse than the guard
  being absent. A payload that arrives but does not parse is a different thing: that is an
  anomaly, and it now **denies**. A rule that throws mid-evaluation also denies — a crashing
  rule produced no verdict, and treating that as a pass is the gate-that-cannot-fail shape.
- **Six of its arms proved six things and nothing else.** An independent review wrote fifteen
  fresh mutation arms and eleven survived: every fake-zero refusal in `checkRuns` and
  `metricTotal` could be deleted with the suite still green, because the tests asserted against
  local *re-implementations* of those parsers rather than importing them — and the copies had
  already drifted from production in both directions. The parsers are now exported
  (`parseMetricSeries`, `parseCheckRuns`, `parseHollowness`, `canonicalBinary`) and tested
  directly, with arms holding each one shut.

## Discovery

All three suites are named `*.test.mjs` and live under `scripts/` so that
`scripts/ci/check-node-test-suites.mjs` — the tree-wide `node:test` discovery that runs inside the
**required** `guardrails` check — actually executes them.

This was measured, not assumed. The original names (`selftest.mjs`, and one file under
`.claude/hooks/`) matched **neither** `TEST_FILE_RE` (`/\.test\.(mjs|cjs|js)$/`, which needs a
literal dot before `test`) **nor** the walker, since `.claude` is in `SKIP_DIRS`. They would have
rotted unrun — the same failure mode as a dispatch-only runbook nobody dispatches.
