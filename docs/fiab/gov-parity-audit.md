# Azure Government day-one parity audit — CSA Loom

> **Effective date:** 2026-07-10 · **Scope:** every Azure service CSA Loom
> consumes, its Azure Government (MAG — US Gov Virginia / US Gov Arizona; and
> GCC-High / DoD / IL5 where relevant) availability, the endpoint deltas, and
> whether the Loom codebase already handles the sovereign split.
> **Governing rules:** `.claude/rules/no-fabric-dependency.md`,
> `.claude/rules/no-vaporware.md`. **Related:** `docs/fiab/hyperscale.md`,
> `PRPs/active/bridge-services/PRP-bridge-services.md`.

## TL;DR — verdict

**Loom is close to day-one Gov parity, not there yet.** The heavy lifting is
already done: `apps/fiab-console/lib/azure/cloud-endpoints.ts` is a
single-source-of-truth (SSOT) endpoint resolver that parameterizes every
sovereign-divergent host/suffix/audience with Microsoft Learn citations, the
MSAL sign-in authority switches per boundary
(`lib/auth/msal.ts` → `login.microsoftonline.us`), and the bicep is driven by a
single `boundary` param (`Commercial | GCC | GCC-High | IL5`) with ~50
`environment()` call sites. The app/api layer is clean — every
`api.fabric.microsoft.com` / `api.powerbi.com` reference in `app/api/**` is a
comment asserting the default path does **not** call it.

What is **not** done:

1. **Databricks Unity Catalog does not exist in Azure Government** (verified,
   below). Loom's UC-based governance/lakehouse-grant path has no Gov backend.
   This is the single largest gap and the reason for the parallel **loom-unity**
   OSS Unity Catalog service.
2. **A provision-time break**: `ai-search.bicep`'s index-creation
   deploymentScript hardcodes the Commercial search suffix **and** the
   Commercial token audience — it fails in Gov.
3. **Service-availability gaps** where MAG simply lacks a service Loom uses:
   **Azure Digital Twins** (Digital Twin Builder editor + `adt-instance.bicep`),
   **Microsoft Fabric / OneLake** (already opt-in, correct), and **AI Foundry
   Agent Service** project endpoints.
4. **Feature deltas inside available services**: Azure OpenAI model catalog is
   thinner in Gov, Microsoft Purview is classic-Data-Map-only, AI Search
   semantic ranker is absent in US Gov Texas, Power BI Gov has SKU limits.

Fix list `GOV-1 … GOV-12` with acceptance criteria is at the bottom.

---

## Method & grounding

- **Availability** was grounded in Microsoft Learn (`microsoft_docs_search` /
  `microsoft_docs_fetch`) plus the "Azure products by region" MAG matrix and the
  Databricks `feature-region-support` page — current as of July 2026, not from
  memory. Citations are inline per row.
- **Endpoint coverage** was audited by grepping `apps/fiab-console/lib` and
  `apps/fiab-console/app/api` for Commercial literals that diverge in Gov
  (`management.azure.com`, `*.windows.net`, `search.windows.net`,
  `documents.azure.com`, `openai.azure.com`, `dev.azuresynapse.net`,
  `kusto.windows.net`, `api.powerbi.com`, `login.microsoftonline.com`, …) and
  classifying each hit as **handled** (an `isGovCloud()` / `environment()`
  ternary or a helper call), **inert** (comment/test/example), or a **real
  break**.
- **Bicep** was audited for `environment()` usage vs string-literal suffixes and
  for the `boundary` discriminator threading.

---

## Per-service availability & coverage

Legend — Loom coverage: ✅ handled (cloud-aware today) · ⚠️ handled but with a
Gov feature delta / honest-gate · ❌ Gov-breaking or unavailable, needs work.

| Service | GA in MAG? (cited) | Endpoint delta (Commercial → Gov) | Loom coverage | Remediation |
|---|---|---|---|---|
| **Azure Databricks** | **Partial — classic workspace only.** No Unity Catalog, no Databricks SQL, no serverless (compute/SQL warehouses/workspaces), no model serving, no AI functions. UC+DBSQL announced for 2026 at FedRAMP-High/IL5 but **not yet in the feature matrix**. [Learn](https://learn.microsoft.com/azure/databricks/resources/feature-region-support) | control plane `adb-*.azuredatabricks.net`; PE `privatelink.databricks.azure.us`; account host `accounts.azuredatabricks.us` | ❌ | **GOV-2** — route Gov to **loom-unity** (OSS Unity Catalog) + classic clusters/hive metastore; keep UC path Commercial/GCC-only. Host suffixes already handled: `pe-subresource-groups.ts:154`, `main.bicep:937`. |
| **Azure OpenAI** | **Yes.** [Learn](https://learn.microsoft.com/azure/ai-foundry/openai/azure-government) | `*.openai.azure.us`; AAD scope `cognitiveservices.azure.us` | ⚠️ | Endpoint handled (`getOpenAiSuffix()`, `cogScope()`, `ai-foundry.bicep` aoaiInferenceEndpoint ternary). **GOV-6** — model-catalog delta: no gpt-4.1-nano, no image/audio/Sora/realtime; **embeddings-3 only in US Gov Arizona, not Virginia**. Gate model pickers per region. |
| **Azure Synapse** (dedicated + serverless SQL, Spark) | **Yes.** [Learn](https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure) | `*.sql.azuresynapse.usgovcloudapi.net`, `*.dev.azuresynapse.usgovcloudapi.net` | ✅ | `synapseSqlSuffix()`, `synapseSqlJdbcHostCert()`. Note: Synapse→Purview lineage unsupported in Gov (delta, not a break). |
| **Azure Data Explorer / Kusto** | **Yes.** [Learn](https://learn.microsoft.com/azure/data-explorer/) | `*.kusto.usgovcloudapi.net`; Monitor-ADX proxy `adx.monitor.azure.us` | ⚠️ | `kustoSuffix()` ✅. **GOV-4** — `kusto-client.ts:150` `laProxyClusterUri()` only tests `AZURE_CLOUD==='AzureUSGovernment'`, so **DoD falls back to the Commercial proxy host**. Use `isGovCloud()`. |
| **Event Hubs** | **Yes.** [Learn](https://learn.microsoft.com/azure/private-link/private-endpoint-dns) | `*.servicebus.usgovcloudapi.net` | ✅ | `serviceBusSuffix()`. |
| **Stream Analytics** | **Yes.** [Learn](https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure) | ARM `usgovcloudapi.net` | ✅ | ARM-plane via `armBase()`. |
| **Azure Data Factory** | **Yes.** [Learn](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap) | Studio `adf.azure.us`; PE `privatelink.adf.azure.us` | ✅ | `adfStudioBase()`. Some connectors lag Commercial (delta). |
| **Cosmos DB (NoSQL)** | **Yes.** [Learn](https://learn.microsoft.com/azure/cosmos-db/) | `*.documents.azure.us` | ✅ | `cosmosSuffix()`, `cosmosEndpointFromName()`. |
| **Cosmos DB Gremlin (graph)** | **Unconfirmed in Gov** — core Cosmos GA, Gremlin-specific Gov availability not documented. | `gremlin.cosmos.azure.us` | ⚠️ | `gremlinSuffix()` handles the suffix; **GOV-9** — verify Gremlin API in US Gov before relying on `cosmos-gremlin-graph`; the editor already honest-gates on `LOOM_COSMOS_GREMLIN_ENDPOINT`. |
| **ADLS Gen2 / Storage** | **Yes.** [Learn](https://learn.microsoft.com/azure/private-link/private-endpoint-dns) | `*.dfs/blob/file.core.usgovcloudapi.net` | ✅ | `dfsSuffix()`, `getBlobSuffix()`, `getFileSuffix()`, `httpsToAbfss()`. |
| **Key Vault** | **Yes** (incl. Managed HSM). [Learn](https://learn.microsoft.com/azure/key-vault/general/about-keys-secrets-certificates) | `*.vault.usgovcloudapi.net` | ✅ | `kvSuffix()`, `kvScope()`. |
| **Container Apps** (Loom's substrate) | **UNCONFIRMED — not on the published Gov GA roadmap; no official Learn confirmation of ACA GA in a US Gov region as of 2026.** Dynamic sessions & serverless GPU are Commercial-only. [Learn](https://learn.microsoft.com/azure/container-apps/) | ingress suffix likely `*.azurecontainerapps.us` (unverified) | ❌ (blocker if absent) | **GOV-3** — this is the substrate the entire product runs on; confirm ACA GA + region + ingress suffix before any Gov deploy. If ACA is not GA in the target Gov region, the whole app tier needs an AKS fallback (bicep already has AKS modules). |
| **Front Door** | **Yes — Standard/Premium/Classic all GA in Gov** (corrects the "historically limited" prior). [Learn](https://learn.microsoft.com/azure/frontdoor/front-door-overview) | `*.azurefd.net` (global) | ✅ | `front-door.bicep`. |
| **Container Registry** | **Yes** (IL6). [Learn](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap) | `*.azurecr.us` | ⚠️ | **GOV-5** — confirm image push/pull uses the `.azurecr.us` login server in Gov params; `gh-runner-job.bicep` examples show `.azurecr.io` (comment only). |
| **Monitor / Log Analytics** | **Yes.** [Learn](https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure) | query `api.loganalytics.us`; ingestion `monitor.azure.us` | ✅ | `getLogAnalyticsHost()`, `logAnalyticsTokenScope()`, `monitorIngestionScope()`. |
| **AI Search** | **Yes.** [Learn](https://learn.microsoft.com/azure/search/search-region-support) | `*.search.usgovcloudapi.net`; AAD audience `search.azure.us` | ❌ (provision) / ✅ (runtime) | Runtime handled (`searchSuffix()`, `searchAadScope()`). **GOV-1** — `ai-search.bicep:250,255,289` deploymentScript hardcodes `search.windows.net` + audience `search.azure.com` → index creation fails in Gov. Delta: semantic ranker/agentic retrieval absent in **US Gov Texas**. |
| **Azure Machine Learning** | **Yes.** [Learn](https://learn.microsoft.com/azure/machine-learning/reference-machine-learning-cloud-parity) | `*.api.ml.azure.us` | ⚠️ | `amlDataPlaneHost()`, `resolve-aml-target.ts:152`, `aml-client.ts:512/517`. Delta: newer model-catalog / prompt-flow / Foundry features lag Commercial. |
| **Microsoft Purview** | **Partial — classic Data Map only (US Gov Virginia).** No sensitivity labeling, no Power BI scanning, no data sharing, no managed attributes, no Synapse lineage. [Learn](https://learn.microsoft.com/purview/legacy/classic-feature-availability) | `*.purview.azure.us` | ⚠️ | **GOV-7** — gate the labeling/DLP-authoring/data-sharing Purview surfaces in Gov to honest MessageBars; classic scan/register/classify works. DLP policy authoring already gated: `graphDlpPolicyApiAvailable()` returns false in Gov. |
| **Azure Maps** | **Yes — now GA at FedRAMP-High/IL5** (corrects "not in Gov" prior). [Learn](https://learn.microsoft.com/azure/azure-maps/how-to-use-services-module#azure-government-cloud-support) | REST/SDK domain `atlas.azure.us` (`atlas.setDomain`) | ⚠️ | **GOV-8** — confirm `azure-maps.bicep` + the map component set the `atlas.azure.us` domain in Gov (Maps already env-gated via `LOOM_MAPS_BACKEND`). |
| **Power BI** | **Yes — Power BI Gov cloud.** [Learn](https://learn.microsoft.com/fabric/enterprise/powerbi/service-government-us-overview) | REST `api.powerbigov.us`; app `app.powerbigov.us` / `app.mil.powerbigov.us`; XMLA scopes split 4-way | ✅ (opt-in) | `getPbiGovHost()`, `getPbiScope()`, `getPbiEmbedHostname()`, `pbiRestScope()`. Power BI is **opt-in**; Loom-native report/semantic-model is the default (no PBI needed). Delta: GCC has no F/embedded SKUs. |
| **Microsoft Fabric / OneLake** | **NO — no sovereign Gov endpoint.** [Learn](https://learn.microsoft.com/fabric/enterprise/powerbi/service-government-us-overview) | — | ✅ (opt-in, gated) | `assertFabricFamilyAvailable()` throws an honest error in GCC-High/DoD naming the Azure-native equivalent. Correct per `no-fabric-dependency.md`. |
| **Cache for Redis** | **Yes** (IL6). [Learn](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap) | `*.redis.cache.usgovcloudapi.net` | ✅ | `redis-cache-client.ts` (via env/PE). |
| **Analysis Services** | **Yes.** [Learn](https://learn.microsoft.com/azure/analysis-services/) | `asazure.usgovcloudapi.net` | ⚠️ | `aasSuffix()` handles Gov suffix; **but** `aasScope(serverUri)` **throws in Gov by design** — AAS-backed semantic model routes to loom-native there. Comments at `cloud-endpoints.ts:1063` say "AAS not in Gov"; the suffix helper still returns a Gov value. Reconcile: prefer loom-native semantic backend in Gov (already the default). |
| **API Management** | **Yes** (IL6). [Learn](https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure) | `*.azure-api.us` | ✅ | ARM-plane; delta: no AAD B2C in Gov. |
| **Logic Apps** | **Yes** (IL6). [Learn](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap) | ARM `usgovcloudapi.net` | ✅ | Used for Activator-alternative (`monitor-client`). |
| **Event Grid** | **Yes.** [Learn](https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure) | `*.eventgrid.azure.us` | ✅ | `eventgrid-client.ts` (via ARM/PE). |
| **Batch** | **Yes.** [Learn](https://learn.microsoft.com/azure/private-link/availability) | `*.batch.usgovcloudapi.net` (data-plane audience) | ✅ | `batchScope()`. |
| **Azure Digital Twins** | **NO Gov region documented — treat as unavailable.** [Learn](https://learn.microsoft.com/azure/digital-twins/) | — | ❌ | **GOV-10** — `digital-twin-builder-editor.tsx` + `adt-instance.bicep` have no Gov backend. Honest-gate the editor in Gov and offer the ADX-graph (`make-graph`) / Cosmos-Gremlin substitute per `no-fabric-dependency` style. |
| **AI Foundry Agent Service** | **Verify — project endpoint host.** | `projectEndpoint` uses `services.ai.azure.com` (`ai-foundry.bicep:409`), no `.azure.us` branch | ⚠️ | **GOV-11** — confirm the Gov Foundry project host and add the sovereign branch, or honest-gate Foundry Agent in Gov (AOAI inference itself is already Gov-aware). |
| **Microsoft Graph** | **Yes — national clouds.** [Learn](https://learn.microsoft.com/graph/deployments) | `graph.microsoft.us` (L4), `dod-graph.microsoft.us` (L5) | ✅ | `getGraphHost()` (3-way split incl. DoD). |
| **Entra sign-in (MSAL)** | **Yes.** [Learn](https://learn.microsoft.com/graph/deployments) | authority `login.microsoftonline.us` | ✅ | `lib/auth/msal.ts` `authorityHost()`. |

---

## Endpoint-coverage audit — `cloud-endpoints.ts` is the SSOT

The grep sweep over `apps/fiab-console/lib/**` and `app/api/**` found **no
unhandled runtime break**: every Commercial literal on a live data path is
either an `isGovCloud()` / `environment()` ternary or a `cloud-endpoints.ts`
helper call. Representative confirmations:

- `aml-client.ts:512,517`, `resolve-aml-target.ts:152`, `pe-subresource-groups.ts:154`
  — all `isGovCloud() ? gov : commercial` ternaries. ✅
- `copilot-orchestrator.ts:217` — a **guard** that warns when
  `LOOM_AOAI_ENDPOINT` points at a Commercial host; not a break. ✅
- `kusto-client.ts:150` `laProxyClusterUri()` — handles Gov but **misses DoD**
  (see **GOV-4**). ⚠️
- All `api.powerbi.com` / `api.fabric.microsoft.com` strings in `app/api/**` are
  **comments** documenting that the default path does not call them. ✅

The one class of real breaks lives in **bicep deployment scripts** (provision
time), which run PowerShell/CLI against literal hosts rather than through the
TypeScript SSOT — see GOV-1.

### Suffixes the SSOT already parameterizes (verified in `cloud-endpoints.ts`)

ARM, Key Vault, Service Bus/Event Hubs, ADLS DFS/Blob/File, ADX/Kusto, AI Search
(host + audience), Batch (audience), Cosmos (NoSQL + Gremlin), AML data-plane,
Cognitive/AOAI scope, Graph (3-way), Log Analytics (host + query audience +
ingestion audience), Analysis Services (suffix + scope, with an explicit Gov
throw), Power BI (REST host, embed host, XMLA scope — all 4-way), Synapse SQL
(suffix + JDBC cert host), ADF Studio. Each carries a Learn-cited per-cloud
truth table in-file.

---

## Bicep cloud-awareness

- **Single discriminator.** `platform/fiab/bicep/main.bicep:20` +
  `modules/admin-plane/main.bicep:10` — `@allowed(['Commercial','GCC','GCC-High','IL5']) param boundary`,
  plus a `loomAzureCloud` two-value override. One param flips the estate.
- **~50 `environment()` call sites** resolve storage/ARM suffixes correctly per
  cloud. Boundary ternaries handle the rest (`main.bicep:922` gremlin,
  `:928` postgres, `:937` databricks account host, `:961` kusto, `:1204`
  effective ARM endpoint).
- **Real bicep break (GOV-1):** `modules/admin-plane/ai-search.bicep:250,255,289`
  — the `Microsoft.Resources/deploymentScripts` that PUTs the
  `loom-governance-items` index hardcodes `https://${search.name}.search.windows.net`
  and requests a token for `resource=https://search.azure.com/`. Both are
  Commercial-only; in Gov the index creation 401s / resolves the wrong host.
- **Candidate (GOV-11):** `modules/admin-plane/ai-foundry.bicep:409`
  `projectEndpoint` hardcodes `services.ai.azure.com` with no `.azure.us` branch
  (the sibling `aoaiInferenceEndpoint` output at `:405` *is* boundary-aware).
- Inert: the many `.database.windows.net` / `asazure.windows.net` /
  `.azurecr.io` hits in bicep are `@description` help text, comments, or
  operator-supplied full-FQDN params — not live literals.

---

## Gov substitutions (per `no-fabric-dependency` style)

Where MAG lacks a service, Loom must fall through to an Azure-native/OSS
equivalent **by default** (never gate as "unavailable"):

| Missing/limited in Gov | Loom substitution | Status |
|---|---|---|
| **Databricks Unity Catalog** (governance + lakehouse grants) | **loom-unity** — OSS Unity Catalog server on ACA (being built in parallel), reconciling ADLS POSIX ACLs + Synapse GRANTs + ADX RLS; classic Databricks + hive metastore for compute | **GOV-2** (in flight) |
| **Databricks serverless / DBSQL** | Synapse serverless SQL + Spark pools; classic Databricks clusters | Synapse path already default |
| **Microsoft Fabric / OneLake / Direct Lake** | ADLS Gen2 + Delta lakehouse, ADX for KQL, Event Hubs eventstream, Azure Monitor scheduled-query for Activator | ✅ default (Fabric opt-in, `assertFabricFamilyAvailable()` gates Gov) |
| **Power BI (when unlicensed)** | Loom-native report renderer + loom-native semantic layer over Synapse/ADLS; Power BI Gov (`api.powerbigov.us`) is the opt-in path | ✅ default |
| **AAS (semantic model)** in Gov | Loom-native tabular backend (`LOOM_SEMANTIC_BACKEND=loom-native`, default) — `aasScope()` throws in Gov to force the fallback | ✅ default |
| **Azure OpenAI model deltas** | Pin to Gov-available models (gpt-4o / o-series / embeddings per region); gate pickers | **GOV-6** |
| **Azure Digital Twins** | Loom-native twin graph over **ADX `make-graph`** or **Cosmos Gremlin**; honest-gate the ADT editor in Gov | **GOV-10** |
| **Purview labeling / PBI-scan / data-sharing** | Loom-native classification catalog + classic Data Map scan; honest-gate the label-authoring surfaces in Gov | **GOV-7** |

---

## Prioritized fix list

Each item is docs-tracked here; implementation lands under the GOV-PARITY task
(#47) and the loom-unity build.

- **GOV-1 (P0, provision break).** Make `ai-search.bicep`'s index deploymentScript
  cloud-aware. **Accept:** the script derives the search host from the Gov suffix
  (`search.usgovcloudapi.net`) and requests the `search.azure.us` audience when
  `boundary` is GCC-High/IL5; a Gov provision creates `loom-governance-items`
  with a real 201/204 receipt.
- **GOV-2 (P0, substitution).** Ship **loom-unity** and route Gov's lakehouse
  governance/grants through it (no UC dependency). **Accept:** with
  `boundary=GCC-High` and no Databricks UC, catalog registration + grant
  reconcile succeed against loom-unity + ADLS ACLs; UC path stays Commercial/GCC
  opt-in. Cross-ref `PRPs/active/bridge-services/PRP-bridge-services.md`
  (loom-onesecurity policy compiler).
- **GOV-3 (P0, substrate).** Verify Azure Container Apps GA + ingress FQDN suffix
  in the target Gov region and wire self-referential app URLs / Front Door origin
  to the `.us` host. **Accept:** a Gov what-if shows the Container Apps Env +
  apps resolving; the Console reaches itself over the Gov ingress host.
- **GOV-4 (P1).** `kusto-client.ts:150` `laProxyClusterUri()` — replace
  `AZURE_CLOUD==='AzureUSGovernment'` with `isGovCloud()` so DoD gets
  `adx.monitor.azure.us`. **Accept:** unit test asserts DoD → `.azure.us`.
- **GOV-5 (P1).** Confirm ACR login server is `*.azurecr.us` in Gov params and
  the two-phase image build/push targets it. **Accept:** Gov `az acr build`
  pushes to `.azurecr.us` and the apps pull it.
- **GOV-6 (P1).** Gov AOAI model-catalog gate: pin/deploy only Gov-available
  models; **embeddings-3 only in US Gov Arizona**. **Accept:** model pickers +
  bicep model deployments in Gov offer only GA models; Virginia hides
  embeddings-3.
- **GOV-7 (P1).** Honest-gate the Purview labeling / PBI-scan / data-sharing /
  managed-attribute surfaces in Gov (classic scan/register/classify stays live).
  **Accept:** those tabs render a MessageBar naming the Gov limitation; scan runs.
- **GOV-8 (P2).** Confirm Azure Maps uses `atlas.azure.us` domain + Gov auth in
  the map component and `azure-maps.bicep`. **Accept:** map tiles render in Gov.
- **GOV-9 (P2).** Verify Cosmos Gremlin API availability in US Gov; if absent,
  keep the graph editor honest-gated and prefer ADX graph. **Accept:** documented
  verification + gate.
- **GOV-10 (P2, substitution).** Digital Twin Builder — honest-gate in Gov and
  offer the ADX/Gremlin twin-graph substitute. **Accept:** ADT editor in Gov
  shows the substitute path, not a broken ARM call.
- **GOV-11 (P2).** AI Foundry `projectEndpoint` — add the Gov host branch or
  honest-gate Foundry Agent Service in Gov. **Accept:** Foundry project wiring in
  Gov resolves a valid host or gates cleanly.
- **GOV-12 (P3, verification).** Reconcile the `aasSuffix()` Gov value vs the
  in-file "AAS not in Gov" comments — the loom-native default already covers it,
  but the helper should not imply a reachable Gov AAS host. **Accept:** doc/test
  note that AAS-in-Gov always routes to loom-native.

### Acceptance for "day-one Gov parity" (overall)

A `boundary=GCC-High` from-scratch deploy (per `no-vaporware.md`'s two-phase
image path) reaches a working Loom, and **every catalog editor either executes
its primary action against the Gov Azure backend or shows a documented honest
MessageBar gate** — with zero Commercial-host calls and zero UC/Fabric hard
dependency. That is the recurring teardown-validation bar, run in a clean Gov
sub.
