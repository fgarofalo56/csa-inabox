# CSA Loom — LIVE E2E Audit: Every Item Type & App

**Run:** 2026-06-16 03:04 UTC · **Target:** https://<your-console-hostname> (image `v0.6`)
**Subscription:** `<subscription-id>` · **RG:** `rg-csa-loom-admin-centralus` · **Workspace under test:** `<workspace-id>`
**Method:** Minted admin session cookie → real create + real primary action against live Azure/Cosmos/ADX/ADF/APIM/Databricks/Synapse backends, with independent ARM / Resource Graph / `az` verification where a green receipt was claimed. No-vaporware and no-fabric-dependency rules applied as the grading bar.

---

## 1. Executive Summary

**133 surfaces probed live.** Authoritative verdict tally across the full run:

| Verdict | Count | Share | Meaning |
|---|---:|---:|---|
| **works** | 83 | 62.4% | Real create + real primary action against a real backend, verified |
| **honest-gate** | 36 | 27.1% | Real backend reached; blocked by a precise, documented env/role/resource requirement (deploy-readiness, not a bug) |
| **broken** | 10 | 7.5% | Real backend reached but the primary action fails as-shipped (mis-wiring / wrong default / mis-classified error) |
| **vaporware** | 3 | 2.3% | Green success receipt over a **null effect** — must-fix integrity violations |
| **skipped-heavy** | 1 | 0.8% | Needs a new billed top-level account to fully exercise |
| **Total** | **133** | 100% | |

**Overall live grade: B / "production-grade with a known fix list."** Roughly 90% of surfaces are either fully working (62%) or honestly gated on a documented deployment action (27%). The integrity problem is small but sharp: **3 vaporware surfaces report success while doing nothing**, and **10 broken surfaces** fail their primary action on the live image. Encouragingly, the failures cluster into a **handful of shared root causes** (see §7) — fixing four config/code defects clears the majority of the broken+vaporware set.

**Coverage note:** the source results JSON handed to this report was truncated at the `plan` record (record 76 of 133). The **executive tally above is authoritative for all 133**. The detail tables in §2–§6 enumerate the **76 captured records** (all 3 vaporware, 6 of 10 broken, 18 of 36 honest-gate, ~49 works). The remaining 57 records (incl. 4 broken + 18 honest-gate + ~34 works) were not present in the supplied JSON and are marked as "(not captured in source extract)" where a count gap exists. Re-run the extract to backfill the per-row detail for those.

---

## 2. BROKEN + VAPORWARE — Must-Fix (deduped, grouped by root cause)

These are integrity / functionality defects on the live image. Grouped by shared root cause.

### Root cause A — `LOOM_FOUNDRY_NAME` points at an AOAI account, not a MachineLearningServices Hub/workspace

The live env sets `LOOM_FOUNDRY_NAME=aoai-csa-loom-centralus`, which is a **Microsoft.CognitiveServices/accounts** (Azure OpenAI) resource. The real ML workspace `aml-csa-loom-centralus` (kind=Default) exists in the same RG but is never targeted. Every ML-Foundry item that PUTs under `Microsoft.MachineLearningServices/workspaces/{LOOM_FOUNDRY_NAME}` 404s — and some routes **swallow the 404 into a fake success**.

| Item/App | Kind | Verdict | What failed live | Evidence |
|---|---|---|---|---|
| **ai-foundry-project** | item | vaporware | POST create → `200 {"ok":true,"project":{}}` but **no ARM resource persisted**. `createProject()` 404s on the AOAI-named hub, ARM returns empty body, route reports success. Confirmed: GET-by-id 404, re-list `[]`, `az resource list` shows only `aml-csa-loom-centralus`. | `POST /api/items/ai-foundry-project → 200 {"ok":true,"project":{}}`; GET `{name}` → 404; ARM has no `loom-e2e-proj-81421`. |
| **compute** | item | vaporware | POST create → `200 {"ok":true,"compute":{}}` null effect. ARM PUT 404s `ParentResourceNotFound` (workspace `aoai-csa-loom-centralus` doesn't exist as ML workspace); `readJson()` returns null on 404 **before** the `!res.ok` throw → `shapeCompute(null)={}` → `ok:true`. | `POST /api/items/compute → 200 {"ok":true,"compute":{}}`; ARM `…/computes?…` → `ParentResourceNotFound`; GET-by-name → 404. |
| **evaluation** | item | broken | POST create → real AML PromptFlow data-plane `404 "Workspace aml-csa-loom-centralus not found"`. Two defects: `LOOM_FOUNDRY_REGION` unset → data-plane defaults to **eastus2** while workspace is in **centralus**; plus the AOAI-named hub means the project picker is empty. GET-list returns `[]` only via 404-swallow. | `POST /api/items/evaluation → {"ok":false,"error":"… 404 … Workspace aml-csa-loom-centralus not found"}` (body shows `environment:eastus2`). |

### Root cause B — `LOOM_KUSTO_DEFAULT_DB=loomdb-default` does not exist on the live ADX cluster

The cluster `adx-csa-loom-z52x3p` only has the database `Real_Time_Ops_KQL_Database`. The env default `loomdb-default` is never provisioned, so any graph/query editor that relies on the default-DB fallback returns a raw Kusto `EntityNotFound 400` instead of data. **The query engines themselves are proven real** — supplying a valid DB returns real rows.

| Item/App | Kind | Verdict | What failed live | Evidence |
|---|---|---|---|---|
| **cypher-graph** | item | broken | Editor "Run" → `/api/items/kql-database/{id}/query` resolves to `loomdb-default` → `400 EntityNotFound`. With a valid DB override the make-graph/graph-match engine returns the real Alice→Bob→Carol cycle (rowCount 3). | default path `400 "Entity ID 'loomdb-default' … not found"`; valid-DB path `200` rows. |
| **geo-query** | item | broken | Same default-DB fallback. As-shipped `400 EntityNotFound`; with real DB returns real geospatial compute (km=331.33 NY→DC, h3/s2 tokens, 36ms). | default `400`; override `200 {km:331.33…,h3:…,s2:…}`. |

> Note: `gql-graph` (app) and `graph-model`/`kql-database`/`kql-queryset`/`dashboard` also surface the same `loomdb-default` mismatch, but each additionally has a legitimate gate or works once a real DB is supplied, so they are classified honest-gate/works (see §3/§4). **Fixing `LOOM_KUSTO_DEFAULT_DB` improves all of them.**

### Root cause C — ADF integration-runtime reference not resolvable in the live factory

| Item/App | Kind | Verdict | What failed live | Evidence |
|---|---|---|---|---|
| **dataflow** | item | broken | `/refresh` compiles the M, builds the ADLS sink, PUTs a real `ExecuteWranglingDataflow` pipeline to `adf-csa-loom-centralus` — ADF rejects it because `AutoResolveIntegrationRuntime` does not resolve in the factory. Honest `ok:false` 502 but a raw bubbled error, not a precise gate. CRUD lifecycle (create/get/save/delete) all work. | `POST …/dataflow/{id}/refresh → 502 "invalid reference 'autoresolveintegrationruntime'"`. |

### Root cause D — surface-specific logic bugs

| Item/App | Kind | Verdict | What failed live | Evidence |
|---|---|---|---|---|
| **automl** | item | vaporware | `submitAutoMlJob` does an ARM PUT then `readJson()` returns null on 404 and the code returns a **synthetic `{name,status:'NotStarted',taskType}`** fallback → route reports `ok:true`. Poll → 404 "job not found"; re-list → `[]`. Compounding: `/options` returns `clusters:[]` + `datastores:[]` (no AmlCompute) so the wizard can't pick a valid compute, yet submit still fabricates success. | `POST …/automl/submit → 200 {ok:true,job:{name:"loom-automl-…",status:"NotStarted"}}`; poll → 404; list → `[]`. |
| **graphql-api** | item | broken | `/publish` → `apim-client.upsertApi()` **hardcodes** `properties.format='graphql-link'` with `value=<inline SDL>`. APIM's `graphql-link` requires `value` to be an absolute URI it fetches, so every inline schema is rejected (`ValidationError`). Inline SDL → 400; a URI → APIM fetched it and returned 405. Query stays permanently 409-gated ("not published"). Correct impl: create API `apiType='graphql'` then PUT schema to `/schemas/{id}`. | `POST …/graphql-api/{id}/publish → 400 ValidationError "'link' property does not contain a valid absolute URI"`. |
| **materialized-lake-view** | item | broken | `/refresh` validates spec, writes lineage, uploads the PySpark driver to ADLS (passes), then submits a real Synapse Spark (Livy) batch to healthy pool `loompool` — Livy returns `400 ErrorSource:User` (most consistent with Spark vCore session/quota). Mis-classified: the engine only converts 401/403 to an honest gate; a 400 quota falls through to a generic 502 with **no remediation**. Surfaces the real error but unactionable. | `POST …/materialized-lake-view/{id}/refresh → 502 "Spark batch submit failed: … statusCode=[400] … ErrorSource:User"`. |

**Broken captured: 6 of 10.** The 4 remaining broken records were beyond the truncation point of the source JSON and are not enumerated here — re-run the extract to capture them.

---

## 3. Honest-Gate — Deploy-Readiness Items (not bugs)

Each reached a real backend and returned a precise, actionable gate. These become "works" once the named env var / role / resource is provisioned. **No code fix required** (a couple have cosmetic gate-message nits noted in §7).

| Item/App | Kind | HTTP | What to provision to clear the gate |
|---|---|---|---|
| ai-builder-model | item | 403 | Add Console UAMI SP (`41d32562…`) to "Service principals can use Power Platform APIs" allow group + register as Dataverse Application User (System Administrator). Requires a Dataverse-enabled Power Platform environment (none in this estate). |
| airflow-job | item | 503 | Set the Airflow webserver URL on the item (self-hosted Airflow); see `docs/fiab/v3-tenant-bootstrap.md`. Azure infra gate, not Fabric. |
| content-safety | item | 503 | Deploy Azure AI Content Safety (CognitiveServices), grant Console UAMI Cognitive Services User, set `LOOM_CONTENT_SAFETY_ENDPOINT`. |
| copilot-studio-action | item | 403 | Console UAMI SP → Power Platform API allow group + Dataverse Application User. |
| copilot-studio-agent | item | 403 / 424 | (a) Console SP → Power Platform admin / Dataverse app-user; (b) set `LOOM_COPILOT_DIRECTLINE_SECRET_*` for test chat. |
| copilot-studio-analytics | item | 403 | Console UAMI SP → Power Platform admin access. |
| copilot-studio-channel | item | 403 | Console UAMI SP → Power Platform API allow group + Application User (System Administrator). |
| copilot-studio-knowledge | item | 403 | Same Power Platform SP allow-group + Dataverse app-user grant. |
| copilot-studio-topic | item | 403 | Same Power Platform SP allow-group + Dataverse app-user grant. |
| cosmos-gremlin-graph | item | 503 | Provision a Cosmos Gremlin-API account; set `LOOM_COSMOS_GREMLIN_ENDPOINT` + grant UAMI Cosmos DB Built-in Data Contributor (or `LOOM_COSMOS_GREMLIN_KEY`). New top-level account. |
| dashboard | item | 200/400 | Provision/seed the ADX database (env/bicep name mismatch: `loomdb-default` vs `loomdb_workspace_monitor`); create path works today. |
| databricks-cluster | item | 403 | Grant Console UAMI the Databricks "Allow unrestricted cluster creation" entitlement (or cluster-create policy/ACL). Read paths already work. |
| databricks-sql-warehouse | item | 502 | Grant Console SP Databricks "Allow SQL endpoint creation" entitlement. Query/start/list already work; only **create** is gated. |
| dataverse-table | item | 503 | Set `LOOM_DATAVERSE_CLIENT_ID/_CLIENT_SECRET/_TENANT_ID` + register that SP as Dataverse Application User; plus the Power Platform allow-group grant for list. |
| gql-graph | app | 400 | Materialize a graph (creates `Node_*/Edge_*` tables) + fix `LOOM_KUSTO_DEFAULT_DB`. Create works. |
| logic-app | item | 409 | Set `LOOM_LOGIC_LOCATION` (or `LOOM_AZURE_LOCATION`) + grant Console UAMI Logic App Contributor + re-install to PUT the workflow. |
| ontology | item | 503 | Provision Weave PostgreSQL-flexible (Apache AGE): set `LOOM_WEAVE_PG_FQDN`, deploy `postgres-weave.bicep`, run `bootstrap-weave-pg.sh`. Azure-native, no Fabric. |
| operations-agent | item | 501 | Set `LOOM_FOUNDRY_PROJECT_ENDPOINT` (deploy `foundry-project.bicep`). |

**Honest-gate captured: 18 of 36.** The other 18 are past the source-JSON truncation point — re-run the extract to enumerate them.

---

## 4. Full Per-Item Results (captured records)

| Name | Verdict | Primary action (live) | Detail |
|---|---|---|---|
| adf-dataset | works | ARM upsertDataset → real dataset under `adf-csa-loom-centralus`; PUT edit changed etag | Real Cosmos-less ARM child; env-pinned factory. |
| adf-trigger | works | start/stop ScheduleTrigger → real ARM `runtimeState` change | Pre-attach start honestly returned ADF 400 (no pipeline refs). |
| ai-builder-model | honest-gate | list/predict/train → real BAP 403 | Power Platform allow-group + Dataverse app-user needed. |
| ai-foundry-project | **vaporware** | create → `200 {project:{}}` null effect | Root cause A. |
| ai-search-index | works | bind+create real index on `srch-csa-loom-centralus`; `/search` real data-plane | `@odata.count:0` genuine empty index. |
| aip-logic | works | `/invoke` → real gpt-4o "PONG", token usage 453/3/456 | Deploy-as-agent honest-gated in Gov. |
| airflow-job | honest-gate | `/dags` → 503 NO_WEBSERVER then real fetch on configure | Self-hosted Airflow infra gate. |
| apim-api | works | `/test-call` → live APIM gateway round-trip (real IIS headers) | Real ARM API+operation create. |
| apim-policy | works | PUT policy → real ARM write, APIM echoes XML | PUT-only (POST = 405 by design). |
| apim-product | works | list APIs/subscriptions, add-API → real ARM | Auto-created admin subscription observed. |
| automl | **vaporware** | submit → `200 {ok:true,job}` synthetic fallback; job never created | Root cause D; `/options` clusters/datastores empty. |
| azure-sql-database | works | `/query` TDS+AAD → real recordset from Synapse SQL endpoint | demo-sql-srv01 honest ELOGIN (MI not a SQL user there). |
| azure-sql-managed-instance | works | list → real ARM `managedInstances` (empty) | List-only client by design. |
| azure-sql-server | works | `/databases` → real ARM DB inventory (2 DBs on demo-sql-srv01) | Proved not a hardcoded `[]`. |
| compute | **vaporware** | create → `200 {compute:{}}` null effect | Root cause A + `readJson` 404-swallow. |
| content-safety | honest-gate | moderate text → 503 NotDeployed | Set `LOOM_CONTENT_SAFETY_ENDPOINT`. |
| copilot-studio-action | honest-gate | bind/list → real BAP 403 | Power Platform SP grant. |
| copilot-studio-agent | honest-gate | create 403 / directline-token 424 | PP admin grant + Direct Line secret. |
| copilot-studio-analytics | honest-gate | getAnalytics → real BAP 403 | Create (Cosmos) works; no DELETE route (405). |
| copilot-studio-channel | honest-gate | publish/list channels → real BAP 403 | PP allow-group + app-user. |
| copilot-studio-knowledge | honest-gate | create/list KB → real BAP 403 | PP allow-group + app-user. |
| copilot-studio-topic | honest-gate | create/list topics → real BAP 403 | PP allow-group + app-user. |
| copilot-template-library | works | Cosmos CRUD works; instantiate → real BAP 403 (honest) | Tenant-partitioned; no workspaceId. |
| copy-job | works | `/run` → real ADF runId; pipeline+datasets upserted | Copy failed downstream on ADLS RBAC (honest). |
| cosmos-db | works | `/keys` real ARM listKeys + `/metrics` real RU series | Env-pinned navigator account. |
| cosmos-gremlin-graph | honest-gate | `/query` → 503 (no Gremlin runtime) | New Cosmos Gremlin account needed. |
| cypher-graph | **broken** | editor Run → 400 `loomdb-default` not found | Root cause B; engine real on valid DB. |
| dashboard | honest-gate | tile-query → live ADX, 400 (DB not provisioned) | Create/save/delete work; ADX DB gap. |
| data-agent | works | `/chat` → real gpt-4o completion, token usage | Cosmos create + AOAI reuse. |
| data-pipeline | works | `/run` → real ADF run, confirmed Succeeded (10.5s) | Azure-native (ADF), no Fabric. |
| data-product | works | publish-as-API → real APIM callable URL + key | register-purview honest 422 (domain GUID). |
| data-product-instance | works | health check → real Cosmos read-back | Born via template instantiate. |
| data-product-template | works | instantiate → 4 real child items + parent | Two parent docs lack DELETE (405). |
| data-science | works | `/home` aggregator → real Cosmos + AML | Workload hub; notebooks default path real. |
| databricks-cluster | honest-gate | create → real Databricks 403 PERMISSION_DENIED | Read paths real; needs cluster-create entitlement. |
| databricks-job | works | run-now → real run_id; create/delete real | Run FAILED only on a deliberately-empty notebook path. |
| databricks-notebook | works | `/list` real workspace dirs; `/run` real Databricks 404 on fake cluster | Did not start cluster (cost). |
| databricks-sql-warehouse | honest-gate | `/query` WORKS (real rows); create → 403 entitlement | Only create gated. |
| dataflow | **broken** | `/refresh` → 502 invalid IR reference | Root cause C; CRUD works. |
| datamart | works | migrate → real Synapse Serverless DB + real AAS server (verified, cleaned) | Spun+deleted a billed AAS server. |
| dataverse-table | honest-gate | create 503 / list 403 | Dataverse SP + PP allow-group. |
| dbt-job | works | generate real dbt files; run → synapse 503 gate / databricks 400 validation | Run executor live; actual job skipped (cost). |
| environment | works | apply-to-pool → real Synapse Spark pool ARM mutation | Restored pool post-test. |
| evaluation | **broken** | create → real PromptFlow 404 (workspace not found) | Root cause A + `LOOM_FOUNDRY_REGION` unset. |
| event-schema-set | works | `/versions` real Avro BACKWARD enforcement (409 on break) | cosmos-inprocess; EH Schema Registry opt-in. |
| eventhouse | works | GET → real ADX cluster + DB + `.show diagnostics` | Binds existing shared ADX. |
| geo-dataset | works | Inspect → Synapse Serverless `SELECT 1` real rows (88ms) | Cosmos save round-trip persisted. |
| geo-map | works | Save → real Cosmos PATCH, GeoJSON round-trip | Azure Maps basemap optional gate. |
| geo-pipeline | works | `/run` → real ADF runId verified Succeeded via `az` | Geo params skipped (pipeline doesn't declare). |
| geo-query | **broken** | editor Execute → 400 `loomdb-default` | Root cause B; engine real on valid DB. |
| graph-model | works | materialize → real ADX `.create-merge` node+edge tables | Default-DB fallback fails until real DB supplied. |
| graphql-api | **broken** | publish → APIM 400 (inline SDL vs graphql-link URI) | Root cause D; create/persist real. |
| health-check | works | `/rule` → real Azure Monitor scheduledQueryRule, verified in Resource Graph | Azure-native default; no Fabric. |
| kql-dashboard | works | `/run` → real ADX rows (`[[9]]`, 37ms) | DELETE via workspace-items (405 on type route). |
| kql-database | works | `/query` → real ADX resultset on real DB | Bare item honestly 400s on default DB. |
| kql-queryset | works | `/run` real ADX rows + `.show schema` | `LOOM_KUSTO_DEFAULT_DB` mismatch noted. |
| lakehouse | works | `/query` → real Synapse Serverless TDS rows | Auto-provisioned paired warehouse item. |
| logic-app | honest-gate | `/run` → 409 (not backed by Microsoft.Logic) | Set `LOOM_LOGIC_LOCATION` + role + re-install. |
| materialized-lake-view | **broken** | `/refresh` → 502 Synapse Spark 400 (quota, mis-classified) | Root cause D; create works. |
| mirrored-database | works | start → real Azure-native mirror engine (ADLS Bronze + TDS attempt) | Errored honestly on unreachable test source. |
| mirrored-databricks | works | `/catalog` → real Unity Catalog (10 schemas, real Delta tables) | UAMI AAD round-trip to live Databricks. |
| ml-experiment | works | listJobs real ARM (empty); runs → honest MLflow gate | Submit/register not fired (compute cost). |
| ml-model | works | register → real ARM model-version on `aml-csa-loom-centralus` | Required real blob artifact (genuine AML precondition). |
| mounted-adf | works | `/run` → real cross-factory ADF createRun | Reference wrapper; detail GET real ARM list. |
| notebook | works | `/run` → real Synapse Livy session on `loompool` | Async Spark cold-start (not null effect). |
| ontology | honest-gate | objects/run-action → 503 weave_not_configured | Provision Weave PG (AGE). |
| ontology-sdk | works | generate → real TS+Python SDK + DAB config (objectCount 3) | publish honest 503 if APIM unset. |
| operations-agent | honest-gate | deploy → 501 missing `LOOM_FOUNDRY_PROJECT_ENDPOINT` | Create (Cosmos) real. |
| paginated-report | works | render → real Loom-native RDL render from stored Cosmos def | Data-bound render honest-gates on Synapse. |
| plan | works | PATCH save → real Cosmos round-trip | SQL writeback honest 503; Fabric-free. |

---

## 5. Full Per-App Results (captured records)

| Name | Verdict | Primary action (live) | Detail |
|---|---|---|---|
| activator | works | rule CRUD → real `microsoft.insights/scheduledQueryRule` (verified enabled in Resource Graph) | **Real bug:** item DELETE always calls Fabric REST → 401, ignoring the azure-monitor default (no-fabric-dependency violation on DELETE verb only). |
| adf-pipeline | works | `/run` → real ADF createRun (runId verified) | 4-hop create→upsert→bind→run, all real ids. |
| dataset (Foundry/AML data asset) | works | GET render → real AML data asset + version (azureml:// URI) | Scoped to real `aml-csa-loom-centralus`; AML can't delete data container (platform limit). |
| eventstream | works | `/provision` → real Event Hub + consumer group (verified Active via `az`) | Azure-native Event Hubs path; honest 422 when no source+sink. |
| gql-graph | honest-gate | `/query` → real ADX, 400 "materialize first" | Plus `loomdb-default` default-path 502. Create real. |
| map | works | PATCH → real Cosmos GeoJSON round-trip | One transient 405 on cold route, then 200. |

---

## 6. Skipped-Heavy (needs a new billed top-level account to fully test)

| Item/App | Why skipped | What a full test would require |
|---|---|---|
| cosmos-gremlin-graph (and any new-account gates) | The Gremlin query path requires provisioning a **brand-new Cosmos DB Gremlin-API account** (a heavy, billed top-level resource). Deliberately not spun. | Provision a Cosmos Gremlin account, set `LOOM_COSMOS_GREMLIN_ENDPOINT` + UAMI Cosmos DB Built-in Data Contributor, then re-run `/query`. |

> The full run recorded **1 skipped-heavy**. Several honest-gate items (ai-builder-model, dataverse-table, copilot-studio-*) also ultimately depend on a Dataverse-enabled Power Platform environment that is not provisioned in this FedCiv estate — those were classified honest-gate (real 403 reached) rather than skipped-heavy.

---

## 7. Recommended Fix Waves (ordered by impact)

### Wave 1 — Integrity fixes (stop reporting success over null effect) — **highest priority**
1. **Fix the AOAI-vs-ML-workspace wiring (clears ai-foundry-project, compute, evaluation).** Point the Foundry/AML clients at the real ML workspace `aml-csa-loom-centralus` (introduce/set `LOOM_AML_WORKSPACE`, stop reusing `LOOM_FOUNDRY_NAME=aoai-…` for `MachineLearningServices/workspaces` paths), and set `LOOM_FOUNDRY_REGION=centralus`.
2. **Make `readJson()` stop swallowing 404 on write verbs.** In `foundry-client.ts` (`createProject`, `createCompute`, `deleteCompute`) and `aml-automl-client.ts` (`submitAutoMlJob`), a non-2xx PUT must **throw**, never return a synthetic success object. This converts 3 vaporware receipts into honest errors/gates immediately, even before the env is fixed.
3. **automl:** when no AmlCompute cluster/datastore exists, surface an honest Fluent gate ("create an AmlCompute cluster") instead of empty dropdowns + fabricated submit.

### Wave 2 — One config change, many fixes: ADX default database
4. **Set `LOOM_KUSTO_DEFAULT_DB=Real_Time_Ops_KQL_Database`** on `loom-console` (or seed a `loomdb-default` DB on the cluster). This fixes **cypher-graph** and **geo-query** outright and removes the raw-400 papercut from gql-graph, graph-model, kql-database, kql-queryset, and dashboard. Also reconcile the env/bicep name mismatch (`loomdb-default` vs `loomdb_workspace_monitor`).

### Wave 3 — Surface-specific code bugs
5. **graphql-api publish:** change `apim-client.upsertApi()` to create the API with `apiType='graphql'` then PUT the SDL to the `/schemas/{id}` sub-resource (stop forcing `format='graphql-link'` with inline SDL).
6. **dataflow refresh:** ensure the live factory `adf-csa-loom-centralus` has a managed/AutoResolve IR, or have the run path provision/reference a Managed IR before issuing `ExecuteWranglingDataflow`.
7. **materialized-lake-view:** extend the engine's gate regex to also catch `400`/`quota`/`vcore`/`capacity` and emit a remediation naming the Synapse Spark vCore quota (turn the 502 into an honest gate).
8. **activator DELETE:** honor the `LOOM_ACTIVATOR_BACKEND` default (azure-monitor) on the item DELETE verb — currently always calls Fabric REST → 401 (no-fabric-dependency violation).

### Wave 4 — Deploy-readiness (provision env/roles; no code change)
9. Work the §3 honest-gate list as a deployment checklist. Two clusters dominate: **Power Platform / Dataverse** (Console UAMI SP → "Service principals can use Power Platform APIs" allow group + Dataverse Application User; unlocks all 6 copilot-studio-* + ai-builder-model + dataverse-table) and **Databricks workspace entitlements** (cluster-create + SQL-endpoint-create for the Console SP). Then the discrete ones: `LOOM_CONTENT_SAFETY_ENDPOINT`, `LOOM_WEAVE_PG_FQDN`, `LOOM_FOUNDRY_PROJECT_ENDPOINT`, `LOOM_LOGIC_LOCATION`, Cosmos Gremlin account.

### Wave 5 — Hygiene
10. Add working DELETE coverage for type-specific routes that currently shadow the generic `[type]/[id]` DELETE and return 405 (copilot-studio-analytics, data-product-template parents, kql-database/kql-dashboard/kql-queryset/eventhouse/paginated-report — delete must currently go via `/api/workspaces/{ws}/items/{id}`).

---

*Coverage caveat (repeated for the reader): §2–§6 detail tables enumerate the 76 records present in the supplied results extract. All 3 vaporware and all 1 skipped-heavy are captured; 6 of 10 broken and 18 of 36 honest-gate are captured. Re-run the source extract to backfill the 57 records (incl. 4 broken + 18 honest-gate + ~34 works) that fell past the JSON truncation point. The §1 tally is authoritative for the full 133.*
