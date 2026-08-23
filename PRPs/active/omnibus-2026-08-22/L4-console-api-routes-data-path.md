# L4 — Console: API Routes & Data Path

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 1
**Rigor:** FULL mutation-proof (data path)
**Suggested concurrency:** up to **3** agents in this lane simultaneously.
**Inventory:** **8 open issues** (3 bugs, 0 epics, 0 labelled security).

## 1. Thesis

The BFF is the contract. An envelope, a status code, or a scope decided wrongly here is invisible until it is a security or data-loss incident.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `apps/fiab-console/app/api/** (EXCLUDING L1's declared authz list and the one cosmos-items route owned by L3)`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `apps/fiab-console/lib/auth/** (L1)`
- `apps/fiab-console/lib/editors/** (L3)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `pnpm vitest run <route suites>`
- `scripts/ci/check-route-toolkit.mjs in PER-KEY mode — the global total is not the teeth`
- `a real-data E2E receipt per no-vaporware.md`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- The route-toolkit ratchet's global total read `1059 = 1059` WITH a live violation. Use the PER-KEY mode; never take its `--update-baseline` escape hatch.
- A dead endpoint scores PERFECT on a safety sweep. Prove the route is reachable before crediting its safety.
- Coordinate with L3 on #3878: whoever changes the cosmos-items envelope changes it ONCE, and the sweep + a guard land together.
- `withSession`'s 401 body is byte-identical to the hand-rolled one (route-toolkit.ts:82-83) — conversions are behaviour-preserving and that is measurable, not assumed.

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

## 7. Issue inventory (8)

| # | title | labels |
|---|---|---|
| #3847 | Enable exactOptionalPropertyTypes in apps/fiab-console/tsconfig.json |  |
| #3832 | auto-bind sweep has no caller — the route exists, nothing schedules it |  |
| #3727 | perf(browse): /browse fetches the same 500-item query 8x per load (~1.5 MB, 5.07s) — measured live | lane:console,sprint:next |
| #3610 | POST /api/setup/identity emits a copy-paste bootstrap command with unescaped caller input (operator-terminal i | lane:console,sprint:active |
| #3578 | content-safety: 'Analyze text' consistently fails with bare 'Error fetch failed' — no status, no reason | bug,lane:console,sprint:next |
| #3526 | activation-sync destination config requires typing Event Grid/Service Bus endpoints instead of picking a bound | bug,csa-loom,lane:console,sprint:next |
| #3524 | App-installed items briefly show a scary 'No containers visible to BFF identity' error on first open — self-re | bug,csa-loom,lane:console,sprint:next |
| #3353 | Evaluate Azure API Center for the API marketplace surface (today Loom-native) | csa-feature-request,csa-loom,lane:console,sprint:blocked |

