# L3 — Console: Item Types & Editors

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 1
**Rigor:** Normal (gates + one independent pass) — EXCEPT data-loss shapes, which are FULL
**Suggested concurrency:** up to **5** agents in this lane simultaneously.
**Inventory:** **21 open issues** (12 bugs, 2 epics, 0 labelled security).

## 1. Thesis

The editors are where users meet Loom. Feature-present-but-broken is the dominant defect shape here.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `apps/fiab-console/lib/editors/**`
- `apps/fiab-console/app/api/cosmos-items/[type]/[id]/route.ts (CROSS-LANE, see §4)`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `apps/fiab-console/app/api/** except the one route named above (L4)`
- `apps/fiab-console/lib/components/** (L5)`
- `apps/fiab-console/lib/azure/** (L6)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `pnpm vitest run <changed editor suites>`
- `pnpm next build`
- `a live in-browser G1 receipt — tsc + vitest are explicitly NOT completion evidence`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- ISSUE #3878 IS THIS LANE'S ANCHOR and it is a cross-lane item: two response-envelope families are interleaved under /api/. `cosmos-items` GET/PATCH return the BARE document; CREATE/DELETE and the hand-written item routes return `{ok,item}`. Seven confirmed dead `j.ok` statements across 4 editor files.
- The same `j.ok` read is CORRECT on one branch of a ternary and DEAD on the other (graph-editors.tsx:949 — POST create is wrapped, PATCH update is bare). Fix the envelope, not the call site, or you will half-fix the family as data-product-editor.tsx already did.
- A fixture keyed to the right URL with the WRONG shape keeps the defect green. geo-pipeline.test.tsx:36 and semantic-model.test.tsx mock the wrapped shape against a bare route.
- Every item GET normalises `state: item.state || {}`, so `state` is NEVER undefined over the wire — a guard keyed on absence has zero population.
- Canvas nodes ~160-190px, ONE on-node badge, flexWrap + minWidth:0 or badges overlap.

## 5. Fan-out plan

1. **Triage pass first (1 agent, sp:1).** Walk the inventory in §7 and split it into
   `real` / `stale` / `duplicate` / `already-fixed`. Verify "already-fixed" by measurement
   — several issues in this repo claim a current failure that is no longer true, and
   several claim a fix that never deployed. Record the verdict as an issue comment.
2. **Batch the survivors by shared file.** Two items touching the same file become ONE
   work item, or they run sequentially. This is the step that prevents the merge
   treadmill, and it is where most of the wall-clock is won or lost.
3. **Fan out to 5 concurrent agents**, each in its own worktree, each owning a
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

## 7. Issue inventory (21)

| # | title | labels |
|---|---|---|
| #3862 | Python Tests are required contexts but apps/copilot/** is outside their paths filter, so they report green hav |  |
| #3801 | 24 of 32 content-bearing semantic models reference a parent workspace the caller cannot see — editors render e | bug |
| #3796 | auto-bind §1/no-vaporware: install reported 'created' with counts for 36 pipelines whose backing object was em | lane:console,sprint:active |
| #3770 | Fabric 2026 P2 umbrella: SharePoint/OneDrive + cross-warehouse shortcuts, mirror private-link, Airflow NL auth | csa-feature-request,csa-loom,enhancement,epic,lane:console,s |
| #3735 | RUM hub: PAGE LOADS and ROUTE CHANGES both read 0 in the last 24h while Web Vitals reports 55 sampled page vie | bug,csa-loom,lane:console,sprint:next |
| #3729 | P0-live: Core platform readiness reports "Azure subscription + resource groups" blocked, but its Fix-it dialog | bug,csa-loom,lane:console,sprint:active,sprint:next |
| #3723 | model-serving-endpoint: the only item type in the 142-item catalog with zero parity doc | csa-loom,documentation,lane:console,sprint:next |
| #3720 | slate-app: parity doc self-grades D ("target A once P0+P1 land") — the only doc-confirmed D-grade item type, u | bug,csa-loom,lane:console,sprint:next |
| #3700 | data-pipeline publish PUTs the canvas-render shape straight to ADF — publishes successfully, does nothing | bug,csa-loom,lane:console,sprint:blocked |
| #3699 | Canvas design surfaces: independently resizable stacked docks + hideable minimap (default for ALL canvases) | csa-feature-request,csa-loom,epic,lane:console,sprint:next |
| #3687 | SYSTEMIC: useItemState renders a client-side fallback that is never persisted — 24 editors show config the ser | bug,lane:console,sprint:next |
| #3567 | mapping-dataflow: every newly created item fails to load with 'invalid data flow name' — item type is complete | bug,lane:console,sprint:next |
| #3566 | dashboard item: bare 'powerbi GET .../dashboards failed' error gives no reason or remediation | bug,lane:console,sprint:next |
| #3564 | adf-dataset editor shows false 'NotFound' error on first render after item creation (self-heals on refresh) | bug,lane:console,sprint:next |
| #3562 | Fine-tuning job editor: 'Load failed — API version not supported' on every open | lane:console,sprint:next |
| #3551 | P0: Activator rules are silently empty across multiple apps — same 'created but empty' pattern as #3549 | lane:console,sprint:active |
| #3541 | Health-check editor requires typing a Logic App resource id by hand for notification wiring | bug,csa-loom,lane:console,sprint:next |
| #3539 | App-installed notebooks briefly render generic 'New notebook' placeholder instead of their real bundle content | bug,csa-loom,lane:console,sprint:next |
| #3536 | Backlog: add 'Exploration' item type (Fabric parity gap) | csa-loom,enhancement,lane:console,sprint:next |
| #3535 | Backlog: add 'Anomaly detector' item type (Fabric parity gap) | csa-loom,enhancement,lane:console,sprint:next |
| #3514 | mounted-adf editor's 'Mount an existing ADF' dialog requires typing subscription id / resource group / factory | bug,csa-loom,lane:console,sprint:next |

