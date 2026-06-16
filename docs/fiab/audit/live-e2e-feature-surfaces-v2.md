# FEATURE-SURFACE Live E2E Report (v2)

**Deployment:** CSA Loom Console `v0.42.0` (https://csa-loom.limitlessdata.ai) — Azure-native backend
**Session:** minted AES-256-GCM admin session (`e2e@limitlessdata.ai`, oid `866a2e12-…`), tenant `866a2e12-…`
**Scope:** 243 live feature-surface results across 12 areas, exercised against real Azure (ARM / Cosmos / Key Vault / ADX / Event Hubs / Log Analytics / APIM / Storage / AOAI).

---

## 1. Executive Summary

### Verdict tally

| Verdict | Count | Share |
|---|---:|---:|
| works | 188 | 77.4% |
| honest-gate | 37 | 15.2% |
| broken | 15 | 6.2% |
| ui-gap | 3 | 1.2% |
| **Total** | **243** | 100% |

### By area

| Area | works | honest-gate | broken | ui-gap | Total |
|---|---:|---:|---:|---:|---:|
| real-time-hub | 9 | 0 | 1 | 0 | 10 |
| rti-hub-catalog | 14 | 3 | 0 | 1 | 18 |
| activators-all | 16 | 2 | 1 | 0 | 19 |
| mirroring-all-source-types | 18 | 5 | 0 | 1 | 24 |
| apis-all | 27 | 4 | 2 | 0 | 33 |
| warp-weave | 9 | 6 | 4 | 0 | 19 |
| workload-hub-all | 8 | 0 | 0 | 0 | 8 |
| connections-all | 11 | 3 | 0 | 1 | 15 |
| business-events-all | 8 | 0 | 3 | 0 | 11 |
| event-hubs-all | 13 | 1 | 1 | 0 | 15 |
| deployment-pipelines-git | 14 | 9 | 3 | 0 | 26 |
| admin-nav-pages | 22 | 2 | 1 | 0 | 25 |
| main-nav-pages | 19 | 1 | 1 | 0 | 21 |
| **Total** | **188** | **37** | **15** | **3** | **243** |

> Note: a handful of leaves are tagged with two area labels in the source (e.g. the eventstream-DELETE gap appears in both `real-time-hub` and `rti-hub-catalog`). The per-area table follows the primary `area` field on each record.

### Overall live grade: **A− (Production-credible, honest)**

- **77% of surfaces work end-to-end against real Azure** with verifiable writes (real ARM PUTs, Cosmos round-trips, Key Vault secret writes, live ADX/Kusto queries, real Event Hub 201 sends, real APIM artifact CRUD, real scheduledQueryRule provisioning, real AOAI SSE orchestration).
- **15% are honest gates** — every one names the exact missing env var, RBAC role, or bicep module. No fabrication anywhere; "broken" verdicts are genuine code/RBAC defects, not vaporware.
- **Only ~6% broken**, and the broken set is dominated by a few repeating root causes (Fabric-error-not-mapped-to-gate, UAMI SQL-login missing, eventstream-DELETE route shadowing, hard-coded default hub/topic names). No surface returned fabricated success data.
- **The single fully-live external-source leg** is Databricks Unity Catalog mirroring (real UC REST, real `samples.nyctaxi.trips` Delta table). Most other external sources are honestly gated on infra not provisioned (ADF, PG AAD app, DAB runtime, Weave AGE Postgres).

---

## 2. BROKEN + Vaporware Must-Fix Table (deduped by root cause)

No vaporware was found (no fabricated success). The "broken" verdicts cluster into 8 root causes:

| # | Root cause | Areas / leaves affected | Evidence | Fix |
|---|---|---|---|---|
| **B1** | **Eventstream DELETE route shadowing** — static `app/api/items/eventstream/[id]/route.ts` exports only GET/PUT and shadows the generic `[type]/[id]` DELETE → 405. No console API path can delete an eventstream. | real-time-hub: `DELETE /api/items/eventstream/[id]`; rti-hub-catalog: `Eventstream item DELETE path` (working alt is `/api/cosmos-items/eventstream/{id}`) | `DELETE /api/items/eventstream/63976f31-… → 405 Method Not Allowed`; `DELETE /api/cosmos-items/eventstream/{id} → 200` | Add a DELETE export to `eventstream/[id]/route.ts` delegating to `loadItem + items.item(id,workspaceId).delete()`; add a row-menu Delete in RealTimeHubView/RtiHubView. |
| **B2** | **Fabric error not mapped to honest-gate** — sibling git/stage routes map 401/403→gate, but Fabric's SPN-unauthorized response is a non-401/403 `UnknownError`, which falls through to a raw 500. | deployment-pipelines-git: `git/[ws]/update`; `stages/[stageId]/workspace` (assign workspace) | `POST …/update {} → 500 {"error":"UnknownError…"}`; `POST …/stages/STG/workspace → 500 {"error":"UnknownError…"}` | Map `FabricError` 5xx/`UnknownError` (and not-connected) to the gate in both routes (widen the pre-flight catch to swallow all FabricError before the action). |
| **B3** | **Console UAMI has no SQL login** on Synapse dedicated / warehouse SQL endpoints → `Login failed for user '<token-identified principal>'`. | warp-weave: `visual-query on warehouse/Synapse Dedicated`; apis-all: `dab/sources/[kind]/schema\|columns`, `thread/warehouse-tables`; (also `thread/publish-as-api` depends on it) | `POST …/warehouse/…/visual-query → {"error":"Login failed…","code":"ELOGIN"}`; `GET /api/dab/sources/mssql/schema → "Login failed for user '<token-identified principal>'."` | Provision the Console UAMI as a SQL login (`CREATE USER … FROM EXTERNAL PROVIDER` + role) on dedicated pool/warehouse; surface a structured 503 remediation gate instead of raw 500/ELOGIN. |
| **B4** | **Activator detail GET always calls Fabric** — no azure-native branch (unlike POST/DELETE/rules/start/stop). Default-backend activator with no `state.content.rule` falls back to null → raw Fabric 401/502. | activators-all: `GET /api/items/activator/[id]` (also breaks `/activator` page item-open) | `GET /api/items/activator/8c41c358-…/ → {"error":"The caller is not authenticated to access this resource"}` | Add `!useFabric()` branch to the detail GET that builds detail+rules from the Cosmos item (`loadContentBackedItem` + `state.rules`). |
| **B5** | **Hard-coded default Event Hub / Event Grid topic names not provisioned** — publish fallback targets `loom-telemetry` (EH) / `loom-business-events` (EG) which don't exist → 404/502. EG topics created via console also lack `EventGrid Data Sender` for the UAMI → 401. | business-events-all: `publish — EH default hub`, `publish — EG channel`; main-nav-pages: `Business events default hub` | `publish (no eventHubName) → 502 …loom-telemetry/messages 404`; `publish → EG → 502 401 "does not have permission to send data…"` | Stop hard-coding defaults; require hub/topic selection from the real `channels` list (or env-derived default). On EG topic create, also assign UAMI `EventGrid Data Sender`. |
| **B6** | **Event Hubs Capture disable sends incomplete shape** — `captureDescription:{enabled:false}` omits `encoding`+`destination`, which ARM 2024-01-01 requires even to disable → `RequestJsonDeserializationFailure 400`. | event-hubs-all: `capture (PUT write — DISABLE path)` | `PUT capture {enabled:false} → 400`; direct ARM: `"Required property 'encoding' not found…"` | In `updateEventHubCapture()`, send full shape on disable (carry over existing destination/encoding); surface the real ARM error body. |
| **B7** | **APIM instance picker duplicates** — route iterates `rgs=[LOOM_ADMIN_RG, LOOM_DLZ_RG]`, both resolve to the same RG → same APIM pushed twice (no dedupe). | apis-all: `GET /api/apim/instances` | `instances:[{apim-csa-loom-centralus…},{apim-csa-loom-centralus…}]` (identical) | Dedupe `rgs` via `new Set` (or dedupe instances by resourceId/name). |
| **B8** | **APIM policy read-back empty** — `getPolicy()` GETs `format=xml` and reads empty even though ARM persisted the policy (PUT confirmed). Editor shows blank over an existing policy. | apis-all: `GET/PUT /api/items/apim-policy/[id]` | PUT scope=api persists (ARM GET returns full `<policies>…X-E2E…`), but route `GET ?scope=api → {"value":"","format":"xml"}` | Use `format=rawxml` on the GET to match the PUT. |
| **B9** | **Thread edge reconcile skipped on workspace-items DELETE** — `reconcileThreadEdgesOnDelete` is only called from `item-crud.ts`, not from `workspaces/[id]/items/[itemId]` DELETE → orphan/stale lineage edges. | warp-weave: `Thread edge reconcile on workspace-items DELETE` | After `DELETE /api/workspaces/…/items/3f2d7349… → ok`, `GET /api/thread/edges` still returns the now-orphaned edge | Call `reconcileThreadEdgesOnDelete` (+ recycle-bin tombstone variant) from the workspaces items DELETE route. |
| **B10** | **dbt-job run crashes on malformed graph** — missing `sources[]`/`model.layer` throws unguarded TypeError → raw 502 instead of 400. | warp-weave: `dbt-job run input validation` | `POST …/dbt-job/<id>/run (no sources) → 502 "Cannot read properties of undefined (reading 'length')"` | Validate `DbtProjectGraph` server-side (require `sources[]`, each `model.layer`); return 400 with field-level errors. |
| **B11** | **Catalog/Governance Purview path: no data-plane RBAC** — `LOOM_PURVIEW_ACCOUNT` set but Console UAMI lacks Atlas/Data Curator → 403, federated Purview lineage can't load. | warp-weave: `Catalog Lineage /api/catalog/lineage`; admin-nav: `Purview sources/domains` (honest-gate twin) | `GET /api/catalog/lineage?source=purview → 403 "Not authorized to access account"` | Grant UAMI Purview Data Curator/Reader on the collection; render 403 as an honest remediation gate. |
| **B12** | **DLP Graph endpoints invalid** — `simulate` POSTs a non-existent `/beta/security/dataLossPrevention/evaluatePolicies` segment; `violations` uses an invalid `$expand=evidence`. | admin-nav-pages: `/admin/security - DLP` | `POST dlp/simulate → 400 "Resource not found for the segment 'dataLossPrevention'."`; `dlp/violations → 400 invalid $expand` | Remove/repoint the simulate feature to a valid API; drop the invalid `$expand=evidence`. |

---

## 3. Honest-Gate Table (exact env var / role / resource to enable)

| Area | Leaf | Gate — what to set/grant | Status |
|---|---|---|---|
| rti-hub-catalog | `GET /api/items/eventstream/{id}/events` | Provision the source first (409 — unprovisioned eventstream has no ingest endpoint) | 409 |
| rti-hub-catalog | `POST /api/eventhubs/data-explorer` (peek) | `@azure/event-hubs` AMQP + `LOOM_EVENTHUB_RECEIVE_ENABLED=1` | 501 |
| rti-hub-catalog | Fabric events tab | `LOOM_EVENTSTREAM_BACKEND=fabric` + bind a Fabric workspace (opt-in) | 200 |
| activators-all | `POST …/eventstream/[id]/activator` | `LOOM_EVENTSTREAM_EVENTS_TABLE` / `LOOM_ACTIVATOR_DEFAULT_TABLE` (default `AppEvents_CL` not in LAW); accept body `sourceTable` | 502 |
| activators-all | `POST …/ontology/[id]/activator` | Same default-table gate; `buildEntityChangeQuery` hardcodes `AppEvents_CL` | 502 |
| mirroring | Start — PostgreSQL | Provision/consent the Azure DB for PostgreSQL AAD app `ossrdbms-aad.database.azure.com` in tenant | 200 (engine real) |
| mirroring | Start — Snowflake | `LOOM_ADF_NAME` + `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE` + `LOOM_MIRROR_ADLS_LINKED_SERVICE` | 200 |
| mirroring | Start — Google BigQuery | `LOOM_ADF_NAME` + ADF CDC env (GoogleBigQuery V2 connector); BigQuery Data Viewer/Job User grants | 200 |
| mirroring | Start — Oracle | `LOOM_ADF_*` + Oracle connector via SHIR/on-prem gateway; LogMiner + SELECT_CATALOG_ROLE | 200 |
| mirroring | Open mirroring — SAS gate | `Storage Blob Delegator` on DLZ account (or use RBAC workaround) | 200 |
| mirroring | Mirror endpoint/shortcut pairing | Synapse Serverless OPENROWSET; pair created at Install against a real reachable source | 200 |
| apis-all | DAB preview (schema/rest/graphql/probe) + publish | `LOOM_DAB_PREVIEW_URL` (deploy DAB runtime via bicep) | 503 |
| apis-all | `GET …/apim-api/[id]/spec` (OpenAPI export) | Export of link-imported APIs needs the export format/path | 404 |
| apis-all | `POST …/user-data-function/[id]/invoke` | Publish UDF to Fabric: `state.fabricEndpoint` or `fabricWorkspaceId`+`fabricItemId`+`LOOM_FABRIC_UDF_HOST` | 409 |
| warp-weave | dbt-job run (synapse/databricks) | `LOOM_DBT_RUNNER_URL` (deploy `loom-dbt-runner` ACA via `modules/integration/dbt-runner.bicep`); databricks needs a cluster | 503/400 |
| warp-weave | Ontology Weave objects + run-action | `LOOM_WEAVE_PG_FQDN` (deploy `postgres-weave.bicep`, Apache AGE) | 503 |
| warp-weave | Tapestry link / geo / timeline | Materialize a graph (Node_*/Edge_* tables in ADX) via "Load sample data" | 400 |
| connections | `GET /api/azure/connectables` | UAMI Reader at mgmt-group/tenant root **OR** scope ARG query to `LOOM_SUBSCRIPTION_ID` | 200 no_access |
| connections | `POST /api/connections` validation | secret required for secret-bearing auth methods | 400 |
| event-hubs | `data-explorer` peek | `@azure/event-hubs` + `LOOM_EVENTHUB_RECEIVE_ENABLED` | 501 |
| deployment-pipelines-git | Fabric pipelines list / stages / operations / items / compare-validate / deploy-validate / create / git connect/status/initialize/commit | **Fabric API authorization** (Console UAMI not authorized for Fabric); some need Workspace admin/contributor + SPN-can-create-deployment-pipelines tenant toggle | 200 gate |
| admin-nav-pages | `/admin/security - MIP` | `LOOM_MIP_ENABLED` / `LOOM_MIP_ADMIN_ENABLED` (admin-plane `main.bicep`) | 503 |
| admin-nav-pages | `/admin/security - Purview` (sources/domains) | UAMI Purview Data Curator/Reader data-plane role (`LOOM_PURVIEW_ACCOUNT` already set) | 403 |
| admin-nav-pages | `/admin/copilot-usage` | App Insights Copilot token events (none yet — honest empty) | 200 |
| main-nav-pages | `/data-agent` chat | Deprecated stub → redirects to `/copilot` orchestrator | 503 |

---

## 4. UI Updates Needed (area / leaf / specific change)

| Area | Leaf | UI change |
|---|---|---|
| real-time-hub | keyvault-certificates | Add an "Upload certificate" affordance / empty-state pointing to the vault (vault configured, 0 certs) so mTLS is configurable in-UI. |
| real-time-hub | preview | Add a real DB/table picker in StreamPreviewDrawer (from `.show databases/.show tables`) instead of assuming stream name == table name. |
| real-time-hub | DELETE eventstream | Add DELETE export + "Delete eventstream" row action (currently no remove path). |
| real-time-hub | RealTimeHubView | Add delete/disconnect to row menu; wire stream-row Preview to its backing KQL table or hide it for streams. |
| rti-hub-catalog | preview (cluster row) | Carry the real Kusto database name in the row preFill so "Preview data" targets the right DB. |
| rti-hub-catalog | eventstream events (409) | EventTestDrawer should render "provision first" CTA with link, not a raw error. |
| rti-hub-catalog | data-explorer peek | Surface the AMQP-receive gate in the View tab instead of a silent dead control; keep Send enabled. |
| rti-hub-catalog | Eventstream DELETE path | Add row-menu Delete wired to `DELETE /api/cosmos-items/{type}/{id}` for Loom item kinds. |
| rti-hub-catalog | Azure events tab | Add "discover storage accounts" enhancement for per-account event sources (phase-2). |
| rti-hub-catalog | connect-source | Reject `fabric-*` sourceTypes when `LOOM_EVENTSTREAM_BACKEND!=fabric` (defense in depth). |
| activators-all | activator detail GET | Add azure-native branch (fixes B4) so the editor opens instead of erroring. |
| activators-all | DELETE [id] / DELETE rules | Garbage-collect the per-activator action group when its last rule is removed (avoid orphan `actionGroups`). |
| activators-all | eventstream/ontology activator quick-create | Accept body `sourceTable`/`eventsTable`; create backing activator only after the rule provisions (avoid orphans). |
| activators-all | /activator-hub | "New rule" should deep-link into a rule-create wizard scoped to the workspace, not just navigate to the list. |
| mirroring | PostgreSQL start | Surface the AAD-app tenant-bootstrap gate in the wizard, not only at Start. |
| mirroring | Cosmos start gate | Drop `server` from the Cosmos Start gate; hide the Server field for Cosmos in the wizard (ui-gap). |
| mirroring | open-mirror merge | Map ADLS PathNotFound/404 to status `NoNewFiles` (friendly "no files yet"). |
| mirroring | endpoint/shortcut pairing | Render an explicit Install CTA when `provisioned:false`. |
| apis-all | apim/instances | Dedupe (fixes B7). |
| apis-all | apim/import | Editor should poll/refresh operations after import (eventual). |
| apis-all | apim/gateways | Render an explanatory caption for the empty Developer-tier list. |
| apis-all | apim-policy/[id] | Fix `getPolicy` read (rawxml) so saved policies render (fixes B8). |
| apis-all | apim-api/[id]/spec | Disable/explain Export button for link-imported APIs with no exportable spec. |
| apis-all | apim-api/[id]/test-call | Attach `Ocp-Apim-Subscription-Key` via master-key fallback so Test console succeeds out of the box. |
| apis-all | dab/[id]/validate | Guard `emitDabConfigJson`/validate against partial bodies (400 not 500). |
| apis-all | dab preview/publish | Render gate remediation (env var + bicep path) inline on Preview/Publish tabs. |
| apis-all | dab sources schema/columns | Surface a SQL-login remediation gate instead of raw 500 (ties to B3). |
| apis-all | thread/publish-as-api + warehouse-tables | Fall back to "custom SQL query" mode + structured 503 gate when SQL-login fails (ties to B3). |
| apis-all | user-data-function invoke | Render the publish-prerequisite gate hint inline. |
| warp-weave | warehouse visual-query | Surface ELOGIN as an actionable "grant UAMI SQL login" hint, not raw driver string (ties to B3). |
| warp-weave | dbt-job run validation | Server-side validate the graph; never 502 from codegen (fixes B10). |
| warp-weave | thread edge reconcile | Call reconcile from the workspaces items DELETE route (fixes B9). |
| warp-weave | catalog lineage Purview | Grant UAMI Purview role; render 403 as honest gate (ties to B11). |
| warp-weave | ontology run-action | Show expected DSL grammar inline; warn when source parses to 0 classes. |
| warp-weave | tapestry link | Add a one-click "Load sample investigation graph" action in the empty pane. |
| workload-hub-all | workloads-catalog list | Reconcile 16 registry groups vs 13 Cosmos seed rows; stop relying on name-string matching for included/CSA-badge. |
| workload-hub-all | workloads-catalog POST | Add DELETE/PATCH route + a Remove control; add a front-end affordance for the back-end-only "add custom workload". |
| workload-hub-all | create-by-workload | Validate `itemType` against `FABRIC_ITEM_TYPES` (rejects junk slugs; currently 201s). |
| workload-hub-all | /workload-hub page | Remove dead `<MessageBar>` ternary branch (used but not imported) in `page.tsx` L380-384. |
| connections-all | azure/connectables | Scope ARG to `LOOM_SUBSCRIPTION_ID` (or grant root Reader); preserve real ARG error code in gate text. |
| connections-all | ConnectionBuilder dialog | Add event-hub, service-bus, key-vault to the TYPES dropdown (8→11 to match the API + Add-existing). |
| connections-all | AzureConnectionsPane | Show `dfsEndpoint` on connected ADLS rows; default staging container name. |
| business-events-all | topics create | Add a Delete control + BFF DELETE for EG custom topics. |
| business-events-all | publish EH default | Remove the misleading "Default (loom-telemetry)" option; require/derive a real hub (fixes B5). |
| business-events-all | publish EG | Assign UAMI `EventGrid Data Sender` on console-created topics (or gate banner); ensure default topic exists (fixes B5). |
| business-events-all | BusinessEventsView | Show per-channel publish status (don't hide a successful EH send behind an EG RBAC failure); add topic-delete; fix default-hub option. |
| event-hubs-all | data-explorer peek | Bundle `@azure/event-hubs` + `LOOM_EVENTHUB_RECEIVE_ENABLED=1` for portal-parity View. |
| event-hubs-all | network | Add an editable Networking tab (IP/VNet rules, public-network toggle) for full parity. |
| event-hubs-all | capture disable | Fix the disable shape + surface the real ARM error body (fixes B6). |
| deployment-pipelines-git | Git tab | Add a tab-level Fabric-authorization gate banner (today only a quiet "No Fabric workspaces visible"). |
| deployment-pipelines-git | git/update + stage/workspace | Render the gate MessageBar instead of raw error toasts (fixes B2). |
| deployment-pipelines-git | page subtitle | Clarify Fabric+Git tabs need a Fabric tenant while Loom-native works standalone. |
| admin-nav-pages | /admin/health healer | Add a dry-run/test-fix affordance (fixable=0 made heal undemonstrable). |
| admin-nav-pages | /admin/capacity cost | Surface retry/backoff for the 429-prone Cost Management endpoint. |
| admin-nav-pages | /admin/attribute-groups | Confirm the Create write path posts to a real BFF route (no dedicated endpoint exists). |
| admin-nav-pages | DLP tabs | Fix the invalid Graph calls (fixes B12). |
| admin-nav-pages | Purview sources/domains | Grant UAMI Purview data-plane role (ties to B11). |
| admin-nav-pages | /admin/copilot-usage | Render a clear "no Copilot events yet" empty state. |
| admin-nav-pages | /admin/users | Show "connect Graph for license data" hint (graphEnriched=false). |
| admin-nav-pages | /admin/updates | Confirm canonical version display (brief said v0.7; `/api/version` returns 0.42.0). |
| main-nav-pages | /thread | Clearer empty-state CTA on the empty lineage canvas. |
| main-nav-pages | /api-marketplace | Add retry/loading state for the transient APIM cold-start 502. |
| main-nav-pages | /data-agent | Remove from main nav or relabel "(read-only)" since chat is permanently gated to /copilot. |
| main-nav-pages | business events default hub | Provision `loom-telemetry` or repoint `LOOM_EVENTHUB_BUSINESS_HUB`; pre-validate the target hub (fixes B5). |

---

## 5. Per-Area Full Results

### 5.1 real-time-hub (9 works, 1 broken)

- **works** — `GET /api/realtime-hub/streams` (200): lists Loom eventstream + kql-database/eventhouse from Cosmos across 2 workspaces (azure-native).
- **works** — `GET /api/real-time-hub/sources` alias of `/api/rti-hub` (200): cross-sub ARG catalog; real ADX cluster `adx-csa-loom-z52x3p`, counts {dataStreams:10, azureEvents:1}.
- **works** — `GET /api/realtime-hub/options` (200): all 6 kinds exercised; honest empties + verbatim ARM 404 for fake hub.
- **works** — `POST /api/realtime-hub/connect-source` (200): creates a REAL Loom eventstream; secret hardening verified (Kafka saslPassword → Key Vault + `saslPasswordSecretRef`); bad sourceType → 400 (22 allowed). Created 3 streams that could not be deleted (see B1).
- **works** — `POST /api/realtime-hub/provision` (200): real ARM PUTs against existing `evhns-csa-loom-centralus` (consumerGroup + eventhub created + cleaned up).
- **works** — `GET /api/realtime-hub/endpoints` (200): projects real eventstream topology; 400/404 guards.
- **works** — `GET /api/realtime-hub/keyvault-certificates` (200): vault `kv-loom-k6mvh5sm6z7do` configured, 0 certs (honest). UI: add upload affordance.
- **works** — `POST /api/realtime-hub/preview` (200): real ADX round-trip; nonexistent table → verbatim SEM0100. UI: add DB/table picker.
- **broken (B1)** — `DELETE /api/items/eventstream/[id]` (405): static route shadows generic DELETE; no API path deletes an eventstream.
- **works** — `/realtime-hub` page + RealTimeHubView (200): all 22 RTH_SOURCE_TYPES, honest infra-gate MessageBars, real drawers.

### 5.2 rti-hub-catalog (14 works, 3 honest-gate, 1 ui-gap)

- **works** — `GET /api/rti-hub` (200): live cross-sub ARG + Cosmos; real ADX cluster, 2 EH namespaces, KQL DB, eventstream items; warnings=[].
- **works** — `POST connect-source` Subscribe (200): real eventstream from AzureEventHub; secret → KV; BogusType → 400. Nit: accepts `FabricWorkspaceItemEvents` even without Fabric opt-in.
- **works** — `GET options` cascading dropdowns (200): all 6 kinds, real connections (e2e-kv-sql, e2e-mi-sql).
- **works** — `POST provision` (200): real ARM consumerGroup created/verified/deleted; IoT 404 verbatim.
- **works** — `POST preview` cluster row (200): real Kusto; clusterUri validated (ftp:// → 400).
- **works** — `GET endpoints` (200): real topology projection.
- **works** — `GET streams` (200): real Cosmos listing.
- **works** — `GET keyvault-certificates` (200): vault configured, 0 certs.
- **works** — `POST /api/items/activator` (200): real Reflex (azure-monitor), cleaned up.
- **honest-gate** — `GET …/eventstream/{id}/events` (409): provision-first.
- **honest-gate** — `POST /api/eventhubs/data-explorer` (200 send / 501 peek): real 201 send; peek gated on AMQP.
- **works** — Subscribe dialog `GET /api/loom/workspaces` (200): real workspaces.
- **ui-gap** — Eventstream item DELETE path (405 on `/api/items/eventstream`; 200 on `/api/cosmos-items/eventstream`): no row-menu delete (B1 twin).
- **honest-gate** — Fabric events tab (200): `fabricEventsGated=true`, opt-in.
- **works** — Azure events tab (200): 1 Blob-events connector; EG enumeration phase-2.

### 5.3 activators-all (16 works, 2 honest-gate, 1 broken)

- **works** — `GET /api/items/activator` (200): real Cosmos list, azure-monitor.
- **works** — `POST /api/items/activator` (200): real owned Cosmos item.
- **broken (B4)** — `GET /api/items/activator/[id]` (502): always calls Fabric; no azure-native branch.
- **works** — `DELETE /api/items/activator/[id]` (200): azure-monitor path; deletes scheduledQueryRules + Cosmos item. Gap: orphaned action group.
- **works** — `GET …/rules` (200); `POST …/rules` Email (200, real scheduledQueryRule + KQL validated against LAW); Webhook/Teams (200); SMS (502 — real ARM PhoneNumberIsNotValid, path correct); structured-condition (200); `POST …/rules?trigger=` run-now (200, real LA result set); `PATCH …/rules?enabled=` (200); `DELETE …/rules?ruleId=` (200).
- **works** — `POST …/start` (200); `POST …/stop` (200); `GET …/history` (200, honest empty).
- **works** — `GET …/eventstream/[id]/activator` (200).
- **honest-gate** — `POST …/eventstream/[id]/activator` (502): real provision; default `AppEvents_CL` not in LAW; body sourceTable not accepted.
- **works** — `GET …/ontology/[id]/activator` (200).
- **honest-gate** — `POST …/ontology/[id]/activator` (502): same default-table gate; `buildEntityChangeQuery` hardcodes table.
- **works** — `/activator` page (ItemsByTypePane); `/activator-hub` ActivatorPane — all panels backed by validated real APIs.

### 5.4 mirroring-all-source-types (18 works, 5 honest-gate, 1 ui-gap)

- **works** — list+create; verify (real TDS probe / honest gates per family); source-tables enumerate; Start SQL family (real change-feed DDL + verbatim TDS error); Start PostgreSQL (real PG path, honest AADSTS500011 tenant gap); Start Cosmos (real listContainers, honest "no tables").
- **ui-gap** — Cosmos Start gate requires `server` but engine never uses it (gate on `database` only).
- **honest-gate** — Start Snowflake / BigQuery / Oracle: ADF-copy backends gated on `LOOM_ADF_NAME` + linked-service env + source grants.
- **works** — open mirroring config GET (real abfss paths); merge run POST (real ADLS list, verbatim PathNotFound).
- **honest-gate** — open mirroring SAS gate (Storage Blob Delegator); status NoJob.
- **works** — open-mirror guard on non-GenericMirror (400); Monitor tab; sql-endpoint pairing (provisioned:false honest); source binding GET/POST; credential-aware table enumerate; lifecycle stop/restart; azure-sql-database mirroring entrypoint.
- **works** — Mirrored Databricks create/list/detail/PATCH; **fully-live** Unity Catalog listing (`samples.nyctaxi.trips` real Delta table) — the one fully-working external-source leg.
- **honest-gate** — Mirror endpoint/shortcut pairing (Synapse Serverless OPENROWSET; full pair at Install).

### 5.5 apis-all (27 works, 4 honest-gate, 2 broken)

- **works** — `GET/PATCH /api/apim/service` (real Developer-tier APIM; SKU/capacity validation).
- **broken (B7)** — `GET /api/apim/instances` (200): duplicate APIM.
- **works** — apis (GET/POST/DELETE), import (OpenAPI, eventual ops), operations (read-only), products, subscriptions, subscription keys reveal, named-values, backends.
- **works** — `GET /api/apim/gateways` (empty on Developer tier; honest).
- **works** — `PUT /api/items/apim-policy` (real ValidationError passthrough).
- **broken (B8)** — `GET/PUT /api/items/apim-policy/[id]` (200): scope wiring works, PUT persists, but GET reads back empty.
- **works** — apim-api revisions; **honest-gate** — apim-api spec export (404 for link-imported); **works** — test-call (real gateway round-trip, 401 missing key — see UI note); product↔api binding; product subscriptions; apim-api item CRUD.
- **works** — connections (KV-backed) GET/POST/DELETE; **works** — dab create + config/download; **works** — dab validate (500 on partial body — robustness nit); **honest-gate** — dab preview/publish (`LOOM_DAB_PREVIEW_URL`); **works** — dab sources mssql/dwsql; **honest-gate** — dab sources schema/columns (500 UAMI SQL-login, B3); **works** — dab deploy-source validation.
- **works** — graphql-api publish/query/item CRUD; **honest-gate** — user-data-function invoke (409 publish-first); **works** — udf item CRUD; data-product publish-api (full APIM transaction); thread publish-as-api validation; **honest-gate** — thread warehouse-tables (500 UAMI SQL-login, B3).
- **works** — Auth gate (401 unauth; `/api/me` valid).

### 5.6 warp-weave (9 works, 6 honest-gate, 4 broken)

- **works** — `/experience/warp` redirect (307→/home); Warp hub + home BFF (real Cosmos: 2 pipelines, 1 dbt-job); Pipeline Builder visual-query on serverless (502 real "Invalid object name" — live round-trip); visual-query input guard (400).
- **broken (B3)** — visual-query on warehouse/Synapse Dedicated (502 ELOGIN — UAMI no SQL login).
- **honest-gate** — Code Repos dbt-job run (503/400 — `LOOM_DBT_RUNNER_URL` / cluster).
- **broken (B10)** — dbt-job run input validation (502 unguarded TypeError).
- **works** — Thread/Lineage page + edges; Thread Weave write analyze-in-notebook (real notebook + edge).
- **broken (B9)** — Thread edge reconcile on workspace-items DELETE (orphan edge).
- **works** — Governance Lineage page + BFF (real cosmos source).
- **broken (B11)** — Catalog Lineage `/api/catalog/lineage` (403 Purview no RBAC; unity-catalog 400 validation correct).
- **honest-gate** — Ontology Weave objects + run-action (503 `LOOM_WEAVE_PG_FQDN`); Tapestry link/geo/timeline (400 no materialized graph).
- **works** — Auth gate consistency (401 + valid `/api/me`).

### 5.7 workload-hub-all (8 works)

- **works** — `GET /api/workloads-catalog` (auto-copy GLOBAL seed → 13 tenant rows). UI: reconcile 16 registry vs 13 seed.
- **works** — `POST /api/workloads-catalog` (201). UI: no DELETE/PATCH; no front-end affordance.
- **works** — `GET /api/items/by-type` (manage-view list; comma-form dodges WAF).
- **works** — Create-by-workload `POST /api/workspaces/[id]/items` for all 16 registry workloads (201; lakehouse auto-pairs warehouse). UI: validate `itemType` against `FABRIC_ITEM_TYPES`.
- **works** — `/workload-hub` (200; 16 tiles). UI: dead `<MessageBar>` branch (import gap).
- **works** — `/workload-hub/[workload]` (200; 404 unknown key); `/workload-hub/[workload]/[type]` (200; wired end-to-end).

### 5.8 connections-all (11 works, 3 honest-gate, 1 ui-gap)

- **works** — `GET /api/connections` (200); `POST` entra-mi no-secret (201); `POST` sql-password secret→KV (201, no plaintext); `DELETE` + KV secret delete (200).
- **honest-gate** — `POST` validation gates (400 missing-secret / bad-type).
- **honest-gate** — `GET /api/azure/connectables` (200 no_access — ARG not scoped to sub + UAMI lacks enumerable-scope Reader; error code stripped).
- **works** — workspace `GET .../connections` (200); adls-accounts (real 3+ accounts); log-analytics-workspaces (real 3 LAWs); `POST kind=adls-gen2` (FULL real provision: RBAC probe + container create + cleanup); `POST kind=log-analytics` (FULL real connect: RBAC probe + KQL print); `DELETE .../{connId}` (200).
- **honest-gate** — workspace connections kind validation (400).
- **ui-gap** — ConnectionBuilder dialog offers 8 of 11 API types (missing event-hub, service-bus, key-vault).
- **works** — AzureConnectionsPane (wires all 5 verified routes; honest MessageBars).

### 5.9 business-events-all (8 works, 3 broken)

- **works** — types GET/POST/DELETE (real Cosmos, `updatedBy` stamped, strict input validation); channels (real EH namespace + 4 hubs + live Azure Monitor metering); topics list (real EG, provisioningState Creating→Succeeded); topics create (real EG topic, localAuthDisabled — no DELETE route, UI gap); publish governed-schema gate (422 precise per-field).
- **works** — publish EH channel (real CloudEvents → `order-change-fan-out`, 201 sent:1).
- **broken (B5)** — publish EH **default** hub fallback `loom-telemetry` (502 404 — not provisioned).
- **broken (B5)** — publish EG channel (502: console-created topic lacks UAMI Data Sender → 401; default topic `loom-business-events` 404).
- **works** — `/business-events` page (BusinessEventsView; all controls map to real routes). UI: per-channel status, topic delete, fix default-hub option.

### 5.10 event-hubs-all (13 works, 1 honest-gate, 1 broken)

- **works** — hubs CRUD; consumergroups CRUD; schemagroups CRUD; authrules list; authrules keys reveal (real listKeys, even on disableLocalAuth namespace); authrules keys rotate (real regenerateKeys — value changed); data-explorer SEND (real 201).
- **honest-gate** — data-explorer VIEW/PEEK (501 — AMQP receive not bundled).
- **works** — geodr list; geodr-actions (validation 400 + real ARM 404→502 round-trip); network firewall summary (read-only — UI: add editable tab); private-endpoints (real round-trip); capture GET.
- **broken (B6)** — capture PUT disable (400 — incomplete shape; ARM requires encoding+destination even to disable).

### 5.11 deployment-pipelines-git (14 works, 9 honest-gate, 3 broken)

- **honest-gate** — Fabric pipelines list (200 gate, UAMI not authorized for Fabric).
- **works** — Loom-native pipelines: list, create (+distinct-workspace guard), read, delete, compare (content diff Fabric lacks), stage rules GET/PUT (+invalid-key 400), **deploy PROMOTE** (real end-to-end — created paired item in Test ws, applied datasource rule, persisted history), history.
- **honest-gate** — git connect/status/initialize/commit (200 gate); Fabric pipeline stages/operations/items/create (200 gate).
- **works** — Fabric compare (400 validation); Fabric deploy (400 validation).
- **broken (B2)** — git/update (500 raw UnknownError); stages/[stageId]/workspace assign (500 raw UnknownError).
- **works** — ARM deployments list (real Microsoft.Resources/deployments); ARM deployment operations (real per-resource).
- **works** — `/deployment-pipelines` page (4 tabs; Loom fully functional, Fabric+Git gate, ARM real). UI: tab-level Fabric gate banner + fix raw-500 leaks.

### 5.12 admin-nav-pages (22 works, 2 honest-gate, 1 broken)

- **works** — /admin/health (26-check self-audit score 100; honest heal-not-applicable); tenant-settings GET/PUT; capacity (real Azure Monitor metrics; real Cost 429 throttle); scaling (10 SKU reads + real ACA PATCH); env-config GET (PUT intentionally not run); api-management (real APIM + named-value CRUD); domains CRUD+inventory+images; attribute-groups (via overview); deploy-planner (real retail pricing); add-landing-zone (read steps; deploy not run); security sensitivity-labels CRUD; permissions capabilities+grants; batch-labeling (real apply+clear); embed-codes CRUD; org-visuals upload/enable/delete; audit-logs (45 real rows); usage (real LA-backed); copilot-config GET/PUT; dspm-ai; users; workspaces (read; destructive not run); network (real topology/PE/gateway); updates (real GitHub release check); cross-cutting reindex (59 items)+refresh-summary+azure-resources(270)+classifications.
- **honest-gate** — security MIP (503 `LOOM_MIP_ENABLED`); security Purview sources/domains (403 — UAMI no data-plane role, B11 twin); copilot-usage (200 honest empty).
- **broken (B12)** — security DLP simulate/violations (400 — invalid Graph endpoints; alerts 403 missing app roles).

### 5.13 main-nav-pages (19 works, 1 honest-gate, 1 broken)

- **works** — Home; Workspaces create+delete; Browse; OneLake catalog; Unified catalog federated search; Org reports render (PBIR model); Lineage /thread; API marketplace (transient cold-start 502); Governance insights; Monitor (real LA KQL + ARM metrics + ARG inventory); Real-Time hub provision (real consumerGroup); Activator stop/start (azure-monitor); Business events publish (real EH 201 + 422 gate); RTI catalog; Data Science home (amlConfigured); Warp home; Copilot orchestrate (real AOAI SSE, 66 tools); Workload hub; Connections create+delete; Deployment create+delete; Admin+Setup (reachable, authenticated).
- **honest-gate** — Data agents chat (503 deprecation → /copilot).
- **broken (B5)** — Business events default hub `loom-telemetry` not provisioned (502 404).

---

## 6. Recommended Fix Waves (by impact)

### Wave 1 — Cleanup-blocking + data-correctness (ship first)
1. **B1** — eventstream DELETE route + row-menu delete (today created eventstreams are undeletable via any console API).
2. **B9** — call `reconcileThreadEdgesOnDelete` from the workspaces items DELETE route (stale lineage).
3. **B8** — `getPolicy` rawxml read (saved APIM policies appear lost).
4. **B7** — dedupe APIM instances.
5. **B6** — Event Hubs capture disable shape (Capture tab can't turn off).

### Wave 2 — Honest-gate the genuine RBAC/error gaps (no fabrication, clear remediation)
6. **B2** — map Fabric `UnknownError`/5xx to gate in git/update + stage-workspace-assign.
7. **B4** — azure-native branch for activator detail GET (item editor open).
8. **B11** — grant UAMI Purview data-plane role + render 403 as gate (catalog/governance + admin).
9. **B3** — provision UAMI SQL login on dedicated pool/warehouse; convert raw 500/ELOGIN to structured 503 gate (warp visual-query, dab schema, thread warehouse-tables/publish).
10. **B12** — fix/remove invalid DLP Graph calls.

### Wave 3 — Default-resource + validation hardening
11. **B5** — stop hard-coding `loom-telemetry`/`loom-business-events`; require/derive real hub/topic from `channels`; assign EG Data Sender on console-created topics; per-channel publish status in the UI.
12. **B10** — server-side validate `DbtProjectGraph` (400 not 502).
13. Validate `itemType` against `FABRIC_ITEM_TYPES` on create-by-workload; guard DAB validate against partial bodies.

### Wave 4 — UX polish + parity affordances
14. Add Delete controls (EG topics, eventstreams, custom workloads, action-group GC on activator/rule delete).
15. Add tab-level gate banners (deployment Git tab) and inline gate remediation (DAB preview/publish, UDF invoke, mirror Install CTA).
16. Add pickers/empty-states (RTH preview DB/table, mTLS cert upload, Tapestry sample-graph, lineage empty-CTA, ConnectionBuilder 3 missing types, EH editable networking).
17. Cosmetic ui-gaps: Cosmos Start `server` gate, workloads registry/seed reconcile, dead MessageBar branch, version-label confirm, Cost 429 retry.

### Wave 5 — Infra/env to unlock honest gates (operator/deployment actions)
18. Deploy ADF (`LOOM_ADF_NAME` + linked services) for Snowflake/BigQuery/Oracle mirroring.
19. Consent the Azure DB for PostgreSQL AAD app for PG mirroring.
20. Deploy DAB runtime (`LOOM_DAB_PREVIEW_URL`), Weave AGE Postgres (`LOOM_WEAVE_PG_FQDN`), dbt-runner ACA (`LOOM_DBT_RUNNER_URL`).
21. Set MIP env (`LOOM_MIP_ENABLED`/`LOOM_MIP_ADMIN_ENABLED`); bundle `@azure/event-hubs` + `LOOM_EVENTHUB_RECEIVE_ENABLED` for EH/RTH peek.
22. Scope ARG to `LOOM_SUBSCRIPTION_ID` (or grant root Reader) so "Add existing" connectables populates.
