# adx-web-ui — parity with the Azure Data Explorer web UI (Kusto Explorer) query + render

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the **KQL query → results grid → `render` auto-chart** experience of the
> ADX web UI, as deepened in the KQL editor. The full ADX/Kusto navigator audit
> (cluster, database, schema tree, mgmt commands, policies) lives in `adx-kusto.md`
> and `adx-kql-database.md`; this doc isolates the **query + visualization** surface,
> with emphasis on the `render`-driven auto-chart that mirrors the ADX web UI.

**Source UI (grounded in Microsoft Learn, not memory):**
- `render` operator (chart families + supported properties — kind/series/accumulate/title/x-y): https://learn.microsoft.com/kusto/query/render-operator
- Query/management HTTP response — `@ExtendedProperties` carries the Visualization annotation: https://learn.microsoft.com/kusto/api/rest/response#the-meaning-of-tables-in-the-response
- Azure Data Explorer web UI (query, results grid, charts): https://learn.microsoft.com/azure/data-explorer/web-query-data
- Visualize data in results grid (sort/filter/group/stats/export): https://learn.microsoft.com/azure/data-explorer/web-results-grid

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/phase3-editors.tsx` — `KqlDatabaseEditor`
  (Monaco KQL editor + Run), `KqlResultsPanel` (chart-picker + render default),
  `TileVisual`/`ResultChart`/pie/map renderers, `KQL_VIZ_CHOICES`.
- Results grid: `apps/fiab-console/lib/components/adx/kusto-results-grid.tsx`
  (`KustoResultsGrid` — sort / filter / search / stats / CSV export).
- Client (real REST, no mocks): `apps/fiab-console/lib/azure/kusto-client.ts`
  (`executeQuery` parses `@ExtendedProperties` → `KustoVisualization`; `executeMgmtCommand`).
- BFF: `app/api/items/kql-database/[id]/query` (auto-routes `.`-prefixed mgmt vs query).

**Backend reality check.** The KQL editor posts to the real cluster
`POST /v1/rest/query` (and `/v1/rest/mgmt` for `.`-commands) via the Console UAMI
(AllDatabasesAdmin). `executeQuery` parses the v1 `@ExtendedProperties` table for the
`render`-produced `Visualization` annotation and returns it, so a `| render piechart`
query opens as a pie exactly as the ADX web UI does. No `return []`, no `MOCK_`, no
`useState(SAMPLE)`. Honest gate keyed on `LOOM_KUSTO_CLUSTER_URI` (defaults to the
shared cluster).

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Query editor & execution

| # | ADX web UI capability | Loom | Where / backend |
|---|---|---|---|
| A1 | KQL editor (Monaco, syntax highlight) | ✅ built | `MonacoTextarea` aria-label "KQL query editor" |
| A2 | Run query | ✅ built | Run → `POST …/[id]/query` → `/v1/rest/query` |
| A3 | Shift+Enter to run | ✅ built | keydown handler scoped to the editor |
| A4 | Run control/mgmt commands (`.show`, `.create`, …) | ✅ built | `.`-prefixed auto-routes to `/v1/rest/mgmt` |
| A5 | Row count + execution-ms + truncation badge | ✅ built | `resultMeta` badges; truncated at 5,000 |
| A6 | Query error surfaced | ✅ built | error MessageBar from the cluster message |
| A7 | **Run-selection** (run highlighted block only) | ❌ MISSING | runs the whole editor |
| A8 | **IntelliSense / KQL autocomplete + schema-aware completion** | ⚠️ partial | Monaco baseline; no Kusto-schema completion |
| A9 | Multi-tab / saved queries / query history | ⚠️ partial | single editor; (querysets live in a separate editor, not here) |
| A10 | Query **parameters** / dashboard params | ❌ MISSING | not in this surface (KQL dashboards have params) |

### B. `render` auto-chart (the ADX visualization hallmark)

| # | ADX web UI capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Parse the query's `\| render` hint and auto-pick the chart | ✅ built | `parseVisualization` (@ExtendedProperties) → default viz |
| B2 | Render: **timechart** | ✅ built | `vizFromRender` → timechart line |
| B3 | Render: **linechart / areachart / stackedareachart** | ✅ built | mapped to line series |
| B4 | Render: **columnchart** | ✅ built | column |
| B5 | Render: **barchart** | ✅ built | bar |
| B6 | Render: **piechart** | ✅ built | SVG pie |
| B7 | Render: **card** (single stat) | ✅ built | stat card |
| B8 | Render: geo **scatterchart** (lat/lon → point map) | ✅ built | point-map renderer |
| B9 | Manual **chart-type picker** to override the render default | ✅ built | `KQL_VIZ_CHOICES` toggle row (Table/Time/Line/Column/Bar/Pie/Card/Map) |
| B10 | Show the render name + auto-render hint badge | ✅ built | "render: …" badge + "Auto-rendered from `\| render …`" note |
| B11 | Honor render **properties** (title) | ⚠️ partial | `Title` shown; `XColumn`/`YColumns`/`Series`/`Kind`/`Accumulate`/`xtitle`/`ytitle` not fully applied |
| B12 | **scatterchart (non-geo X/Y), anomalychart, ladderchart, pivotchart, treemap, timepivot** | ❌ MISSING | not rendered |
| B13 | Interactive chart (hover tooltips, legend toggle, zoom, cross-filter) | ❌ MISSING | static SVG |
| B14 | Pin chart to a dashboard | ⚠️ partial | possible via the separate KQL-dashboard editor, not from here |

### C. Results grid

| # | ADX web UI capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Tabular results grid | ✅ built | `KustoResultsGrid` |
| C2 | Sort by column (type-aware: numeric/datetime) | ✅ built | header click asc→desc→none |
| C3 | Per-column filter + global search-in-grid (highlight) | ✅ built | per-column substring + global box |
| C4 | Per-column **stats** (min/max/sum/avg; distinct/most-common) | ✅ built | column stats popover |
| C5 | **Export to CSV** (visible sorted+filtered rows) | ✅ built | grid CSV download |
| C6 | **Group by column** (drag-to-group / row groups) | ❌ MISSING | flat grid; sort/filter only |
| C7 | **Pivot** mode | ❌ MISSING | not surfaced |
| C8 | **Column profile / full data profile** panel | ⚠️ partial | per-column stats only; no full-result profile |
| C9 | Expand JSON/dynamic cell viewer | ⚠️ partial | objects shown as JSON string (no expand-tree) |
| C10 | **Open in Excel / Query to Power BI / Share query-link** | ❌ MISSING | CSV export only |

---

## Coverage tally

- **built ✅: 19**
- **partial ⚠️: 6**
- **honest-gate ⚠️: 0** (cluster gate is `LOOM_KUSTO_CLUSTER_URI`, defaulted)
- **MISSING ❌: 8**

## Honest grade: **B**

The query → results-grid → `render` auto-chart path is genuinely
**production-grade** and the closest thing in the catalog to a true ADX-web-UI 1:1:
the editor runs real KQL and mgmt commands against the live cluster, and crucially
it **parses the `@ExtendedProperties` Visualization annotation** so a `| render`
query auto-opens in the right chart — timechart, line/area, column, bar, pie, card,
and geo point-map — with a manual chart picker to override, exactly like the web UI.
The results grid is a real one: type-aware sort, per-column + global filter,
per-column stats, and CSV export. **No vaporware.**

Held to **B** (not A) by `ui-parity.md`'s completeness bar: the charts are **static
SVG** (no hover/legend/zoom/cross-filter), several **render kinds are unmapped**
(non-geo scatter, anomaly, ladder, pivot, treemap, timepivot) and the render
**properties** beyond Title aren't fully honored, the grid lacks **group-by / pivot
/ full profile / dynamic-cell expand**, there's **no run-selection** or **schema-aware
IntelliSense**, and the ADX share/export integrations (**Open in Excel / Query to
Power BI / share-link**) are absent.

## Highest-value gaps to build first

1. **Honor full render properties** (B11) — apply `XColumn`/`YColumns`/`Series`/
   `Accumulate`/axis titles so multi-series charts match ADX.
2. **Interactive charts** (B13) — tooltips/legend/zoom (swap SVG for a charting lib).
3. **Grid group-by + pivot + full profile** (C6–C8).
4. **Run-selection** (A7) and **schema-aware KQL IntelliSense** (A8).
5. **Open-in-Excel / Query-to-Power-BI / share query-link** (C10).
6. **Remaining render kinds** (B12).

## Backend per control

| Control | BFF route | client fn | Kusto endpoint |
|---|---|---|---|
| Run query | `POST /api/items/kql-database/[id]/query` | `executeQuery` | `POST /v1/rest/query` |
| Run mgmt command | same (`.`-prefixed) | `executeMgmtCommand` | `POST /v1/rest/mgmt` |
| Render hint parse | (in `executeQuery`) | `parseVisualization` | reads `@ExtendedProperties` table |
| Grid sort/filter/stats/export | (client-side) | `KustoResultsGrid` | n/a (operates on returned rows) |

## Bicep / env sync

- Env var consumed: **`LOOM_KUSTO_CLUSTER_URI`** (defaults to
  `adx-csa-loom-shared.eastus2.kusto.windows.net`); `LOOM_KUSTO_DEFAULT_DB`,
  `LOOM_UAMI_CLIENT_ID` for auth.
- Role: Console UAMI holds **AllDatabasesAdmin** on the cluster (granted via
  `az kusto cluster-principal-assignment create`).
- No new Cosmos container.

## Verification

- Per `no-vaporware.md`: every Run hits the real cluster; the render annotation is
  parsed from the live response, not faked.
- Live `pnpm uat` side-by-side against the ADX web UI: **pending** (depends on a
  reachable cluster + minted session). MISSING/partial rows derived from code; confirm
  against the live web UI per the no-scaffold rule.
