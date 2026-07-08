# ai-search-service — parity with Azure AI Search (Cognitive Search)

**Source UI:** Azure portal → AI Search service blade (Indexes, Indexers, Data
sources, Skillsets, Synonym maps, Aliases, Semantic configurations, Vector
profiles, Debug sessions, Search explorer) + the per-index Schema designer.
**Learn grounding:**
- Data-plane REST (indexes, indexers, datasources, skillsets, synonymmaps,
  aliases, docs/search, analyze, stats): https://learn.microsoft.com/rest/api/searchservice/
- Indexer scheduling (`schedule.interval` ISO-8601, 5min..24h): https://learn.microsoft.com/azure/search/search-howto-schedule-indexers
- Semantic configuration (`index.semantic.configurations[]`): https://learn.microsoft.com/azure/search/semantic-how-to-configure
- Vector search (`index.vectorSearch.algorithms[]` + `profiles[]`, hnsw / exhaustiveKnn, metrics): https://learn.microsoft.com/azure/search/vector-search-how-to-create-index
- Debug sessions (`Microsoft.Search/searchServices/debugSessions`): https://learn.microsoft.com/azure/search/cognitive-search-debug-session
- Debug sessions with private connectivity (shared private link): https://learn.microsoft.com/azure/search/cognitive-search-how-to-debug-skillset
- Indexer field mappings + mapping functions: https://learn.microsoft.com/azure/search/search-indexer-field-mappings
- Run / reset indexers (reset docs, reset skills): https://learn.microsoft.com/azure/search/search-howto-run-reset-indexers
- Scoring profiles: https://learn.microsoft.com/azure/search/index-add-scoring-profiles
- Custom analyzers: https://learn.microsoft.com/azure/search/index-add-custom-analyzers
- CORS + customer-managed keys: https://learn.microsoft.com/azure/search/search-security-manage-encryption-keys
- Service API keys: https://learn.microsoft.com/azure/search/search-security-api-keys
- Monitor AI Search (QPS / latency / throttling metrics): https://learn.microsoft.com/azure/search/monitor-azure-cognitive-search

**Data-plane api-version:** `2024-07-01` (`SEARCH_DATA_API` in `lib/azure/search-index-client.ts`).
**ARM api-version (debug sessions, scale):** `2024-03-01-preview` (`SEARCH_API` in `lib/azure/aisearch-client.ts`); the service resource uses `2025-02-01-preview` in bicep.
**Auth:** Loom UAMI via `ChainedTokenCredential(ManagedIdentityCredential{LOOM_UAMI_CLIENT_ID}, DefaultAzureCredential)` — data plane scope `https://search.azure.com/.default`, ARM scope `https://management.azure.com/.default` (sovereign-aware via `cloud-endpoints.ts`).
**Roles required:** Search Index Data Contributor + Search Service Contributor on the service. Debug sessions additionally need the search service **system-assigned MSI** to hold Storage Blob Data Contributor on the session-state storage account (`ai-search.bicep debugSessionStorageId`).
**Honest infra-gates:** `searchConfigGate()` 503s naming `LOOM_AI_SEARCH_SERVICE` (data plane); `readSearchConfig()` 503s naming `LOOM_AI_SEARCH_SUB` / `LOOM_AI_SEARCH_RG` / `LOOM_AI_SEARCH_SERVICE` (ARM / debug sessions). The navigator + editor still render the gate MessageBar.

## Azure feature inventory → Loom coverage → backend per control

| Azure AI Search capability | Loom coverage | Backend per control |
| --- | --- | --- |
| **Indexes** — list with field count + vector badge | ✅ built (group + count) | `GET /api/ai-search/indexes` → `listIndexes()` → `GET /indexes?$select=name,fields,vectorSearch` |
| Create / delete index | ✅ built (＋New / inline) | `POST` / `DELETE /api/ai-search/indexes` → `createIndex()` / `deleteIndex()` |
| Open index → Schema / Search / Statistics / Indexers tabs | ✅ built (select → editor) | `/api/ai-search/indexes/{name}` + item routes |
| **Index Schema** — visual per-field designer (name/type/key/attrs/analyzer/dims/profile) | ✅ built | `PUT /indexes/{name}` via `applyFieldRows()` |
| Advanced full-definition JSON editor | ✅ built (Monaco) | `PUT /indexes/{name}` |
| **Semantic configuration designer** (title / content / keyword fields) | ✅ built (`SemanticConfigDesigner`) | `PUT /indexes/{name}` with `buildSemanticSection()` |
| **Vector search designer** (algorithms hnsw/exhaustiveKnn + profiles) | ✅ built (`VectorSearchDesigner`, gated on a vector field) | `PUT /indexes/{name}` with `buildVectorSearchSection()` |
| **Scoring-profile designer** (per-field text weights + magnitude/freshness/distance/tag functions + default profile) | ✅ built (AIF-16 · `ScoringProfilesDesigner`, was JSON-only) | `PUT /indexes/{name}` with `buildScoringProfiles()` / `applyDesignerSections()` |
| **Custom-analyzer designer** (tokenizer + token/char filters from the built-in Lucene lists) | ✅ built (AIF-16 · `AnalyzersDesigner`, was JSON-only) | `PUT /indexes/{name}` with `buildCustomAnalyzers()` (`analyzers[]`) |
| **CORS options** (allowed origins + max-age) | ✅ built (AIF-16 · `CorsAndCmkDesigner`, was JSON-only) | `PUT /indexes/{name}` with `buildCorsOptions()` (`corsOptions`) |
| **Customer-managed key (CMK)** (Key Vault URI + key + optional UAMI identity) | ✅ built (AIF-16 · `CorsAndCmkDesigner`, was JSON-only) | `PUT /indexes/{name}` with `buildEncryptionKey()` (`encryptionKey`) |
| **Search explorer** — simple/full/semantic, vector + hybrid, facets, highlight, scoring profile, answers/captions, raw JSON | ✅ built | `POST /indexes/{name}/docs/search` via `buildSearchBody()` |
| **Analyze text** — token output per analyzer | ✅ built | `POST /indexes/{name}/analyze` |
| **Index statistics** — doc count / storage / vector index size | ✅ built | `GET /indexes/{name}/stats` |
| **Indexers** — list with target/datasource/skillset + schedule + paused | ✅ built | `GET /indexers?$select=…,schedule,disabled` → `listIndexers()` |
| Indexer run / reset | ✅ built (inline) | `POST /indexers/{name}/run` · `/reset` |
| Indexer status (last run result) | ✅ built (tree status badge) | `GET /indexers/{name}/status` |
| **Indexer execution history** (per-run start/end, items processed/failed, expandable warnings + errors) | ✅ built (AIF-10 · `IndexerOpsPanel`) | `POST {action:'status'}` → `GET /indexers/{name}/status` → `parseExecutionHistory()` (executionHistory[]) |
| **Indexer field-mappings builder** (source→target + mapping-function picker: base64/extractTokenAtPosition/urlEncode/…) | ✅ built (AIF-10 · `IndexerOpsPanel`) | `POST {action:'setFieldMappings'}` → `updateIndexerFieldMappings()` → `PUT /indexers/{name}` (`buildFieldMappings()`) |
| **Indexer output-field-mappings builder** (skillset output node → index field) | ✅ built (AIF-10) | same PUT `outputFieldMappings` |
| **Reset docs** (selectively re-index specific document keys) | ✅ built (AIF-10) | `POST {action:'resetDocs'}` → `POST /indexers/{name}/resetdocs` |
| **Reset skills** (clear cached skill output; preview API) | ✅ built (AIF-10, gated on a skillset) | `POST {action:'resetSkills'}` → `POST /indexers/{name}/resetskills` (`2024-11-01-preview`) |
| **Indexer schedule designer** (recurrence preset + custom interval + startTime + pause) | ✅ built (`IndexerSchedulePanel`) | `POST {action:'setSchedule'}` → `getIndexer()` + `updateIndexerSchedule()` → `PUT /indexers/{name}` |
| Create indexer (+ optional schedule + disabled) | ✅ built (＋New) | `POST /api/ai-search/indexers` → `createIndexer()` (schedule passthrough) |
| **Data sources** — list / create / delete (blob, adlsgen2, sql, cosmos, …) | ✅ built | `/api/ai-search/datasources` → `list/create/deleteDataSource()` |
| **Skillsets** — list / create (JSON) / delete | ✅ built | `/api/ai-search/skillsets` → `list/create/deleteSkillset()` |
| **Synonym maps** — list / create (solr rules) / delete | ✅ built | `/api/ai-search/synonymmaps` → `list/create/deleteSynonymMap()` |
| **Aliases** — list / create / delete | ✅ built | `/api/ai-search/aliases` → `list/create/deleteAlias()` |
| **Debug sessions** — list / create / delete + last status | ✅ built (`Debug sessions` tree group) | `/api/ai-search/debug-sessions` → `list/create/deleteDebugSession()` → ARM `…/debugSessions/{name}` |
| Debug session — visual skill-graph enrichment trace | ⚠️ honest deep-link | "Open in portal" — the node-graph trace renderer is portal-proprietary UI over the stored session state; Loom links to `…/debugSessions/{name}` |
| Debug session storage (keyless, MSI) | ✅ built (default deploy) | New-service deploys provision a dedicated debug-session storage account in the admin RG, grant the search system-MSI Storage Blob Data Contributor (`ai-search.bicep` `debugSessionStorageId`), and wire `LOOM_AI_SEARCH_DEBUG_STORAGE_CONN` to a keyless `ResourceId=` connection string. BYO-search deploys leave it empty and the UI accepts a per-session connection string. |
| Debug session — private-link prerequisites (PE-locked) | ⚠️ honest note | BFF response + create-dialog Caption name the same-region trusted-service exception, `executionEnvironment:"private"` on the indexer, and shared-private-link requirement |
| **Import data / Import and vectorize data wizard** | ⚠️ honest "coming" row | the individual pieces (datasource + skillset + index + indexer) are each creatable via ＋New; the single coordinated wizard is not yet built |
| Scale (SKU tier immutable; replicas/partitions) | ✅ built (admin scaling page) | `PATCH Microsoft.Search/searchServices/{name}` via `updateSearchService()` |
| **Service administration — in-editor ⚙ Service tab** (AIF-17 · `AiSearchServicePanel`) | ✅ built | `GET /api/ai-search/service` → `getServiceProperties()` (ARM) + keys + stats |
| Service admin → **API keys** (reveal admin keys, regenerate primary/secondary) | ✅ built | ARM `POST …/listAdminKeys` · `…/regenerateAdminKey/{primary\|secondary}` |
| Service admin → **Query keys** (list, create named, revoke) | ✅ built | ARM `…/listQueryKeys` · `…/createQueryKey/{name}` · `…/deleteQueryKey/{key}` |
| Service admin → **Networking** (public network access toggle, IP rules + PE list, auth mode) | ✅ built | ARM `PATCH properties.publicNetworkAccess`; PE/ipRules read from the resource |
| Service admin → **Semantic-ranker tier** (disabled/free/standard) | ✅ built | ARM `PATCH properties.semanticSearch` via `setSemanticTier()` |
| Service admin → **Monitoring** (QPS / latency / throttling, timespan picker) | ✅ built | `GET /api/ai-search/service/metrics` → Azure Monitor `SearchQueriesPerSecond` / `SearchLatency` / `ThrottledSearchQueriesPercentage` (`fetchMetrics`) |
| Service admin → **Service statistics & quotas** (per-object usage/quota) | ✅ built | data-plane `GET /servicestats` via `getServiceStatistics()` |
| Diagnostic settings (logs + AllMetrics → Log Analytics) so Monitoring has data | ✅ built (bicep) | `ai-search.bicep` `diag` resource (OperationLogs + AllMetrics → `workspaceId`) |

## Per-cloud notes

| Feature | Commercial + GCC | GCC-High / IL5 |
| --- | --- | --- |
| Data plane (schedule, semantic, vector, search) | `search.windows.net` suffix via `getSearchSuffix()`. | `search.azure.us` suffix; scope `https://search.azure.com/.default` is sovereign-aware. |
| Semantic ranking | `semanticSearch: standard` on the service (bicep). | Available on Azure Government. |
| Debug sessions (ARM) | `management.azure.com` via `armBase()`. | `management.usgovcloudapi.net`. Same PE / shared-private-link caveat. |
| Service admin (keys / networking / semantic / stats) | ARM + data-plane, sovereign-aware. | Gov-native (`management.usgovcloudapi.net` + `search.azure.us`). |
| Monitoring metrics | Azure Monitor `microsoft.insights/metrics`, sovereign-aware via `fetchMetrics`. | Gov-native. UAMI needs Monitoring Reader (or Reader) on the service. |
| Reset skills (preview API) | `2024-11-01-preview` data-plane. | Verify preview API availability per Gov region; the honest error surfaces if absent. |
| Fabric / Power BI | N/A — AI Search is Azure-native only; no Fabric dependency on any path. | N/A |

## Verification

- `pnpm vitest run lib/azure/__tests__/search-field-shapes.test.ts lib/azure/__tests__/search-index-client.test.ts` — schedule validation, semantic/vector builders, `getIndexer` / `updateIndexerSchedule` wire contract.
- Live: with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, open an index → Schema → author a semantic config + vector profile → Save (real `PUT /indexes`); Indexers tab → Schedule → set `PT2H` → Save (real `PUT /indexers`); tree → Debug sessions → New (real ARM `PUT …/debugSessions`).
