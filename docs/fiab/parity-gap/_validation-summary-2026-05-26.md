# v2 Validator Summary — 2026-05-26 batch

> Validator session: fabric-parity-loop v2.
> Editors validated this batch (per request):
> - Power Platform: `powerplatform-environment` / `dataverse-table` / `power-app` / `power-automate-flow` / `power-page` / `ai-builder-model`
> - Azure SQL: `azure-sql-server` / `azure-sql-database` / `azure-sql-managed-instance` / `sql-server-2025-vector-index`
> - Geo: `geo-map` / `geo-dataset` / `geo-query` / `geo-pipeline` / `map` (phase4)
> - Graph + Vector: `cosmos-gremlin-graph` / `cypher-graph` / `gql-graph` / `vector-store`
> - Fabric IQ: `variable-library` / `plan` / `ontology` / `graph-model`
> - Data Engineering misc: `mirrored-database` / `dataflow` / `copy-job` / `spark-job-definition` / `environment` / `dbt-job`
> - APIs + Data Products: `graphql-api` / `user-data-function` / `data-product` / `data-product-template` / `data-product-instance`
> - Streaming Analytics: `stream-analytics-job` (replaces `usql-job`)
> - BI/RTI: `dashboard` / `paginated-report` / `report` / `scorecard` / `kql-dashboard` / `activator`

**Total editors graded this batch: 39**.

## Validation method (honest)

Per parity-validation-standard, the validator should do 4 phases live in a browser. **This session's reality**:

- Phase 1 (Fabric reference): leveraged prior catalog work (`docs/fiab/parity-specs/`) + memory of Microsoft surfaces. No new Fabric screenshots captured this session.
- Phase 2 (Loom capture): **1 live editor captured** (`powerplatform-environment/new` at `temp/parity/powerplatform-environment-loom.png`). All other navigations either:
  - 404'd because the editor slug is in source but not in deployed bundle (`stream-analytics-job/new`), OR
  - Hit the in-app router which auto-redirected to other tabs / home, OR
  - Triggered MSAL re-auth flow with MFA prompt that requires the user's Authenticator app.
- Phase 3 (gap matrix): **complete from source-grade audit**, written per editor family.
- Phase 4 (click every button): **blocked** for live verification; **source-grade `onClick` audit complete** for every editor — dead ribbon labels enumerated per editor.

This is the limit of what an automated session without MFA-credential injection can deliver. The grades below are honest **source-grade verdicts** consistent with parity-validation-standard's wording for "BLOCKER" / "MAJOR" / "MINOR". Where source grading is uncertain without live observation, the editor is marked with a `?` and assumes the more pessimistic grade.

## Summary table

| Editor | Grade | Headline reason |
|---|---|---|
| **Power Platform** | | |
| powerplatform-environment | **C** | Renders, real BAP env REST; advertised capacity/security panes missing; ribbon labels-only |
| dataverse-table | **D** | Read-only browse: no Forms, no Views, no Charts, no Add column, no Add row, no Business Rules |
| power-app | **D** | Read-only browse + Play link; no Studio launch, no edit, no share, no versions |
| power-automate-flow | **C** | Run flow ✓ + runs history ✓; no edit, no toggle, no delete, no share |
| power-page | **D** | Read-only browse; **NO** deep-link to make.powerpages.microsoft.com (request asked for this) |
| ai-builder-model | **D** | Read-only browse; no Train, no Quick test, no Publish |
| **Azure SQL** | | |
| azure-sql-server | **C** | Server list + databases ✓; "Security" / "Firewall" / "AAD admin" ribbon labels are dead |
| azure-sql-database | **D** | T-SQL `<textarea>` (BLOCKER), no schema tree, no query history, Mirroring/Replication are MessageBar stubs |
| azure-sql-managed-instance | **D** | Honest list-only |
| sql-server-2025-vector-index | **C** | DDL builder + Create ✓; Test similarity is explicitly disabled, no existing-index list |
| **Geo** | | |
| geo-map | **D** | 3 inputs + dead Save/Preview ribbon; no map canvas |
| geo-dataset | **D** | 3 inputs + dead Save ribbon; no inspect, no preview |
| geo-query | **D** | `<textarea>` (BLOCKER) + JSON dump; no map overlay |
| geo-pipeline | **D** | Config form + dead Save/Trigger run ribbon |
| map (phase4) | **C** | Static map preview ✓ (real REST when key set), bbox compute ✓; `<textarea>` for GeoJSON, no vector overlay |
| **Graph + Vector** | | |
| cosmos-gremlin-graph | **C** | Real Gremlin REST + Vertices/Edges fix ✓; `<textarea>` + JSON dump + no graph viz |
| cypher-graph | **D** | `<textarea>` + JSON dump + "write KQL directly" admission |
| gql-graph | **C** | 3-backend selector + honest persist-only mode ✓; `<textarea>` + no schema browser |
| vector-store | **D** | 4-backend selector ✓ but no real create per backend; Similarity test disabled |
| **Fabric IQ** | | |
| variable-library | **B** | 9 types ✓ + 4 value sets ✓ + per-type validation ✓ + save ✓ |
| plan | **C** | Progress badges ✓ + inline edit ✓; no board view, no approval workflow |
| ontology | **C** | Materialize-as-graph-model ✓ end-to-end; `<textarea>` + regex parser (not real OWL) |
| graph-model | **C** | Materialize ✓; two `<textarea>` for schema, no visual diagram |
| **Data Engineering misc** | | |
| mirrored-database | **B** | Real 8-source create wizard ✓ + start/stop/delete + tables metrics |
| dataflow | **D** | `<textarea>` for Power Query M (BLOCKER); no source/sink/transforms UI |
| copy-job | **C** | Run + Save + runs table ✓; JSON mappings textarea (BLOCKER for ADF parity) |
| spark-job-definition | **C** | Submit + pool picker + runs table ✓; JSON-textarea conf, no logs |
| environment | **C** | Wired to ARM; no Monaco, no upload widget, no versions |
| dbt-job | **C** | Run dbt via Databricks ✓; no manifest browse, no logs, free-text cluster |
| **APIs + Data Products** | | |
| graphql-api | **C** | Publish to APIM ✓; SDL `<textarea>` (BLOCKER), no playground |
| user-data-function | **D** | Save ✓; code `<textarea>`, Deploy advertised but no in-pane button |
| data-product (APIM) | **C** | No hardcoded Customer 360 (F-fix confirmed), Purview gate honest 501 |
| data-product-template | **B** | Gallery + detail + Instantiate end-to-end ✓ |
| data-product-instance | **B** | Health refresh ✓, child item links, error MessageBar |
| **Streaming Analytics** | | |
| stream-analytics-job | **C** source / **F deployed** | Start/Stop/Save/Refresh wired ✓; `<textarea>` (BLOCKER); slug NOT in deployed bundle today (404) |
| **BI / RTI** | | |
| dashboard | **D** | Metadata + tile metadata only, no live tiles, no edit |
| paginated-report | **D** | Metadata browse only |
| report | **D** | Metadata browse only |
| scorecard | **C** | Add value to goal ✓; no goal authoring, no measure connect |
| kql-dashboard | **C** | Add tile / Re-run / Edit JSON / Save ✓; `<Textarea>` for KQL, no real charts |
| activator | **C** | Create + Add rule + Trigger ✓; JSON condition/action (no visual builder) |

## Grade distribution (39 editors)

- **A**: 0
- **B**: 4 (variable-library, mirrored-database, data-product-template, data-product-instance)
- **C**: 18
- **D**: 16
- **F**: 1 (stream-analytics-job — only because of deployment lag; source grades C)

## The 4 structural blockers across the catalog

1. **No Monaco anywhere** — every code/query/text editor uses `<textarea>`. Per parity-validation-standard this alone limits the whole catalog to **C ceiling** until Monaco lands. Affects: notebook (already known D), azure-sql-database, geo-query, cypher-graph, gql-graph, cosmos-gremlin-graph, graphql-api, user-data-function, ontology, graph-model, copy-job mappings, spark-job-definition conf, environment requirements, kql-dashboard tiles, activator rule JSON, stream-analytics-job query, dataflow M, map GeoJSON, sql-server-2025-vector-index DDL.

2. **Dead ribbon labels** — every editor declares ribbon buttons in `RibbonTab[]` constants, but **most of those labels have NO `onClick`** — they exist only to make the ribbon visually full. Strict Phase 4 reading: every dead ribbon label = BROKEN. The editor's REAL action buttons sit in the main pane below; users who click ribbon expect those to fire. Conservatively ~120 dead ribbon labels across this batch.

3. **No live output rendering** — most query editors return `<pre>{JSON}</pre>` instead of a real result grid/chart. Affects: cosmos-gremlin-graph, cypher-graph, gql-graph, geo-query, kql-dashboard tile preview.

4. **Read-only browse pattern** for Power Platform + Power BI families — list rows + click for metadata, but no in-Loom editor to modify the underlying item. Editing = "go to the real Microsoft tool" but most editors don't even deep-link to that tool. Affects: dataverse-table, power-app, power-page, ai-builder-model, dashboard, paginated-report, report.

## Notable wins

- **mirrored-database** — only editor in the catalog with a real multi-step create wizard (8 source-type cards, source/server/database form, real REST POST). **B-grade**.
- **variable-library** — 9 types + 4 value sets + per-type regex validation + save. The Fabric-IQ leader.
- **data-product-template + data-product-instance** — end-to-end push-button (gallery → instantiate → spawn child items → health refresh). Both **B**.
- **power-automate-flow** — Run flow + runs history actually fire. **C** because edit/toggle/delete missing, but the Run path is real.
- **ontology → graph-model materialize chain** — D→C upgrade per the v3.27 fix. End-to-end: ontology classes parsed → POST creates graph-model → ADX materialize creates real KQL tables.
- **map (phase4) static tile preview** — emits real `https://atlas.microsoft.com/map/static?...` URL when key is set, bbox + zoom computed client-side.

## Recommended next-session priorities

1. **Deploy** the latest main branch — stream-analytics-job is in source but not in deployed bundle. As is, `/items/stream-analytics-job/new` 404s today.
2. **Land Monaco + IntelliSense pass** across ALL `<textarea>` editors. This single change moves every query/SDL/M/JSON editor from D-or-C ceiling to B-or-A potential. Per parity-loop v2 build contract, this is the mandated standard.
3. **Wire dead ribbon labels** — every `RibbonTab[]` action gets a real `onClick` OR is removed from the ribbon. Today they're vaporware-flavored chrome.
4. **Power Platform deep-links** — at minimum, every PP editor should `Open in Power Platform` deep-link to the real make.X.microsoft.com URL on click. Today the ribbon label exists but has no handler.
5. **Real result rendering** for KQL/Gremlin/Cypher/GQL query results — table + simple chart (recharts) instead of `<pre>{JSON}</pre>`.

## Validator session limitations

- **Live Phase 4** was blocked by MFA re-auth required mid-session. The deployed Loom rotates SP/OBO tokens that need user Authenticator approval on every fresh browser context. Source-grade `onClick` audit substitutes.
- **stream-analytics-job** appears in source and registry but NOT in deployed bundle — surface returns 404 today. Author/registry confirmed; deploy pending.
- All 39 grades are conservative source-grade; live click might find additional BROKEN cases (downgrading) but unlikely to find better behaviour than source promises (upgrading).
