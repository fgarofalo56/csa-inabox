<!-- parity-doc-meta
Reviewed-on: 2026-07-24
Validated-against:
  - apps/fiab-console/lib/code-report/parse.ts
  - apps/fiab-console/lib/code-report/render.ts
  - apps/fiab-console/lib/editors/code-report-editor.tsx
  - apps/fiab-console/app/api/items/code-report/[id]/render/route.ts
  - apps/fiab-console/app/api/items/code-report/[id]/content/route.ts
  - apps/fiab-console/app/api/items/code-report/validate/route.ts
  - apps/loom-cli/src/commands/report.ts
  - apps/fiab-console/lib/catalog/item-types/power-bi.ts
-->

# code-report — parity with Evidence.dev (BI-as-code)

**Source category:** Evidence.dev / Rill / Observable Framework — "dashboards as
versionable text: PR-reviewed, CI-tested, diff-able." There is **no Fabric or
Power BI analog** for this item type; the baseline is the open-source BI-as-code
category, and Loom's `code-report` matches its authoring model with a
**fully Azure-native execution engine** (Synapse serverless / Azure Data
Explorer) and the N15 governed-metrics layer.

Source UI references:
- Queries — https://docs.evidence.dev/core-concepts/queries/
- Components — https://docs.evidence.dev/components/all-components/
- CI / build — https://docs.evidence.dev/deployment/overview/

Die-hard rules honored: **no-vaporware** (every block runs on a real backend —
Synapse serverless T-SQL / ADX KQL / N15 `runGovernedMetricQuery`; no mock
arrays), **no-fabric-dependency** (Azure-native default; renders with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset; no Power BI / F-SKU), **ux-baseline**
(guided never-red first open, resizable panes, honest per-query gates).

## Evidence.dev feature inventory → Loom coverage

| # | Evidence.dev capability | Loom coverage | Backend / where |
|---|-------------------------|---------------|-----------------|
| 1 | Report authored as ONE Markdown document, versionable in git | ✅ built | `state.source` (Markdown text) — `content/route.ts` GET/PUT; git-diffable, PR-reviewable |
| 2 | Fenced SQL query blocks with a **name** | ✅ built | ` ```sql <name> ` parsed by `parse.ts` → `RawQueryDef` |
| 3 | Named query referenced by visual components | ✅ built | `{visual query=<name>}` cross-referenced; undefined name → parse error |
| 4 | Query runs against the project's data source | ✅ built | raw block → bound engine (Synapse serverless T-SQL or ADX KQL) via `render.ts` |
| 5 | Governed / shared metric definitions (Evidence: dbt/MetricFlow metrics) | ✅ built (**exceeds**) | ` ```sql loom <name> ` → N15 `runGovernedMetricQuery` — one metric, one number everywhere |
| 6 | Table component | ✅ built | `{table query=…}` → Fluent `Table` from real columns/rows |
| 7 | Bar / Line / Area charts | ✅ built | `{bar\|line\|area query=… x=… y=…}` → `LoomChart` (`column`/`line`/`area`) |
| 8 | Scatter chart | ✅ built | `{scatter query=… x=… y=…}` → `LoomChart type=scatter` |
| 9 | BigValue / KPI component | ✅ built | `{bignumber query=… value=… label=…}` → KPI card |
| 10 | Multi-series charts (series/group by) | ✅ built | `{… series=<col>}` pivots rows per series before charting |
| 11 | Chart titles / axis labels | ✅ built | `title=`, `x=`, `y=` directive attributes |
| 12 | Markdown prose interleaved with data | ✅ built | markdown nodes → `CopilotMarkdown`; non-sql fences (```mermaid, ```python) kept verbatim |
| 13 | Live preview while authoring | ✅ built | two-pane editor (source ↔ preview) with **Run** → `POST …/render` real data |
| 14 | Query result caching | ✅ built | metric blocks cache via N15's `getOrComputeCached` (scoped key) |
| 15 | `evidence build` / CI validation that fails on error | ✅ built | `loom report validate <file>` → `POST …/validate` (parse + dry-compile); **non-zero exit** on any error |
| 16 | Query parameters / filters | ✅ built | metric-block `filter:` lines → structured, injection-safe predicates (N15 binds/escapes) |
| 17 | Time-grain roll-ups (day/week/month/…) | ✅ built | metric-block `grain:` → N15 time-bucket compile |
| 18 | SQL injection / read-only safety | ✅ built (**exceeds**) | raw blocks pass `assertReadOnlyQuery` (single SELECT/WITH, no DML/EXEC/`;`-stacking, no KQL control commands); metrics whitelisted+bound |
| 19 | Export / share the rendered report | ✅ built | item-level Share, Version history, Lineage, Thread via `ItemEditorChrome`; `.loomapp` export bundles the source |
| 20 | Deploy / host the built report | ✅ built | it IS a Loom item — served in-console by the render route; no separate hosting step |
| 21 | Component library beyond core charts (maps, funnels, etc.) | ⚠️ honest scope | Core set (table, bar, line, area, scatter, bignumber) shipped; richer geometries are additive via the same `{visual}` grammar + `LoomChart` (which already supports funnel/treemap/gauge/…). Tracked as an additive follow-up, not a stub. |
| 22 | DuckDB/local dev engine | ⚠️ Azure-native by design | Loom runs on Synapse serverless / ADX in-boundary (IL5); a local DuckDB dev engine is intentionally out of scope per no-fabric/no-external-egress — the N2 DuckDB-WASM preview covers ad-hoc local exploration separately |

**Zero ❌.** Every core Evidence.dev capability is built ✅; rows 21–22 are honest
scoping notes (an additive component follow-up and a deliberate Azure-native
engine choice), not missing features or stub banners.

## Backend per control

- **Load / save source + engine** → `GET|PUT /api/items/code-report/[id]/content`
  (`withWorkspaceOwner`, real Cosmos `updateOwnedItem`; drafts always saveable).
- **Render** → `POST /api/items/code-report/[id]/render` (`withWorkspaceOwner`,
  audited). Metric blocks → `runGovernedMetricQuery` (N15 → Synapse serverless /
  ADX); raw blocks → the bound engine directly, read-only-guarded.
- **Validate (CI)** → `POST /api/items/code-report/validate` (`withSession`):
  the real parser + N15 `compileGovernedMetric` dry-compile against the caller's
  governed spec; `loom report validate <file>` maps `ok:false` to a non-zero exit.
- **Kill-switch** → FLAG0 `n16-code-report` (default-ON) gates render + validate.

## Verification (per no-vaporware / no-scaffold)

- Parser: `lib/code-report/__tests__/parse.test.ts` (golden AST + every malformed
  shape throws + injection guard).
- Renderer: `lib/code-report/__tests__/render.test.ts` (metric→N15 path, raw→engine,
  gate degradation).
- CLI: `apps/loom-cli/test/report.test.ts` (exit-code contract).
- Editor: `lib/editors/__tests__/code-report-editor.test.tsx` (clean guided first-open).
- Live E2E (minted-session): create a `code-report`, save the starter source, Run
  → real rows from Synapse serverless with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset;
  `loom report validate` on a broken report exits non-zero.
