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
3. **A substrate blocker**: **Azure Container Apps — the host the entire
   product runs on — is not documented as GA in any US Gov region** (absent from
   the Gov GA roadmap; no `azurecontainerapps.us` suffix). If unconfirmed on the
   live Products-by-region matrix, the Gov app tier must swap to a Gov-GA host
   (AKS or App Service Environment v3, both Gov-listed). This is GOV-3 and is
   potentially the biggest day-one obstacle after Unity Catalog.
4. **Service-availability gaps** where MAG simply lacks a service Loom uses:
   **Azure Digital Twins** (Digital Twin Builder editor + `adt-instance.bicep`),
   **Microsoft Fabric / OneLake** (already opt-in, correct), and **AI Foundry
   Agent Service** project endpoints.
5. **Feature deltas inside available services**: Azure OpenAI model catalog is
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
| **AI Search** | **Yes.** [Learn](https://learn.microsoft.com/azure/search/search-region-support) | `*.search.usgovcloudapi.net`; AAD audience `search.azure.us` | ✅ FIXED (#1866) | Runtime handled (`searchSuffix()`, `searchAadScope()`). **GOV-1 — FIXED in PR #1866**: `ai-search.bicep` deploymentScript now derives suffix + audience from the sovereign discriminator. Delta: semantic ranker/agentic retrieval absent in **US Gov Texas**. |
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
| **AI Foundry Agent Service** | **Verify — project endpoint host.** | `projectEndpoint` uses `services.ai.azure.com` (`ai-foundry.bicep:409`), no `.azure.us` branch | ✅ FIXED (#1866) | **GOV-11 — FIXED in PR #1866**: `projectEndpoint` outputs now branch to `services.ai.azure.us` in Gov (`ai-foundry.bicep`, `foundry-project.bicep`). Was: confirm the Gov Foundry project host (AOAI inference itself is already Gov-aware). |
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
- **GOV-3 (P0, substrate — likely hard blocker).** Azure Container Apps is the
  substrate the entire product runs on, and it is **not documented as GA in any
  US Gov region.** It is absent from the Azure Government Product GA Roadmap
  (which *does* list Container Instances + Container Registry as GA); no ACA
  feature/region doc lists a Gov row (unlike App Service Environment, which
  explicitly enumerates US Gov Arizona/Texas/Virginia + US DoD); Private Link for
  ACA is "All public regions" (not "All Government regions" as ACR/AKS say); and
  there is no documented `azurecontainerapps.us` Gov ingress suffix. The last
  concrete public signal (MS Q&A #1655402, Apr 2024) said ACA was not yet
  available in Azure US Government. **Action:** confirm on the live
  Products-by-region matrix (`regions=usgov-virginia,usgov-arizona`) / an actual
  Gov subscription's region picker. If ACA is not GA in the target Gov region,
  the app tier needs a substrate swap to a **Gov-GA host** — **AKS** (GA in Gov,
  all IL levels; bicep already has `aks-arm-client.ts` + AKS modules) or **App
  Service Environment v3 / Web App for Containers** (GA in Gov). **Accept:** a
  documented Products-by-region confirmation of ACA in the target region **or** a
  chosen AKS/ASEv3 fallback path wired for the Gov app tier, with the Console
  reaching itself over the Gov host.
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

## Live deploy deltas (verified in tenant)

A real `az deployment sub create -f platform/fiab/bicep/main.bicep -p
params/gcc-high.bicepparam` into **US Gov Virginia** (2026-07-10) surfaced five
sub-deployment failures that only appear against a live Gov control plane (the
rest of the estate deployed cleanly, and the deployment is idempotent). Each is
fixed boundary-aware — **Commercial output is unchanged for #1, #2, #5 and
improved-only (a latent from-scratch bug fixed in both clouds) for #3, #4.**

| # | Module | Live Gov error | Fix | Commercial impact |
|---|--------|----------------|-----|-------------------|
| 1 | `admin-plane/network.bicep` (`diag-loom-stdz` on the hub VNet) | `Category 'VMProtectionAlerts' is not supported` | `vnetDiagLogs` var: Commercial/GCC keep `category:'VMProtectionAlerts'`; GCC-High/IL5 use `categoryGroup:'allLogs'` (the same idiom `diagFw` already uses). | Byte-identical (Gov-only branch). |
| 2 | `admin-plane/adx-cluster.bicep` SKU (default from `admin-plane/main.bicep` `adxSkuName`) | `Standard_E2a_v4 is not supported in usgovvirginia` | `effectiveAdxSkuName` in `main.bicep`: when a Gov boundary is left on the E2a_v4 Dev default, substitute the LIVE-verified Gov Dev SKU `Dev(No SLA)_Standard_D11_v2` (tier-preserving 1:1 swap — Basic tier, 1 node). Added `Standard_E2ads_v5`/`Standard_E4ads_v5` (LIVE-verified Gov) to the module `@allowed` list for operators wanting a Gov production tier. | Byte-identical (Gov-only branch; explicit SKUs pass through). |
| 3 | `admin-plane/audit-stream.bicep` DCR (`dcr-loom-audit-<region>`) | `Types of transform output columns do not match ... TenantId [produced:'String', output:'Guid']` | `TenantId` is a RESERVED Log Analytics column typed `guid`; the pass-through `transformKql:'source'` emitted it as string. Cast it: `source | extend TenantId = toguid(TenantId)`. | Improved-only — same latent mismatch fixed in Commercial. |
| 4 | `admin-plane/monitoring-default-alerts.bicep` (3 `scheduledQueryRules`) | `failed to resolve table or column expression ... ContainerAppConsoleLogs_CL` | The `ContainerAppConsoleLogs_CL` / `ContainerAppSystemLogs_CL` tables are created by the Container Apps diagnostic pipeline only after the Console first logs, so a fresh LAW lacks them and Gov validates the KQL at create time. Set `skipQueryValidation:true` on all three rules (purpose-built for alerts over not-yet-existent tables; the rule evaluates correctly once the table materializes). Pre-creating the `_CL` tables was rejected — their schema/lifecycle is owned by the platform. | Improved-only — same latent from-scratch failure fixed in Commercial. |
| 5 | `admin-plane/swa-publish-rbac.bicep` (Website Contributor role assignment) | `RoleDefinitionDoesNotExist: de139f84175647ae9be6808fbbe706ee` | Website Contributor does not resolve in Azure Government. Module is now boundary-aware: Commercial/GCC keep Website Contributor (`de139f84-1756-47ae-9be6-808fbbe706ee`), GCC-High/IL5 fall back to Contributor (`b24988ac-6180-42a0-ab88-20f7382dd24c`) — the narrowest built-in available in Gov covering `Microsoft.Web/staticSites` write + listSecrets. `boundary` threaded from `main.bicep`. | Byte-identical (Gov-only branch; same role, same assignment GUID). |

### Round 4 (2026-07-10, usgovvirginia)

A follow-up `az deployment sub create -f platform/fiab/bicep/main.bicep -p
params/gcc-high.bicepparam` into **US Gov Virginia** (after rounds 1–2 landed as
#1879/#1883) surfaced five newly-unmasked sub-deployment failures. Each is fixed
boundary-aware; **Commercial output is unchanged for all five** (params-only or a
Gov-only branch that leaves the Commercial value identical).

| # | Module | Live Gov error | Fix | Commercial impact |
|---|--------|----------------|-----|-------------------|
| 1 | `container-platform` (AKS preflight, from `params/gcc-high.bicepparam` + `il5.bicepparam` `containerPlatform='aks'`) | `Feature Microsoft.ContainerService/EnableAPIServerVnetIntegrationPreview is not enabled` | Flip both Gov params `containerPlatform` `'aks'→'containerApps'`. **Microsoft.App (Azure Container Apps) is LIVE-verified GA in US Gov Virginia/Arizona/Texas** (both params deploy to usgovvirginia) — see GOV-3; the prior "Container Apps not at IL4+" assumption is superseded. The AKS module is left intact (flip back + register the preview feature to use it). IL5 accreditation note: confirm the ACA IL5 authorization scope for that boundary. | Byte-identical (Commercial param `containerApps` unchanged; AKS code untouched). |
| 2 | `agent-foundry` (`modules/ai/foundry-project.bicep` AOAI deployments, via `admin-plane/main.bicep` `agentFoundry`) | `The specified SKU 'GlobalStandard' of account deployment is not supported by the model 'gpt-4o' version: '2024-11-20'` | `agentFoundry` invocation now passes `chatModelSkuName`/`embedModelSkuName`/`completionModelSkuName` = `(GCC-High\|IL5) ? 'Standard' : 'GlobalStandard'`. Per Learn, "Global standard deployments won't be available in government clouds"; `gpt-4o 2024-11-20` (chat) and `text-embedding-ada-002 v2` (embed) are both **Standard**-available in usgovvirginia/usgovarizona, so only the SKU changes — model + version unchanged. | Byte-identical (Gov-only branch). |
| 3 | `admin-plane/keyvault.bicep` (`diag-loom-stdz` on the Key Vault + managed HSM) | `CategoryGroup: 'audit' is not supported, supported ones are: 'allLogs'` | `keyvault.bicep` gains a `boundary` param; `kvDiagLogs` var emits only `categoryGroup:'allLogs'` in GCC-High/IL5 (a superset that carries the audit events), Commercial/GCC keep both `allLogs` + `audit`. **Inverse of the round-1 hub-VNet case**: per-resource-type category support differs — Key Vault supports `allLogs` but rejects the separate `audit` group in Gov, whereas the VNet rejected the per-category form; the `allLogs` idiom resolves both. | Byte-identical (Gov-only branch). |
| 4 | `apim` (`admin-plane/network.bicep` `snet-apim` subnet, consumed by `apim.bicep`) | `API Management service v1 deployment into a Virtual Network requires that the subnet is not delegated to any service` | `snet-apim` `delegations` is now boundary-conditional: `[]` in GCC-High/IL5, `Microsoft.Web/hostingEnvironments` in Commercial/GCC. Verified nothing else consumes that delegation (its only reference is the subnet definition). | Byte-identical (Gov-only branch). |
| 5 | `vpn-gateway` (`admin-plane/vpn-gateway.bicep` P2S `vpnClientConfiguration`) | `VpnClientConfigurationAadTenantIsNotValid` | `vpn-gateway.bicep` gains a `boundary` param; the Azure VPN Client **audience** app ID is now `(GCC-High\|IL5) ? '51bb15d4-3a4f-4ebf-9dca-40096fe32426' (Gov) : '41b23e61-6c1e-4545-b367-cd054e0ed4b4' (Public)` per Learn "Configure P2S VPN gateway for Entra ID authentication". `aadTenant` was already cloud-aware via `environment().authentication.loginEndpoint` (→ `login.microsoftonline.us` in Gov) and `aadIssuer` (`sts.windows.net`) is cloud-agnostic, so only the audience GUID changed. | Byte-identical (Gov-only branch; same manually-registered app family). |

### Round 6 (2026-07-10, usgovvirginia)

A re-deploy of `params/gcc-high.bicepparam` into **US Gov Virginia** (after the
round-1 hub-VNet race that had been masking downstream failures cleared) surfaced
four deltas — three of them showing that two round-4 fixes were **incomplete**,
not wrong. All fixed boundary-aware; **Commercial output is unchanged for all
four** (a Gov-only branch that leaves the Commercial value identical). Grounded in
Microsoft Learn: [Azure OpenAI and features in Azure Government](https://learn.microsoft.com/azure/ai-foundry/openai/azure-government)
(Standard-deployment model availability) and [About Point-to-Site VPN — how are P2S VPN clients authenticated?](https://learn.microsoft.com/azure/vpn-gateway/point-to-site-about#how-are-p2s-vpn-clients-authenticated).

| # | Module | Live Gov error | Fix | Commercial impact |
|---|--------|----------------|-----|-------------------|
| 1 | `ai-foundry` (shared Foundry hub, `admin-plane/ai-foundry.bicep` default chat deployment) | `The specified SKU 'GlobalStandard' of account deployment is not supported by the model 'gpt-4o-mini' version: '2024-07-18'` | Round 4 made **agent-foundry** SKU-aware but never touched the **shared-hub** default chat deployment, which was still hard-`GlobalStandard` + `gpt-4o-mini`. `ai-foundry.bicep` now derives `effectiveChat*` from its existing `boundary` param: GCC-High/IL5 → **`gpt-4.1` `2025-04-14` on regional `Standard`**. Per Learn's Gov Standard-availability table, usgovvirginia offers **no** `gpt-4o-mini` (Arizona-only) and **no** GlobalStandard, but `gpt-4.1 2025-04-14` **is** Standard-available in usgovvirginia + usgovarizona and is current. Deployment name flips too (output `defaultChatDeploymentName` follows it, so `LOOM_AOAI_DEPLOYMENT` stays correct). | Byte-identical (`isSovereignGov=false` → param defaults `gpt-4o-mini`/`GlobalStandard`/`2024-07-18` unchanged; GCC on Azure Public also unchanged). |
| 2 | `agent-foundry` (`modules/ai/foundry-project.bicep` chat deployment, via `admin-plane/main.bicep` `agentFoundry`) | `The model 'Format:OpenAI,Name:gpt-4o,Version:2024-11-20' is in deprecating state and cannot be used for new deployments` | Round 4 fixed the **SKU** but left the **version** at `gpt-4o 2024-11-20`, which has since entered a deprecating state (blocked for new deployments). The `agentFoundry` invocation now also flips **model name + version** boundary-aware: chat → `gpt-4.1`/`2025-04-14`, completion → `gpt-4.1-mini`/`2025-04-14` (both Standard-available in usgovvirginia). Embed (`text-embedding-ada-002 v2`) is cloud-agnostic — SKU-only. Completion only materialises if `completionDeploymentName` is non-empty (empty in GCC-High/IL5 by default). | Byte-identical (Gov-only branch; Commercial keeps `gpt-4o 2024-11-20` / `gpt-4o-mini 2024-07-18` / `GlobalStandard`). |
| 3 | `ai-defense` (`admin-plane/ai-defense.bicep` Sentinel playbook `Microsoft.Logic/workflows`) | `InvalidTemplate: The workflow parameters 'TeamsWebhookUrl' are not valid; they are not declared in the definition` | Real bug (fires on any fresh deploy of this playbook, which runs when `!defenderForAIEnabled`, i.e. in Gov). The workflow **definition** `parameters` block only declared `$connections`, yet the resource-level `parameters` supplied `TeamsWebhookUrl` and the `PostToTeams` action referenced `@parameters('TeamsWebhookUrl')`. Declared `TeamsWebhookUrl` (`type:'String'`, `defaultValue:''`) in the definition so the value binds and the reference resolves. | Not deployed in Commercial (`defenderForAIEnabled=true` there), so no impact; the fix is cloud-agnostic and correct regardless. |
| 4 | `vpn-gateway` (`admin-plane/vpn-gateway.bicep` P2S `vpnClientConfiguration`) | `VpnClientConfigurationAadTenantIsNotValid — AAD Tenant must contain a valid AAD Directory ID (Guid)` | Round 4's Gov **audience** `51bb15d4-…` is the **manually-registered** Azure VPN app, which a Cloud App Admin must register + consent in the tenant *before* it is usable; unconsented, the gateway can't resolve it and rejects the config (surfaced as a tenant-validation error). Switched Gov to the **Microsoft-registered universal audience `c632b3df-fb67-4d84-bdcf-b95ad541b5c8`** (valid for Azure Public, **Azure Government**, Germany, 21Vianet), which is pre-consented and needs **no** tenant registration — Microsoft's recommended value, so P2S works day-one with no manual bootstrap. `aadTenant` (`login.microsoftonline.us/<tenant>`) and `aadIssuer` (`sts.windows.net/<tenant>/`) were already Gov-correct. | Byte-identical (Commercial/GCC keep the manually-registered Public GUID `41b23e61-…`). |
