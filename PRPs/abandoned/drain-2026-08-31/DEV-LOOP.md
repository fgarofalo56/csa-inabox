# DEV-LOOP — the parallel dev→test→validate→deploy machine

Companion to `PRP.md`. This document defines **how** a lane runs, not **what** it
fixes. Every lane in every wave follows it.

Operator requirement, verbatim: *"make sure the spec/plan/prp is built to do
complete dev loops and ships as much as possiable in parrellel it can use agent
workflows, and subagent, multiple models to optimize the dev, test, valdatate deploy
workflows."*

---

## 1. The loop

```
  ┌─ TRIAGE ──► SCOPE ──► IMPLEMENT ──► TEST ──► REVIEW ──► PREFLIGHT ──► MERGE ──► DEPLOY ──► VERIFY ─┐
  │  (sonnet)   (opus)    (by size)    (verifier) (opus)    (script)     (operator)  (CI)     (browser) │
  └──────────────────────────────── re-verify at head, re-derive artifacts ◄───────────────────────────┘
```

Each stage has an **owner model**, an **artifact**, and a **failure mode it exists
to catch**. A stage that produces no artifact did not run.

| Stage | Model | Artifact | Catches |
|---|---|---|---|
| **Triage** | sonnet | verdict + file list + size + evidence line | Mis-titled issues; already-fixed issues |
| **Scope** | opus | declared file ownership in `OWNERSHIP.md` | Lane collision; hidden root cause outside the fence |
| **Implement** | sonnet (XS/S) · opus (M/L) | the diff | — |
| **Test** | verifier (haiku) | raw gate output, uninterpreted | A gate that passes without executing |
| **Review** | opus, never the author | a **posted** `gh pr comment` | Self-certification |
| **Preflight** | script, no model | `merge-eligible` + `hollow-control` output | Green rollup over an unexecuted suite |
| **Merge** | operator | merge SHA | — |
| **Deploy** | CI | `/build-marker.txt` SHA | "merged" reported as "shipped" |
| **Verify** | browser (G1) | screenshot / trace / real response body | Vaporware; dead data path behind a fluent answer |

---

## 2. Multi-model role assignment

Models are assigned by **what failure each stage must catch**, not by cost. The
governing constraint is `csa_loom_agreement_is_not_independence_shared_method`: two
agents using the same method agreeing is a cross-check, never independent
confirmation. So the review model must differ from the implementer *instance*, and
the verifier must not be permitted to interpret.

| Role | Model | Rationale |
|---|---|---|
| **Triage / research** | `sonnet` | High volume, bounded output (a table row). 158 issues to sweep; opus is not the constraint here, throughput is. |
| **Implementer — XS/S** | `sonnet` | Single-file, mechanical (swap a raw `<Input>` for `AzureBackedField`; add `--name` to a role assignment). |
| **Implementer — M/L** | `opus` | Multi-file, cross-cutting, or needs a design call (#3513's 119 sites; #3573's new provisioner; #3847's typed sweep). |
| **Reviewer** | `opus`, **never the authoring agent** | The review must be able to find what the author's own frame could not. Different instance is the minimum; different model class where the author was sonnet. |
| **Verifier** | `haiku` | Runs the gate and returns **raw output**. Deliberately the least interpretive model available — its job is to *not* explain a failure away. |
| **Docs** | `sonnet` | Parity docs, ADRs, issue closure text. |
| **Architecture / wave planning** | `opus` (this session) | Cross-lane consequences; not delegated. |

**The verifier constraint is load-bearing.** The `verifier` agent definition says it
*"Executes commands; never interprets away failures."* Give it the command and the
expected exit code; take back the raw output. If a lane reports a gate as green and
the verifier's raw output is not attached, the gate did not run.

---

## 3. Rigor tiers

Not every change earns the same gate. Applying T4 to a doc edit wastes a validation
window; applying T0 to a bicep change ships a broken deploy. Tier is chosen from the
**files touched**, not the issue's label.

| Tier | Trigger | Required evidence |
|---|---|---|
| **T0 — docs** | `docs/**`, `PRPs/**`, `*.md` only | Build renders; links resolve. No code gate. |
| **T1 — guard / CI script** | `scripts/ci/**`, `.github/workflows/**` | Guard runs at **parent** and at **tip** over the **same fixtures**, both outputs attached. **Mutation proof:** introduce the defect the guard claims to catch; the guard must go red. A guard that cannot be made red by its own target defect is not a guard. |
| **T2 — console** | `apps/fiab-console/**` | `tsc` clean · `vitest` for touched modules · **generated artifacts re-derived** (I1) · **browser E2E** per `ux-baseline.md` G1 — screenshot dark+light for canvases, click-walk of every control, narrow-width pass for badge overlap, first-open pass on a freshly created item. |
| **T3 — bicep / IaC** | `platform/fiab/bicep/**`, `deploy/**` | `bicep lint` · compiled-template diff (the compiled ARM is a **second artifact** and must be re-rendered, not hand-edited — a re-render **drops out-of-band state**, so diff it) · `what-if` where meaningful, understanding it is **blind to nested inner-scope** · a per-boundary statement (I8). |
| **T4 — deploy path** | any workflow that deploys, builds, or rolls | A **real run** with its conclusion attached. `gh run list` + the specific job's `steps\|length` — a `CANCELLED` run with `"steps":[]` measured **nothing** and is ABSENT, not RED. Then `/build-marker.txt` to confirm the estate actually moved. |

**Tier escalation is by union.** A PR touching a bicep file and a console file runs
T2 **and** T3. There is no "primary file".

---

## 4. Parallel execution shape

### 4.1 Lane cut

Lanes are cut from the **measured file lists** in `OWNERSHIP.md`. Two issues may run
in parallel **iff** their declared file sets are disjoint. Topic similarity is
irrelevant; two "auth" issues in the same file must serialize, two unrelated issues
in different files may not.

- **WIP ceiling: 4 implementing lanes.** Review-only and triage-only lanes are
  read-only, collide with nothing, and do not count against the ceiling.
- **Batch shape: big batches, one CI cycle each** (operator decision). Open the
  batch, let one CI cycle run, drain, open the next. Do not trickle PRs — past ~10
  cycling PRs the runners become the ceiling (24 active / 18 queued measured).
- **`strict: false` stays off.** Turning it on is quadratic and previously starved
  the runners into false reds across 12/12 PRs.

### 4.2 The batching pattern

```
phase("Triage")     → N parallel read-only agents, one per issue group   (sonnet)
phase("Implement")  → ≤4 parallel lanes, disjoint file sets              (sonnet|opus by size)
phase("Review")     → 1 reviewer per lane, different instance            (opus)
phase("Verify")     → raw gate output per lane                           (haiku)
phase("Merge")      → serialized; preflight each                         (operator)
```

Implementation pipelines by lane rather than by phase where possible: a lane's review
starts the moment *that* lane's diff exists, not when all four lanes finish. The
slowest lane must not gate the fastest lane's review.

### 4.3 The generated-artifact serialization hazard

Five committed generated files serialize every parallel PR that touches them. One
merge previously re-conflicted **seven** PRs and voided their CI.

```
security-graph.json
docs/fiab/route-inventory.md
apps/fiab-console/deploy-templates/main.json
apps/fiab-console/lib/api-routes.generated.d.ts  (+ .json)
scripts/ci/no-freeform-inputs-baseline.json
```

**Protocol:** after any base update, **re-derive in a scripted loop across every open
branch**. Never hand-merge a generated file — a hand-merge produces a file that
matches neither generator output and passes the drift check by coincidence.

Related trap: **the extractor walks the FILESYSTEM, not the git index.** A gitignored
file makes the drift gate unsatisfiable locally — `--check` returns rc=0 on the
workstation and RED in CI. If a drift gate is green locally and red in CI, check for
an untracked file in the walked tree before assuming the gate is broken.

---

## 5. Verification standards

### 5.1 What does not count as evidence

- `tsc` + `vitest` + a DOM-string check. Measured: an adoption passed every CI gate
  and **hard-froze the renderer** live; Browse pages rendered fine with **0-counts**
  because the data path was dead. Only the browser catches both.
- A fluent JSON answer. `200 / ok:true` with `plan:[]` and `steps:[]` is the best
  disguise a dead data path has. **Ask for the ROWS, never the prose.**
- Two agents agreeing via the same method.
- A green status rollup. Only 15 of ~35 checks can block.
- A type-correct fixture. A null-deref took all AI down in production while the
  22-test suite written *for* it passed 22/22. Ask **"what input shape has no
  fixture?"**, not only "what mutation fails?"

### 5.2 What does count

- Raw gate output from the verifier, unedited.
- A guard proven red by its own target defect, at parent and tip, same fixtures.
- A browser screenshot / Playwright trace with a real response body.
- A workflow run conclusion **with** `steps|length > 0`.
- `/build-marker.txt` matching the merge SHA.
- A per-boundary statement naming which clouds were exercised and which were not.

### 5.3 Reporting vocabulary — three distinct words

**merged** ≠ **deployed** ≠ **verified live.** Never substitute one for another.
`deploy-integrity.md` R2 exists because a two-week window of green merges could not
change anything the operator could see. If something is merged and not rolled, the
words are exactly *"merged, not deployed."*

---

## 6. Guard hardening — the two-round stop rule

W5 hardens guards. Guard work has a measured failure mode: it becomes an infinite
regress of narrower enumerations, and the "fixes" start regressing.

- **Round 1:** fix the measured bypass. Attach mutation proof.
- **Round 2:** fix what round 1's own mutation testing found. Attach both.
- **Round 3: STOP.** Merge the gain. **File the class as an issue.** Do not continue.

Measured basis: one guard went three rounds and **three of round-2's fixes were
regressions**; another lost round 1 to a spelling and round 2 to a 44-byte move into
another function with a **byte-identical log**. The lesson is to assert the
**outcome**, not the shape of the bypass.

**Guard design rule:** key a guard to the *shape* of the defect, never to a spelling
list. A control can be **present and unreachable** — below an `exit 1`, inside a
terminal `else`. And a filter **inside** the predicate beats the population
contract: a `continue` goes red, a `SKIP_FILE`/param filter does not.

---

## 7. Failure handling inside a lane

| Situation | Action |
|---|---|
| Fix needs a file outside declared ownership | **STOP. Report a blocker.** Do not widen. (I5) |
| Triage verdict is stale at head | Re-measure, update `LEDGER.md`, then proceed or close |
| Gate red for an unrelated reason | Do not `continue-on-error`, do not `\|\| true`, do not `2>/dev/null`. A discarded result is forbidden in a deploy path. |
| Agent returns a verdict | It is not posted. `gh pr comment` it. (I3) |
| Agent reports `completed` with a zero-byte output | Treat as **not run**. Re-run. Measured twice this program. |
| Agent dies on "Prompt is too long" | Split the batch. Do not retry verbatim. |
| Subagent `.output` needs reading | **Never Read it directly** — it is a full JSONL transcript (200KB–980KB). Prefer the task-notification `<result>` payload; the tail-block extractor **truncates long reports** (one 27-issue report extracted to 818 chars). |

---

## 8. Environment constraints

These are workstation facts that have each cost real time.

- **Python is `python`**, never `python3` (the latter hits the Store shim).
  `sys.stdout.reconfigure(encoding="utf-8")` at module top; explicit
  `encoding="utf-8"` on every text read.
- **`cmd /c "…"` from Git Bash is a FALSE SUCCESS** — it opens an interactive shell,
  exits 0, and the command never runs. Verify by **effect**, not exit code.
- **Shell CRLF probes lie in both directions.** Count bytes in Python.
- **`bash` invoked from Windows Python resolves to WSL bash.** Re-run one case
  natively before believing a mass failure.
- **`find` / `Glob` / `rg` time out under agent load.** Use `git ls-files`.
- **`az tsv` and `gh --json` output carry `\r`.** A perfect zero result is the tell.
- **The workstation `az` context is a different tenant.** Run `az account show`
  first. There is **no local `az` path to Gov, ever** — Gov receipts come from a
  GitHub Actions run in-boundary.
- **`git stash` is repo-global** — a hazard with parallel agents in one worktree.
- **Worktree `node_modules` junctions can delete MAIN's copy.** Tear down with
  `cmd /c rmdir`, and see the false-success caveat above.
- **`containerapp exec` has a ~2KB URL cap**; an IIS 404 really means "too long",
  and chunking to fix it trips a 429 with `retry-after: 600`. One exec, minified.
- **`RC=$?` on the line immediately after the subject command**, never after a pipe.

---

## 9. Estate discipline

The estate is **PAUSED** by default in both MAC and MAG. It costs ~$3k/mo unpaused.

- Estate work batches into **declared validation windows** (operator decision).
  Open the window, collect every queued `NEEDS-ESTATE` receipt, close the window,
  return to PAUSED.
- **A pause changes deploy behaviour.** Measured: a paused Analysis Services caused
  five identical `resource-mid-update` exhaustions; a "transient" that *recurs* is a
  standing condition, not a flake. The pause also blinds the What-If lane — What-If
  is not a required check, so its absence is silent.
- **The Commercial estate rolls itself.** Read `/build-marker.txt` before saying
  "merged, not deployed" — it may already be live. Gov does not roll on the same
  trigger; read Gov's own marker.
- **Rapid merges cancel CI and strand the roll** — every PR green, estate frozen.
  This is why batches take one CI cycle each.

---

## 10. Lane definition-of-done checklist

A lane closes only when every box is checked. Unchecked with no documented
honest-gate = reviewer rejects.

- [ ] Verdict re-verified at head (carried findings are hypotheses)
- [ ] Diff confined to declared file ownership
- [ ] Rigor tier evidence attached, raw and uninterpreted
- [ ] Generated artifacts re-derived, not hand-merged
- [ ] Reviewer verdict **posted** on the PR
- [ ] Preflight run: `merge-eligible` + `hollow-control`
- [ ] Boundaries stated: which clouds verified, which explicitly not
- [ ] Post-merge: issue closure audited (a merge can auto-close an unclaimed issue;
      the string *"Does not close #N"* **closes #N**)
- [ ] Status reported in the correct word: merged / deployed / verified live
