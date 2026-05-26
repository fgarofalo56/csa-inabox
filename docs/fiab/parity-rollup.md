# CSA Loom parity rollup — every surface

> Generated 2026-05-26 in response to user directive: "make sure you do this for everything in csa-loom.. every single page, item, options tools service, function, call, tools, ect".
>
> Live URL: https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/
> Live image tag: `loom-console:fix-44f3b00b` (revision `loom-console--0000075`)
>
> **Standard**: every row gets validated via the v2 4-phase validator from `.claude/workflows/fabric-parity-loop.md`. Grades: A+ / A / B / C / D / F. No row may be marked SHIPPED without a side-by-side Fabric+Loom screenshot + click-every-button report. See `parity-validation-standard` memory.

## Scope counts

| Surface family | Count | Status |
|---|---:|---|
| Pages (top-level UI routes) | 43 | swarm in flight |
| Editors (item types) | 85 | partial gap docs landing |
| API routes (handlers) | 242 | smoke + 401-gate checks in flight |
| Topbar + global UI | 9 | queued |
| Settings + drawers | 7 | queued |
| Auth + onboarding flows | 4 | queued |
| Azure service integrations | 18 | queued |
| **TOTAL surfaces to validate** | **408** | |

## Wave plan

### Wave A — Pages
- `/` Home
- `/workspaces` list + `/workspaces/[id]` detail
- `/browse`, `/onelake`, `/api-marketplace`, `/learn`
- `/governance` + 8 sub-pages (catalog, classifications, insights, lineage, policies, purview, scans, sensitivity)
- `/monitor`, `/realtime-hub`, `/data-agent`, `/copilot`, `/workload-hub`, `/workloads`, `/deployment-pipelines`
- `/admin` + 7 sub-pages (audit-logs, capacity, domains, security, tenant-settings, updates, usage, users, workspaces)
- `/setup` wizard
- `/apps` catalog + `/apps/[id]` detail
- Direct-link editor entry points: `/activator`, `/lakehouse`, `/notebook`, `/semantic-model`, `/warehouse`

### Wave B — Editors (85)
See `docs/fiab/fabric-parity-tasks.json`. Subset already in flight per the 4 background agents.

### Wave C — API routes (242 handlers)
Smoke against live URL: every GET returns 200 or documented 401/403/501 gate; every POST/PUT validates session; no 5xx unhandled exceptions.

### Wave D — Topbar + global UI
- App launcher (`AppLauncher`)
- Topbar search (`/api/search/items` backed)
- Copilot pane (`CopilotPane`)
- Notifications button
- Send-feedback widget
- Theme toggle
- Learn link
- Admin link
- Command palette (Ctrl+K)
- Tab strip
- Open-tabs persistence

### Wave E — Settings + drawers
- Workspace settings drawer (5 tabs: Permissions / Git / OneLake / Capacity / Domain)
- Item-side panel
- New-item dialog
- Sign-in modal
- Activity feed pane
- Pinned section
- Recent items / Recommended apps

### Wave F — Auth + onboarding
- MSAL sign-in
- Tenant bootstrap (admin bootstrap-catalogs + load-sample-data)
- Setup wizard end-to-end
- Apps install E2E (10 apps)

### Wave G — Azure service integrations
- Synapse (Dedicated SQL / Serverless SQL / Spark / Pipeline / Studio)
- Databricks (Notebook / Job / Cluster / SQL Warehouse / Workspace SCIM)
- ADF (Factory / Pipeline / Dataset / Trigger / Linked Service)
- APIM (Instance / API / Product / Policy / Operation)
- AI Foundry (Hub / Project / Compute / Dataset / Prompt Flow / Evaluation / Content Safety / Tracing / AI Search index)
- Power Platform (Environment / Dataverse / Power App / Power Automate / Power Pages / AI Builder)
- Copilot Studio (Agent / Knowledge / Topic / Action / Channel / Analytics)
- Cosmos DB (Gremlin / Vector / NoSQL)
- Azure SQL (Server / DB / MI / 2025 vector index)
- Azure Maps (Map / GeoDataset / GeoQuery / GeoPipeline)
- ADX/Kusto (KQL DB / Queryset / Dashboard / Eventhouse)
- Event Hubs / IoT Hub / Stream Analytics
- Purview (Data Product / Catalog / Classifications / Lineage)
- Azure ML (Experiment / Model / Endpoint)
- ACR / Container Apps / Front Door (Loom Console hosting)
- Key Vault / UAMI / Entra (auth + secrets)
- Storage / ADLS Gen2 (Lakehouse backing)
- Logic Apps (Auto-pause)

## Per-surface gap docs

All gap docs land in `docs/fiab/parity-gap/<surface>.md`. Each contains:
- The Fabric reference screenshot path
- The Loom under-test screenshot path
- A row-by-row Fabric-element-vs-Loom matrix with severity (BLOCKER/MAJOR/MINOR/COSMETIC)
- A click-every-button functional log
- The final A+/A/B/C/D/F grade with justification

## Current honest grades (as of 2026-05-26 — wave 1 + batch 1-3 land)

Aggregated from 60+ v2 validator gap docs in `docs/fiab/parity-gap/`. Each cell is anchored to a per-surface markdown file with side-by-side reference + click-every-button log.

### Editors (item-type editors at `/items/<type>/<id>`)

| Editor | Grade | Top BLOCKER |
|---|:---:|---|
| `notebook` | **D** | Cells are `<textarea>`, no Monaco. History 500s. 1-tab vs Fabric 5-tab. |
| `lakehouse` | **C** | Upload preview now handles all file types. Tables enumeration + Create Shortcut still missing. |
| `semantic-model` | **D** | DAX editor is `<textarea>`, no measure tree, no relationship-view canvas. |
| `report` | **D** | No `powerbi-client` SDK; embed surface is metadata text + 7 dead ribbon buttons. |
| `dashboard` | **D** | Reuses REPORT_RIBBON, wrong vocabulary. Tile grid is static CSS cards. No iframe. |
| `data-pipeline` | **D** | `PipelineDagView` emits arrows as Unicode text `from → to`. No SVG. |
| `warehouse` | **D** | T-SQL is `<textarea>` (`s.monaco` class is decorative). Query history is fake. |
| `synapse-dedicated-sql-pool` | **C** | Textarea + dead ribbon. Pool Resume/Pause is real-REST. |
| `synapse-serverless-sql-pool` | **C** | Textarea. Lake browser read-only. Run is real. |
| `synapse-spark-pool` | **B** | No code editor by design. Submit/Pause/Resume real-REST. 5 dead ribbon buttons. |
| `synapse-pipeline` | **D** | Shared DAG-view text-arrow BLOCKER. JSON tab is textarea. |
| `databricks-notebook` | **D** | Whole notebook is one `<textarea>`. No cells. No inline output. |
| `databricks-cluster` | **B** | Real lifecycle wiring. 8 dead ribbon buttons. |
| `databricks-job` | **B** | Strongest in batch — real Jobs 2.1 CRUD. Only `notebook_task` type. |
| `databricks-sql-warehouse` | **C** | Textarea. UC tree is real and excellent. Start/Stop real. |
| `adf-pipeline` | **D** | Shared DAG-view text-arrow BLOCKER. JSON textarea. |
| `adf-dataset` | **C** | Save + type mapping real. 6/80+ ADF dataset types supported. |
| `adf-trigger` | **C** | Schedule trigger fully real. Tumbling/Blob have hardcoded fields. |
| `apim-api` | **C** | Top-level settings real. Operations read-only. OpenAPI viewer is `<div>`. |
| `apim-product` | **B** | All fields persist correctly. Missing Subscriptions/Access tabs (scope expansion). |
| `apim-policy` | **C** | Scope routing correct. Save validates XML. No XSD/expression IntelliSense. |
| `eventstream` | **D** | Designer is a static node list; no live preview, no transform tile UI. |
| `eventhouse` | **D** | KQL editor textarea labeled `monaco`. No `@kusto/monaco-kusto`. |
| `kql-database` | **D** | Same KQL-textarea BLOCKER. Schema tree partial. |
| `kql-queryset` | **D** | Same. No multi-tab queryset surface. |
| Power Platform editors | **D-F** | See `powerplatform-editors.md` — most are config stubs. |
| Azure SQL editors | **D** | Same textarea pattern + minimal CRUD. See `azure-sql-editors.md`. |
| Graph/Vector editors | **C-D** | gql-graph Run wired; vector-store has Cosmos NoSQL backend. |
| Geo editors | **D** | Map preview stub. No live geo-query. See `geo-editors.md`. |
| Fabric IQ editors | **D** | See `fabric-iq-editors.md`. |

### Top-level pages

| Page | Grade | Top issue |
|---|:---:|---|
| `/` (home) | **C** | Recent + Recommended cards real. Hero is static. |
| `/browse` | **C** | Listing real. No filter facets. |
| `/workspaces` | **C** | Real Cosmos backing. Detail page is stub. |
| `/workspaces/[id]` | **C** | Items list real. Settings drawer 5 tabs. No git/capacity actions. |
| `/setup` (wizard) | **F** | `/api/setup/deploy` returns `stub-${Date.now()}`. Pure vaporware. |
| `/apps` (catalog) | **F** | Listing real. **All 10 apps install ZERO items** (`installed: []`). |
| `/apps/[id]` (10 apps) | **F** | Same root cause — items[] omitted from bootstrap-catalogs route. |

### Admin portal

| Page | Grade | Top issue |
|---|:---:|---|
| `/admin` (overview) | **C** | 9/25 nav vs Fabric. Landing is "Pick an area" stub. |
| `/admin/audit-logs` | **F** | EmptyState. No `/api/admin/audit-logs`. |
| `/admin/capacity` | **B** | Real ARM call. Only A-shaped admin page. |
| `/admin/domains` | **F** | Dead "Add domain" button (no onClick). |
| `/admin/security` | **F** | EmptyState. None of the promised links render. |
| `/admin/tenant-settings` | **F** | **0 of Fabric's 160 toggles.** Biggest portal violation. |
| `/admin/updates` | **A-** | Real /api/version, real CTAs. Markdown render away from A. |
| `/admin/usage` | **F** | EmptyState with "(preview)". No data. |
| `/admin/users` | **F** | EmptyState. No Graph integration. |
| `/admin/workspaces` | **F** | Misleading "My workspaces" button routes to user view. |

### Distribution snapshot

| Grade | Count (of ~60 surfaces validated) |
|:---:|:---:|
| A+ | 0 |
| A / A- | 1 |
| B | 6 |
| C | ~18 |
| D | ~22 |
| F | ~13 |

### Cross-cutting BLOCKERs (apply to many surfaces)

1. **No Monaco anywhere** — `@monaco-editor/react` not in `package.json`. Every code/query/JSON/XML editor is a `<textarea>` with a `font-family: Consolas` CSS class misleadingly named `monaco`. **Affects ~25 editors.**
2. **`PipelineDagView` has no SVG arrows** — edges render as Unicode text `from → to`. **Affects synapse-pipeline + adf-pipeline + data-pipeline + 2 others.**
3. **74+ dead ribbon buttons across the validated batches** — `RibbonAction.onClick` consistently missing. Editors compensate with toolbar buttons but the ribbon pills are inert.
4. **Apps install ZERO items** — `seed-catalogs.sh` defines `items[]` arrays for 22 items across 10 apps, but `app/api/admin/bootstrap-catalogs/route.ts` omits items entirely. **Affects all 10 apps.**
5. **No `powerbi-client` SDK** — Report / Dashboard / Semantic-Model can't embed live. **Affects PB trio.**
6. **URL auto-rotator** — every navigation is followed 1-3s later by an unsolicited `router.push` to `/items/<random>/new`. **Affects every editor + every page.**

### Remediation priority

1. **Install `@monaco-editor/react` + `@kusto/monaco-kusto`** → ~6h, unblocks ~25 editors (C→B, several B→A).
2. **Install `powerbi-client` + `powerbi-client-react`** → ~4h, unblocks PB trio (D→B).
3. **Wire SVG arrows in `PipelineDagView`** → ~4h, unblocks 5 pipeline editors (D→C).
4. **Fix `bootstrap-catalogs` items[] omission** → ~2h, unblocks all 10 apps (F→C).
5. **Diagnose URL auto-rotator** → ~3h, unblocks every page (site-wide fix).
6. **Add Fluent MessageBars to 7 admin F-grade pages** → ~3h, F→C (honest gates).
7. **Sweep RibbonAction.onClick wiring** → ~2h, closes 74 BROKEN findings.

Total Build Phase 1 estimate: **~24h to lift portal-wide average from D to B-.**

The rollup is updated by every validator agent. Each gap doc dropped under `docs/fiab/parity-gap/` is appended here under the right family.
