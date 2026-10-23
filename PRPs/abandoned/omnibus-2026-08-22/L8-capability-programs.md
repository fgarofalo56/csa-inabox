# L8 — Capability Programs

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 2
**Rigor:** Normal at design, FULL at any auth/data/deploy touchpoint
**Suggested concurrency:** up to **3** agents in this lane simultaneously.
**Inventory:** **3 open issues** (0 bugs, 1 epics, 0 labelled security).

## 1. Thesis

The surviving forward-looking work from the 21 archived PRPs. Feature build, not defect drain — it starts only when the defect lanes are demonstrably down.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `new directories declared per work item, plus the lane that owns each touched file BY DELEGATION`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `editing a file owned by an active L0-L7 item without sequencing through this program's master`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `the owning lane's gates apply to every file touched`
- `a threat model BEFORE build for any new service`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- This lane inherits the unfinished checkbox work of the archived PRPs: geo-graph-ml (29 open), access-governance (9 open), foundry-parity (9 open). Those counts are real and were measured at archive time.
- No silent scope growth: anything discovered mid-item is filed and routed through the master, never absorbed.
- Do not start a capability whose foundation is an open L0-L7 defect. Fix-before-build on shared files.

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

## 7. Issue inventory (3)

| # | title | labels |
|---|---|---|
| #3721 | digital-twin: 27 missing capability rows, untracked despite being the worst gap in Real-Time Intelligence | csa-loom,enhancement,lane:console,sprint:next |
| #3589 | APIM origin fields could offer a picker over discovered Backend entities alongside the free-text BYO path | enhancement,lane:console,sprint:next |
| #3361 | EPIC: end-to-end access management — grant, scope, pause, and revoke CSA Loom access | csa-feature-request,csa-loom,epic,lane:console,sprint:blocke |

