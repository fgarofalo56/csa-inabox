# Appendix — Real-Time Intelligence (RTI): Fabric → CSA Loom parity (deep dive)

Domain owner: Fabric → Loom Parity Architect (RTI)
Scope: Real-Time hub · Eventstream · Eventhouse + KQL Database (+ OneLake availability) · KQL Queryset · Real-Time Dashboard · Activator/Reflex · plus RTI peripherals (anomaly detection/forecasting, Maps, Operations/Data agent, Digital twin builder, Business events).
Loom default backends (per `.claude/rules/no-fabric-dependency.md`): **Azure Event Hubs + Azure Stream Analytics + Azure Data Explorer (ADX) + Loom-native KQL dashboards over ADX + Logic Apps Standard / Azure Monitor for Activator.** Fabric/Power BI is opt-in only.

> **HEADLINE FINDING.** The Eventhouse/KQL/Eventstream/Dashboard *storage and query* stack is substantially real (ADX cluster + databases provisioned day-one; `kusto-client.ts` 1.7k LOC; `kql-dashboard-model.ts` 672 LOC; `stream-analytics-client.ts` 821 LOC). **The Activator and the Real-Time hub are the broken links**, and the root cause is architectural: the Loom Activator's Azure-native runtime (`lib/azure/activator-monitor.ts`, `lib/install/provisioners/activator.ts`) evaluates rules **only against Log Analytics** (`queryLogs` → `api.loganalytics.azure.com/v1/workspaces/{id}/query`). It has **zero ADX/Kusto path.** But every RTI stream lands in **ADX/Eventhouse** (Event Hubs → Stream Analytics → Kusto). So the canonical RTI scenario — *"alert when a KQL query over the Eventhouse returns rows"* — is impossible on the default path. The Activator looks built (rules CRUD, action groups, history all wired) but fires against the wrong data store. This appendix designs the ADX-native Activator runtime and the day-one enablement that makes both surfaces work.

---

## 1. Fabric RTI capability inventory (grounded in Microsoft Learn)

Architecture per Learn: **Real-Time hub** (tenant catalog of streams) → **Eventstream** (no-code ingest/transform/route) → **Eventhouse/KQL DB** (Kusto storage+query, OneLake-available) → **KQL Queryset / Real-Time Dashboard** (consume) → **Activator** (act). Data agents + anomaly detection reason over Eventhouse data.

### 1.1 Real-Time hub (`learn.microsoft.com/fabric/real-time-hub/*`)
| # | Capability | How it works |
|---|---|---|
| 1 | Tenant-wide unified catalog of data-in-motion | Auto-provisioned per tenant; lists all streams + KQL tables the user can access. No setup. |
| 2 | **All data streams** page | Lists eventstream outputs (default + derived streams) + Microsoft sources + Fabric/Azure events. Per-row actions: Preview, Open eventstream, Endorse. |
| 3 | **All data (KQL tables)** | Per-table actions: Explore (Copilot), Open KQL DB, Endorse, Detect anomalies, Create RTD, Add to data agent. |
| 4 | **Get events / Add data** connector gallery | Out-of-box connectors (see #5). Launches the Connect-source wizard → creates an eventstream. |
| 5 | Connector portfolio | Other clouds (GCP Pub/Sub, Amazon Kinesis), Kafka (Confluent, Apache Kafka, Amazon MSK), DB CDC (Azure SQL, PostgreSQL, MySQL, Cosmos DB, SQL MI, SQL-on-VM), MS streaming (Event Hubs, Service Bus, IoT Hub), Fabric events, Azure events (Storage). |
| 6 | **Microsoft sources** browse | Cross-resource browse of Event Hubs / IoT Hub / ADX in the tenant → subscribe into an eventstream. |
| 7 | **Fabric events** | Workspace item events, Job events, OneLake events, Capacity overview events (preview) — discrete CloudEvents. Trigger pipelines/alerts. |
| 8 | **Azure events** | Azure Blob Storage events, Event Grid system topics → discrete events. |
| 9 | Preview data streams | Live sample of a stream/derived stream. |
| 10 | Endorse data streams | Promote/certify governance endorsement on the parent eventstream/KQL DB. |
| 11 | Set alerts on Fabric Job events | Shortcut: create an Activator alert on job success/failure. |
| 12 | Subscribe to OneLake events | Shortcut card → eventstream from OneLake CRUD events. |
| 13 | Real-time weather source | Sample managed source card. |
| 14 | Business events | Eventstream-published business events surfaced as a discrete event source consumable by Activator. |

### 1.2 Eventstream (`learn.microsoft.com/fabric/real-time-intelligence/event-streams/*`)
| # | Capability | How it works |
|---|---|---|
| 15 | Eventstream item + **Edit mode / Live view** | Edit = no-code canvas, changes staged until Publish; Live = running topology with pause/resume on nodes. |
| 16 | No-code event-processor **canvas** (drag-drop) | Nodes: sources → operators → destinations + streams; right config pane; lower Test-result + Authoring-errors pane. |
| 17 | Sources | Azure Event Hubs, IoT Hub, Service Bus, CDC (SQL/PG/MySQL/Cosmos), Kafka/Confluent/MSK, GCP Pub/Sub, Kinesis, sample data, custom endpoint, Fabric/Azure events. |
| 18 | **Operators** (7) | Filter, Manage fields, Aggregate, Group by (windowed), Union, Expand, Join. |
| 19 | **SQL operator** (preview) | Code-first stream transform via SQL expressions (windowing/joins/aggregations). |
| 20 | Destinations | Eventhouse (Direct ingestion / Event processing before ingestion), Lakehouse (Delta), Custom endpoint, Derived stream, Activator, Spark Notebook (preview). |
| 21 | **Default vs Derived streams** | Default = raw source stream; Derived = transformed stream, itself routable + shareable in RTH. Pause/resume per derived stream. |
| 22 | Enhanced capabilities | Operators valid for all destinations (derived stream bridges unsupported sinks). |
| 23 | Publish | Validates topology (must have source+destination, no authoring errors) → goes Live. |
| 24 | Eventstream REST API + item definition | `sources/destinations/operators/streams` JSON topology; Create-with-definition / Get / Update. |
| 25 | Data preview per node | Test-result tab samples events at each node. |
| 26 | Business-events publisher | Filter raw telemetry → emit named business events. |

### 1.3 Eventhouse + KQL Database (`.../real-time-intelligence/eventhouse`, `create-database`, `event-house-onelake-availability`, `data-policies`)
| # | Capability | How it works |
|---|---|---|
| 27 | Eventhouse = DB container | Holds multiple KQL DBs sharing capacity; unified monitoring (System overview: storage, compute, ingestion rate, top DBs, schema changes, advisory). |
| 28 | KQL Database | Kusto DB under an eventhouse; standard or **shortcut/follower** (read-only). Embedded queryset auto-created. |
| 29 | Tables / columns / ingestion | `.create table`, ingest from Eventstream/SDK/Kafka/pipelines; auto time-organized. |
| 30 | **Update policies** | On-ingest transform: source table write triggers a query that appends to a target table (different schema/retention). |
| 31 | **Materialized views** | Persisted `summarize` aggregation over a source table/MV; own retention/caching. |
| 32 | **Stored functions** | `.create-or-alter function` stored in DB metadata. |
| 33 | **Data policies** | Retention (1–36500d) + Caching (hot SSD, ≤ retention) at DB/table level via Manage → Data policies. |
| 34 | RLS / restricted-view / purge / soft-delete | Row-level security policy, data purge, soft-delete management commands. |
| 35 | **OneLake availability** | Logical Delta copy of KQL data in OneLake (mirroring policy, adaptive Parquet batching, TargetLatencyInMinutes 5m–3h). Enables Direct Lake / shortcuts / SQL endpoint / notebook. |
| 36 | **Analyze data with** (SQL endpoint / Notebook) | When OneLake+schema-sync on: T-SQL SQL analytics endpoint + Spark notebook over the same data. |
| 37 | Continuous export | Scheduled export of query results to external table (CSV/Parquet/JSON) in storage. |
| 38 | Entity diagram view | Visual DB schema/dependency graph. |
| 39 | Data profiling / preview | Histograms + min/max per column; recent-rows preview. |
| 40 | Database shortcut (follower) | Read-only attach to a leader DB. |
| 41 | Eventhouse-as-endpoint | Lakehouse/Warehouse → managed Eventhouse child for KQL over Delta. |
| 42 | Monitoring eventhouse | Read-only platform-telemetry eventhouse (workspace monitoring). |
| 43 | Git integration | DatabaseSchema.kql + DatabaseProperties.json sync. |

### 1.4 KQL Queryset (`.../kusto-query-set`)
| # | Capability | How it works |
|---|---|---|
| 44 | Queryset item | Run KQL, view/grid results, save+share queries; multi-DB tabs. |
| 45 | Data-source explorer | Tables/MVs/shortcuts/functions tree; per-item actions (profile, explore, insert script, get data, create dashboard, delete). |
| 46 | Cross-service query | Query Azure Monitor Log Analytics / App Insights from a queryset. |
| 47 | SQL over KQL | Many T-SQL functions supported alongside KQL. |
| 48 | Save to Dashboard | Pin a query as an RTD tile. |
| 49 | Copilot for KQL | NL → KQL in the queryset. |
| 50 | Notebook (Kqlmagic) | `%%kql` against the DB. |

### 1.5 Real-Time Dashboard (`.../dashboard-real-time-create`, `dashboard-parameters`, `real-time-dashboards-overview`)
| # | Capability | How it works |
|---|---|---|
| 51 | Dashboard item = tiles + pages | Each tile = a KQL query + visual; pages group tiles; drillthrough between pages. |
| 52 | Tile editor (KQL or Copilot) | Manual KQL + visual-formatting, or NL→KQL via Copilot; switchable. |
| 53 | Visual types | Table, stat/card, line/area/bar/column, pie, time chart, anomaly chart, map, heatmap, multi-stat, markdown. |
| 54 | Data sources | Eventhouse/KQL DB or Azure Data Explorer cluster; reusable, per-tile. |
| 55 | **Parameters** | Time-range, single/multi-select (query- or fixed-backed), free-text, drillthrough-as-parameter; injected into tile queries for perf. |
| 56 | **Live refresh / auto-refresh** | Continuous or interval as low as 10s; per-dashboard + min interval. |
| 57 | Cross-filter / drill-down | Click a visual to filter others. |
| 58 | Explore data (no-code) | Pivot/aggregate underlying tile data without KQL. |
| 59 | **Alerts from tile** | Set Activator rule directly from a tile (copies the tile KQL, runs vs Eventhouse on a frequency). |
| 60 | Base queries | Shared query prologue across tiles. |
| 61 | Permission separation | Share dashboard without exposing underlying data. |
| 62 | Git integration + export/replace-with-file | JSON dashboard template. |
| 63 | Pin to Power BI / Save-to-dashboard | Interop. |

### 1.6 Activator / Data Activator / Reflex (`.../data-activator/*`)
| # | Capability | How it works |
|---|---|---|
| 64 | Reflex item + Object Explorer | Tree: events → objects → properties → rules. No-code event-detection engine, subsecond for stateless stream rules. |
| 65 | Get data (event source) | Subscribe Eventstream, Power BI report visual, Real-Time Dashboard tile, KQL queryset query, Fabric/Azure events, **Warehouse SQL query result** (preview). |
| 66 | Assign events to objects | Map event columns → objectId + properties[]; rules evaluated per object (state tracked). |
| 67 | **Rules** | Three kinds: on every event, on event-value condition, on object property. Conditions: comparisons + stateful (`BECOMES`, `INCREASES`, `DECREASES`, `EXIT RANGE`, heartbeat/absence). |
| 68 | Monitor / Condition / Filter / Action builder | Monitor (property + summarization window/step), Condition (type + occurrence: each / N consecutive / for duration), Property filter (≤3 ANDed), Action. |
| 69 | Computed/derived properties | E.g. 1h rolling average reused across rules. |
| 70 | **Actions** | Email, Teams (individual/group/channel), Run Fabric item (pipeline/notebook/Spark job/dataflow/UDF/copy-job/publish-business-event), Power Automate (custom). |
| 71 | `@property` mentions + context | Inject live property values into subject/headline/notes/context. |
| 72 | Start / Stop reflex; enable/disable + delete a rule | Activation toggle; per-rule state. |
| 73 | Analytics + activation history | Activations over time, top-5 object IDs, fired/resolved log with payload. |
| 74 | Preview / test fire | Replay historical events → "would have fired N times"; test fire once. |
| 75 | Embedded-in-Eventstream rule authoring | Add-alert in the eventstream canvas. |

### 1.7 RTI peripherals
| # | Capability | How it works |
|---|---|---|
| 76 | **Anomaly detection / forecasting** | Native KQL `series_decompose_anomalies()` / `series_decompose_forecast()` / `series_outliers()` over Eventhouse time-series (in-place, no export). Multivariate via notebook-trained GAT model scored in KQL. |
| 77 | **Map** (geospatial) | Azure Maps-backed item: bubbles/heatmap/polygons/3D extrusions over Lakehouse/Eventhouse KQL with refresh; GeoJSON/PMTiles. |
| 78 | **Operations agent** (preview) | Per-business-process Fabric item: monitors real-time data, tracks metrics, recommends actions on business rules. |
| 79 | **Data agent** over Eventhouse | NL agent reasoning over live+historical Eventhouse data → automate workflows. |
| 80 | **Digital twin builder** (preview) | Low/no-code ontology of physical env; map OneLake/Eventhouse data; rules → alerts/actions. |

**featureCount ≈ 80 capabilities** across the 6 core areas + peripherals.

---

## 2. Loom coverage map (built / stubbed / missing — honest)

Files: `lib/editors/phase3-editors.tsx` (EventhouseEditor, KqlDatabaseEditor, KqlQuerysetEditor, KqlDashboardEditor, EventstreamEditor, ActivatorEditor), `lib/editors/stream-analytics-editor.tsx`, `lib/install/provisioners/{eventstream,kql-db,kql-dashboard,activator,workspace-monitor}.ts`, `lib/azure/{kusto-client,kusto-arm-client,stream-analytics-client,kql-dashboard-model,activator-monitor,monitor-client,eventhubs-client,eventhubs-data-client}.ts`, routes under `app/api/items/{eventstream,eventhouse,kql-database,kql-dashboard,kql-queryset,activator}` + `app/api/{rti-hub,realtime-hub}`, parity docs `docs/fiab/parity/{activator,rti-hub,real-time-hub,eventstream,eventhouse*,kql-*,real-time-dashboard}.md`.

| Area | Loom status | Evidence / honest note |
|---|---|---|
| Eventhouse + KQL DB storage/query | **built** | ADX cluster + DB provisioned day-one (`adx-cluster.bicep`, `adx-db-inner.bicep`); `createDatabase`/`executeMgmtCommand`/`ingestInline`/`executeQuery`; tables/policies/MV/update-policy/continuous-export routes exist. `LOOM_KUSTO_CLUSTER_URI` wired in `admin-plane/main.bicep`. |
| KQL Queryset | **built** | `KqlQuerysetEditor` + `/kql-queryset/{id}/run` + Copilot `assist`. Cross-service (LA/App Insights) and SQL-endpoint-over-ADX = partial. |
| Real-Time Dashboard | **built (partial)** | `KqlDashboardEditor` + `kql-dashboard-model.ts` + tiles/params/run/generate-tile routes. Auto-refresh/cross-filter/drillthrough/alerts-from-tile depth = verify; Copilot generate-tile present. |
| Eventstream | **built (partial)** | `EventstreamEditor` has designer/sql/json tabs + provision-to-EH/ASA + publish-to-Fabric (opt-in) + add-alert. Operators map to ASA. **JSON tab as a primary surface borderline vs `loom_no_freeform_config`.** Derived-stream pause/resume, full 7-operator no-code builder, Spark-notebook sink = partial/missing. |
| Real-Time hub | **stubbed (functionally)** | `/rti-hub` + `/realtime-hub` routes + Resource-Graph discovery exist, but **live peek/preview honest-gates** (AMQP receive not bundled; `LOOM_EVENTHUB_RECEIVE_ENABLED` unset) and **discovery gates** on missing subscription/Reader RBAC → appears non-functional out of the box. Fabric/Azure-events connect partly real. |
| **Activator** | **stubbed (BROKEN on default path)** | Rules CRUD / action groups / start-stop / history all wired — but **only against Log Analytics** (`queryLogs`). **No ADX path.** RTI data is in ADX → rules never fire on real streams. Day-one gates on `LOOM_LOG_ANALYTICS_*` + Monitoring Contributor. |
| Anomaly detection / forecasting | **missing (UI)** | KQL `series_decompose_*` works in queryset by hand; no dedicated detect/forecast surface or "Detect anomalies" RTH action. |
| Map (geospatial) | **partial** | `geo-editors.tsx` / `geo-*` parity exist (Azure Maps / OSS MapLibre); RTI live-refresh map tile binding = verify. |
| Operations agent / Data agent over Eventhouse | **partial** | `data-agent-*` editors exist; Eventhouse-grounded data agent + Operations-agent item = missing. |
| Digital twin builder | **partial** | Maps to `ontology.md` / Weave; rules→action wiring to Activator = missing. |
| Business events | **partial** | `eventgrid-business.bicep` + `business-events-store.ts` exist; Activator "publish business event" action + consume path = partial. |

---

## 3. brokenFound (present-but-broken — fix specs)

### B1 — Activator fires against the wrong data store (P0, the core failure)
- **Symptom:** Create an Activator rule to alert on streaming/Eventhouse data → it never fires; or it provisions a `scheduledQueryRule` whose KQL targets a Log Analytics table (e.g. `{hub}_CL`, `AppEvents`) that streaming data never populates.
- **Root cause:** `lib/azure/activator-monitor.ts` + `lib/install/provisioners/activator.ts` build Azure Monitor `scheduledQueryRules` evaluated by `queryLogs()` against `api.loganalytics.azure.com/v1/workspaces/{id}/query`. The RTI pipeline lands data in **ADX** (Event Hubs → Stream Analytics → Kusto), and there is no Event-Hub→Log-Analytics ingestion. The two never meet.
- **Fix:** add an **ADX-query-backed Activator runtime** (see Gap G1). Default the Activator to a **Logic App Standard** workflow (recurrence trigger → ADX "Run KQL query" connector against `LOOM_KUSTO_CLUSTER_URI`/DB → condition on row count/value → action fan-out). Reserve the existing `scheduledQueryRule`/Log-Analytics path strictly for infra/log alerts (it is genuinely correct for LA-sourced data). The rule wizard's source picker must offer **Eventhouse/KQL DB** as the default source and thread `clusterUri`+`database`+`table` into the runtime.

### B2 — Activator + RTI Hub ship gated (violates day-one-ON) (P0)
- **Symptom:** Fresh deploy → Activator returns `status:'remediation'` ("Set `LOOM_LOG_ANALYTICS_RESOURCE_ID`…/grant Monitoring Contributor"); RTI Hub returns `503 not_configured` ("Set `LOOM_SUBSCRIPTION_ID`"). Both look dead.
- **Root cause:** honest-gates are the *default* path, not exceptions. The platform does not deploy+grant+wire these day-one.
- **Fix:** bicep deploys the Eventhouse alert path day-one and grants the Console UAMI the required roles, env wired automatically: ADX DB Admin on the cluster (already), Reader on each in-scope subscription (`rti-hub-rbac.bicep` — extend to all params), Monitoring Contributor on the alert RG, Logic App Contributor on the Activator RG. `LOOM_KUSTO_CLUSTER_URI`, `LOOM_SUBSCRIPTION_ID`, `LOOM_LOG_ANALYTICS_*` set in every param file. No gate on the happy path.

### B3 — RTI Hub / Eventstream live peek never shows events (P1)
- **Symptom:** Preview/Test drawer can **send** test events but "Peek recent events" returns `501 receive_unavailable`.
- **Root cause:** AMQP receive requires `@azure/event-hubs` bundled + `LOOM_EVENTHUB_RECEIVE_ENABLED=true`; neither is on by default. Event Hubs has no HTTPS receive.
- **Fix:** bundle `@azure/event-hubs`; set `LOOM_EVENTHUB_RECEIVE_ENABLED=true` day-one; **and** add a fallback preview that reads the last N rows from the **ADX ingestion sink** (the eventstream's Eventhouse destination) or the Event Hubs **Capture** ADLS Delta files — both already deployed — so preview always shows real data even where AMQP is blocked by private networking.

### B4 — Eventstream "Activator destination" / add-alert seeds a dead LA rule (P1)
- **Symptom:** The eventstream canvas "Add alert" creates an Activator + a scheduled-query rule keyed to `{hub}_CL` (a Log Analytics table that does not exist).
- **Root cause:** same as B1 — the embedded alert path assumes EH→LA ingestion.
- **Fix:** route add-alert through the ADX runtime (G1); the seeded rule queries the eventstream's Eventhouse destination table.

### B5 — Eventstream primary authoring includes a raw JSON tab (P2, rule-compliance)
- **Symptom:** `EventstreamEditor` exposes a `json` tab editing `cfgText` directly.
- **Root cause:** legacy; `loom_no_freeform_config` allows freeform only for 1:1 source-product code surfaces (KQL/SQL operator qualifies; topology JSON does not).
- **Fix:** demote JSON to read-only "Advanced/Definition view"; make the **canvas designer** the only authoring surface (G5).

---

## 4. Gap build specs (Azure-native default + OSS; Commercial + Gov; day-one ON; Web-5.0 UI)

> Conventions for every gap: **UI** = Fluent v9 + Loom tokens, wizard/dropdowns/canvas/Copilot only; **API** = BFF route returning `{ok,data,error}`; **Backend** = real Azure REST/ARM/data-plane; **Deploy** = bicep module + env, enabled by default with a disable toggle; **Gov** = `.us` endpoints, sovereign substitutes; **Accept** = works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

### G1 — ADX-native Activator runtime (P0) — *the keystone*
**Architecture (words):** Rule wizard → BFF persists rule to Cosmos → provisioner materializes a **Logic App Standard** workflow per rule (or one parameterized workflow per Activator with per-rule triggers): *Recurrence trigger (evalFrequency)* → *ADX "Run KQL query" action* (cluster=`LOOM_KUSTO_CLUSTER_URI`, db, the rule's composed/verbatim KQL incl. stateful operators via `series_*`/`prev()`/`row_window_session`) → *Condition (rows > 0 / aggregate vs threshold)* → *Action fan-out* (email, Teams, ADF pipeline run, Synapse/Databricks notebook, webhook/Power Automate, publish business event to Event Grid). State (BECOMES/INCREASES/heartbeat) realized by KQL over a lookback window + a small Kusto "rule-state" table the workflow upserts. "Trigger now" = run the KQL immediately via `kusto-client.executeQuery` and report `fired`. History = Logic App run history + an ADX `ActivatorActivations` table.
- **Loom current:** stubbed (LA-only). **Priority P0.**
- **Azure services:** Logic Apps Standard (workflows), ADX (query), ADF/Synapse/Databricks (item actions), Azure Communication Services Email **or** Azure Monitor action-group email, Microsoft Graph/Teams webhook. Azure Monitor `scheduledQueryRule` retained for LA infra alerts only.
- **OSS option:** if Logic Apps is undesired, a Loom **ACA "activator-runner"** cron job (Node) that runs the KQL on a schedule and POSTs actions — fully self-hosted, identical contract.
- **UI:** extend `ActivatorEditor` rule wizard — Source dropdown defaults **Eventhouse / KQL DB** (cluster+db+table pickers from `LOOM_KUSTO_*`), then Monitor (property + summarization window/step), Condition (each / value / grouped-by + occurrence: each / N-consecutive / for-duration / becomes / exits-range / heartbeat), Property filter (≤3 ANDed), Action (the 8 kinds already in the wizard) — all dropdowns; an "Activation history" view from real runs; "Test fire" + "Preview (would-have-fired)". Object Explorer tree (events→objects→properties→rules).
- **API:** `POST/PATCH/DELETE /api/items/activator/[id]/rules` (compose KQL + upsert Logic App), `/start|/stop` (enable/disable workflows), `/history`, `/trigger` (run-now via executeQuery), `/preview` (replay over lookback).
- **Backend per control:** condition→KQL (`activator-monitor.ts` new `buildAdxRuleQuery`), provision→ARM `Microsoft.Web/sites` (Logic App Standard) workflow upsert, actions→connector configs, run-now→`kusto-client.executeQuery`.
- **Commercial vs Gov:** Commercial = Logic Apps + ACS Email/Teams. **Gov:** ADX (`*.kusto.usgovcloudapi.net` / `dataexplorer.azure.us`) + Logic Apps Standard available in Gov; Teams connector available in GCC/GCC-High (limited) — fall back to **Azure Monitor action-group email/SMS/webhook** (works in Gov) + Power Automate GCC. In IL4/5 air-gapped, use the ACA activator-runner (no public connectors) + SMTP relay.
- **Day-one:** Logic App Standard host + Activator RG deployed; Console UAMI granted Logic App Contributor + ADX DB Viewer; a default `ActivatorActivations` table created in the day-one KQL DB. Enabled; user can disable per rule.
- **Accept:** create a rule "avg temperature > 30 over 5m" on the day-one Eventhouse sample table → ingest a breaching row → email/Teams/ADF action fires; history shows the activation; all with Fabric unset.

### G2 — RTI Hub day-one discovery + always-real preview (P0/P1)
- **Loom current:** stubbed. **Priority P0** (discovery RBAC) + **P1** (preview).
- **Design:** grant Console UAMI **Reader** on every in-scope subscription via `rti-hub-rbac.bicep` (extend to all param files, not just commercial-full); wire `LOOM_SUBSCRIPTION_ID`+`LOOM_EXTRA_SUBSCRIPTIONS` day-one. Preview reads from ADX sink / EH Capture Delta when AMQP receive is blocked (B3). Fabric/Azure-events tabs connect to real Event Grid (G9).
- **UI:** keep the catalog (`LoomDataTable`) — sortable/filter; per-row kind-aware actions (Subscribe, Preview, Activator, Open). No gate on the happy path.
- **API:** `/api/rti-hub`, `/api/realtime-hub/{preview,connect-source,endpoints,provision}`.
- **Backend:** Resource Graph + Event Hubs ARM + ADX query + Cosmos.
- **Gov:** Resource Graph + ARM at `management.usgovcloudapi.net`; ADX `.us`. Cross-cloud sources (GCP/Kinesis/Confluent) hidden in air-gapped Gov; OSS Kafka-Connect/Debezium-on-ACA substitute surfaced instead.
- **Accept:** fresh deploy → Hub lists day-one Event Hub namespace + ADX cluster + Loom items; Preview shows real rows; Subscribe→eventstream→provision closes without leaving the surface.

### G3 — Eventhouse/KQL management surface parity (P1)
Update policies (create/alter UI), Materialized views (create-MV wizard over a table + summarize builder), Stored functions (create-or-alter), Data policies (retention+caching sliders), RLS/restricted-view, continuous export config, entity-diagram view, data profiling. Most routes exist — finish the **UI** (wizards/sliders, no raw command box except the 1:1 KQL editor).
- **Backend:** `kusto-client.executeMgmtCommand` (`.create-or-alter function`, `.create materialized-view`, `.alter table ... policy ...`, `.create-or-alter continuous-export`). **Gov:** identical Kusto control commands on `.us` cluster.
- **Day-one:** retention/caching defaults set on the day-one DB.

### G4 — OneLake availability ≡ ADX→ADLS Delta export (P1)
Fabric OneLake availability has no Fabric-free equivalent by name; the **Azure-native 1:1** is ADX **continuous export to ADLS Gen2 Delta** (+ Synapse/lakehouse external-table registration) giving the same "query KQL data as Delta from other engines" outcome. UI: a per-DB/table "Expose as Delta in the lake" toggle with TargetLatency slider; backend `.create-or-alter continuous-export` to a Delta external table on `LOOM_DATALAKE_*`. **Gov:** ADLS + ADX both in Gov; same path. Day-one: off by default per table (cost), toggle-on in UI.

### G5 — Eventstream no-code canvas completion (P1/P2)
Full 7-operator no-code builder (Filter/ManageFields/Aggregate/GroupBy/Union/Expand/Join) on the React-Flow canvas (per `canvas-node-kit.tsx`), each operator a config panel (no JSON); Derived-stream nodes with pause/resume; SQL-operator code node (allowed freeform); destinations incl. Spark-notebook sink; per-node Test-result preview; demote JSON to read-only Definition view (B5). Backend: operators compile to **ASA query** (`stream-analytics-client.ts`) or to the eventstream definition for the opt-in Fabric publish. **Gov:** ASA available in Gov; same.

### G6 — Real-Time Dashboard depth (P1)
Parameters (time-range/single/multi/free-text/drillthrough), Live-refresh interval picker (10s–), cross-filter, drill-down, Explore-data no-code pivot, **Alerts-from-tile** (→ G1 ADX Activator), base queries, pages, export/replace-with-file, permission separation. `kql-dashboard-model.ts` carries most; finish param + refresh + alert-from-tile wiring. **Gov:** tiles query ADX `.us`; Loom-native renderer (no Fabric/Power BI dependency). Day-one: a sample RTD over the day-one DB.

### G7 — KQL Queryset cross-service + SQL endpoint (P2)
Cross-service query to Azure Monitor LA/App Insights (`monitor-client.queryLogs` already exists — surface it as a queryset data source); T-SQL SQL-analytics endpoint over the ADX/Delta copy (Synapse serverless external table over G4 Delta). **Gov:** LA/App Insights + Synapse serverless in Gov.

### G8 — Anomaly detection & forecasting surface (P1)
A "Detect anomalies / Forecast" action on KQL tables + dashboard tiles that composes `series_decompose_anomalies()` / `series_decompose_forecast()` and renders the anomaly/forecast chart; multivariate via a notebook-trained model (Spark) scored in KQL. Pure KQL — works on the day-one ADX. **Gov:** native KQL functions, no service dependency; multivariate uses the OSS `time-series-anomaly-detector` package on Spark.

### G9 — Business events + Fabric/Azure events (P2)
Event Grid namespace (`eventgrid-business.bicep`) as the business-event bus; Eventstream business-events publisher; Activator "publish business event" action + consume path; Azure Blob/Storage events + Event Grid system-topic discovery in RTH. **Gov:** Event Grid in Gov; Fabric workspace/job/OneLake events are Fabric-only → mark opt-in, no default-path dependency.

### G10 — Maps / Operations agent / Data agent / Digital twin (P2)
Map: live-refresh KQL tile over Azure Maps (Commercial) / **OSS MapLibre + self-hosted PMTiles** (Gov, where Azure Maps is limited). Data agent over Eventhouse: ground the existing `data-agent-*` editor on `LOOM_KUSTO_*` (AOAI Commercial / Gov AOAI or OSS LLM via MCP). Operations agent: new item = monitored metrics + business rules → G1 actions. Digital twin: wire `ontology.md` entity rules → Activator actions.

---

## 5. Dual-cloud & day-one summary
- **Commercial:** ADX, Event Hubs, Stream Analytics, Log Analytics, Logic Apps Standard, ACS Email/Teams, Azure Maps — all GA; deployed+enabled day-one by `platform/fiab/bicep`.
- **Government (GCC / GCC-High / DoD IL4/5):** ADX (`*.kusto.usgovcloudapi.net`, `dataexplorer.azure.us`), Event Hubs, Stream Analytics, Log Analytics/Monitor, Logic Apps Standard all available in Azure Government. Substitutes where managed/connector gaps exist: Teams connector → Azure Monitor action-group email/SMS/webhook; Azure Maps → OSS MapLibre+PMTiles; cross-cloud stream connectors → OSS Kafka-Connect/Debezium on ACA/AKS → Event Hubs Kafka endpoint; AOAI-limited regions → Gov AOAI or OSS LLM via the MCP agent layer; air-gapped action fan-out → ACA "activator-runner" + SMTP relay (no public connectors). Private-only networking (PE + managed VNet) throughout; no public Fabric/Power BI/OneLake hosts on the default path.
- **Day-one ON:** ADX cluster+DB, Event Hubs namespace, Stream Analytics, Log Analytics, Logic App host, sample Eventhouse table + sample RTD all deployed and enabled; Console UAMI granted ADX DB Admin + Reader (subs) + Monitoring Contributor + Logic App Contributor; every `LOOM_KUSTO_*`/`LOOM_EVENTHUB_*`/`LOOM_LOG_ANALYTICS_*`/`LOOM_SUBSCRIPTION_ID` wired. Users disable per item; nothing ships dark.

## 6. Master acceptance (per `no-vaporware` / `ui-parity` / `no-fabric-dependency`)
With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET on a clean Commercial **and** Gov sub: ingest a sample stream → it lands in the day-one Eventhouse → a KQL queryset + Real-Time Dashboard show live rows → an **Activator rule fires a real action on the Eventhouse data** (the keystone fix) → RTI Hub lists + previews real resources → all via wizards/canvas/dropdowns/Copilot, no raw config, no dead buttons, no Fabric/Power BI host touched.
