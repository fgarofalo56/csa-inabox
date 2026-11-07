# L5 — Console: Admin & UX Surfaces

**Parent:** [`PRP.md`](./PRP.md) (OMNIBUS master, 2026-08-22) · **Wave:** 1
**Rigor:** Normal (gates + one independent pass)
**Suggested concurrency:** up to **5** agents in this lane simultaneously.
**Inventory:** **34 open issues** (23 bugs, 1 epics, 0 labelled security).

## 1. Thesis

Fabric is the FLOOR, not the target. Functional-but-below-baseline is not done.

## 2. Declared file ownership — this is what makes the fan-out safe

Parallel safety in this repo is a FILE property, not a topic property. An agent in this
lane may edit ONLY these paths:

- `apps/fiab-console/app/admin/**`
- `apps/fiab-console/lib/components/**`
- `apps/fiab-console/app/(workspace)/**`
- `apps/fiab-console/app/items/**`

It must NOT touch (another lane owns them, and a shared-file edit must be sequenced,
never parallelised):

- `apps/fiab-console/lib/editors/** (L3)`
- `apps/fiab-console/app/api/** (L4)`

If an item genuinely needs a file this lane does not own, it does **not** take the file.
It stops and routes through the master's §6 cross-lane procedure.

## 3. Gates — the bar for "done" in this lane

- `pnpm vitest run <surface suites>`
- `pnpm next build`
- `G1 browser receipt: click EVERY control, dark AND light, plus a narrow-width pass`

`make validate` remains the whole-repo bar. A narrow gate passing is not `make validate`
passing, and neither is a merge: **done means DEPLOYED and verified live.**

## 4. Landmines — read before writing any code here

These are measured, not theoretical. Each one has already cost this repo real time.

- DOM strings are NOT parity. A surface is verified by a click-walk, not by a grep.
- A LIVE browser found 2 bugs CI missed. Budget for the browser pass; it is the gate, not a formality.
- Zero day-one gates: a remediation MessageBar with no inline Fix-it is non-compliant.
- Every canvas/graph/query pane needs SplitPane + a persisted sizingKey.
- A freshly created item must open with NO error banner.
- Use TileGrid / EmptyState / PageShell — never a raw grid or a bare <div> empty state; never hard-coded px or hex.

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

## 7. Issue inventory (34)

| # | title | labels |
|---|---|---|
| #3856 | authflow spec: flipping the last base64url char often tampers nothing, so the test passes for the wrong reason |  |
| #3852 | release-please silently drops commits whose BODY the parser cannot read — 15 lost since 2026-06-11 | bug |
| #3851 | bulk-delete tenant-boundary suite: the disclosed residual reads exhaustive, but a joint (size, index) key is b |  |
| #3831 | copilot-quality-evals: the help floor sits inside the judge's own noise band, so it fails on unrelated branche |  |
| #3804 | Eight UAT harnesses mint a LIVE session as an all-zeros principal when the identity env var is unset — it alre | bug |
| #3802 | KNOWN_SPLIT exemptions validate the issue reference's FORM but not its referent — pin the title alongside the  | bug |
| #3793 | fix(readiness): DENIED is a bare substring test — a subscription id containing 401/403 misclassifies every fai | lane:console,sprint:next |
| #3768 | Data agents: service-principal / app-identity binding UI (Fabric June 2026 GA parity) | csa-feature-request,csa-loom,enhancement,lane:console,sprint |
| #3752 | Policy as code: 'Load sample' shows 3 statements visibly targeting 5 backends, but every compiled backend tab  | bug,csa-loom,lane:console,sprint:next |
| #3749 | DLP → Policies 'Graph read' card blames a missing env var when Graph is enabled and the real cause is a tenant | bug,csa-loom,lane:console,sprint:next |
| #3748 | Landing zone map renders empty (React hydration error #418) despite real attached-DLZ data | bug,csa-loom,lane:console,sprint:next |
| #3746 | External-engine federation: 'Live' badge shows green success next to the red 'Catalog unreachable' error, and  | bug,csa-loom,lane:console,sprint:next |
| #3743 | Copilot usage 'Top users' Est. cost is ~13x inflated vs the same calls' Total/By-persona/By-model cost (per-us | bug,csa-loom,lane:console,sprint:next |
| #3742 | Copilot quality Budgets 'New budget' dialog requires typing a raw workspace/agent Scope id by hand instead of  | bug,csa-loom,lane:console,sprint:next |
| #3739 | FinOps Cockpit: anomaly feed and budgets panels show a false confident empty state when their read fails | bug,csa-loom,lane:console,sprint:next |
| #3738 | usage-adoption.md (rev.5, 2026-06-09, graded A) is stale — /admin/usage has grown far beyond its documented sc | csa-loom,documentation,lane:console,sprint:next |
| #3736 | Health hub Journeys tab: about 1 in 6 synthetic-journey runs show zero journeys with 'crashed before Playwrigh | bug,csa-loom,sprint:next |
| #3734 | Incident console 'New monitor' dialog asks for a raw item id + catalog.schema.table string instead of a picker | bug,csa-loom,lane:console,sprint:next |
| #3733 | Performance hub: Recommendations card claims 'everything is inside its bars' while the same page shows cache h | bug,csa-loom,lane:console,sprint:next |
| #3731 | fix(ui): three Runs grids drop truncatedBy, turning a disclosed partial back into a silent wrong answer | lane:console,sprint:next |
| #3725 | 4 Platform & Admin parity docs (rev.5, 2026-06-09) are confirmed stale — real bug fixes landed after the grade | csa-loom,documentation,lane:console,sprint:next |
| #3724 | Two fully-built admin pages have no nav path in: /admin/classifications and /admin/sensitivity-labels | bug,csa-loom,lane:console,sprint:next |
| #3684 | Studio extension fails to log in | bug,lane:console,sprint:next |
| #3673 | RibbonAction.title is silently discarded — every disabled ribbon button loses its explanation (ribbon.tsx:254- | bug,csa-loom,lane:console,sprint:next |
| #3632 | activation-sync: 'Container' picker (and likely sibling pickers) never opens — blocks the entire setup flow | bug,lane:console,sprint:next |
| #3575 | variable-library: unresolved @{variables.NAME} refs are echoed verbatim with no user-visible signal (root caus | bug,lane:console,sprint:active |
| #3574 | user-data-function Test/Run sends None for blank optional params instead of omitting them, crashing functions  | bug,lane:console,sprint:active |
| #3565 | ai-foundry-hub: selecting a non-Loom AI Foundry account has no recovery path back to the auto-bound default | bug,lane:console,sprint:next |
| #3548 | KQL queryset 'Run the smoke test' card creates an empty query, not the promised print statement | lane:console,sprint:next |
| #3528 | App-install workspace picker dropdown can become click-dead after a React hydration error (#418) until page re | bug,csa-loom,lane:console,sprint:next |
| #3527 | V&V Sprint: Item & App Catalog coverage matrix (142 items + 29 apps) — 2026-08-15 | csa-loom,epic,lane:console,sprint:next |
| #3520 | geo/Azure Maps account field shows the configured account name only as a placeholder hint, never auto-populate | bug,csa-loom,lane:console,sprint:next |
| #3516 | azure-sql AAD admin dialog requires typing a directory object id (GUID) by hand instead of a directory picker | bug,csa-loom,lane:console,sprint:next |
| #2583 | G1 browser E2E receipt for the AOAI target-resolution path (#2557 / #2568) | lane:console,sprint:blocked |

