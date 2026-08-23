# L7 — Docs & Parity Artifacts

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 1
**Rigor:** Normal (gates + one independent pass)
**Suggested concurrency:** up to **3** agents in this lane simultaneously.
**Inventory:** **6 open issues** (1 bugs, 0 epics, 0 labelled security).

## 1. Thesis

Docs are a source of truth in this repo, and a stale parity doc is a false claim with a grade attached.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `docs/**`
- `*.md at repo root except CLAUDE.md`
- `PRPs/archive/** (disposition notes only)`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `any code path`
- `CLAUDE.md and .claude/rules/** (operator-owned)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `mkdocs build where the site is touched`
- `every claim in a parity doc traced to a receipt or removed`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- `</>` in a page crashes py3.12 mkdocs.
- Four Platform & Admin parity docs are CONFIRMED stale (rev.5, 2026-06-09) and self-grade against fixes that have since landed.
- A parity doc is A-grade only at zero MISSING rows — a self-graded D is a defect, not a status.
- Write in the operator's CDO voice; no customer framing.

## 5. Fan-out plan

1. **Triage pass first (1 agent, sp:1).** Walk the inventory in §7 and split it into
   `real` / `stale` / `duplicate` / `already-fixed`. Verify "already-fixed" by measurement
   — several issues in this repo claim a current failure that is no longer true, and
   several claim a fix that never deployed. Record the verdict as an issue comment.
2. **Batch the survivors by shared file.** Two items touching the same file become ONE
   work item, or they run sequentially. This is the step that prevents the merge
   treadmill, and it is where most of the wall-clock is won or lost.
3. **Fan out to 3 concurrent agents**, each in its own worktree, each owning a
   disjoint file set from step 2.
4. **Serialize the merges.** Branch protection is `strict`, so every merge invalidates
   the branches behind it. Merge one, re-verify, merge the next. Prefer batching several
   fixes per PR over one PR per issue: with strict protection, N PRs cost N CI cycles.

## 6. Definition of done for this lane

- Every §7 issue is closed, or re-scoped with its reason recorded, or explicitly deferred
  by the operator.
- Every closure is on DEPLOYED-and-verified evidence, never on a merge.
- No guard introduced by this lane passes when its subject is mutated.
- The lane's own landmine list in §4 has been extended with anything new it learned.

## 7. Issue inventory (6)

| # | title | labels |
|---|---|---|
| #3778 | lakebase-postgres: re-audit against Lakebase GA-on-Azure surface and rebuild the parity doc with real rows | csa-loom,documentation,lane:console,sprint:next |
| #3774 | Governed metrics layer: certified KPI definitions consumable by BI + agents (UC Metrics / business-semantics p | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3764 | Mirroring: add Azure Monitor Logs as a mirrored source (Fabric GA Build 2026 parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3763 | Mirroring: add Oracle as a mirrored-database source type (Fabric preview 2026 parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3762 | Mirroring: add BigQuery as a mirrored-database source type (Fabric preview 2026 parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3722 | ai-red-team: parity doc explicitly says "Not A-grade" — untracked | bug,csa-loom,lane:console,sprint:next |

