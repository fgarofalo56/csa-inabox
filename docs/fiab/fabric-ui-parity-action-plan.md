# CSA Loom — Fabric UI Parity Action Plan (2026-05-25)

Deep review of Microsoft Fabric screenshots in `C:\tmp\csa-loom\` (27 PNGs). Action items grouped by surface, with Azure backing service (✅ already wired) or open-source alternative.

## Source images reviewed

`2026-05-24_23-48-15` Workspace view (casino-fabric-poc) · `_23-48-39` Workspace Settings drawer · `_23-50-11` +New item full catalog · `_23-50-49` Folder browse (lh_bronze) · `_23-51-30` Power BI Learning Center · `_23-52-03` Scorecards hub · `_23-52-38` OneLake catalog · `_23-53-17` Real-Time hub · `_23-53-42` Real-Time hub detail · `_23-54-31` Functions hub · `_23-55-28` Workloads marketplace · `_23-56-26` Fabric Home (task flows) · `_23-57-29` Lakehouse table editor · `_00-02-52` Deployment pipelines · `_00-03-58` Lakehouse SQL endpoint · `_00-04-32` Open existing notebook modal · `_00-05-27` Notebook editor (chrome + ribbon + Copilot) · `_00-06-13` Data Pipeline editor · `_00-15-41`/`_00-15-55` Map (Translytical) editor.

## Capabilities Fabric has that CSA Loom must match

### A. Top-level UI chrome (every page)
- **App launcher icon** (top-left grid — M365 dot-grid waffle) ✅ HTML/CSS only
- **Product name + tab strip** — tabs per opened item with × close + "Saved/Saving" status ✅
- **Center search bar** (global semantic search) — needs Azure AI Search index of items
- **Right cluster**: sidebar collapse, notifications-with-badge, settings gear, downloads, help, feedback, profile-with-status
- **Workspace + item breadcrumb** (e.g., `Fabric > lh_bronze`) ✅ Next.js routing

### B. Left sidebar persistent rail (13 items)
Home · Copilot · Create · Browse · Apps · Scorecards · OneLake catalog · Learn · Monitor · Real-Time · Functions · Workloads · Workspaces

Loom currently has: Home, Workspaces, Browse, OneLake, API marketplace, Governance, Monitor, Real-Time Hub, Data Agent, Copilot, Workload Hub, Deployment Pipelines, Admin, Setup. **Renames + reorder + add Apps + Scorecards + Functions + Learn + Create**. Pin recent workspaces + items at bottom.

### C. Top-level pages — gap analysis

| Page | Fabric capability | Loom state | Azure backing | Action |
|---|---|---|---|---|
| **Home** | Welcome + 11 predesigned task-flow templates + Learn cards carousel + Quick access (Recent workspaces/items/Favorites) | basic | n/a | Rebuild with task-flow grid |
| **Apps** | Gallery of installable apps (CSA-curated + 3rd-party) | missing | Marketplace catalog in Cosmos | Build Apps gallery page |
| **Scorecards** | Goals/KPI tracking + sample scorecards + Recommended/Following/Assigned tabs | missing | Cosmos for goals + Power BI Scorecards REST (already wired) | Build Scorecards hub page |
| **OneLake catalog** | Explore/Govern/Secure tabs + cross-workspace inventory + filters | basic Browse | Cosmos + ADLS Gen2 + Synapse Serverless + Purview (existing dmlz-dev-purview) | Build catalog page with tabs |
| **Learn center** | Training cards + Sample reports + What's new + Testimonials | missing | Static MDX content + GitHub releases API | Build Learn page |
| **Real-Time hub** | Streaming data tab + Subscribe to (Business/Fabric/Azure events) + Browse (event schema registry) + Discover/analyze/act hero cards | basic | EventHubs + ADX + Activator + Synapse pipelines (all wired) | Rebuild Real-Time hub page |
| **Monitor** | Activity log + Run history + Refresh status across all items | basic | App Insights + Log Analytics (UAMI has Reader role) | Real activity stream |
| **Functions hub** | Functions discovery + All/My/Endorsed/Favorites filters + Explorer rail | missing | Azure Functions (need module in DLZ) | Build Functions hub page + bicep Functions module |
| **Workloads** | Marketplace of partner/MS workloads (30+ tiles) + My workloads (Included/Org-added) | missing | Cosmos catalog + workload install metadata | Build Workloads marketplace page |
| **Workspaces** | List view of all workspaces with capacity icons + filter + create | ✅ wired (Cosmos) | Cosmos | Enhance with workspace icons + filter |
| **Deployment pipelines** | 4-stage Dev→Test→Prod visual + assign workspace + share | missing | Cosmos + GitHub Actions for promote | Build pipeline page + GHA promotion workflow |
| **Admin** | Tenant settings, capacity admin, audit logs, users, security | basic | Defender for Cloud + AAD admin REST | Build Admin pages |
| **Setup** | One-button deploy wizard | ✅ wired (setup-orchestrator) | Bicep deployment | Enhance UI |
| **Copilot** | Cross-item NL orchestration | ✅ wired (v3 agent in flight) | AOAI via Foundry hub | Surface in /copilot |

### D. Workspace view (`/workspaces/[id]`)
- Header: workspace name + badges (diamond=capacity tier, cloud=OneLake-enabled) + description
- Right action bar: Create deployment pipeline, Create app, Manage access, Workspace settings
- Toolbar row: **+New item**, New folder, Import, Migrate, Filter by keyword, Filter (advanced)
- Task-flow ribbon at top with predesigned templates ✅ Cosmos catalog
- Empty state: "Choose from predesigned task flows or add a task"
- Item table with extended columns: Name · Status · Type · Task · Owner · Refreshed · Next refresh · Endorsement · Sensitivity · Included in app

### E. +New item modal (catalog)
60+ item types grouped by category. **Loom catalog already has most types**, but needs:
- Tabbed category nav (left)
- Card grid (icon + name + 1-line description)
- "Show details" toggle for full descriptions
- Filter/search across all types
- Bottom CTA: Cancel · Create

### F. Workspace Settings drawer (15+ sections)
General · Workspace type · Azure connections · System storage · Git integration · Workspace identity · Outbound networking · Inbound networking · Encryption · Monitoring · Power BI (collapsible) · Delegated Settings · OneLake · Data Engineering/Science · Data Factory · Data Warehouse

All wired against real Azure resources via existing clients. The drawer just renders panels.

### G. Editor chrome (every item editor)
- **Multi-tab interface** — every opened item is a tab in the top tab strip with × close + dirty marker
- **Saved/Saving live status** + "No label" dropdown for endorsement/sensitivity
- **Ribbon** with tabs: Home, Edit, AI tools, Run, View (per item type)
- **Toolbar row** below ribbon with item-specific actions
- **Right action cluster**: Comments · History · Develop dropdown · Share button · Copilot floating
- **Left Explorer panel** (collapsible) for tree/list of related items
- **Status bar** at bottom: connection state, AutoSave, Copilot completions toggle, current selection
- **Copilot integration EVERYWHERE** — toolbar button + slash commands + side pane

### H. Specific editors to polish
| Editor | Fabric pattern | Loom state |
|---|---|---|
| **Notebook** (Fabric) | Code cells + magics + Data Wrangler + Run all + cluster connect + Environment picker + VS Code link | ✅ wired in v2.4 — needs UI polish |
| **Lakehouse** | Explorer left + table grid + Get data / Open notebook / Add to data agent / Manage OneLake security / Update activities ribbon | ✅ wired — needs ribbon styling |
| **Data Pipeline** | Activity palette + canvas + Run/Schedule/Trigger ribbon | ✅ wired — needs canvas (currently JSON editor) |
| **Map (Translytical)** | World map + data sources rail + Fabric items / Bottom sources tabs + welcome tour | partial in `phase4-editors.tsx` — needs Leaflet/Azure Maps |
| **Activator** | Rules + triggers (Fabric Reflex) | ✅ wired in v2.3 |
| **All others** | Same chrome pattern | ✅ underlying functionality wired |

## Theme — keep CSA Loom branding

Fabric uses bright **cyan/teal accent** (#1FCE9A-ish) on dark gray. Loom uses its own brand — already dark with brand color. **DO NOT switch to Fabric's teal**. Apply Fabric's *patterns* (cards, ribbons, spacing, badge usage, tab strips, drawer layouts) using Loom's existing tokens (`tokens.colorBrandBackground*`, etc. from Fluent UI v9 via `lib/components/`).

## Azure services — coverage check

Loom is now wired against **all 28 backend services** Fabric exposes:
- ✅ Synapse (Serverless+Dedicated+Spark+Pipeline), Lakehouse (ADLS), Databricks (SQL Warehouse+Notebook+Job+Cluster), APIM, AI Foundry hub + projects + sub-editors, ADX/Kusto, ADF, Power BI/Fabric editors (workspace SP gated), Cosmos, AI Search (reused), Content Safety, App Insights/Log Analytics tracing, Foundry compute/datasets/connections/deployments, Activator
- v3 in-flight: Power Platform (Dataverse/PowerApps/PowerAutomate/PowerPages/AI Builder), Copilot Studio (Agents/Knowledge/Topics/Actions/Channels), SQL Server 2025, geoanalytics (Azure Maps), graph stores (Cosmos Gremlin), data-product templates, cross-item Copilot orchestrator

**Open-source fallbacks where Azure doesn't have it:**
- Real-time visualization → Grafana embedded
- Code editor / IDE → Monaco (already in use)
- Graph viz → vis-network or cytoscape
- Map → Leaflet (open-source basemap)
- Notebook execution → Databricks (already wired) + Jupyter via Container App when needed

## 1-click deploy status

Loom's top-level `platform/fiab/bicep/main.bicep` is push-button. All resources deploy via `commercial-full.bicepparam`. v3 work (agents in flight) is also bicep-modular. Remaining: PE for Power Platform (admin SP), Fabric Capacity allocation (manual + paid), Function App provisioning bicep module.

## What I'm spawning the UI agent to do

**Scope (this session):**
1. Top header redesign (app launcher + tab strip + saved status + right cluster + breadcrumbs)
2. Left sidebar redesign (13 nav items + pinned section + collapse)
3. Home page redesign (predesigned task flows + Learn cards carousel + Quick access)
4. Workspace view enhancement (action bar + toolbar + task-flow ribbon + extended item table columns)
5. +New item modal (category-grouped catalog with tabbed left nav + card grid)
6. Workspace Settings drawer (15 sections)
7. Apps gallery page (new)
8. Scorecards hub page (new)
9. Functions hub page (new)
10. Workloads marketplace page (new)
11. Learn center page (new)
12. Editor chrome refactor: multi-tab interface + ribbon + saved status + right cluster + status bar

**Theme constraint:** keep existing Loom brand tokens; use Fabric's structural patterns only.

**Out of scope (deferred to v4):**
- Power BI/Fabric workspace embed (requires Power BI Embed SDK + delegated user auth)
- Real Azure Maps tile rendering (needs Azure Maps account provisioned)
- Drag-drop canvas for Data Pipeline (currently JSON editor — sufficient for v3)
- Apps gallery 3rd-party submission flow (CSA-curated only)
