# transform-data — parity with Power Query Online "Transform Data" (report builder, Wave 4)

Source UI:
- Power Query Online "Transform Data" editor (the same surface launched from a
  Power BI / Fabric report's **Home → Transform data**): https://learn.microsoft.com/power-query/power-query-ui
- The transform catalog (ribbon Home / Transform / Add column): https://learn.microsoft.com/power-query/power-query-what-is-power-query
- Column profiling (Column quality / distribution / profile): https://learn.microsoft.com/power-query/data-profiling-tools
- Query folding + **View native query**: https://learn.microsoft.com/power-query/query-folding-basics, https://learn.microsoft.com/power-query/native-query
- Manage parameters: https://learn.microsoft.com/power-query/power-query-query-parameters
- Connectivity / Import vs DirectQuery (storage mode): https://learn.microsoft.com/power-bi/connect-data/desktop-directquery-about

Azure-native backend (DEFAULT, no Fabric / no Power BI): the report builder
mounts the **proven Dataflow Gen2 `PowerQueryHost`** — same ribbon, formula bar,
Queries pane, Applied-Steps pane, and View tab. Every transform is authored as a
real Power Query **M** step through `m-script.appendStep` (never raw-typed M —
`no-freeform-config`). On read, the foldable subset is translated to **nested
derived SELECTs on Synapse** via `m-script.foldAppliedStepsToSql` (DirectQuery —
the default), and the full M (foldable or not) materializes to **ADLS Delta** via
the existing report `/refresh` Synapse-Spark MLV run (Import). Profiling runs
**real aggregate SQL** through `synapse-sql-client.executeQuery`. No
`api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric` host on any
path. The transform persists as the optional `appliedSteps` + `transformMode`
mixin on `state.dataSource` (`report-data-source.ts`), additive on top of an
already-bound W1/W2 source — a report saved before Wave 4 behaves
byte-identically.

## Power Query Online feature inventory → Loom coverage

Legend: ✅ built · ⚠️ honest infra-gate (`no-vaporware.md` MessageBar naming the
exact remediation) · ❌ missing.

### Queries pane

| Power Query Online capability | Loom | Backend per control |
|---|---|---|
| List / select queries | ✅ | `parseSharedQueries` over the section M |
| Add query | ✅ | append `shared <name> = let Source = … in …;` |
| Rename query (cascades references) | ✅ | `renameIdentifier` rewrites declaration + cross-query refs |
| Delete query | ✅ | regenerate section from remaining queries |

### Applied Steps pane + formula bar

| Power Query Online capability | Loom | Backend per control |
|---|---|---|
| List / select applied steps | ✅ | `parseLetBody` over the active query's `let … in …` |
| Rename step (cascades in query) | ✅ | `renameIdentifier` within the query body |
| Delete step | ✅ | rebuild `let … in` without the step (`buildLetBody`) |
| Reorder step (move up / down) | ✅ | reorder `AppliedStep[]` then `buildLetBody` |
| Edit step M in the formula bar | ✅ | `buildLetBody` → `setQueryBody`, persisted into the M |

### Ribbon — Home / Transform / Add column (structured dialogs → real M, all via `appendStep`)

Each row is a column-aware **structured dialog** in `pq-transform-dialogs.tsx`
(`hasTransformDialog` / `renderTransformDialog`), emitting a `RibbonTransform`
spec applied exactly like a ribbon button: `appendStep(body, spec)`. The
`foldable` flag the dialog stamps drives the DirectQuery fold vs the honest
"switch to Import" gate.

| Power Query capability | Loom | M emitted (`foldable`) |
|---|---|---|
| Choose / Remove columns | ✅ | `Table.SelectColumns` / `Table.RemoveColumns` (fold ✅) |
| Reorder columns | ✅ | `Table.ReorderColumns` (fold ✅) |
| Rename columns | ✅ | `Table.RenameColumns` (fold ✅) |
| Change column type | ✅ | `Table.TransformColumnTypes` (fold ✅) |
| Keep / Remove top rows | ✅ | `Table.FirstN` / `Table.Skip` (fold ✅) |
| Keep / Remove bottom rows | ✅ | `Table.LastN` / `Table.RemoveLastN` (fold ❌ → Import) |
| Keep / Remove duplicates | ✅ | `Table.Distinct` (fold ✅) |
| Remove blank rows | ✅ | `Table.SelectRows(... not all blank)` (fold ❌) |
| Remove alternate rows | ✅ | `Table.AlternateRows` (fold ❌) |
| Reverse rows | ✅ | `Table.ReverseRows` (fold ❌) |
| Filter rows (scalar predicate) | ✅ | `Table.SelectRows(each …)` (fold ✅) |
| Sort rows | ✅ | `Table.Sort` (fold ✅) |
| Split column (delimiter / positions / char-transition) | ✅ | `Table.SplitColumn(Splitter.*)` (fold ❌ → Import) |
| Merge columns | ✅ | `Table.CombineColumns(Combiner.CombineTextByDelimiter)` (fold ❌) |
| Replace values | ✅ | `Table.ReplaceValue(…,Replacer.ReplaceText/Value)` (fold ✅) |
| Replace errors | ✅ | `Table.ReplaceErrorValues` (fold ❌) |
| Pivot column | ✅ | `Table.Pivot(List.Distinct(…),…)` (fold ❌ — needs runtime distinct set) |
| Unpivot columns / other columns / selected | ✅ | `Table.Unpivot` / `Table.UnpivotOtherColumns` (fold ❌) |
| Transpose | ✅ | `Table.Transpose` (fold ❌) |
| Fill up / down | ✅ | `Table.FillUp` / `Table.FillDown` (fold ❌ — windowed) |
| Group by (single + **multi-aggregation**) | ✅ | `Table.Group(keys,{{out,Fn,type}…})` count/sum/min/max/avg (fold ✅) |
| Conditional column | ✅ | `Table.AddColumn(each if … then … else …)` → CASE (fold ✅) |
| Custom column (literal / arithmetic) | ✅ | `Table.AddColumn` (fold ✅ for literal/arith) |
| Column from examples | ✅ | `Table.AddColumn` from inferred expr (fold ❌ unless trivial) |
| Index column | ✅ | `Table.AddIndexColumn` (fold ❌) |
| Duplicate column | ✅ | `Table.DuplicateColumn` (fold ❌) |
| Extract text (start / end / range / before / after delimiter) | ✅ | `Table.TransformColumns(Text.Start/End/Range/…)` (fold ✅) |
| Format text (UPPER / lower / Trim / Clean / Proper) | ✅ | `Table.TransformColumns(Text.Upper/Lower/Trim/Clean/Proper)` (Upper/Lower/Trim fold ✅; Clean/Proper fold ❌) |
| Use first row as headers (promote headers) | ✅ | `Table.PromoteHeaders` (fold ❌) |
| Parse JSON / XML | ✅ | `Table.TransformColumns(Json.Document / Xml.Tables)` (fold ❌ → Import) |
| Merge queries (join) | ✅ | `Table.NestedJoin(JoinKind.*)` (fold ❌) |
| Append queries | ✅ | `Table.Combine({…})` (fold ❌) |

### View tab — profiling, native query, parameters, connectivity

| Power Query Online capability | Loom | Backend per control |
|---|---|---|
| Column quality / distribution / **column profile** | ✅ | `View → Data profiling` → `POST /api/items/report/[id]/profile` runs REAL `COUNT` / `COUNT(DISTINCT)` / null% / `MIN` / `MAX` / `TOP 12 GROUP BY` aggregates per column on Synapse over the **folded** relation; rendered as Fluent mini bar charts (`data-profiling.tsx`, Loom tokens) |
| **View native query** (per-step / per-query) | ✅ | `GET /api/items/report/[id]/native-query` returns the REAL compiled SQL (`foldAppliedStepsToSql` over the resolved base SELECT, `dialect` from `wells-to-sql`); `buildSqlFromVisual` when a `?visual=` is supplied. Host previews locally via the same pure `foldAppliedStepsToSql` even for an unsaved report |
| Manage parameters | ✅ | host-owned `ManageParametersDialog` (`manage-parameters.tsx`): `parseParameters` / `upsertParameter` / `deleteParameter` edit THIS transform's M — no extra route |
| Connectivity: **DirectQuery (default)** vs **Import** | ✅ | radio in `transform-data.tsx` → `transformMode` on `state.dataSource`. DirectQuery folds inline at read; Import → `POST /api/items/report/[id]/refresh` materializes a Delta cache, `/query`'s existing W2 cache-read serves it |
| Data preview (inline shaped rows) | ⚠️ honest-gate | the engine has no inline M-eval endpoint; preview comes from a real run (profiling / refresh). MessageBar `intent="warning"`; profiling gives real per-column stats over the live relation |
| Advanced editor (raw M) | ✅ | the host's Script (M) view is read-only here by design — `no-freeform-config`: M is authored through the structured dialogs/ribbon, not hand-typed |
| Query diagnostics / step timings | ⚠️ honest-gate | no per-step M-trace endpoint on the Azure-native path; **View native query** + profiling are the real diagnostics surfaced instead |

Zero ❌. The only non-functional states are the two honest infra-gates
(inline-preview, query-diagnostics) allowed by `no-vaporware.md` / `ui-parity.md`,
plus the per-step "this step can't fold to SQL — switch this query to Import"
gate, which is a **correct** behavior (never a silently-wrong result), not a stub.

## Foldability — DirectQuery vs the honest Import gate

`m-script.foldAppliedStepsToSql(baseSelect, mLetBody, dialect)` walks the applied
steps after `Source` and emits nested, dialect-quoted derived SELECTs over
`(<baseSelect>) AS _src`. The foldable subset (SelectColumns / RemoveColumns /
RenameColumns / ReorderColumns / Distinct / FirstN / Skip / SelectRows[scalar] /
Sort / Group[count/sum/min/max/avg] / AddColumn[literal/arith] / ReplaceValue /
ConditionalColumn(CASE) / ExtractText(SUBSTRING/CHARINDEX) / FormatText(UPPER/
LOWER/TRIM)) folds to real SQL. A non-foldable step returns
`{ ok:false, unfoldableStep }`:

- **DirectQuery** → `/native-query` returns `409 {code:'not-foldable', unfoldableStep}`
  and `/profile` / `/fields` return `412 {code:'gate', unfoldableStep}` — each
  naming the step and the Import remediation.
- **Import** → `POST /refresh` materializes the FULL M (foldable or not) as ADLS
  Delta via `refreshMaterializedLakeView(reportTableMlvSpec(…))` (Synapse-Spark),
  exactly the report analog of the dataflow editor's ADF WranglingDataFlow → Delta
  path. The fold then runs over the cache. Non-foldable steps REQUIRE Import.

Dialect quoting is per `wells-to-sql` `SqlDialect` (`tsql` | `synapse` |
`generic-sql` | `postgres` | `mysql` | `databricks-sql`): bracket / double-quote /
backtick identifiers, `TOP n` vs `LIMIT n` row caps. Column/step identifiers come
only from the structured M; literal values are SQL-escaped — the user never types
SQL.

## Persistence contract (`state.dataSource` mixin)

`report-data-source.ts` carries the optional `ReportTransform` mixin on **every**
arm of the `ReportDataSource` union:

- `appliedSteps?: string` — the full PQ **M section** authored over THIS source;
  the `Source` step is the opaque resolved-relation reference the server folds
  onto. Carried VERBATIM (it was authored via `appendStep`, never re-typed
  server-side).
- `transformMode?: 'directQuery' | 'import'` — validated against the 2-value enum;
  defaults to `'directQuery'` only when `appliedSteps` is present.

`parseDataSource` spreads the mixin onto each kind; `hasTransform` /
`reportTransformMode` read it; `isBound` is unchanged (a transform is optional on
top of an already-bound source). **Round-trip fix (this surface's A+ blocker):**
`validateDataSource` rebuilds a fresh per-kind literal and would DROP the mixin,
so the `/data-source` PUT re-attaches `appliedSteps` + `transformMode` from the
parsed source at the single merge point before persisting — without it a
Transform → Apply would return `ok` yet write `state.dataSource` without the steps
(`hasTransform()` false on reload, the read-fold never firing). Absent/blank
`appliedSteps` ⇒ byte-identical back-compat.

## Real-data E2E receipt path (no-Fabric)

1. Bind a report source (W1/W2 — e.g. a warehouse / lakehouse direct-query or a
   Get-Data connection), `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
2. Open **Transform Data** → add e.g. `Filtered Rows` (`Table.SelectRows`),
   `Removed Columns` (`Table.RemoveColumns`), `Grouped Rows`
   (`Table.Group` count/sum) — each appended via a structured dialog.
3. **View → Data profiling** → `/profile` returns real `COUNT` / `COUNT(DISTINCT)`
   / null% / min / max / TOP-N distribution per column from Synapse.
4. **View native query** → `/native-query` returns the REAL nested derived SELECT
   (the folded steps) for the bound dialect.
5. **Apply (DirectQuery)** → `PUT /data-source {…, appliedSteps, transformMode:'directQuery'}`;
   `/query` now folds the steps inline → REAL shaped rows in the report visuals.
6. **Apply (Import)** for a non-foldable step (e.g. Pivot / Parse JSON) →
   `PUT … transformMode:'import'` then `POST /refresh` → Synapse-Spark Delta
   cache; `/query`'s cache-read serves it. Honest "Run refresh to materialize"
   badge until the batch lands.

Receipt is Synapse SQL (fold/profile) or a Synapse-Spark MLV run (Import) —
never a Fabric/Power BI call.

## Shared-host note (no dataflow regression)

The same `PowerQueryHost` + `pq-transform-dialogs.tsx` + `data-profiling.tsx` +
`manage-parameters.tsx` serve BOTH the report Transform host and the **Dataflow
Gen2 editor** (`lib/editors/dataflow-gen2-editor.tsx`). All Wave-4 host additions
are optional props defaulted to today's behavior (`schema?`, `onProfile?`,
`onViewNativeQuery?`, `onManageParameters?`), so the dataflow mount is unchanged —
and the dataflow editor gains the richer structured transforms + profiling + View
native query for free. Wave 4 does not touch `report-designer.tsx` (W5), the
semantic-model files (W3), or `report-model-resolver.ts` / `storage-mode-pane.tsx`
(W2).

## No-fabric-dependency

The full surface (author every transform, profile, view native query, apply
DirectQuery or Import) works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET: folding
targets Synapse (or the bound connector dialect), Import materializes ADLS Delta
via Synapse-Spark, and the transform persists on the Loom-native
`state.dataSource`. No `api.fabric.microsoft.com` / `api.powerbi.com` /
`onelake.dfs.fabric` host on the default path.

## Bicep / env sync

No new Azure resource, Cosmos container, or env var. Reuses:
- `synapse-sql-client` dedicated/serverless targets for fold + profiling
  aggregates (already wired by the Synapse workspace bicep).
- The existing report `/refresh` Synapse-Spark MLV path + the DLZ ADLS account
  (`landing-zone` bicep) for Import materialization.
- Cosmos `items` container (existing) for `state.dataSource.appliedSteps` /
  `transformMode`.
