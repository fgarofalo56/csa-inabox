# CSA Loom workflows (`.claude/workflows/`)

Persistent, reusable multi-agent **Workflow** scripts. Invoke any of them by
name with the Workflow tool — no need to re-author the script:

```
Workflow({ name: '<workflow-name>' })
Workflow({ name: '<workflow-name>', args: { … } })   # parameterized run
```

They run in the background, fan out subagents, and report when done. To
**update / refactor**, edit the `.js` file here and re-invoke by name (or pass
`args` to change scope without editing).

> Convention in all of these: agents implement + verify and **open a PR per
> unit of work**; the **operator merges after CI** (agents never merge). Dev-loop
> discipline is baked into the prompts: branch off `origin/main`, stage explicit
> paths (never `git add -A`), **no `pnpm install`** in the shared tree, filter the
> pre-existing makeStyles `tsc` px-noise, conventional commits + the
> `Co-Authored-By: Claude Opus 4.8` trailer.

## `loom-backlog-drain`
Reusable **coding drain**: research (Sonnet, read-only) → implement (sequential
coding agent) → adversarial review + one fix → **PR per item**.

Add/refactor work for new requests via `args` (no script edit needed):
```
Workflow({ name: 'loom-backlog-drain', args: { backlog: [
  { id: 'my-feature',
    title: 'Short title',
    goal: 'Exactly what to build (real backend or honest gate, no mocks).',
    files: 'paths to create/edit',
    research: 'what to read to ground it (code + MS Learn)',
    verify: 'how to prove it works (tsc / vitest / grep)' },
  …more items… ] } })
```
A bare array also works (`args: [ {…}, {…} ]`). With no `args` it runs the
`DEFAULT_BACKLOG` in the script — edit that for the standing backlog.

## `loom-fabric-parity-prp`
The big planner: per Fabric experience → **inventory** the full feature set
(MS Learn) → map **1:1 Azure-native + OSS parity** (every service's full feature
set + native UI to rebuild, portability across Commercial/GCC/GCC-High/IL5) →
**audit** vs Loom today → write a dev-loop **PRP** to `docs/fiab/prp/<id>.md`,
then a master `README.md` + `UNLEASH-KICKOFF.md` (and it returns the kickoff
prompt). Scope or extend the experience list:
```
Workflow({ name: 'loom-fabric-parity-prp' })                               # all 12 experiences
Workflow({ name: 'loom-fabric-parity-prp',
           args: { experiences: [ { id:'…', name:'…', scope:'…' } ] } })   # subset / new
```
No git ops — the operator commits the generated `docs/fiab/prp/*` set.

## `loom-drain-tutorials`
Example **docs-rewrite drain** (rewrite tutorials 02–08 to the real product).
Template to copy for any doc set. Plain-text research (no schema) so it can't
fail the structured-output call.

---
### The flow to "Unleash CSA Loom"
1. Run **`loom-fabric-parity-prp`** → produces the PRP set + the kickoff prompt.
2. Build PRP tasks with **`loom-backlog-drain`** (pass the PRP tasks as
   `args.backlog`, or paste the kickoff prompt which drives the same loop).
3. Operator merges the green PRs after CI; repeat until every PRP's
   definition-of-done (zero stubs/placeholders) is met.
