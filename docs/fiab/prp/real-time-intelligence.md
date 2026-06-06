# PRP — Real-Time Intelligence at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Real-Time Intelligence (RTI).
> **Parity target:** Microsoft Fabric "Real-Time Intelligence" workload —
> Eventhouse, KQL Database, KQL Queryset, Real-Time Dashboard, Eventstream,
> Activator (Reflex), and the Real-Time hub.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on Azure-native backends by default, with a
> real Microsoft Fabric capacity / workspace UNSET.** Fabric is opt-in only,
> selected via `LOOM_<ITEM>_BACKEND=fabric` + a bound workspace. Never gate on
> `fabricWorkspaceId` without an Azure fallback in the same function.
> Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no
> `return []` placeholders** — each task lands real backend calls or an honest
> infra-gate MessageBar (Fluent `intent="warning"` naming the exact env var /
> role / resource to provision).
> Per `.claude/rules/ui-parity.md`, each surface gets a parity doc at
> `docs/fiab/parity/<slug>.md` and must match the source UI one-for-one — theme
> differs (Fluent v9 + Loom tokens), functionality does not.
> Per `.claude/rules/loom-no-freeform-config.md`, all config is
> dropdowns/wizards/WYSIWYG/canvas — the only freeform exception is a 1:1
> ADF/Synapse expression + dynamic-content builder. KQL/SQL query editors are
> *query surfaces*, not config, and are allowed.

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric Real-Time Intelligence is the end-to-end streaming + analytics
workload. Its objects are:

- **Eventhouse** — the top-level container (a compute/storage cluster) holding
  one or more KQL databases sharing capacity. Exposes a Query URI and an
  Ingestion URI. Has a system-overview dashboard (storage, ingestion, top
  queries) and a schema-change log.
- **KQL Database** — a read-write database (or a read-only *database shortcut*)
  inside an eventhouse. Holds tables, materialized views, stored functions,
  update policies, ingestion mappings, retention/caching policies, and an
  embedded KQL queryset. Optionally exposes data as Delta Parquet.
- **KQL Queryset** — the saved query authoring surface (KQL editor, results
  grid, charting, NL2KQL Copilot, cross-service queries).
- **Real-Time Dashboard** — tile-based dashboard whose tiles each run a KQL
  query, with parameters, auto-refresh, drill-through, and conditional
  formatting.
- **Eventstream** — a no-code canvas that ingests from sources (Event Hubs,
  IoT, Kafka, CDC, custom app), applies stream transforms, and routes to
  destinations (KQL DB, lakehouse, custom endpoint, Activator).
- **Activator (Reflex)** — condition monitoring over streaming/KQL data that
  fires actions (alert, Teams/email, pipeline, Power Automate) when a rule
  trips.

CSA Loom rebuilds all of these 1:1 on **Azure Data Explorer (ADX)** + **Azure
Event Hubs** + **Azure Stream Analytics** + **Azure Monitor**, with **no
dependency on a real Fabric capacity, OneLake, Power BI workspace, or
`api.fabric.microsoft.com`** on the default path.

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component (optional) | Loom client / module |
|---|---|---|---|
| Eventhouse cluster | **ADX cluster** (one shared per Loom deployment) | — | `kusto-arm-client` |
| KQL database (read-write) | **ADX database** in the cluster | — | `kusto-arm-client`, `kusto-client` |
| KQL database shortcut (read-only) | **ADX follower database** / leader-follower attach | — | `kusto-arm-client` |
| KQL / table commands | **ADX management `.command` REST** (`/v1/rest/mgmt`) | — | `kusto-client` |
| KQL queries | **ADX query REST** (`/v1/rest/query`) | — | `kusto-client` |
| Streaming ingestion | **ADX data connections** (Event Hubs / IoT Hub) | — | `kusto-arm-client` |
| Queued/one-click ingestion | **ADX Data Management endpoint** (`ingest-<cluster>`) | Kusto.Ingest SDK | `kusto-client` |
| Delta export ("OneLake availability") | **ADX continuous-export → ADLS Gen2 Delta** | `delta-rs` (log compaction) | `kusto-client`, `adls-client` |
| Eventstream sources/sink | **Azure Event Hubs** (+ Stream Analytics for processing) | Apache Kafka protocol (EH Kafka endpoint) | `eventhubs-client`, `eventhubs-data-client`, `stream-analytics-client` |
| Eventstream stream processing | **Azure Stream Analytics job** (ASA) | — | `stream-analytics-client` |
| Real-Time Dashboard | **Loom-native dashboard model over ADX** (tiles run KQL) | OSS Grafana (export, optional) | `kql-dashboard-model`, `kusto-client` |
| Activator (Reflex) | **Azure Monitor scheduled-query alert rule** (or Logic App for rich actions) | — | `monitor-client`, `activator-monitor` |
| NL2KQL Copilot | **Loom Copilot build-assist** backend | — | (existing copilot edges) |
| Identity / RBAC | **Entra ID + Azure RBAC** (ADX `AllDatabasesAdmin`, `Database User/Viewer`; Monitoring Contributor) | — | `arm-client`, `rbac-client` |
| Secrets (connection strings) | **Azure Key Vault** secretRef | — | `keyvault-client` |

There is **no Fabric capacity and no OneLake** in the Azure-native path. The
"OneLake availability" toggle maps to an ADX **continuous-export policy** that
writes Delta Parquet to an ADLS Gen2 account Loom owns; all "OneLake virtual
path" display strings are translated from the real ABFS path.

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High / IL5 | IL6 (Azure Secret) | Endpoint difference |
|---|---|---|---|---|---|
| ADX cluster (query) | GA | GA | GA | GA (IL6-authorized per FedRAMP scope) | `<name>.<region>.kusto.windows.net` vs `<name>.kusto.usgovcloudapi.net` |
| ADX Data Management (ingest) | GA | GA | GA | GA | `ingest-<name>.<region>.kusto.windows.net` vs `ingest-<name>.kusto.usgovcloudapi.net` |
| ADX ARM control plane | GA | GA | GA | GA | `management.azure.com` vs `management.usgovcloudapi.net` |
| Event Hubs | GA | GA | GA | verify region | `<ns>.servicebus.windows.net` vs `<ns>.servicebus.usgovcloudapi.net` |
| Stream Analytics | GA | GA | GA | verify region/SKU | ARM split as above |
| Azure Monitor (alerts) | GA | GA | GA | GA | `management.*` + `<region>.monitoring.azure.com` split |
| ADLS Gen2 (continuous export) | GA | GA | GA | use Blob+HNS fallback if ADLS unconfirmed | `dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net` |
| Key Vault | GA | GA | GA | GA | `vault.azure.net` vs `vault.usgovcloudapi.net` |

**SKU caveat:** not all ADX compute SKUs and not all ASA streaming-unit tiers
are available in every Gov region. Every SKU/region selector built below MUST
call ARM `ListSkus` (ADX) / capability APIs (ASA) and filter by region at
runtime — never a hard-coded SKU list.

**Implication for code:** every host must resolve via the existing
`cloud-endpoints` helper (`getKustoSuffix()`, `getKustoIngestSuffix()`,
`getServiceBusSuffix()`, `getArmEndpoint()`, `getDfsSuffix()`,
`getKeyVaultSuffix()`), **never hard-coded**. Any new client routes through that
helper and is covered by a cloud-matrix unit test.

### 1.4 Item-type topology in Loom

```
eventhouse (item)                       ← ADX cluster (shared, 1 per deployment)
 ├─ Query URI / Ingestion URI           ← cluster query + ingest endpoints
 ├─ system-overview                     ← ADX .show diagnostics / Azure Monitor metrics
 ├─ schema-change log                   ← ADX .show journal
 └─ kql-database (item, child)          ← ADX database
      ├─ Tables / columns               ← .create/.alter/.drop table
      ├─ Materialized views             ← .create materialized-view
      ├─ Stored functions               ← .create-or-alter function
      ├─ Update policies                ← .alter table policy update
      ├─ Ingestion mappings             ← .create ingestion mapping
      ├─ Data policies (retention/cache)← .alter-merge policy retention/caching
      ├─ Data connections (EH/IoT)      ← ARM dataConnections
      └─ continuous-export ("OneLake")  ← .create-or-alter continuous-export → ADLS
kql-queryset (item)                     ← saved KQL over a database
kql-dashboard (item)                    ← Loom-native tile model over ADX
eventstream (item)                      ← Event Hubs + Stream Analytics graph
activator (item)                        ← Azure Monitor scheduled-query alert(s)
```

---

## 2. Feature-by-feature parity table

Legend — **Status:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.

| # | Fabric feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| R1 | Eventhouse — cluster create/manage | ADX cluster (ARM `PUT/PATCH /clusters`) | Cluster CRUD via `EventhouseEditor`; shared single instance | all clouds | ✅ built | none (verify SKU wizard calls `ListSkus`) |
| R2 | Eventhouse — auto-scale (min/max) | ADX optimized auto-scale (`optimizedAutoscale`) | Manage › Data policies dialog: enable + min/max sliders | all clouds | ⚠️ honest-gate (retention/cache only) | **T1** extend `applyPolicies` + ARM PATCH |
| R3 | Eventhouse — streaming ingestion toggle | ADX `enableStreamingIngest` | Manage panel checkbox | all clouds | 🔶 stub | **T2** toggle → ARM PATCH |
| R4 | Eventhouse — purge (GDPR erasure) | ADX `.purge table … where <predicate>` (`EnablePurge=true`) | Purge dialog: table picker + predicate + confirm | all clouds | ❌ missing | **T3** purge route + dialog + Bicep `EnablePurge` |
| R5 | Eventhouse — OneLake availability (Delta export) | ADX `.create-or-alter continuous-export` → ADLS Gen2 Delta | Export-to-ADLS dialog: account/container/path/format/interval | all clouds | ⚠️ honest-gate (toggle, no export config) | **T4** continuous-export config |
| R6 | Eventhouse — SQL analytics endpoint (T-SQL) | ADX native T-SQL subset (`language=sql`) | Query editor SQL/KQL mode toggle | all clouds | ✅ built | none (document T-SQL subset limits) |
| R7 | Eventhouse — system overview | ADX `.show diagnostics`/`.show capacity` + Azure Monitor metrics | Overview panel: state, storage breakdown, ingestion rate, top-10 queried/ingested DBs, top users, schema-change log | all clouds | ❌ missing | **T5** overview panel + metrics routes |
| R8 | Eventhouse — databases page (list/tile) | ADX `.show databases` | DB browser: list/tile, per-db actions (query, get data, delete, open) | all clouds | ⚠️ partial (tree only) | **T6** databases page + tiles |
| R9 | KQL DB — create (read-write) | ADX `PUT /clusters/{c}/databases` | Create dialog: name, retention, hot-cache | all clouds | ✅ built | none |
| R10 | KQL DB — database shortcut (read-only) | ADX follower database (leader-follower attach) | Wizard: leader cluster/db picker, attach as follower | all clouds | ❌ missing | **T7** follower-attach wizard + route |
| R11 | KQL DB — retention policy | ADX `.alter-merge database/table policy retention` | Data-policies dialog: retention days / unlimited + recoverability | all clouds | ✅ built | none |
| R12 | KQL DB — caching (hot-cache) policy | ADX `.alter-merge … policy caching` | Data-policies dialog: hot-cache days slider | all clouds | ✅ built | none |
| R13 | KQL DB — table management (create/alter/drop) | ADX `.create/.alter/.drop table` | Visual schema designer: column grid (name/type), add/del rows, ALTER, drop-confirm | all clouds | 🔶 stub (read-only tree) | **T8** schema designer |
| R14 | KQL DB — materialized views | ADX `.create materialized-view` | MV editor: source table, KQL, backfill toggle | all clouds | 🔶 stub (read-only) | **T9** MV editor + create |
| R15 | KQL DB — update policies (ETL on ingest) | ADX `.alter table policy update` | Wizard: source/target table, transform function, transactional toggle | all clouds | 🔶 stub | **T10** update-policy wizard |
| R16 | KQL DB — stored functions | ADX `.create-or-alter function` | Function editor: name, params grid, KQL body, save/delete | all clouds | 🔶 stub | **T11** function editor |
| R17 | KQL DB — ingestion mappings | ADX `.create ingestion mapping` | Mapping wizard: format selector, column-map grid, type per col, auto-detect | all clouds | 🔶 stub | **T12** mapping wizard + auto-detect |
| R18 | KQL DB — one-click ingestion (Blob/ADLS/file) | ADX Data Management ingest (`ingest-<cluster>`) | Get-data wizard: source picker, schema preview, mapping, target | all clouds | ✅ built (file/EH/OneLake) | **T13** enrich pickers (ARM-populated) |
| R19 | KQL DB — streaming from Event Hubs | ADX data connection (`PUT …/dataConnections`) | Wizard: ns/hub/consumer-group (Resource-Graph populated), format, target | all clouds | ⚠️ partial | **T14** EH data-connection wizard |
| R20 | KQL DB — streaming from IoT Hub | ADX data connection (`iotHubResourceId`) | Wizard: IoT Hub picker, consumer group, format, target | all clouds | ❌ missing | **T15** IoT-Hub data-connection wizard |
| R21 | KQL DB — entity diagram view | ADX `.show database schema` → graph | React Flow canvas: tables/views/functions/shortcuts + dependency edges, inline actions | all clouds | ❌ missing | **T16** entity diagram canvas |
| R22 | KQL DB — explorer pane actions | mixed ADX commands | Tree: data profile, explore, insert script, get data, create dashboard, delete | all clouds | ⚠️ partial | **T17** hover-action wiring |
| R23 | KQL Queryset — authoring + results + charts | ADX query REST + Loom chart model | Monaco-kusto editor, run, result grid, chart picker, save, share | all clouds | ⚠️ partial | **T18** queryset editor parity |
| R24 | KQL Queryset — NL2KQL Copilot | Loom Copilot build-assist | Inline NL→KQL, explain, fix; cross-service hint | all clouds | ❌ missing | **T19** NL2KQL edge |
| R25 | KQL Queryset — cross-service queries | ADX `cluster()`/`database()` + Log Analytics proxy | Add Log Analytics / App Insights workspace as source; federated query | Comm + Gov | ❌ missing | **T20** cross-service source binder |
| R26 | Real-Time Dashboard — tiles over KQL | Loom dashboard model; each tile = ADX query | Tile grid: add/edit tile (KQL + viz), layout, resize | all clouds | ⚠️ partial | **T21** tile CRUD + render |
| R27 | Real-Time Dashboard — parameters | dashboard model params → KQL `declare query_parameters` | Parameter bar: dropdown/multiselect/time-range, bound to tiles | all clouds | ❌ missing | **T22** parameter engine |
| R28 | Real-Time Dashboard — auto-refresh + drill | client refresh loop; drill = cross-tile param | Auto-refresh interval, manual refresh, drill-through wiring | all clouds | ❌ missing | **T23** refresh + drill |
| R29 | Real-Time Dashboard — conditional formatting | dashboard model rules over tile cells | Per-tile rule editor (thresholds → color/icon) | all clouds | ❌ missing | **T24** conditional-format editor |
| R30 | Eventstream — canvas (sources→transform→dest) | Event Hubs (transport) + Stream Analytics (transform) | React Flow canvas; node palette; edge routing | all clouds | ⚠️ partial (canvas exists) | **T25** real backend per node |
| R31 | Eventstream — sources (EH/IoT/Kafka/CDC/custom) | EH ingest endpoint / EH Kafka endpoint / ADF CDC | Source node config wizards | all clouds | 🔶 stub | **T26** source node provisioning |
| R32 | Eventstream — transforms (filter/aggregate/join) | ASA query (`ASAQL`) | Transform node → ASA query builder (no-freeform: guided + expression builder) | all clouds | ❌ missing | **T27** ASA transform builder |
| R33 | Eventstream — destinations (KQL DB/lakehouse/custom/Activator) | ASA outputs → ADX / ADLS / EH / Monitor | Destination node config wizards | all clouds | 🔶 stub | **T28** destination node + ASA output |
| R34 | Eventstream — start/stop + monitor | ASA job `Start`/`Stop`; metrics | Run controls + live throughput/lag tiles | all clouds | ⚠️ partial | **T29** ASA lifecycle + metrics |
| R35 | Activator — rule definition | Azure Monitor scheduled-query alert rule | Rule wizard: data source (KQL/EH), condition builder, eval frequency, severity | all clouds | ⚠️ partial | **T30** rule wizard on Monitor |
| R36 | Activator — actions | Monitor action group (email/SMS/webhook) / Logic App | Action editor: action-group picker/create, Teams/email/pipeline/Logic-App | all clouds | 🔶 stub | **T31** action-group CRUD + Logic App |
| R37 | Activator — run history + trigger log | Monitor alert history (`Alerts` query) | History grid: fired times, state, payload | all clouds | ⚠️ partial | **T32** alert-history view |
| R38 | Real-Time hub — unified stream catalog | Resource Graph over EH/IoT/ADX + Loom item index | Hub page: data streams, Azure events, Fabric events; subscribe → eventstream/activator | all clouds | ❌ missing | **T33** real-time hub catalog |
| R39 | Eventhouse — throttling / surge protection | ADX cache/ingestion capacity policies + Monitor throttle metrics | Capacity panel: throttle state, per-db CU%, mission-critical exempt | all clouds | ❌ missing | **T34** capacity/throttle panel |
| R40 | Eventhouse — endpoint for lakehouse/warehouse | ADX external table over ADLS Delta + query-acceleration policy | Wizard: bind ADLS Delta source → mirrored KQL view + acceleration | all clouds | ❌ missing | **T35** lakehouse-endpoint wizard |
| R41 | Workspace-monitoring eventhouse | ADX DB fed by Azure Monitor diagnostic export | Read-only monitoring DB view + dashboard template | all clouds | ❌ missing | **T36** monitoring eventhouse provisioner |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

For each backing service the team must **inventory the real UI first** (per
`ui-parity.md`, grounded in Microsoft Learn via `microsoft_docs_search` /
`microsoft_docs_fetch` and the live portal), write the inventory into the
per-surface parity doc, then build it one-for-one.

### 3.1 Azure Data Explorer (ADX) — Eventhouse / KQL Database

- **Control plane (ARM):** clusters (create/scale/auto-scale/stop/start,
  `enableStreamingIngest`, `enablePurge`, `enableDiskEncryption`, SKU + capacity,
  managed-identity, public/private network), databases (create, retention,
  hot-cache, soft-delete), follower databases (leader-follower attach),
  data connections (Event Hubs / IoT Hub / Event Grid).
- **Data/management plane (`.command`):** `.create/.alter/.drop table`,
  `.create materialized-view`, `.create-or-alter function`,
  `.alter table policy update`, `.alter-merge policy retention|caching`,
  `.create ingestion mapping`, `.ingest`, `.purge table`,
  `.create-or-alter continuous-export`, `.show diagnostics|capacity|journal|
  database schema`, `.show queries|commands`.
- **Query plane:** KQL + ADX T-SQL subset; `cluster()`/`database()` federation;
  Log Analytics proxy.
- **Native UI surfaces to mirror:** ADX Web UI cluster dashboard, database
  explorer tree, one-click ingestion wizard, query editor with charting, and
  the Azure portal cluster blade (Overview, Scale, Databases, Data connections,
  Query, Security, Diagnostic settings).

### 3.2 Azure Event Hubs — Eventstream transport / RTI sources

- **Capabilities:** namespaces, event hubs (partitions, retention, capture to
  ADLS/Blob), consumer groups, Kafka endpoint, schema registry, SAS/Entra auth,
  throughput units / processing units, geo-DR.
- **UI surfaces to mirror:** namespace Overview, Event Hubs list + create, Capture
  config, Consumer Groups, Shared access policies, Schema Registry, metrics.

### 3.3 Azure Stream Analytics — Eventstream transforms

- **Capabilities:** job topology (inputs/outputs/query), ASAQL (windowing,
  joins, aggregates, UDFs/UDA), streaming units, no-code editor, test query
  with sample data, start/stop, job diagram, metrics (SU%, watermark delay,
  backlogged events).
- **UI surfaces to mirror:** job Overview, Inputs, Outputs, Query editor + test,
  Job topology diagram, Scale (SU), Monitoring.

### 3.4 Azure Monitor — Activator (Reflex)

- **Capabilities:** scheduled-query (log) alert rules, metric alert rules,
  action groups (email/SMS/voice/webhook/Logic App/Automation), alert
  processing rules, severity, evaluation frequency + window, dimensions,
  alert history.
- **UI surfaces to mirror:** Alert rule create wizard (Scope → Condition →
  Actions → Details), Action groups, Alerts list + history.

### 3.5 Loom-native Real-Time Dashboard (over ADX)

- **Model:** dashboard JSON (tiles, queries, viz config, parameters, layout,
  refresh, conditional-format rules) persisted in Cosmos; each tile executes a
  KQL query via `kusto-client` at render/refresh.
- **UI surfaces to mirror (from Fabric Real-Time Dashboard):** tile grid +
  resize, add-tile flyout (KQL + viz picker), parameter bar (time range,
  dropdown, multiselect, free text), auto-refresh, base queries, drill-through,
  conditional formatting, page tabs, export.

### 3.6 OSS components (optional, disclosed)

- **delta-rs** — Delta log compaction/validation for continuous-export output.
- **Grafana (export only)** — optional dashboard export target; never a
  dependency on the default path.
- **Apache Kafka protocol** — via the Event Hubs Kafka endpoint, for Kafka
  sources without a separate Kafka cluster.

---

## 4. Sequenced TASK LIST

Each task is one implementable unit. **No stubs, no mock arrays, no `return []`,
no hard-coded sample data.** Every BFF route validates the minted session and
returns `{ ok, data, error }` with correct HTTP status. Every UI surface either
shows real data or a Fluent `MessageBar intent="warning"` naming the exact
env var / role / resource to provision. SKU/region/resource pickers populate
from ARM / Resource Graph at runtime.

> Shared paths referenced below:
> - Editors: `apps/fiab-console/lib/editors/phase3-editors.tsx` (Eventhouse/KQL),
>   `apps/fiab-console/lib/editors/stream-analytics-editor.tsx`,
>   `apps/fiab-console/lib/editors/event-schema-set-editor.tsx`.
> - ADX clients: `apps/fiab-console/lib/azure/kusto-client.ts`,
>   `apps/fiab-console/lib/azure/kusto-arm-client.ts`.
> - Stream/EH/Monitor clients: `stream-analytics-client.ts`,
>   `eventhubs-client.ts`, `eventhubs-data-client.ts`, `monitor-client.ts`,
>   `activator-monitor.ts`.
> - API roots: `apps/fiab-console/app/api/adx/**`,
>   `apps/fiab-console/app/api/items/{eventhouse,kql-database,kql-queryset,
>   kql-dashboard,eventstream,activator}/[id]/**`.
> - Bicep: `platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep` and
>   siblings; env list in `platform/fiab/bicep/admin-plane/main.bicep`.
> - Cloud endpoints: `apps/fiab-console/lib/azure/cloud-endpoints.ts`.

### Phase A — Eventhouse / cluster completeness (R2–R8)

**T1 — Eventhouse auto-scale controls**
- Goal: surface ADX optimized auto-scale (enable + min/max) in Manage › Data policies.
- Edit: `phase3-editors.tsx` (`applyPolicies` callback, EventhouseEditor Manage dialog).
- Backend: extend `app/api/items/eventhouse/[id]/policies/route.ts` PATCH → `kusto-arm-client` ARM `PATCH /clusters` with `properties.optimizedAutoscale {isEnabled,minimum,maximum,version}`.
- Bicep/portability: none new; SKU/version via existing module. Route through `cloud-endpoints`.
- UI: enable switch + two `SpinButton`/`Slider`; disabled when streaming-only SKU; honest-gate MessageBar if cluster SKU unsupported.
- Acceptance: with Fabric UNSET, set min=2/max=6 → ARM returns updated `optimizedAutoscale`; receipt shows real ARM response; reload reflects values.

**T2 — Streaming ingestion toggle**
- Goal: real `enableStreamingIngest` toggle.
- Edit: `phase3-editors.tsx` Manage policies dialog.
- Backend: same policies route → ARM `PATCH /clusters` `properties.enableStreamingIngest`.
- UI: checkbox "Enable streaming ingestion".
- Acceptance: toggle on → ARM cluster shows `enableStreamingIngest:true`; a streaming `.ingest inline` then succeeds; receipt attached.

**T3 — Purge table (GDPR)**
- Goal: `.purge` predicate-based erasure.
- Create: `app/api/items/eventhouse/[id]/purge/route.ts` (POST) calling `kusto-client.postMgmt` with `.purge table <T> records where <predicate>` (two-step verify/commit).
- Edit: `phase3-editors.tsx` Manage panel → Purge dialog (table picker from `.show tables`, predicate builder, typed confirm).
- Bicep: add `enablePurge: true` to `adx-cluster.bicep`; document `Database Admin` requirement.
- UI: dialog with table dropdown + predicate (no freeform JSON; guided `column op value` rows) + confirm.
- Acceptance: Fabric UNSET; insert rows, purge by predicate, re-query shows rows gone; receipt = purge operation id + post-purge count 0.

**T4 — OneLake availability via continuous-export to ADLS**
- Goal: replace honest-gate toggle with real Delta export config.
- Create: `app/api/items/eventhouse/[id]/continuous-export/route.ts` (GET list / POST create) → `kusto-client` `.create-or-alter continuous-export <name> to table <ext> with(...) <| <query>`; external table over ADLS via `.create external table ... (Delta)`.
- Edit: `phase3-editors.tsx` Manage → "Export to OneLake/ADLS" dialog: ADLS account+container+path (ARM-populated), format=Delta, interval, source table.
- Bicep/portability: ADLS path via `cloud-endpoints.getDfsSuffix()`; grant cluster MI `Storage Blob Data Contributor` (role assignment in bicep).
- UI: wizard; honest-gate MessageBar if no ADLS account env (`LOOM_RTI_EXPORT_ADLS`).
- Acceptance: export runs; Delta files land in ADLS; `.show continuous-export` shows last-run success; receipt = ABFS path listing.

**T5 — Eventhouse system overview panel**
- Goal: build the overview dashboard (R7).
- Create: `app/api/items/eventhouse/[id]/overview/route.ts` aggregating `.show diagnostics`, `.show capacity`, `.show database <db> details`, `.show queries`, plus Azure Monitor ingestion/throttle metrics via `monitor-client`.
- Create: `app/api/items/eventhouse/[id]/journal/route.ts` → `.show journal` for schema-change log.
- Edit: `phase3-editors.tsx` new Overview tab: state indicator, storage breakdown (original/compressed/cache), per-db storage bar chart, time-range filter (1H/1D/7D/30D), ingestion rows tile, top-10 queried/ingested DBs grids, top-5 users, schema-change log.
- UI: Fluent cards + charts (existing chart model); time-range applies to all tiles.
- Acceptance: live ADX returns metrics; top-queries grid shows real recent queries; no `MOCK_`/`return []`; receipt = first 300 chars of each route response.

**T6 — Databases page (list/tile)**
- Goal: full DB browser (R8).
- Edit: `phase3-editors.tsx` Databases tab: list/tile toggle; per-tile actions (open new tab, query data, get data, delete); +New database / +Database shortcut.
- Backend: `.show databases` + existing create/delete routes; delete via `kusto-arm-client`.
- Acceptance: tiles list real DBs with size/retention; delete removes DB (ARM 200); create appears after refresh; receipt attached.

### Phase B — KQL Database object editors (R10, R13–R17, R21–R22)

**T7 — Database shortcut (follower attach)**
- Create: `app/api/items/kql-database/[id]/follower/route.ts` → ARM attach follower DB (`PUT …/attachedDatabaseConfigurations`).
- Edit: KQL DB editor add wizard (leader cluster URI + db, attach).
- UI: wizard; read-only badge on follower DBs.
- Acceptance: attach a real ADX DB as follower; querying the follower returns leader data; write blocked with clear message; receipt attached.

**T8 — Table schema designer (create/alter/drop)**
- Edit: `phase3-editors.tsx` KQL DB editor → schema designer; wire to `app/api/adx/tables/route.ts` (POST `.create table`, PATCH `.alter table`, DELETE `.drop table`).
- UI: column grid (name + type dropdown: string/int/long/real/decimal/datetime/bool/dynamic/guid/timespan), add/del rows, alter, drop-confirm.
- Acceptance: create table → `.show table schema` matches; alter adds column; drop removes; receipt attached. No read-only stub.

**T9 — Materialized views editor**
- Edit: KQL DB editor MV section; wire to `app/api/adx/materialized-views/route.ts` POST `.create materialized-view ... on table ... { <KQL> } with(backfill=...)`.
- UI: source-table picker, KQL body (monaco-kusto), backfill toggle, create/drop.
- Acceptance: create MV; `.show materialized-views` lists it; query returns aggregated rows; receipt attached.

**T10 — Update policy wizard**
- Edit: KQL DB editor; wire to `app/api/adx/policies/route.ts` `.alter table <target> policy update`.
- UI: source/target table pickers, transform-function selector (from `.show functions`), transactional toggle.
- Acceptance: ingest into source → transformed rows appear in target; `.show table policy update` reflects config; receipt attached.

**T11 — Stored function editor**
- Edit: KQL DB editor; wire to `app/api/adx/functions/route.ts` `.create-or-alter function`.
- UI: name, params grid (name/type), KQL body, save/delete.
- Acceptance: create function; invoke in a query → expected output; delete works; receipt attached.

**T12 — Ingestion mapping wizard + auto-detect**
- Edit: KQL DB editor; wire to `app/api/adx/ingestion-mappings/route.ts` `.create ingestion mapping`.
- UI: format selector (CSV/JSON/Parquet/Avro/ORC/TSV/PSV), column-map grid (source→column, type), name; auto-detect from uploaded sample.
- Acceptance: create mapping, ingest a file with it → rows land correctly mapped; `.show table ... ingestion mappings` lists it; receipt attached.

**T13 — Enrich one-click ingestion pickers**
- Edit: `phase3-editors.tsx` `onIngest`/`getDataMode`: file picker; ADLS/Blob URL with SAS/MI; Event Hubs ns/hub/consumer-group dropdowns from `eventhubs-client` (ARM list); schema preview before commit.
- Acceptance: ingest from Blob URL and from a real Event Hub via wizard; preview shows detected schema; rows land; receipt attached.

**T14 — Event Hubs data connection wizard**
- Create: `app/api/items/kql-database/[id]/data-connections/route.ts` (GET/POST/DELETE) → ARM `dataConnections` (EventHub kind).
- Edit: KQL DB editor; ns/hub/consumer-group (Resource-Graph populated), format, compression, table+mapping target.
- Portability: EH host via `cloud-endpoints.getServiceBusSuffix()`; grant cluster MI `Azure Event Hubs Data Receiver` (bicep role).
- Acceptance: create connection; send events to the hub → rows appear in the table within seconds; `.show data connections` lists it; receipt attached.

**T15 — IoT Hub data connection wizard**
- Edit: same route as T14 with `kind:IotHub` + `iotHubResourceId` + `sharedAccessPolicyName`.
- UI: IoT Hub picker (Resource Graph), consumer group, format, target.
- Acceptance: device-to-cloud messages land in the table; honest-gate MessageBar if no IoT Hub in subscription; receipt attached.

**T16 — Entity diagram view**
- Create: `app/api/items/kql-database/[id]/schema-graph/route.ts` → `.show database schema as json` → nodes/edges.
- Edit: KQL DB editor new "Diagram" tab on React Flow (`@xyflow/react`, reuse pipeline canvas patterns).
- UI: nodes for tables/MVs/functions/shortcuts; dependency edges; inline actions (query, delete) from nodes.
- Acceptance: diagram renders real entities + real dependencies; node action runs against ADX; receipt = screenshot + route body.

**T17 — Explorer hover-action wiring**
- Edit: `AdxDatabaseTree` in `phase3-editors.tsx`: data profile, explore data, insert script, get data, create dashboard, delete table → each to its real route/command.
- Acceptance: every hover action performs its real operation (no dead buttons); receipt per action.

### Phase C — KQL Queryset (R23–R25)

**T18 — Queryset editor parity**
- Edit/create: `kql-queryset` editor surface (monaco-kusto) with run, result DataGrid (sort/filter/resize/copy-CSV), chart picker, multi-query tabs, save to item, share.
- Backend: `kusto-client` query REST; save to Cosmos via `app/api/items/kql-queryset/[id]/route.ts`.
- Acceptance: run real KQL, render grid + chart, save + reload preserves queries; receipt attached.

**T19 — NL2KQL Copilot edge**
- Edit: queryset editor inline assist; wire to existing Loom Copilot build-assist backend (NL→KQL, explain, fix).
- Acceptance: NL prompt produces a runnable KQL that executes against ADX; explain returns plain-language summary; receipt attached.

**T20 — Cross-service query source binder**
- Edit: queryset add-source dialog: bind Log Analytics / App Insights workspace; federated query via `union` / `workspace()` proxy or ADX `cluster()`.
- Backend: route resolving LA workspace + cross-query auth.
- Acceptance: a query joins ADX + Log Analytics data and returns rows; honest-gate if no LA workspace env; receipt attached.

### Phase D — Real-Time Dashboard (R26–R29)

**T21 — Tile CRUD + render**
- Edit: `kql-dashboard` editor; model in `kql-dashboard-model`; tiles each store KQL + viz; render via `kusto-client`.
- UI: grid layout, add/edit/delete tile flyout (KQL + viz picker), resize, base queries.
- Acceptance: add a tile with real KQL → renders live chart; persists to Cosmos; receipt attached.

**T22 — Parameter engine**
- Edit: dashboard editor parameter bar (time-range, dropdown, multiselect, free text); inject as `declare query_parameters` into tile KQL.
- Acceptance: changing a parameter re-runs dependent tiles with new values; receipt = before/after tile data.

**T23 — Auto-refresh + drill-through**
- Edit: refresh interval control + manual refresh; drill-through sets a target-page parameter.
- Acceptance: auto-refresh re-queries on interval; drill navigates with carried parameter; receipt attached.

**T24 — Conditional formatting**
- Edit: per-tile rule editor (threshold → color/icon) applied to grid/stat tiles.
- Acceptance: rule colors cells per real data thresholds; receipt = screenshot.

### Phase E — Eventstream (R30–R34)

**T25 — Eventstream canvas → real backend per node**
- Edit: eventstream React Flow editor; persist topology; map to EH + ASA resources.
- Backend: `app/api/items/eventstream/[id]/route.ts` orchestrating `eventhubs-client` + `stream-analytics-client`.
- Acceptance: a source→transform→destination graph provisions a real EH + ASA job; receipt = ARM resource ids.

**T26 — Source nodes (EH/IoT/Kafka/CDC/custom)**
- Edit: source node config wizards; custom app source provisions an EH; Kafka uses EH Kafka endpoint; CDC delegates to ADF (`adf-client`).
- Acceptance: each source type yields a real ingest endpoint and shows live event preview; receipt attached.

**T27 — Transform nodes (ASA query builder)**
- Edit: transform node → guided ASAQL builder (filter/aggregate/window/join) + expression builder (allowed 1:1 builder exception); compile to ASA query.
- Backend: `stream-analytics-client` set job query + test with sample.
- Acceptance: transform applied; ASA test-query returns expected sample output; receipt attached.

**T28 — Destination nodes + ASA outputs**
- Edit: destination wizards for KQL DB / ADLS lakehouse / custom EH / Activator; create matching ASA output.
- Acceptance: destination receives transformed events (rows in ADX / files in ADLS); receipt attached.

**T29 — ASA lifecycle + metrics**
- Edit: start/stop controls + live tiles (SU%, watermark delay, backlogged events) from `stream-analytics-client` metrics + `monitor-client`.
- Acceptance: start job → status Running; metrics tiles show real values; stop works; receipt attached.

### Phase F — Activator (R35–R37)

**T30 — Rule wizard on Azure Monitor**
- Edit: `activator` editor rule wizard (data source KQL/EH, condition builder, eval frequency + window, severity); wire to `app/api/items/activator/[id]/rules` + `monitor-client` scheduled-query alert rule (ARM).
- Acceptance: rule created in Monitor; forcing the condition fires the alert; receipt = alert rule id + fired alert.

**T31 — Action group CRUD + Logic App actions**
- Edit: action editor: action-group picker/create (email/SMS/webhook) + optional Logic App for Teams/pipeline.
- Backend: `monitor-client` action groups; Logic App via `logic-app` client.
- Acceptance: fired alert delivers a real notification (webhook receiver logs payload); receipt attached.

**T32 — Run history + trigger log**
- Edit: history grid from Monitor Alerts query (`activator-monitor`).
- Acceptance: grid shows real fired/resolved history with payloads; receipt attached.

### Phase G — Real-Time hub, capacity, endpoints, monitoring (R38–R41)

**T33 — Real-Time hub catalog**
- Create: `app/api/rti-hub/route.ts` enumerating EH/IoT/ADX via Resource Graph + Loom item index; tabs: Data streams / Azure events / (Fabric events opt-in).
- Edit: new `/rti-hub` page; subscribe → creates eventstream or activator pre-filled.
- Acceptance: hub lists real streams across subs; subscribe pre-fills an eventstream; receipt attached.

**T34 — Capacity / throttle panel**
- Edit: Eventhouse editor capacity tab: throttle state, per-db CU%, ingestion/query capacity policies (`.show capacity policy`), mission-critical exempt toggle (workspace-level, honest-gate if not applicable).
- Acceptance: panel shows real capacity policy + live throttle metrics; editing ingestion capacity policy applies; receipt attached.

**T35 — Eventhouse endpoint for lakehouse/warehouse**
- Edit: wizard binding an ADLS Delta source → ADX external table + query-acceleration policy → mirrored KQL view.
- Backend: `.create external table (Delta)` + `.alter external table policy query_acceleration`.
- Acceptance: lakehouse Delta queryable via KQL within seconds; acceleration policy shown; receipt attached.

**T36 — Workspace-monitoring eventhouse provisioner**
- Create: provisioner that creates a read-only ADX DB fed by Azure Monitor diagnostic-settings export of Loom resources; ship a dashboard template.
- Bicep: diagnostic-settings + export module.
- Acceptance: monitoring DB contains real usage/perf tables; template dashboard renders; receipt attached.

### Phase H — Cross-cutting

**T37 — Cloud-endpoint + RBAC sweep**
- Goal: every new client/route uses `cloud-endpoints` (Kusto/ingest/ServiceBus/ARM/DFS/KV suffixes); every new Azure dependency has a bicep role assignment and a cloud-matrix unit test.
- Acceptance: grep finds zero hard-coded `kusto.windows.net` / `servicebus.windows.net` / `management.azure.com` outside `cloud-endpoints`; cloud-matrix tests pass for Commercial + Gov.

**T38 — Bicep + env sync**
- Goal: `adx-cluster.bicep` exposes `enablePurge`, `enableStreamingIngest`, MI role assignments (Storage Blob Data Contributor, EH Data Receiver, Monitoring Contributor); add RTI env vars (`LOOM_RTI_EXPORT_ADLS`, etc.) to `admin-plane/main.bicep` apps env list.
- Acceptance: `az deployment sub create -f platform/fiab/bicep/main.bicep -p params/commercial-full.bicepparam` produces a working RTI with all roles; bicep diff in PR.

**T39 — Per-surface parity docs**
- Goal: `docs/fiab/parity/{eventhouse,kql-database,kql-queryset,real-time-dashboard,eventstream,activator,real-time-hub}.md`, each with source-UI inventory, Loom coverage (✅/⚠️/❌), and backend-per-control table.
- Acceptance: zero ❌ rows and zero stub banners at experience close.

---

## 5. Claude Code DEV-LOOP per task

Run this loop for **each** numbered task until acceptance criteria pass. Use
worktree isolation (`worktree-feature`) so parallel tasks don't corrupt
`node_modules` (per the pnpm-worktree gotcha).

1. **Coding agent**
   - Read the task row + the referenced files; inventory the real Azure/Fabric
     UI first via `microsoft_docs_search` / `microsoft_docs_fetch`.
   - Implement the BFF route(s) (real backend call, `{ok,data,error}`, correct
     status), the editor surface (Fluent v9 + Loom tokens, no freeform JSON),
     and any bicep/env/RBAC changes.
   - Forbidden: `return []`, `return {}`, `useState(MOCK…)`, dead buttons,
     hard-coded SKUs/hosts, default-path Fabric gate.

2. **Validation / test agent**
   - `pnpm -C apps/fiab-console tsc --noEmit` (zero errors).
   - `pnpm -C apps/fiab-console vitest run <area>` (unit tests for client + route,
     including a cloud-matrix test for any new endpoint suffix).
   - **Real-data E2E:** mint a session cookie; hit the new route(s); confirm a
     real Azure response (ADX op id, ARM resource id, EH/ASA/Monitor id, or an
     honest-gate MessageBar). Capture first 300 chars of the body.
   - Run the grep guards:
     `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_)" apps/fiab-console/lib/editors apps/fiab-console/app/api`
     and the no-fabric-dependency greps. Any hit on a default path → back to step 1.

3. **Docs agent**
   - Update the per-surface parity doc (T39) row(s) to ✅/⚠️ with the backend it
     calls; update `docs/fiab/eventhouse-parity-spec.md` and any user docs
     (docs = source of truth). No clarifying-questions/side-convo content in
     product or docs.

4. **UAT agent**
   - Live browser walk (Playwright / claude-in-chrome): with
     `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, open the surface, click **every**
     control the task added, confirm it performs the real operation (DOM
     strings ≠ parity). Side-by-side against the real Azure/Fabric UI for the
     row. Screenshot + trace.
   - If any control is dead, empty, or only works with Fabric bound → fail,
     return to step 1.

5. **Iterate** until: tsc clean, vitest green, real-data E2E receipt captured,
   grep guards clean, parity doc updated, UAT walk passes. Then open the PR with
   the receipt (endpoint hit + real response body + screenshot/trace + bicep
   diff). Reviewer rejects any PR missing the receipt.

---

## 6. Definition of done (whole experience)

The Real-Time Intelligence experience is **done** when, with a real Microsoft
Fabric capacity / workspace **UNSET** (`LOOM_DEFAULT_FABRIC_WORKSPACE` unset):

1. **Every row R1–R41 is ✅ built or ⚠️ honest-gate** — zero 🔶 stubs, zero ❌
   missing, zero dead buttons, zero empty tabs.
2. **No default-path Fabric/Power BI dependency** — the no-fabric-dependency
   greps return zero hits outside explicit `LOOM_<ITEM>_BACKEND=fabric` opt-in
   branches; no calls to `api.fabric.microsoft.com` / `api.powerbi.com` /
   `onelake.dfs.fabric` on the default path.
3. **No vaporware** — the vaporware greps (`return []`, `return {}`,
   `useState([{`, `MOCK_`, `SAMPLE_`) return zero hits in
   `apps/fiab-console/lib/editors` + `apps/fiab-console/app/api`; every honest
   gate is a Fluent MessageBar naming the exact env var / role / resource.
4. **Real backends verified** — each surface has a real-data E2E receipt: ADX
   `.command`/query, ARM cluster/db/data-connection, EH send→ingest, ASA
   start + metrics, Monitor alert fired, ADLS Delta export.
5. **Cloud portability** — all hosts resolve via `cloud-endpoints`; cloud-matrix
   unit tests pass for Commercial + Gov; SKU/region pickers filter via
   `ListSkus` at runtime.
6. **Bicep-synced** — `az deployment sub create -f platform/fiab/bicep/main.bicep
   -p params/commercial-full.bicepparam` + bootstrap produces a working RTI with
   every role grant and env var; bicep diff merged.
7. **Parity docs complete** — `docs/fiab/parity/*` for all seven surfaces show
   every inventory row ✅ or ⚠️, zero ❌, zero stub banners.
8. **UAT green** — `pnpm uat` RTI specs pass + a live side-by-side click-every-
   control walk confirms one-for-one behavior with the Azure/Fabric UI.

Target grade: **A or A+** for every surface (production-grade + tested +
documented + bicep-synced) before the next major release.
