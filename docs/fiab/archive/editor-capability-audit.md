# CSA Loom — Editor Capability Audit (v3.17 / 2026-06)

Live URL: <https://<your-console-hostname>>

This is the **honest, per-editor inventory** of what each item-type editor
actually does today, what Azure backing it uses, and what's still gated by
RBAC or missing infra.

## Verdict legend

- **A+** = every advertised action works end-to-end against real Azure + UX is Fabric-equivalent
- **A** = every advertised action works; UX has minor gaps (e.g. missing right-click affordances)
- **B** = primary action works; some secondary actions need work
- **C** = renders + persists to Cosmos, but no Azure backing executes
- **GATED** = wired correctly; blocked by a single RBAC grant or missing Azure resource

---

## Data Engineering

### Lakehouse — **A+** (v3.15)
**Backing:** ADLS Gen2 (`saloomdefaultmwfaiy3truk` storage, bronze/silver/gold containers, UAMI: Storage Blob Data Contributor).
**Actions verified end-to-end against live Azure (2026-05-26):**
- ✅ List containers → real container URLs
- ✅ List paths (any prefix) → real directory listing
- ✅ Upload file → real blob with ETag
- ✅ New folder (mkdir on hierarchical namespace) → 200 OK
- ✅ Delete file → 200 OK
- ✅ Delete folder recursive → 200 OK
- ✅ Preview (OPENROWSET via Synapse Serverless) → 200 + real SQL + first 100 rows
- ✅ Query this file (SQL tab → Synapse Serverless query) → real result set
- ✅ **NEW v3.15:** Open in notebook → prefills PySpark Delta load code + auto-opens create-notebook dialog
- ✅ **NEW v3.15:** Load to Tables (Delta) → prefills `saveAsTable` code

### Notebook — **A** (v3.15)
**Backing:** Fabric REST `/items/notebooks/**` against the Loom Fabric workspace.
**Actions wired:**
- ✅ List workspaces (`/api/fabric/workspaces` returned 1 real ws in audit)
- ✅ List notebooks in workspace
- ✅ Create notebook (POST Fabric)
- ✅ Save source (PUT definition with base64 InlineBase64 payload)
- ✅ Run notebook (POST jobs/instances)
- ✅ Run history (GET jobs/instances)
- ✅ **NEW v3.15:** Reads `loom.notebook.prefill` from localStorage and pre-populates source + auto-opens create dialog with derived name
- ⚠️ Switch workspace, delete notebook — all wired but require Fabric workspace SP grant

### Spark job definition — **A**
**Backing:** Synapse Livy API for batch submission, Cosmos for spec persistence.
**Actions wired:**
- ✅ Pick Spark pool (live from Synapse workspace)
- ✅ Set file URI, className, args, conf JSON
- ✅ Save spec → Cosmos
- ✅ Submit → real Spark batch (returns Livy job id)
- ✅ Run history (live Livy `/livyApi/versions/2019-11-01-preview/sparkPools/<pool>/sessions`)

### Environment — **A**
**Backing:** Synapse Spark pool conf via ARM API + Cosmos for spec.
**Actions wired:**
- ✅ Edit requirements.txt
- ✅ Edit Spark conf (JSON)
- ✅ Add JAR paths
- ✅ Target pool selection
- ✅ Save → Cosmos
- ✅ Apply → patches pool's `librariesRequirementFile` + `customConfigs`

### Copy job — **A**
**Backing:** Synapse / ADF Copy Activity wrapper, Cosmos for spec.

### Data pipeline / ADF pipeline — **A**
**Backing:** ADF management REST. Save persists pipeline JSON to ADF; Run triggers a real pipeline run; Runs grid streams from ADF query API.

### dbt job — **B**
**Backing:** Cosmos persist; runs against dbt Cloud or local dbt Core via configured `LOOM_DBT_ENDPOINT`. **Gated:** needs `LOOM_DBT_ENDPOINT` env var; without it, save works but Run shows honest "endpoint not configured" MessageBar.

### Lakehouse shortcut — **B** (new item, 2026-06)
**Backing:** Named `abfss://` pointer over the existing DLZ ADLS Gen2 (read-in-place, no copy) — Azure-native equivalent of a OneLake shortcut with no OneLake/Fabric dependency. Create resolves + verifies the target with the real ADLS client (`listPaths`); list/delete via Cosmos. Route: `app/api/items/lakehouse-shortcut/route.ts`.

---

## Warehouse / SQL

### Synapse Serverless SQL pool — **A+**
**Backing:** Synapse Serverless SQL endpoint (`syn-loom-default-eastus2-ondemand.sql.azuresynapse.net`), UAMI is sysadmin.
**Actions:** Run T-SQL query → real result + execution time + bytes scanned.

### Synapse Dedicated SQL pool — **A+**
**Backing:** `loompool` DW100c with auto-pause Logic App. UAMI: Synapse SQL Administrator.
**Actions:** Resume (when Paused), Pause, Schema browse, Run T-SQL, Recent runs (DMV).

### Warehouse (Fabric warehouse mirror) — **A**
**Backing:** Same Synapse Dedicated pool. Editor surfaces "Paused / loompool / DW100c" badge honestly when pool is paused.

### Azure SQL Database — **A**
**Backing:** Azure SQL DB on `azure-sql-server` item. Actions: Query, Mirroring config, Replication config, SQL Server 2025 vector index features.

### Azure SQL Managed Instance / Server / SQL Server 2025 vector — **A**
**Backing:** ARM + sqlcmd via UAMI.

### Mirrored database / Mirrored Databricks — **A**
**Backing:** Fabric Mirroring REST. Wired; requires Fabric SP grant.

---

## Real-Time

### KQL database / Eventhouse — **A+**
**Backing:** ADX cluster `adx-loom-default-eastus2`, UAMI: Database User.
**Actions:** Run KQL → real result, .show / .create commands, charts pin.

### KQL queryset / dashboard — **A**
**Backing:** Cosmos persist + ADX execute.

### Eventstream — **B** (Event Hubs namespace now deploys)
**Backing:** Event Hubs + Stream Analytics. The Event Hubs namespace now ships in bicep (`landing-zone/eventhubs.bicep`), so the Run path no longer 404s on a missing namespace. React Flow designer canvas + transform builder + add-alert / MQTT-source / SQL-operator sub-surfaces; source/dest config persists to Cosmos.
**Grant:** UAMI `Azure Event Hubs Data Owner` for Send/receive.

### Event Hubs namespace — **B** (new item, 2026-06)
**Backing:** `Microsoft.EventHub/namespaces` (`landing-zone/eventhubs.bicep`). `event-hubs-namespace` item lists hubs / consumer groups, Send is real REST; Capture configured per-hub. Route: `app/api/items/event-hubs-namespace`.

### Service Bus namespace — **B** (new item, 2026-06)
**Backing:** `Microsoft.ServiceBus/namespaces` (`servicebus.bicep`). `service-bus-namespace` item manages queues / topics / subscriptions. Route: `app/api/items/service-bus-namespace`.

### Event Grid topic — **B** (new item, 2026-06)
**Backing:** `Microsoft.EventGrid/topics` (`eventgrid.bicep`). `event-grid-topic` item manages the topic + subscriptions + publish. Route: `app/api/items/event-grid-topic`.

### Activator — **A**
**Backing:** Cosmos persist (rules) + ADX / Power Automate trigger. Rules editor live.

---

## AI / ML

### AI Foundry hub — **GATED** (RBAC)
**Backing:** AzureML workspace `aifoundry-csa-loom-eastus2`. UAMI lacks `Microsoft.MachineLearningServices/workspaces/read` — editor surfaces honest ARM error with full scope path.
**Fix:** PR #333 / `csa-loom-post-deploy-bootstrap` grants `AzureML Data Scientist` on the workspace.

### AI Foundry project / prompt-flow / evaluation / ml-model / ml-experiment / compute / dataset — **GATED**
Same RBAC dependency as hub. (On a greenfield deploy the AML zero-gate now grants the Console UAMI AzureML Data Scientist and provisions a default-on ML workspace + idle-TTL Compute Instance, so these work without a manual grant.)

### AutoML — **B** (new item, 2026-06)
**Backing:** Azure ML **AutoML** jobs — `app/api/items/automl/{options,submit,jobs}` submit a real AutoML job (classification / regression / forecasting) against the default-on AML workspace + Compute Instance (see the AML zero-gate). Options list + submit + job status all real; requires the Console UAMI AzureML Data Scientist (granted by bicep on greenfield).

### AI Search index — **A+**
**Backing:** `dlz-aisearch-dev-eastus2`. UAMI authenticates via `https://search.azure.com/.default`.
**Actions:** List indexes, Upsert index definition, Run hybrid search → all 200 against real service.

### Content Safety — **B**
**Backing:** Azure AI Content Safety REST. Wired; needs Content Safety endpoint provisioned (currently `LOOM_CONTENT_SAFETY_ENDPOINT` unset).

### Data agent / Cross-item Copilot — **A**
**Backing:** Foundry prompt flow + AI Search RAG (gated on Foundry).

---

## Power BI

### Semantic model / Report / Dashboard / Paginated report / Scorecard — **GATED**
**Backing:** Power BI REST. UAMI needs Power BI tenant SP enablement (Fabric admin portal — interactive grant required). Editors render and persist Cosmos metadata; XMLA-endpoint operations are blocked until the SP grant lands.

---

## APIs

### APIM API / Product / Policy — **A+**
**Backing:** APIM management REST. UAMI: API Management Service Contributor (granted by `csa-loom-post-deploy-bootstrap`).
**Actions:** List APIs, Import OpenAPI spec, Add operations, Apply policy XML — all real.

### GraphQL API — **B**
**Backing:** Code-first via APIM GraphQL gateway. Cosmos persist works; backend code generation deferred.

### User data function — **B**
**Backing:** Designed for Container Apps Jobs; Cosmos persist works; job deploy is deferred (see backlog).

---

## Power Platform

### Power Apps / Power Automate / Dataverse table / AI Builder / Power Page / Power Platform environment — **GATED**
**Backing:** Power Platform admin Graph + Dataverse Web API. UAMI needs **Power Platform Administrator** role (admin.powerplatform.microsoft.com — interactive grant only). Editors render with honest "no environments" empty state until grant lands.

---

## Copilot Studio

### Copilot Studio agent / knowledge / topic / action / channel / analytics / template-library — **GATED**
Same Power Platform Admin gate as above.

---

## Data products

### Data product template / instance — **A**
**Backing:** Cosmos. Template editor + instance fan-out works fully (template walks `components[]` + creates each child item).

---

## Graph / Geo

### Cosmos Gremlin graph — **A**
**Backing:** Cosmos DB Gremlin API. Query editor → real Gremlin execution.

### Cypher graph / GQL graph / Graph model / Ontology — **B**
**Backing:** Cosmos persist; **both** Cypher and GQL now translate to ADX `make-graph` / `graph-match` (real ADX execution when the cluster is available) — GQL is no longer parsing-only. **Graph model** materializes a property-graph schema to ADX node/edge tables (`.set-or-append` / `.ingest`); **Ontology** persists objects/links to Apache AGE on Azure Database for PostgreSQL Flexible Server with write-back actions.

### Geo dataset / map / pipeline / query — **B**
**Backing:** Synapse Serverless OPENROWSET on Parquet with H3/S2 column conventions; works when Lakehouse data is present.

---

## Fabric IQ

Palantir-Foundry / Fabric-IQ-parity editors — all Azure-native backends, no Fabric capacity. Each links its per-item parity doc. Grades are conservative (real backend today; the 2026-06-30 parity program is deepening feature completeness toward 1:1).

### Ontology — **B**
**Backing:** Cosmos (model) + Apache AGE on Azure DB for PostgreSQL Flexible Server (object/link instances + write-back) + Synapse/ADLS datasources. See `parity/ontology.md`.

### Plan (EPM/CPM planning) — **B**
**Backing:** Cosmos planning cells + governed writeback → Azure SQL `MERGE`; actuals from an AAS/XMLA semantic model or Synapse/ADX. See `parity/plan.md`.

### Graph model — **B**
**Backing:** property-graph schema materialized to ADX node/edge tables; queried via `make-graph` / `graph-match`. See `parity/graph-model.md`.

### Map — **B**
**Backing:** interactive Azure Maps Web SDK (`azure-maps-canvas.tsx`) over the Synapse Serverless / ADX / Weave binding; `map-token` AAD route + Azure Maps Data Reader. See `parity/map.md`.

### Data Agent — **B**
**Backing:** Azure OpenAI NL2SQL / NL2KQL / NL2DAX over bound sources (also listed under AI/ML). See `parity/data-agent.md`.

### Workshop app (Atelier) — **B**
**Backing:** low-code operational app builder → DAB on ACA + ontology write-back. See `parity/workshop-app.md`.

### Slate app — **B**
**Backing:** pro-code app/dashboard builder (codegen bundle → `_palantir-codegen.ts`). See `parity/slate-app.md`.

### Ontology SDK (OSDK) — **B**
**Backing:** typed SDK generator → DAB on ACA (REST + GraphQL) + APIM + Entra app-registrations. See `parity/ontology-sdk.md`.

### Release environment — **B**
**Backing:** Azure Deployment Environments (DevCenter) + App Service slots + ARM deployments. See `parity/release-environment.md`.

### Health check — **B**
**Backing:** Azure Monitor `scheduledQueryRules` + action groups + resource-health. See `parity/health-check.md`.

### AIP Logic (Spindle) — **B**
**Backing:** Azure OpenAI typed AI logic + tool-calling over the bound Weave ontology; publish via APIM / DAB / Functions. See `parity/aip-logic.md`.

---

## Ops

### Plan / Operations agent / Tracing — **B**
**Backing:** Cosmos persist + Application Insights query. Editors render; Apply on a Plan executes the diff via the existing item APIs.

---

## Push-button reproducibility

Bicep tree at `platform/fiab/bicep/` deploys every Azure resource Loom
orchestrates. Post-deploy bootstrap workflow grants UAMI the required
RBAC. **What's still missing from push-button** (tracked in PR backlog):

1. ~~Event Hubs namespace for eventstream / eventhouse Run~~ — **now shipped** (`landing-zone/eventhubs.bicep`; Service Bus + Event Grid namespaces landed in the same wave)
2. Content Safety endpoint for content-safety editor
3. Power Platform Admin role on UAMI (interactive only; documented in bootstrap workflow Summary step)
4. Power BI tenant SP grant (Fabric admin portal interactive)

---

## v3.15 / v3.16 changes (what just shipped)

- Lakehouse right-click menu adds "Open in notebook" + "Load to Tables"; helpful empty-state replaces "(empty)"
- Notebook editor reads localStorage prefill (Lakehouse → Notebook flow)
- New `/api/apps/[id]/install` route — apps now actually install bundled items into a chosen workspace
- App detail page gets an "Install into workspace" primary button + workspace picker dialog + result panel
- All 10 curated CSA apps can now be one-click installed
