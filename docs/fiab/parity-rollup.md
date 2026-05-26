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

## Current honest grades (as of 2026-05-26)

From the partial side-by-side I ran today + the user's manual feedback:

| Surface | Honest grade | Top gap |
|---|---|---|
| Notebook editor | **D** | Plain `<textarea>` instead of Monaco. 1-tab vs Fabric 5-tab. No 3-tab Explorer. HistoryDrawer 500s. |
| Data pipeline DAG canvas | **D** | DAG view renders box columns; **zero arrows drawn between activities** — edges shown as a text paragraph. |
| Lakehouse upload | **C** (was D before today's fix) | Upload preview now handles all file types gracefully (no more "not a parquet file" error). Create Shortcut flow still missing. |
| Stream Analytics | not graded | Editor scaffold landed today, ARM-backed BFF not wired |
| All other 80 editors | **C-** (assumed) | Most are scaffold-grade until validator confirms otherwise. Will be re-graded by the swarm. |
| Top-level pages | not graded | Validator wave A pending |
| API routes | unknown | Validator wave C pending |

The rollup is updated by every validator agent. Each gap doc dropped under `docs/fiab/parity-gap/` is appended here under the right family.
