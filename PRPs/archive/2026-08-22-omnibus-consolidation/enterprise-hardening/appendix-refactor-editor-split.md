# Appendix — Refactor: Split the Monster Editor Files

**Domain:** `refactor-editor-split`
**Scope:** `apps/fiab-console/lib/editors/` — break the five largest editor modules into
per-item-type files behind the existing lazy registry, with zero behavior change and a
per-editor build/test gate, to unblock parallel development and end all-session merge pain.
**Author stance:** This is a build-time **code-organization** change. It has **no runtime,
identity, endpoint, RBAC, or scale surface** — so the usual enterprise-hardening cross-cuts
(OBO, Cosmos partitioning, AOAI PTU, Front Door failover, Gov endpoints, 60k-user quota)
are **Not Applicable as design targets**. The cross-cuts that *do* apply are: (a) the refactor
must be **behavior-identical in both Commercial and Gov** because several editors branch on the
cloud suffix; (b) the no-vaporware / web3-ui / ui-parity rules require **zero UI or backend
regression**; (c) the real "scale" win is **developer scale** — N agents/engineers editing N
item-types without colliding in one 18k-line file. Those are addressed below; I do not invent
Azure-service work that this domain does not have.

---

## 1. Current state (grounded in the code)

### 1.1 The five monsters

| File | Lines | Top-level editor exports | Shape |
|------|------:|-------------------------:|-------|
| `lib/editors/phase3-editors.tsx` | 18,078 | 13 editors + `EventhouseCapacityPanel` | **Multi-editor** (RTI/KQL + Warehouse + Power BI family) |
| `lib/editors/databricks-editors.tsx` | 5,824 | 4 editors | **Multi-editor** |
| `lib/editors/lakehouse-editor.tsx` | 5,014 | 1 editor (`LakehouseEditor`) | **Single mega-component**, 8 tabs |
| `lib/editors/phase4-editors.tsx` | 4,979 | 9 editors | **Multi-editor** |
| `lib/editors/report-designer.tsx` | 4,164 | 1 editor (`ReportDesigner`) | **Single mega-component**, orchestrator over `report/` panes |

Total ≈ 38k lines in five files. `phase3-editors.tsx` alone is ~1.02 MB on disk.

### 1.2 The one fact that makes this safe — the registry is **already** a lazy indirection

`lib/editors/registry.ts` maps every item-type slug to a component via `next/dynamic` and a
**named-export pick**:

```ts
const reg = (loader, name) =>
  dynamic(() => loader().then((m) => ({ default: m[name] })), { ssr: false });

'eventhouse':   reg(() => import('./phase3-editors'), 'EventhouseEditor'),
'kql-database': reg(() => import('./phase3-editors'), 'KqlDatabaseEditor'),
// …13 phase3 slugs all import('./phase3-editors')
```

Because each slug already names *both the module and the export*, moving an editor to a new file
is a **one-line edit per slug** (`import('./phase3-editors')` → `import('./phase3/eventhouse-editor')`).
No call-sites elsewhere construct these editors directly. `getEditor(slug)` is the only public API.

### 1.3 Who else imports the monsters (the real consumer set)

A repo-wide search (`grep -rln "phase3-editors"`) shows the **only** importers of `phase3-editors`
are: `registry.ts` and the per-editor tests in `lib/editors/__tests__/*.test.tsx`
(`import { EventhouseEditor } from '../phase3-editors'`, etc.). The other apparent hits
(`warehouse-editor.tsx`, `components/model-tabs-extra.tsx`, `app/api/items/route.ts`,
`pbi-content-fallback.ts`, `provisioners/kql-dashboard.ts`) match the **string** "phase3" in
comments, **not** an `import`. So the consumer graph is tiny and fully enumerable:

```
phase3-editors.tsx  ←  registry.ts (13 dynamic imports)
                    ←  __tests__/{eventhouse,kql-*,eventstream,activator,warehouse,
                                   semantic-model,report,paginated-report,dashboard,
                                   scorecard,stored-function}.test.tsx  (named imports)
```

databricks/phase4/lakehouse/report-designer have the same two-consumer shape (registry + tests).

### 1.4 Internal structure / the real risk = shared module-private helpers

`phase3-editors.tsx` has ~179 top-level `function`/`const`/`type` declarations; the 13 editors are
public, the rest are **module-private** sub-components and helpers. Some are editor-local
(e.g. `PaginatedReportDesigner`'s dialogs); a cross-cutting set is **shared across editors**:
`vizFromRender`, `fmtCell`/`formatCell`, `ResultChart`, `PieChart`, `MapVisual`, `TileVisual`,
`KqlResultsPanel`, `ConditionalTable`, `computeColStats`, `kqlResultToCsv`, `downloadTextFile`,
`useWorkspaces`, `usePowerBiWorkspaces`, `WorkspacePicker`, `ConditionalFormattingEditor`, etc.
**These shared helpers are the only thing that makes a naive cut break the build** — if you move
`EventhouseEditor` and it references `KqlResultsPanel` that stays behind, you get a broken import.
The mechanical plan therefore extracts **shared helpers first, in their own commit**, then editors.

### 1.5 The team already does sub-component extraction

`lib/editors/components/` (≈50 files) and `lib/editors/report/` (≈30 panes) are the **established
pattern**: heavy sub-surfaces are pulled into a subdir and imported back. `report-designer.tsx` is
already an orchestrator over `report/*` panes; `lakehouse-editor.tsx` already pulls many pieces from
`components/*`. The split below **continues this proven pattern** rather than inventing a new one.

### 1.6 Build / gate facts

- `tsconfig.json`: `"isolatedModules": true`, `"incremental": true`, path aliases `@/`, `@/lib/*`.
  `isolatedModules` means each file must transpile independently — **type-only re-exports must use
  `export type { … }`**, and no cross-file `const enum`. This is a hard constraint on the barrel.
- Scripts: `build` = `next build`, `test` = `vitest run`, `lint` = `next lint`, `uat` = Playwright.
- **The vitest render harness is known-broken repo-wide** (env `node`, no jsdom setupFile — see
  MEMORY `fiab_console_vitest_harness_broken`). So the **authoritative gate is `tsc --noEmit` +
  `next build`** (chunk graph + type resolution), with the per-editor `__tests__` runs as a
  best-effort signal and a real **browser smoke** (open each item, confirm the lazy chunk loads
  and the primary action fires) as the no-vaporware receipt. No tooling for circular-dep detection
  exists (`madge`/`dependency-cruiser`/`knip` absent) — add `madge` as a dev-only guard (§4.4).

---

## 2. Grounding (authoritative patterns)

- **Dynamic import = code-split boundary.** Microsoft Learn (SPFx dynamic loading,
  `learn.microsoft.com/sharepoint/dev/spfx/dynamic-loading`) confirms the webpack rule the Loom
  registry already relies on: `await import('x')` splits `x` into its own chunk loaded on demand,
  and *"not every file should be dynamically imported — group like code blocks into a single
  bundle."* Implication for Loom: keep **one chunk per editor file** (the registry already gives us
  one `dynamic()` per slug); do **not** over-split shared helpers into dozens of micro-chunks —
  put them in a shared module that each editor chunk imports (webpack will hoist the shared module
  into a common chunk automatically).
- **Next.js `next/dynamic`** (Context7 `/vercel/next.js`) is a wrapper over `React.lazy` +
  `Suspense`; `{ ssr: false }` (already set) keeps these client-only. Repointing a `dynamic`
  loader's import path is a pure build-time change — no API/runtime contract moves.
- **TypeScript `isolatedModules` + project structure** (Learn "Work with multiple projects and
  project references", MSBuild incremental-build docs by analogy): the smaller and more
  one-to-one your compile inputs→outputs, the faster and more cacheable incremental builds get —
  i.e. 13 small files rebuild only the touched editor, where today any one-char change in
  phase3-editors re-type-checks 18k lines. This is the *build-perf* dividend of the split.

These are the only authoritative sources this domain needs; Next.js/React (via Context7) and the
SPFx/webpack Learn doc are the relevant ones — there is no Azure-service, OBO, or Cosmos surface
here to ground.

---

## 3. Target structure

Mirror the multi-editor vs single-component distinction:

```
lib/editors/
  phase3/
    _shared/
      kql-visuals.tsx        # ResultChart, PieChart, MapVisual, TileVisual, StatCard, LoomVisual
      kql-results.tsx        # KqlResultsPanel, ConditionalTable, conditional-format helpers
      kql-format.ts          # vizFromRender, fmtCell, formatCell, kqlResultToCsv, computeColStats,
                             #   downloadTextFile, slugifyForFile, pickNumericCol, refreshLabel, genId
      workspace-hooks.tsx    # useWorkspaces, usePowerBiWorkspaces, WorkspacePicker
      index.ts               # re-export barrel for the shared set (type-only via `export type`)
    eventhouse-editor.tsx    # EventhouseEditor (+ EventhouseCapacityPanel, EventhouseOverviewPanel)
    kql-database-editor.tsx  # KqlDatabaseEditor (+ parseFnParams/serializeFnParams)
    kql-queryset-editor.tsx  # KqlQuerysetEditor
    kql-dashboard-editor.tsx # KqlDashboardEditor (+ Loom tile dialogs)
    eventstream-editor.tsx   # EventstreamEditor (+ EventstreamSqlOperatorTab, aliasesFromQuery)
    activator-editor.tsx     # ActivatorEditor
    warehouse-editor.tsx     # WarehouseEditor   (NB: distinct from the existing top-level
                             #   warehouse-editor.tsx — place under phase3/, no name clash)
    semantic-model-editor.tsx# SemanticModelEditor (+ AAS/security/copilot panes)
    report-editor.tsx        # ReportEditor, ReportLikeEditor, LoomNativeReportEditor, ReportCopilotPanel
    paginated-report-editor.tsx # PaginatedReportEditor (+ Tablix/Dataset/DataSource/Parameter dialogs)
    dashboard-editor.tsx     # DashboardEditor (+ Pinned/QA/Streaming tile dialogs)
    scorecard-editor.tsx     # ScorecardEditor
    datamart-editor.tsx      # DatamartEditor (deprecated/migration-only)
  phase4/                    # 9 editors → 9 files (+ _shared if any)
  databricks/                # 4 editors → 4 files (+ _shared)
  lakehouse/                 # tab-panel extraction (see §3.2)
  report/                    # already exists — finish the orchestrator extraction (see §3.2)
```

### 3.1 Multi-editor files (phase3, phase4, databricks) — the easy, high-value case

Each public editor moves to its own file; the **barrel stays** as pure re-exports for backward
compatibility during migration:

```ts
// lib/editors/phase3-editors.tsx  (after migration — a thin barrel)
'use client';
export { EventhouseEditor, EventhouseCapacityPanel } from './phase3/eventhouse-editor';
export { KqlDatabaseEditor }    from './phase3/kql-database-editor';
export { EventstreamEditor }    from './phase3/eventstream-editor';
// …one line per moved editor
```

This barrel keeps **both** the registry's `import('./phase3-editors')` lines **and** every
`__tests__/*.test.tsx` named import resolving unchanged — so each editor can be extracted and merged
independently, in any order, with the rest of the file untouched. (Per `isolatedModules`, re-export
**types** with `export type { … }`.)

### 3.2 Single-mega-component files (lakehouse, report-designer) — the harder, lower-priority case

`LakehouseEditor` and `ReportDesigner` are **one component each** with shared `useState`, so you
cannot "split by editor". You split by **tab/panel**, continuing the `components/`–`report/`
pattern. The lakehouse component has a clean 8-tab seam already in the JSX
(`Files / Tables / History / Schemas / Preview / SQL / Shortcuts / Security`). Each tab body becomes
a `LakehouseFilesTab`, `LakehouseSecurityTab`, … component in `lib/editors/lakehouse/`, receiving the
slice of state + callbacks it needs as props; the shell file keeps the tab strip, top-level state, and
data fetching. `report-designer.tsx` is already an orchestrator over ~30 `report/*` panes — the
remaining 4.2k is mostly the canvas/state controller; extract the largest inline panels
(format/analytics/data-source controllers) the same way. **No barrel needed** here (single export
name unchanged), so the risk is purely intra-component state plumbing — hence P2 and a heavier gate.

---

## 4. The mechanical migration (strangler-fig, one editor at a time)

### 4.1 Phase A — extract shared helpers FIRST (one commit, no editor moves)

1. Create `lib/editors/phase3/_shared/{kql-format.ts, kql-visuals.tsx, kql-results.tsx,
   workspace-hooks.tsx, index.ts}`.
2. **Move** (cut, do not copy) the shared module-private helpers from §1.4 into those files and
   `export` them. In `phase3-editors.tsx`, add `import { … } from './phase3/_shared'` at the top and
   **delete** the now-moved local declarations.
3. Gate: `pnpm tsc --noEmit` (resolves all references) + `pnpm build` (chunk graph still builds).
   The editors are byte-identical in behavior — only the *location* of helpers moved.
4. Commit: `refactor(editors): extract phase3 shared KQL/PBI helpers to phase3/_shared (no behavior change)`.

This is the highest-risk-per-line step because everything references these helpers — doing it alone,
first, isolates that risk to one reviewable commit.

### 4.2 Phase B — extract editors one at a time (one commit per editor)

For each editor `E` (start with the smallest leaf editor, e.g. `ScorecardEditor`, to prove the loop):

1. Create `lib/editors/phase3/<e>-editor.tsx`, `'use client'` at top.
2. **Move** `E` and its **editor-local** private helpers into it; import shared helpers from
   `./_shared` and any `components/*` it already used (unchanged paths via `@/lib/editors/components/*`).
3. In `phase3-editors.tsx`, **replace** the moved function body with a re-export line
   (`export { E } from './phase3/<e>-editor';`). The registry line and the test import are untouched.
4. Gate (per editor): `pnpm tsc --noEmit` → `pnpm build` → the editor's `__tests__/<e>.test.tsx`
   (if the harness runs) → **browser smoke**: open an item of that type, confirm the lazy chunk loads
   (Network tab shows the new chunk), the editor renders identically, and its primary backend action
   fires (no-vaporware receipt).
5. Commit per editor: `refactor(editors): split <E> out of phase3-editors (strangler barrel)`.
6. **Optional Phase B2 (even safer, later):** once an editor file is stable, repoint its registry
   slug(s) `import('./phase3-editors')` → `import('./phase3/<e>-editor')`. This shrinks the lazy
   chunk to just that editor and lets the barrel eventually disappear. Do this in a separate commit
   so a regression bisects cleanly to "barrel removal" vs "code move".

### 4.3 Phase C — retire the barrel

When all 13 editors are extracted and **all** consumers (registry repointed in B2, tests repointed),
delete `phase3-editors.tsx`. Verify with `grep -rn "phase3-editors" lib app` returning zero, then
`pnpm build`. Repeat A–C for phase4 and databricks.

### 4.4 Guardrails baked into the loop

- **`isolatedModules` discipline:** the barrel re-exports types via `export type { … }`; no
  `const enum` crosses files. CI `tsc --noEmit` catches violations immediately.
- **Circular-dep guard:** add `madge` (dev dep) and a CI step
  `npx madge --circular --extensions ts,tsx lib/editors/phase3` — extraction must not introduce a
  cycle (editor → _shared → editor). If `_shared` ever needs an editor, that's a smell to hoist.
- **One-PR-per-editor cap:** keep each extraction PR to a single editor (+ its local helpers) so
  review is trivial and `git revert <sha>` is a clean one-editor rollback.
- **Chunk-name stability:** `next/dynamic` derives the chunk from the import path; after B2 the chunk
  name changes (expected). Confirm no route hard-codes a chunk name (none do).

---

## 5. Reversibility / "feature flag" model

A code-organization refactor has no runtime flag in the literal sense; the **reversibility
mechanisms** are:

1. **The strangler barrel itself is the flag.** During Phase B the barrel re-exports the new file;
   reverting an editor = paste its body back into the barrel and delete the new file (one commit
   revert). The registry never changed, so nothing downstream notices.
2. **Per-editor git commits** = per-editor `git revert`. No big-bang to undo.
3. **Optional runtime A/B for the P2 single-component files only:** if you want a kill-switch for the
   riskier lakehouse/report-designer tab extraction, keep the old monolith export and the new
   shell side by side and select via a build-time env, e.g.
   `const LakehouseEditor = process.env.NEXT_PUBLIC_LOOM_EDITOR_SPLIT === '1' ? NewShell : LegacyShell;`
   wired in `registry.ts`. This is **overkill for the multi-editor files** (the barrel covers them)
   and is offered only as defense-in-depth for the two single-component splits. Document the env in
   `admin-plane/main.bicep` apps env list **only if** you actually ship the A/B (per no-vaporware,
   don't add an unused env).

No bicep, no infra, no tenant action is required for the multi-editor splits — they are pure source
moves shipped by the normal `az acr build` console roll.

---

## 6. Commercial vs Government

There is **no cloud-specific endpoint, authority, or CMK surface in this domain** — it is a source
refactor. The dual-cloud obligation is narrower but real:

- Several phase3 editors branch on the **cloud suffix** (e.g. ADX cluster default
  `adx-csa-loom-shared` with a "cloud-correct suffix", Power BI/Fabric hosts `api.powerbi.com` /
  `api.fabric.microsoft.com` on the **opt-in** path, Kusto `*.kusto.windows.net` vs
  `*.kusto.usgovcloudapi.net`). The refactor must **carry that branching verbatim** — never inline a
  Commercial host while moving code. After each extraction, grep the moved file for hard-coded
  `.windows.net`/`.com` hosts and confirm they still come from the cloud-resolver, not a literal.
- **Verification runs in BOTH clouds' build**: `next build` is cloud-agnostic, but the per-editor
  browser smoke (§4.2 step 4) should be done once against a Commercial console roll and, for the
  Gov image, confirmed that the same chunk loads — because the Gov console is a separate ACR image.
  This is a *test-matrix* obligation, not a code difference.
- Gov has no managed-service gap introduced or closed here, and no OSS substitute is needed.

---

## 7. Code vs tenant-admin action

| Action | Type | Owner |
|--------|------|-------|
| Extract shared helpers + per-editor files, barrel re-exports, registry repoint | **Code** (this domain) | Loom dev/agent |
| Add `madge` dev-dep + CI circular-dep step | **Code** | Loom dev |
| Per-editor `tsc --noEmit` + `next build` gate | **Code/CI** | Loom CI |
| Browser smoke per editor (no-vaporware receipt) | **Code/verify** | Loom dev/agent |
| Console image roll (`az acr build`) to ship the refactor | **Operator action** (existing routine roll) | Operator |

**No tenant-admin / Azure RBAC / Entra / capacity action exists for this domain.** There is no
in-product honest-gate to add, because nothing user-facing changes — the editors render and behave
identically. (If a P2 A/B env is shipped, it is an internal build env, not a tenant action.)

---

## 8. Sequence & priority

- **P0 — `phase3-editors.tsx` (18k → 13 files + `_shared`).** Biggest file, most contended in
  merges, and the *easiest* big win (13 independent sibling editors). Phase A (shared) then Phase B
  (one editor per PR, smallest first). Unblocks the most parallel work immediately.
- **P1 — `phase4-editors.tsx` (9 editors)** and **`databricks-editors.tsx` (4 editors).** Identical
  multi-editor mechanic; smaller blast radius. Run after phase3 proves the loop.
- **P2 — `lakehouse-editor.tsx` and `report-designer.tsx`.** Single mega-components; tab/panel
  extraction into `lakehouse/` and the existing `report/` subdir. Higher intra-component-state risk,
  heavier gate, optional A/B kill-switch. Do last, in small per-tab PRs.

---

## 9. Acceptance criteria

1. `phase3-editors.tsx` reduced to a pure re-export barrel (then deleted in Phase C); 13 editors live
   in `lib/editors/phase3/*-editor.tsx`, shared helpers in `phase3/_shared/`. Same for phase4/databricks.
2. `grep -rn "phase3-editors" lib app` returns **zero** after Phase C; `pnpm tsc --noEmit` and
   `pnpm build` are green; `npx madge --circular lib/editors` reports no cycles.
3. **Behavior identity:** for every migrated slug, the item page opens the same editor, the lazy chunk
   loads, every tab/control renders, and the primary backend action returns real data (no-vaporware
   receipt) — verified in a browser, Commercial roll, with the Gov chunk-load confirmed.
4. Each extraction is a single-editor PR that reverts cleanly; no PR touches more than one editor's
   body (plus the one barrel line).
5. No new env var, bicep resource, role assignment, or tenant action shipped (unless the optional P2
   A/B is taken, in which case its env is documented in `admin-plane/main.bicep`).
6. Post-split, a one-character change to one editor type-checks/rebuilds only that editor's file, not
   18k lines — confirmed via `incremental` build timing.

---

## 10. Files to create / edit (file-level spec)

**Create (P0):**
- `lib/editors/phase3/_shared/kql-format.ts`, `kql-visuals.tsx`, `kql-results.tsx`,
  `workspace-hooks.tsx`, `index.ts`
- `lib/editors/phase3/{eventhouse,kql-database,kql-queryset,kql-dashboard,eventstream,activator,
  warehouse,semantic-model,report,paginated-report,dashboard,scorecard,datamart}-editor.tsx`

**Edit (P0):**
- `lib/editors/phase3-editors.tsx` → shrink to barrel, then delete (Phase C)
- `lib/editors/registry.ts` → repoint the 13 phase3 `import('./phase3-editors')` loaders (Phase B2)
- `lib/editors/__tests__/*.test.tsx` → repoint named imports to new paths (Phase C)

**Create (P1):** `lib/editors/phase4/*`, `lib/editors/databricks/*` (+ barrels/registry edits).
**Create (P2):** `lib/editors/lakehouse/*-tab.tsx`; extend `lib/editors/report/*`.
**Tooling:** add `madge` devDependency + a `lint:circular` script + CI step.

**Do NOT touch:** any `app/api/**` route, any `lib/azure/**` client, any bicep module, any
`lib/auth/**` — this domain has zero surface there, and editing them would violate the
"behavior-identical" acceptance criterion.
