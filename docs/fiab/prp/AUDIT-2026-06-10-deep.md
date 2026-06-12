# CSA Loom — Deep-Dive Gap Audit Supplement (2026-06-10)

This supplement reconciles five operator deep-dive ledgers — **ATLAS deep history**
(107 distinct open asks), **Fabric Build 2026** (37 new-feature parity items),
**Help/Learning Hub**, **MCP/Admin catalog**, and **UI redesign** — against the
codebase. It extends the first audit (`AUDIT-2026-06-10.md`, items
**audit-T01..T36**) with **NEW** items the first audit missed or collapsed.

## What the first audit missed

The first audit was accurate but **coarse-grained** in five places — it folded entire
epics into one line each:

1. **Weave / Palantir parity (audit-T29)** — one line for what the operator
   specified as **8 distinct product surfaces** (Weave, Atelier, Spindle, Tapestry,
   Warp, Shuttle, Lens, Bolt) plus a Thread integration-fabric epic with **6 deferred
   edges**. None broken out.
2. **MCP server library (audit-T34)** — one line. The deep dive shows the BYO-endpoint
   half is built but the **entire deployable catalog** (catalog data file, browse UI,
   deploy-to-Container-Apps wizard, per-field KV secrets, Azure Files mount, stdio→HTTP
   bridge, deploy/status/delete routes, bicep) is unbuilt — **8 sub-items**.
3. **Learning Hub** — essentially **uncovered**. The portal + per-item Learn drawer are
   built, but **use-case deep-links, notebook import wizard, Supercharge-Fabric
   conversion, Learning-Hub Copilot, guided tour** are all missing.
4. **Fabric Build 2026 features** — **entirely uncovered**. 37 GA/Preview features
   announced June 2-3 2026 + Jan–Jun 2026 monthly drops, ~20 of which have no Loom
   surface (Planning in Fabric, materialized lake views, Eventstream SQL Operator tab,
   RTI dashboard live-refresh/time-series/AI-tile, OneLake item-size, SharePoint
   shortcuts, Iceberg endpoint, GPU-DW gate, SQL DB migration assistant, DSPM-for-AI,
   IRM-for-lakehouse, AutoML, ghe.com Git, Loom CLI, etc.).
5. **UI redesign** — collapsed into one "uiPolish[]" line. The deep dive enumerates
   **per-page adoption debt** (primitives exist but ~30 pages still write raw inline
   styles) plus **5 operator-flagged functional bugs** (Monitor slow load, data-agent
   Send scrolls off, deploy-planner missing service types, federated-search vertical-rule
   collision, Workload Hub icon quality).

It also missed a cohort of **Thread edges**, **deployment/BYO depth**, **governance
depth** (warehouse/KQL access-policy enforcement, classification taxonomy read-in,
Purview scan depth), **perf/ops quality** (page-load harness, async install,
capacity/compute scale UI), and **CLI/platform** asks (fiab-migrate, loom-*,
`/api/agent/<id>/chat`).

## Verification performed

Grepped `apps/fiab-console` to confirm absence/presence before listing:

- `lib/mcp/catalog*` → **absent** (no catalog data file).
- `fabric-planning` / `PlanningEditor` → **absent**.
- `materialized-lake-view` / `MaterializedLakeView` → **absent**.
- guided-tour / shepherd / intro.js → **absent**.
- `loom-skills` → **absent**.
- `publishToM365` / data-agent M365 publish → **absent**.
- `xyflow`/`ReactFlow` under `lib/thread` or `app/thread` → **absent** (Thread edges
  have a Cosmos data layer `lib/thread/thread-edges.ts` but **no node-link render**).
- `scripts/csa-loom/byo-wizard.sh` → **absent**.
- AutoML editor/catalog entry → **absent**.
- **Correction to ledgers:** `lib/components/onelake/lifecycle-rules.tsx` **exists** —
  OneLake lifecycle UI is BUILT (UI ledger lists it only as polish-debt). Item-size
  reporting and tiers-UI are still gaps. Use-case `appId` is stored in
  `lib/learn/content.ts` but the install button is **not** wired.

## New Backlog (audit-T37+)

Grouped into waves continuing after the first audit's 5 waves.

| New Item | Area | Ask Source | Status | Goal | Wave |
|---|---|---|---|---|---|
| audit-T37 ~40 use-case tutorials as individual deep-link LearnTopics | help-learning | csa_loom_learning_hub.md: "~40 use cases (both sites) as LearnTopics (new 'Use cases' section), each → matching content-bundle app install where one exists, else a built walkthrough" | partial | Each of the 21+ use cases links to its own walkthrough doc (not the shared index); step-by-step + visuals authored | 6 |
| audit-T38 Use-case "install this live example" wizard in Learn portal | help-learning | learn/content.ts: appId stored but "install/import wizard is wired in a follow-up; today the card opens the doc" | ui-only | appId-bearing use cases get a working Install button → real provisioner install→provision→seed | 6 |
| audit-T39 Notebook import wizard (pick workspace + with/without sample data) | help-learning | csa_loom_learning_hub.md: "Learning-Hub action → pick workspace + 'with sample data / without' → import the prebuilt notebook (Synapse + Databricks) via the existing notebook provisioner" | missing | Learn-Hub wizard calls notebook provisioner; real ADLS seed when sample-data chosen | 6 |
| audit-T40 Convert all Supercharge-Fabric notebooks to Loom-native bundles | help-learning | csa_loom_learning_hub.md: "import all notebooks from Suppercharge_Microsoft_Fabric/notebooks/ and convert to Loom (Synapse Spark + Databricks, ADLS/ADX instead of OneLake/Fabric)" | missing | Converted notebook bundles in lib/apps/content-bundles run on Azure-native backends | 6 |
| audit-T41 Learning Hub Copilot (tutorial-step context + auto-error-detect + apply-fix) | help-learning | csa_loom_learning_hub.md: "reuse help-copilot/copilot-orchestrator with a tutorial-context system prompt + the current step + auto-error-detection (watch the run/provision receipts) → recommend/apply fixes" | missing | Per-step aware Copilot that reads run receipts and recommends/applies fixes | 6 |
| audit-T42 Guided in-product onboarding tour | help-learning | csa_loom_ui_overhaul_backlog.md + setup-wizard ask; no TourStep/shepherd found in repo | missing | First-run guided tour overlay across core surfaces; dismissable + resumable | 6 |
| audit-T43 Learn portal: flip primary doc links to Loom docs, MS Learn secondary | help-learning | csa_loom_ui_overhaul_backlog.md: "links go to MS docs → flip to CSA Loom docs PRIMARY (LOOM_DOCS_BASE → docs/fiab/**) + MS Learn SECONDARY; missing Loom docs = tracked build-out (don't fake links)" | done | DONE: Loom docs PRIMARY everywhere (getLearn/getLearnCatalog/getCoreSurfaceTutorials → loomDocUrl), MS Learn SECONDARY (catalog.docsUrl demoted); missing Loom pages tracked via computed loomDocBacklog(), not faked; learn-topic-card shows "Loom guide coming" badge for doc-less items. loom-docs-links.test.ts (151 assertions) enforces: every hasLoomDoc primary resolves to a real on-disk page, no mislabelled link, no fake/dead link. Fixed link-integrity test false-negative: docExists() now recognises the MkDocs README.md index-alias convention (used by 198 nav entries incl. learn/08-solutions/<accelerator>/), so the 5 solution-accelerator use-case docs are correctly validated instead of flagged dead. | 6 |
| audit-T44 MCP deployable-catalog data file (lib/mcp/catalog.ts) | mcp-admin | csa_loom_mcp_library.md: typed catalog entry per server {id,name,desc,category,image,runtime,transport,configSchema,source,govSafe,airGapSafe,license,defaultRecommended}; research ready in temp/mcp-gov-research.md | missing | Typed catalog of MS + vetted 25 gov-safe community servers generated from research doc | 7 |
| audit-T45 MCP browse-catalog + deploy wizard (per-server configSchema, per-field KV secrets) | mcp-admin | csa_loom_mcp_library.md: "Admin Portal → Tenant settings → External MCP Tools gets a library of MCP servers users pick from → deployed to Azure, preconfigured, wired in, zero user config" | missing | Browse UI + wizard; secrets→KV (per-field flag), non-secrets→env; one-click deploy | 7 |
| audit-T46 MCP deploy-to-Container-Apps path + Azure Files mount | mcp-admin | csa_loom_mcp_library.md: "deployed to Azure Container Apps + KV secretRef env + Azure Files mount"; container-apps-arm-client now has MCP deploy methods (deployMcpContainerApp/upsertEnvStorage/getStorageAccountKey/createMcpContainerApp) | done | container-apps-arm-client deploys MCP image with KV secretRef env + Azure Files persistence — see docs/fiab/csa_loom_mcp_library.md | 7 |
| audit-T47 MCP stdio→HTTP/SSE bridge wrapper for npx/uvx servers | mcp-admin | csa_loom_mcp_library.md: "stdio→HTTP/SSE bridge wrapper (supergateway/mcp-proxy) for stdio-transport MCP servers" | missing | Bridge image + wrapper config so stdio servers expose HTTP/SSE | 7 |
| audit-T48 MCP catalog BFF routes (deploy/status/delete) + bicep (KV policy, Azure Files) | mcp-admin | csa_loom_mcp_library.md build order: "/api/admin/mcp-catalog/deploy, /status, /delete + bicep KV access policy for MCP app UAMIs + Azure Files share" | missing | Real deploy/status/delete routes calling ARM; bicep modules deploy supporting infra | 7 |
| audit-T49 Admin env/config management UI (set deployment env vars from UI) | mcp-admin | csa_loom_mcp_library.md / admin deep dive: "No admin page to view or change deployment env vars from the UI"; mandate is zero-Azure-portal config | missing | Admin surface to view/edit runtime config (env-backed settings) with audit trail | 7 |
| audit-T50 Weave (Semantic Ontology) — object/link/action types + write-back, Phase 1 | fabric-build-2026 | csa_loom_weave_epic.md: "build 1:1 Palantir-class parity INTO CSA Loom … Azure-native + OSS, pre-deployed + wired + secure-by-design, deployed BY DEFAULT via bicep" | missing | Ontology object/link/action types on PostgreSQL+Apache AGE, real write-back, bicep-deployed | 8 |
| audit-T51 Atelier — low-code operational app builder over the Weave (Workshop-equiv) | fabric-build-2026 | csa_loom_weave_epic.md: Atelier = Workshop-equiv operational app builder | missing | Low-code app builder bound to Weave ontology; real CRUD over backing store | 8 |
| audit-T52 Spindle — AI agents + logic over the Weave (AIP-equiv) incl. Spindle Studio | fabric-build-2026 | csa_loom_weave_epic.md: Spindle = AIP-equiv agents+logic + Spindle Studio agent studio | missing | Agent/logic layer + studio over the ontology, real Azure OpenAI/Foundry backend | 8 |
| audit-T53 Tapestry — investigative graph + link/geo/timeline analysis (Gotham-equiv) | fabric-build-2026 | csa_loom_weave_epic.md: Tapestry = Gotham-equiv investigative graph + link analysis + geospatial + timeline | missing | Link-analysis + geo + timeline on ADX graph + Azure Maps, real data | 8 |
| audit-T54 Warp — visual transforms / code pipeline builder (Pipeline Builder + Code Repos-equiv) | fabric-build-2026 | csa_loom_weave_epic.md: Warp = Pipeline Builder / Code Repos-equiv | missing | Visual+code transform builder emitting real Spark/SQL transforms | 8 |
| audit-T55 Shuttle — deployment/release/environment orchestration (Apollo-equiv) | fabric-build-2026 | csa_loom_weave_epic.md: Shuttle = Apollo-equiv release/env orchestration | missing | Real release/promotion orchestration across Loom environments | 8 |
| audit-T56 Lens — point-and-click analytics (Contour-equiv) | fabric-build-2026 | csa_loom_weave_epic.md: Lens = Contour-equiv point-and-click analytics | missing | Visual analytics board executing real queries against Loom backends | 8 |
| audit-T57 Bolt — packaging / marketplace distribution (Marketplace-equiv) | fabric-build-2026 | csa_loom_weave_epic.md: Bolt = Marketplace-equiv packaging/distribution | missing | Package + distribute Weave artifacts; real install path | 8 |
| audit-T58 Thread edge: data-agent semantic-model DAX via executeDatasetQueries | fabric-build-2026 | csa_loom_thread_roadmap.md: "DataAgentSource lacks pbi workspaceId+datasetId; source-schema + picker change needed" | missing | DataAgentSource carries dataset binding; DAX dispatch via executeDatasetQueries | 8 |
| audit-T59 Thread edges: Lakehouse/KQL/Azure SQL → Power BI model + API (per-backend adapter) | fabric-build-2026 | csa_loom_thread_roadmap.md: "Lakehouse/KQL/Azure SQL → Power BI model + API thread edges (per-backend columns adapter)" | missing | Each backend adapts columns into a model/API edge, real backend | 8 |
| audit-T60 Thread edge: Lakehouse → Synapse Serverless SQL view (CREATE DATABASE/VIEW DDL) | fabric-build-2026 | csa_loom_thread_roadmap.md: "Lakehouse → Synapse Serverless SQL view edge (Thread PR2, CREATE DATABASE/VIEW DDL)" | missing | Real Synapse Serverless DDL creates view over lakehouse Delta | 8 |
| audit-T61 Thread edge: report build + embedded report as a Thread edge | fabric-build-2026 | csa_loom_thread_roadmap.md: "Report build + embedded report in Loom as a Thread edge" | missing | Build + embed report edge over the semantic layer | 8 |
| audit-T62 Thread edge: medallion promotion flow | fabric-build-2026 | csa_loom_thread_roadmap.md: "Medallion promotion flow as a Thread edge" | missing | Bronze→Silver→Gold promotion edge executing real transforms | 8 |
| audit-T63 Thread edges: React Flow node-link rendering of thread-edges Cosmos data | fabric-build-2026 | csa_loom_thread_roadmap.md: "React Flow node-link rendering of thread-edges Cosmos data"; no xyflow under lib/thread | missing | Graph render of thread-edges (data layer exists, render absent) | 8 |
| audit-T64 Planning in Fabric — PlanningEditor (budgets/forecasts/scenarios + AAS writeback) | fabric-build-2026 | Fabric Build 2026 #3: "Planning in Fabric GA — plans/budgets/forecasts/scenario models on semantic models with writeback"; current 'plan' slug is a CI/CD concept, no PlanningEditor found | missing | New fabric-planning item + PlanningEditor; writeback via AAS XMLA/Synapse INSERT | 8 |
| audit-T65 Materialized Lake Views item type (cross-workspace lineage + pipeline refresh) | fabric-build-2026 | Fabric Build 2026 #11: "Materialized lake views — SQL+PySpark authoring, cross-workspace lineage, Refresh Materialized Lake View pipeline activity"; no item type found | missing | New item type on ADLS Delta + Cosmos lineage + ADF refresh activity | 8 |
| audit-T66 Eventstream SQL Operator tab (inline T-SQL, per-output testing, multi-sink) | fabric-build-2026 | Fabric Build 2026 #12: "SQL operator in Eventstream GA — code-first T-SQL, multiple outputs, per-output testing"; ASA wired but no T-SQL operator tab | partial | T-SQL operator tab backed by ASA SQL job, multi-named-sink, per-output test | 8 |
| audit-T67 Eventstream embedded Activator alerts (inline ribbon quick-create) | fabric-build-2026 | Fabric Build 2026 #13: "Create/manage Activator alert rules directly within the Eventstream editor"; no Add-alert action found | missing | Eventstream ribbon Add-alert creates+links Activator pre-seeded with stream source | 8 |
| audit-T68 Eventstream secure MQTT mTLS (Key Vault cert picker) | fabric-build-2026 | Fabric Build 2026 #14: "MQTT source supports CA+client certs from Key Vault for mTLS"; MQTT source exists, no mTLS cert panel | missing | KV cert picker fields in MQTT source dialog; real mTLS connection | 8 |
| audit-T69 RTI dashboard live-refresh interval control (push/auto-refresh) | fabric-build-2026 | Fabric Build 2026 #16: "Real-Time Dashboards Live Refresh GA — tiles update as data lands"; KQL dashboard refresh on demand only | missing | Refresh-interval control (Off/5s/30s/1m) on KQL dashboard, real ADX requery | 8 |
| audit-T70 RTI dashboard AI tile editor (NL → KQL visualization) | fabric-build-2026 | Fabric Build 2026 #15: "AI-first tile editor — describe in NL, Copilot generates the KQL visualization" | missing | Describe-in-NL → KQL Copilot inserts a real tile | 8 |
| audit-T71 RTI dashboard time-series visualization (overlay/multi-panel/zoom slider) | fabric-build-2026 | Fabric Build 2026 #17: "Time-series: legend search, pin-and-overlay, multi-panel, Y-axis scaling, zoom slider" | missing | Time-series controls in tile renderer over real ADX series | 8 |
| audit-T72 Business Events publishing surface (Activator structured signals) | fabric-build-2026 | Fabric Build 2026 #18: "Business Events GA — Activator publishing structured governed signals, capacity-metered" | missing | Activator publishes structured events (Event Hubs+Event Grid), discoverable in RT hub | 8 |
| audit-T73 OneLake item-size reporting (workspace storage usage) | fabric-build-2026 | Fabric Build 2026 #9: "Item-level storage usage across OneLake incl. system + soft-deleted, on-demand refresh"; no aggregate report found | missing | Workspace panel aggregating ADLS blob sizes per item prefix | 8 |
| audit-T74 OneLake shortcuts to SharePoint/OneDrive | fabric-build-2026 | Fabric Build 2026 #10: "Create shortcuts to SharePoint and OneDrive GA"; shortcut wizard supports ADLS/S3/GCS only | missing | SharePoint/OneDrive shortcut source via Microsoft Graph in shortcut wizard | 8 |
| audit-T75 OneLake Iceberg V2 endpoint toggle on lakehouse | fabric-build-2026 | Fabric Build 2026 #21: "OneLake Iceberg V2 virtualization — Delta read by Iceberg readers"; no Iceberg endpoint setting | missing | Lakehouse 'expose as Iceberg' shows ADLS path + Iceberg catalog URL | 8 |
| audit-T76 GPU-accelerated warehouse honest-gate | fabric-build-2026 | Fabric Build 2026 #7: "GPU-Accelerated Fabric DW (NVIDIA) Preview"; no acceleration toggle in WarehouseEditor | missing | Query-acceleration toggle + honest MessageBar (Synapse default has no GPU; Fabric backend opt-in) | 8 |
| audit-T77 SQL DB migration assistant (DACPAC import + compatibility scan) | fabric-build-2026 | Fabric Build 2026 #22: "SQL DB Migration Assistant Preview — imports schema via DACPACs, flags compatibility"; no migration wizard found | missing | DACPAC upload + compatibility assessment + import into Synapse SQL pool | 8 |
| audit-T78 SQL DB vector index + full-text search management tab | fabric-build-2026 | Fabric Build 2026 #23: "SQL DB Vector Index + Full-Text Search Preview"; no dedicated FTS/vector tab in AzureSqlDatabaseEditor | partial | FTS + vector index creation dialogs via T-SQL | 8 |
| audit-T79 Copy Job native CDC mode toggle for SQL sources | fabric-build-2026 | Fabric Build 2026 #25: "Copy Job CDC for Azure SQL/SQL Server/MI"; only custom watermark path exists, no CDC-mode UI | partial | CDC-mode toggle (source-gated) using ADF change-tracking | 8 |
| audit-T80 Mirroring BigQuery + Oracle source wizard (credential forms) | fabric-build-2026 | Fabric Build 2026 #19: "Mirroring BigQuery + Oracle Preview"; provisioner maps bigquery→GenericMirror but wizard credential forms unverified | partial | Wizard surfaces BigQuery/Oracle with project-id/SHIR credential fields | 8 |
| audit-T81 Mirroring Snowflake Iceberg-table option | fabric-build-2026 | Fabric Build 2026 #20: "Snowflake now also mirrors Apache Iceberg tables"; no Iceberg checkbox in mirror wizard | partial | 'Include Iceberg tables' option when source is Snowflake | 8 |
| audit-T82 Copilot modifies semantic models (model-structure NL pane) | fabric-build-2026 | Fabric Build 2026 #26: "Copilot modifies semantic models via NL — rename measures, add descriptions, suggest relationships, restore checkpoint"; auto-describe exists, model-edit NL missing | partial | Copilot pane edits model structure via XMLA TMSL (aas-client), with checkpoint | 8 |
| audit-T83 Bulk AI auto-description for semantic models (catalog action) | fabric-build-2026 | Fabric Build 2026 #36: "AI Auto-Description for Semantic Models Preview — bulk from OneLake catalog detail"; per-measure exists, bulk catalog surface missing | partial | 'Generate descriptions for all tables/measures' bulk action via dax-tools | 8 |
| audit-T84 Semantic-model-bound Fabric App builder | fabric-build-2026 | Fabric Build 2026 #28: "Fabric Apps for Semantic Models — full web apps backed by semantic models"; Rayfin covers general case only | partial | Model-bound app builder extending Rayfin, real model binding | 8 |
| audit-T85 Data agents → publish to M365 Copilot | fabric-build-2026 | Fabric Build 2026 #4: "Data Agents in M365 Copilot GA — discover+chat governed sources inside M365 Copilot"; copilot-studio-client exists, no publish surface | partial | Publish a Loom data agent as an M365 Copilot data source via Copilot Studio API | 8 |
| audit-T86 Fabric IQ / Microsoft IQ unified MCP tool surface | fabric-build-2026 | Fabric Build 2026 #1+#6: "Fabric IQ GA … integrated as an MCP tool in Agent 365 and Foundry"; no FabricIQ MCP/Agent 365 surface | missing | Package ontology+semantic+live-signals as one MCP tool endpoint for external agents | 8 |
| audit-T87 AutoML low-code wizard | fabric-build-2026 | Fabric Build 2026 #37: "AutoML Low-Code UX GA — regression/forecasting/classification/multi-class"; no automl item/editor found | missing | automl item + wizard (task picker, dataset, compute, run monitoring) on AML AutoML | 8 |
| audit-T88 loom-skills package (Azure-native patterns for AI coding agents) | fabric-build-2026 | Fabric Build 2026 #27: "skills-for-fabric MIT OSS teaches AI tools the right APIs"; no Loom equivalent found | missing | loom-skills bundle documenting Azure-native Loom client patterns | 9 |
| audit-T89 GitHub Enterprise Cloud (ghe.com) Git integration | fabric-build-2026 | Fabric Build 2026 #29: "Git Integration — GitHub Enterprise Cloud with Data Residency (ghe.com) GA"; no ghe.com host config | missing | ghe.com host option in workspace Git/CI-CD config | 9 |
| audit-T90 loom CLI npm package (wraps Loom REST API) | fabric-build-2026 | Fabric Build 2026 #30: "Fabric CLI v1.5 GA — one-command workspace deploys"; no loom CLI published | missing | Published loom CLI wrapping Loom REST API (workspace+item mgmt) | 9 |
| audit-T91 Azure DevOps pipeline task for Loom | fabric-build-2026 | Fabric Build 2026 #31: "Fabric CLI in Azure DevOps — built-in pipeline task"; no ADO extension/task for Loom | missing | Azure DevOps task wrapping Loom REST API | 9 |
| audit-T92 Loom MCP server exposing data-movement/pipeline tools to agents | fabric-build-2026 | Fabric Build 2026 #32: "Data Factory Skills (MCP) — author/consume/diagnose pipelines via MCP"; no MCP server exposing Loom ops | missing | MCP server with pipeline/copy-job/dataflow tools over real clients | 9 |
| audit-T93 BYO wizard + bicepparam generator (existing<Svc> params, every service) | fabric-build-2026 | csa_loom_master_program.md: "1-button deploy must let customers pick EXISTING vs NEW for any service via wizard or bicepparam-generator"; byo-wizard.sh absent | missing | byo-wizard.sh emits existing<Svc>{Name,Rg,Sub} params for all services; bicep honors them | 9 |
| audit-T94 Azure Maps account deploy + LOOM_AZURE_MAPS_ACCOUNT binding | fabric-build-2026 | csa_loom_master_program.md: "Azure Maps account deployment + LOOM_AZURE_MAPS_ACCOUNT env binding" | done | Bicep deploys Azure Maps (Gen2/G2); module output now bound to LOOM_AZURE_MAPS_ACCOUNT + NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT + key secretRef; geo-map/map editors prefill the deployed account; patch-navigator-env.sh + bicepparams synced (audit-t94) | 9 |
| audit-T95 Cosmos Gremlin-capable account deploy + bicep sync | fabric-build-2026 | csa_loom_master_program.md: "Cosmos Gremlin account (default is NoSQL-only; graph editor requires Gremlin)" — created live, bicep sync unclear | partial | Gremlin account in bicep + env; graph editor works default-deploy | 9 |
| audit-T96 Datasets typeProperties JSON textarea → guided builder | fabric-build-2026 | csa_loom_data_integration_infra.md: "Datasets tab typeProperties JSON textarea → guided builder (location/format builder)"; violates no-freeform-config rule | stub | Guided location/format builder replaces JSON textarea | 9 |
| audit-T97 Shared admin-zone SHIR for Purview + auto-scale-up on pipeline trigger | fabric-build-2026 | csa_loom_data_integration_infra.md: "SHIR admin-zone SHARED instance for Purview" + "auto-scale-UP on pipeline trigger (scale 0→N before run)" | missing | Shared SHIR pre-deployed; detect pipeline-uses-SHIR, scale up pre-run | 9 |
| audit-T98 Surface VNet data gateway tenant gate in Network UI | fabric-build-2026 | csa_loom_data_integration_infra.md: "Surface VNet data gateway tenant gate in the Network UI" | missing | Network UI shows honest VNet gateway tenant gate | 9 |
| audit-T99 DLP coverage extended to all structured OneLake data (ADLS paths + Synapse schemas) | fabric-build-2026 | Fabric Build 2026 #33: "DLP Restrict Access extended to all structured OneLake data"; DLP panel exists but scope is PBI-only | partial | DLP wizard targets ADLS Gen2 paths + Synapse SQL schemas | 9 |
| audit-T100 DSPM-for-AI posture report (sensitive-label exposure per data agent/Copilot) | fabric-build-2026 | Fabric Build 2026 #34: "DSPM for AI / Fabric Copilots Preview"; copilot usage tracked, no DSPM posture report | missing | Admin security report: which agents/Copilots touch sensitive-labeled data | 9 |
| audit-T101 IRM-for-lakehouse indicators dashboard | fabric-build-2026 | Fabric Build 2026 #35: "Insider Risk Management for Lakehouse GA"; components exist, no IRM report | missing | IRM indicators (unusual volume, off-hours) over audit logs + Monitor | 9 |
| audit-T102 Non-ADLS access-policy enforcement (warehouse SQL user + ADX role) | fabric-build-2026 | csa_loom_governance_buildassist.md: "Non-ADLS access-policy enforcement (warehouse/KQL — grant SQL user + ADX role)"; ADLS live, warehouse/KQL still gate | partial | Access-policy wizard enforces real Synapse SQL GRANT + ADX role assignment | 9 |
| audit-T103 Item editors read the classification taxonomy (not free-text) | fabric-build-2026 | csa_loom_governance_buildassist.md: "Wiring item editors to read the classification taxonomy (currently free-text input)"; taxonomy admin done (#704), read-in missing | missing | Item editors pick from taxonomy dropdown wired to admin taxonomy | 9 |
| audit-T104 Deeper Purview auto-classification + scan trigger | fabric-build-2026 | csa_loom_harness_session3.md: "Deeper Purview auto-classification/scan (taxonomy → classification defs + scan trigger)"; auto-onboard gate removed (#752) but scan depth absent | missing | Taxonomy → Purview classification defs + real scan trigger | 9 |
| audit-T105 Mirroring ongoing CDC for PostgreSQL + Cosmos + Snowflake copy runtime | fabric-build-2026 | csa_loom_session4_operator_drain.md PR #773: "ongoing CDC deferred for PG/Cosmos; Snowflake requires ADF copy runtime" | partial | Ongoing-CDC for PG/Cosmos via ADF/Synapse Link; Snowflake copy runtime | 9 |
| audit-T106 Page-load timing harness + fix no-timeout/non-resolving-catch pattern | ui-redesign | csa_loom_master_backlog.md: "Page-load timing harness (Playwright over every route → slowest-first) + fix systemic server-call-without-timeout + non-resolving-catch pattern" | missing | Playwright timing report per route; timeout+resolve-on-error sweep | 10 |
| audit-T107 Capacity & Compute scale UI (admin/capacity beautify + scale controls) | ui-redesign | csa_loom_master_backlog.md / csa_loom_work_queue.md: "Capacity & Compute UI — scale controls + Web 3.0 beautify (ADX SKU dropdown, Synapse pause/resume, SHIR scale)" | partial | Scale controls UI on real scaling route; Web 3.0 cards | 10 |
| audit-T108 True async app install (long provisions → async + progress) | ui-redesign | csa_loom_harness_session3.md task-019: "Async app install (gateway-timeout for long provisions → real async + progress tracking)" | partial | Async install job + progress polling replaces sync gateway-timeout path | 10 |
| audit-T109 Workspaces page redesign (LoomDataTable + TileGrid + ViewToggle) | ui-redesign | UI deep dive: "app/workspaces/page.tsx (1443 lines, 0 primitives) — the largest page; custom renderSection + ad-hoc cards"; csa_loom_ui_overhaul_backlog.md | partial | List=LoomDataTable, tile=TileGrid+ItemTile, ViewToggle, Section groupings | 10 |
| audit-T110 Apps page redesign (ItemTile + TileGrid + ViewToggle + LoomDataTable) | ui-redesign | UI deep dive: "app/apps/page.tsx (353 lines, 0 primitives) — raw div empty state + app-list" | partial | ItemTile cards + ViewToggle + Section categories + list view | 10 |
| audit-T111 admin/scaling page redesign (74 inline styles → Fluent Card/makeStyles/LoomDataTable) | ui-redesign | UI deep dive: "app/admin/scaling/page.tsx (653 lines, 74 inline styles, 0 LoomDataTable) — biggest inline-style offender; raw button style" | partial | Fluent Card per resource, makeStyles, LoomDataTable lists, Fluent Buttons | 10 |
| audit-T112 catalog/metastores page redesign (30 inline styles → LoomDataTable/ItemTile) | ui-redesign | UI deep dive: "app/catalog/metastores/page.tsx (384 lines, 30 inline styles) — heaviest raw-layout page" | partial | LoomDataTable metastore list + ItemTile tiles + Section groups | 10 |
| audit-T113 Connections / Thread / Data-products pages get ViewToggle + tile view | ui-redesign | UI deep dive: connections + thread use LoomDataTable but 0 ViewToggle; data-products 0 primitives | partial | Tile view + ViewToggle + ItemTile on connections, thread, data-products | 10 |
| audit-T114 realtime-hub-view component redesign (26 inline styles + color-coded source icons) | ui-redesign | UI deep dive: "lib/components/realtime-hub/realtime-hub-view.tsx (462 lines, 26 inline styles, 0 ViewToggle/TileGrid)" + Workload Hub icon quality | partial | makeStyles, color-coded source-type icons from item-type-visual, ViewToggle | 10 |
| audit-T115 Inline-style adoption sweep across primitive-wired pages (governance/onelake/workload-hub/copilot/learn/browse) | ui-redesign | UI deep dive Wave A: pages import primitives but carry 3–14 inline styles each; csa_loom_ui_overhaul_backlog.md | partial | Replace residual inline styles with makeStyles + Section/Card | 10 |
| audit-T116 Admin-portal tab inline-style sweep (tenant-settings/permissions/usage/updates/security/labels/domains/etc.) | ui-redesign | UI deep dive Wave C: ~12 admin tabs carry 3–14 inline styles each despite LoomDataTable | partial | makeStyles + Section + Badge tokens across admin tabs | 10 |
| audit-T117 Monitor page slow-load fix (debounce/memo/aggregate KQL cascade) | ui-redesign | UI deep dive functional gap #1 + csa_loom_ui_overhaul_backlog.md: "BUG: monitor is extremely slow to load"; monitor-pane fires all KQL on mount | partial | Single aggregating endpoint or memo/debounce; measurable load improvement | 10 |
| audit-T118 Data-agent composer pin (Send always visible) | ui-redesign | UI deep dive functional gap #2 + csa_loom_ui_overhaul_backlog.md: "must scroll vertically to see Send; not wired in"; lib/panes/data-agent.tsx | partial | Flex column with scroll on messages only, composer flex-shrink:0 pinned | 10 |
| audit-T119 Deploy-planner all-Azure-service-types nodes + Atlas Diag icons | ui-redesign | UI deep dive functional gap #3 + csa_loom_ui_overhaul_backlog.md: "should offer ALL Azure service types; use Atlas Diag icon API for icons" | partial | Full Azure service catalog as draggable nodes; Atlas Diag icons per node; bounded canvas | 10 |
| audit-T120 Federated-search vertical-rule collision fix | ui-redesign | UI deep dive functional gap #4: "search box + source picker physically overlap the left vertical rule divider"; lib/components/catalog/federated-search.tsx | partial | Correct width/overflow so search area clears the divider | 10 |

## Suggested Build Waves (continuing the first audit)

- **Wave 6 — Help / Learning Hub:** audit-T37..T43.
- **Wave 7 — MCP deployable catalog + admin config:** audit-T44..T49.
- **Wave 8 — Fabric Build 2026 parity + Weave/Thread:** audit-T50..T87.
- **Wave 9 — Platform / deployment / BYO / governance depth + CLI:** audit-T88..T105.
- **Wave 10 — UI redesign adoption + functional bugs:** audit-T106..T120.

## Notes on overlap with the first audit (intentionally NOT re-listed)

- audit-T29 (Palantir migration) is **expanded** into T50..T57 (the 8 named products) +
  T29's Workshop/Slate/OSDK/Apollo mapping remains valid as the migration-doc layer.
- audit-T34 (MCP library) is **expanded** into T44..T48; the BYO-endpoint half is built.
- audit-T01..T07 already cover the live-route stub panes; the UI items here (T109..T120)
  are **redesign/adoption** debt on *other* pages, not those stub panes.
- Fabric Build 2026 #2 (Graph in Fabric), #5 (Rayfin), #20-subset (mirroring GA), #24
  (SQL Copilot) are **HAVE** per the ledger and are not listed.
