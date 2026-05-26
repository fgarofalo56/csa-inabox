# Loom AI Search Skillset Editor — Fabric-parity build spec

> Reference: Microsoft Learn — *AI enrichment in Azure AI Search* (`/azure/search/cognitive-search-concept-intro`), *Skillset concepts* (`/azure/search/cognitive-search-working-with-skillsets`), *Built-in skills reference* (`/azure/search/cognitive-search-predefined-skills`), *Tutorial: Skillsets in Azure AI Search* (`/azure/search/tutorial-skillset`), *Custom skill interface* (`/azure/search/cognitive-search-custom-skill-interface`), *Knowledge store concept* (`/azure/search/knowledge-store-concept-intro`), *Attach a billable resource* (`/azure/search/cognitive-search-attach-cognitive-services`), REST `Skillsets - Create or Update` (`/rest/api/searchservice/skillsets/create-or-update`, api-version `2026-04-01`). Documented 2026-05-26 by catalog agent.

## Overview

An Azure AI Search **skillset** is the AI-enrichment recipe attached to an **indexer**. The indexer cracks documents in a data source, hands the extracted text + images to the skillset, which runs an ordered (but parallelizable) graph of **skills** — Microsoft-provided built-ins, custom Web API calls, or AML-hosted models — to produce enriched output that lands in (a) **index fields** via `outputFieldMappings`, and (b) optionally a **knowledge store** for downstream non-search workloads (Power BI, Synapse, ad hoc SQL).

The skill graph is wired through **enrichment paths** — `/document/content`, `/document/normalized_images/*/text`, `/document/merged_content/keyphrases/*` — that Microsoft treats as a tree where each skill consumes inputs from earlier nodes and writes outputs that become new nodes downstream. The skillset is billable when it calls Microsoft Cognitive Services (Vision, Language, Translator), with billing tied either to a free-tier 20 transactions/day allowance or to an attached **`cognitiveServices`** resource (key-based or managed-identity-based).

A skillset is created and edited under AI Search → **Skillsets** → click name. The Portal exposes a JSON editor only; structured authoring lives in the **Import data (new)** wizard. The full skillset doc covers ~25 built-in skill types and an arbitrary number of custom skills.

## AI Search Skillset UX inventory

### Page chrome
- Page title with skillset name · skill count · attached indexer count · cognitive-services attach state chip
- Top action bar: **Edit JSON**, **Reset skillset** (clears cache so all docs re-enrich on next indexer run), **Run indexer** (downstream link), **Delete**, **Refresh**

### Tab — Skills (visual graph + list view toggle)
**Graph view** (left): node-link DAG of skill nodes. Each node shows skill type + name. Edges follow input→output enrichment paths. **List view** (right): ordered table — drag-to-reorder, per-row edit drawer.

Per-skill drawer (varies by `@odata.type`):

| Skill type | Key fields |
|---|---|
| `Microsoft.Skills.Text.SplitSkill` | textSplitMode (`pages`/`sentences`), maximumPageLength, pageOverlapLength, defaultLanguageCode, unit |
| `Microsoft.Skills.Vision.OcrSkill` | defaultLanguageCode, detectOrientation toggle, lineEnding |
| `Microsoft.Skills.Vision.ImageAnalysisSkill` | visualFeatures multi-select (`categories`/`tags`/`description`/`faces`/`objects`/`brands`), details multi-select (`celebrities`/`landmarks`), defaultLanguageCode |
| `Microsoft.Skills.Text.KeyPhraseExtractionSkill` | defaultLanguageCode, maxKeyPhraseCount |
| `Microsoft.Skills.Text.V3.EntityRecognitionSkill` | categories multi-select (`Person`/`Location`/`Organization`/`Quantity`/`DateTime`/`URL`/`Email`/`PersonType`/`Event`/`Product`/`Skill`/`Address`/`Phone Number`/`IPAddress`), modelVersion, minimumPrecision |
| `Microsoft.Skills.Text.V3.EntityLinkingSkill` | defaultLanguageCode, minimumPrecision, modelVersion |
| `Microsoft.Skills.Text.PIIDetectionSkill` | piiCategories multi-select, domain (`phi`/`none`), maskingMode (`replace`/`none`), maskingCharacter |
| `Microsoft.Skills.Text.LanguageDetectionSkill` | defaultCountryHint |
| `Microsoft.Skills.Text.MergeSkill` | insertPreTag, insertPostTag |
| `Microsoft.Skills.Text.TranslationSkill` | defaultFromLanguageCode, defaultToLanguageCode, suggestedFrom |
| `Microsoft.Skills.Text.V3.SentimentSkill` | defaultLanguageCode, includeOpinionMining toggle |
| `Microsoft.Skills.Util.DocumentExtractionSkill` | parsingMode, dataToExtract, configuration |
| `Microsoft.Skills.Util.ConditionalSkill` | condition expression input, whenTrue/whenFalse path inputs |
| `Microsoft.Skills.Util.ShaperSkill` | inputs definition tree (compose a structured object for KnowledgeStore projection) |
| `Microsoft.Skills.Custom.WebApiSkill` | uri, httpMethod, timeout, batchSize, httpHeaders DataGrid, degreeOfParallelism, authResourceId (for AAD-protected APIs) |
| `Microsoft.Skills.Custom.AmlSkill` | uri (AML inference endpoint), key OR resourceId (managed identity), region, timeout, degreeOfParallelism |
| `Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill` | resourceUri, deploymentId, modelName, apiKey OR managed identity, dimensions |
| `Microsoft.Skills.Vision.VectorizeSkill` | modelVersion, resource auth |
| `Microsoft.Skills.Text.DocumentIntelligenceLayoutSkill` | endpoint, modelId, markdownHeaderDepth, outputMode |

All skills share: **name** (free text), **description**, **context** (default `/document`, overridable to e.g. `/document/pages/*`), **inputs** (DataGrid of `name` → `source` enrichment path), **outputs** (DataGrid of `name` → `targetName`).

### Tab — Cognitive services attach
- **Mode** dropdown — `<none>` (free 20 txns/day) · `#Microsoft.Azure.Search.CognitiveServicesByKey` (key-based) · `#Microsoft.Azure.Search.AIServicesByKey` (newer name, same shape) · `#Microsoft.Azure.Search.AIServicesByIdentity` (managed-identity-based)
- Key-mode fields: subdomainUrl (for AIServicesByKey), key (from KV reference)
- Identity-mode fields: subdomainUrl, identity selector (system-assigned MI / user-assigned MI by resourceId)
- Region note — must match indexer region or be in the AI Services multi-service region group

### Tab — Knowledge store
- **storageConnectionString** input (or KV reference, or `ResourceId=...` for managed-identity-based)
- **identity** selector (if MI-based)
- **projections** repeater — per projection group:
  - **Tables** repeater — `tableName`, `referenceKeyName`, `generatedKeyName`, `source` enrichment path (typically a Shaper output)
  - **Objects** repeater — `storageContainer`, `referenceKeyName`, `generatedKeyName`, `source`
  - **Files** repeater — `storageContainer`, `referenceKeyName`, `generatedKeyName`, `source` (image bytes)
- Preview pane: projected rowset / object JSON sample

### Tab — Index projections (new, replaces parts of KnowledgeStore for vector workflows)
- **indexProjections.selectors** repeater — `targetIndexName`, `parentKeyFieldName`, `sourceContext`, `mappings` DataGrid (each mapping = inputName → source path)
- **parameters.projectionMode** dropdown — `skipIndexingParentDocuments` / `includeIndexingParentDocuments`
- Used to fan one parent doc out to multiple child docs in a target index (chunking + vectorization scenario)

### Tab — Encryption
- **encryptionKey** form — KV URI, key name, version, identity selector

### Tab — JSON editor
Monaco editor over the full skillset definition. Useful for skills the structured editor doesn't cover.

### Toolbar actions
- **Test skill** — pick a skill, paste a sample document JSON, see the skill's output as if executed in the enrichment tree (uses the [Debug session](https://learn.microsoft.com/azure/search/cognitive-search-how-to-debug-skillset) feature in portal)
- **Open debug session** — launches a stateful debug session that pins a document and lets the user step through the skill graph

---

## What Loom has today

**Nothing.** There is **no skillset editor registered** in `apps/fiab-console/lib/editors/registry.ts`. The catalog does not include `ai-search-skillset` as an item type. Indexers and data sources are likewise absent — the only AI-Search-adjacent editor is `ai-search-index` (read-only, A-grade).

This means the entire AI enrichment story is unreachable from Loom today. A user can browse an existing index but cannot author the skillset that loads it, attach a cognitive services resource, configure a knowledge store, set up index projections for chunking, or wire a custom Web API skill.

Grade: **F (absent)** — by definition not vaporware (nothing is shown), but a hole in the catalog that blocks every realistic enterprise-search ingest scenario.

## Gaps for parity

1. **Add `ai-search-skillset` (and `ai-search-indexer`, `ai-search-datasource`) item types** to `fabric-item-types.ts` and wire editors into `registry.ts`. Skillset can't usefully exist without its sibling indexer and data source — propose shipping all three together.
2. **Skills graph view** — DAG renderer. Loom already has graph components (used by the `synapse-pipeline` editor); reuse the same dependency.
3. **Skills list view + per-skill drawer** — typed forms for each of the ~25 built-in skill types. Drives most of the implementation effort.
4. **Custom Web API skill drawer** — uri / headers / batchSize / timeout / authResourceId for AAD-protected endpoints. Test-call button that POSTs a sample envelope to the URL and renders the response.
5. **AML skill drawer** — endpoint, region, auth mode (key from KV / MI by resourceId), timeout.
6. **AzureOpenAI Embedding skill drawer** — pulls the AOAI deployment list from the linked Foundry hub (already enumerable via Loom's foundry-hub editor) into the dropdown.
7. **Document Intelligence Layout skill drawer** — endpoint + modelId picker (`prebuilt-layout`, `prebuilt-document`, etc.) — pulls models from the linked DI resource.
8. **Cognitive services attach tab** — mode dropdown including `AIServicesByIdentity` (the keyless option Loom should default to in Gov environments).
9. **Knowledge store tab** — full projections editor (tables / objects / files) with storage account picker pulled from Loom's storage-account catalog.
10. **Index projections tab** — selectors editor for chunking-to-child-index scenarios. Critical for vector-search ingest.
11. **Debug session button** — launches the portal debug session in a new tab, deep-linked to this skillset + indexer + sample document. Manageable scope reduction vs building an in-Loom debugger.
12. **Test skill action** — POST a sample doc to `https://{svc}.search.windows.net/skillsets/{name}/test?api-version=2026-04-01` (preview API) and render the per-skill outputs.
13. **Reset skillset button** — confirms destructive cache-clear, calls `POST /skillsets/{name}/resetskills`.
14. **Run indexer / Run on selection** — convenience trigger that fires the attached indexer after a skillset edit.
15. **MessageBar gates** — billable-skill detection that warns when a paid skill (OCR, KeyPhrases, EntityRecognition, etc.) is added without an attached cognitive services resource (the free 20-txns/day path is dev-only).

## Backend mapping

| AI Search concept | Loom backend |
|---|---|
| List skillsets | **NEW** `GET /api/items/ai-search-skillset` → `GET /skillsets?api-version=2026-04-01` |
| Get skillset | **NEW** `GET /api/items/ai-search-skillset/[id]` → `GET /skillsets/{name}` |
| Create / update skillset | **NEW** `PUT /api/items/ai-search-skillset/[id]` → `PUT /skillsets/{name}?api-version=2026-04-01`. Server-side validate skill graph (no cycles, all input paths resolvable). |
| Delete skillset | **NEW** `DELETE /api/items/ai-search-skillset/[id]` → `DELETE /skillsets/{name}` |
| Reset cache | **NEW** `POST .../[id]/reset` → `POST /skillsets/{name}/resetskills` |
| Test (debug) | **NEW** `POST .../[id]/test` → preview API; pass sample doc |
| List indexers / datasources (sibling) | **NEW** `GET /api/items/ai-search-indexer`, `GET /api/items/ai-search-datasource` |
| List AOAI deployments (for embedding skill picker) | ✅ Existing — Foundry hub editor enumerates `Microsoft.CognitiveServices/accounts/deployments` |
| List storage accounts (for KS picker) | ✅ Existing — storage-account catalog |
| List Document Intelligence resources | **NEW** small helper — list `Microsoft.CognitiveServices/accounts?$filter=kind eq 'FormRecognizer'` in subscription |
| Auth to AI Search | ✅ Existing — `cognitive-services` route helper (admin key from KV or AAD via Search Index Data Contributor) |
| Auth to Cognitive Services (when attaching by identity) | **NEW** role assignment — Loom MI needs `Cognitive Services User` on the attached resource |

## Required Azure resources

- ✅ **Azure AI Search service** (existing in bicep)
- ✅ **Storage account** for blob data source + (optional) knowledge store (existing)
- **NEW**: Multi-service **Azure AI Services (Cognitive Services) account** (`Microsoft.CognitiveServices/accounts` kind=`AIServices`) in the same region as Search. Add to `platform/fiab/bicep/modules/` and wire into the admin-plane orchestrator. Required for any production skillset that calls billable skills.
- ✅ **Azure OpenAI deployment** (existing via foundry-hub.bicep) — for embedding skills
- **Optional**: **Document Intelligence resource** for the Layout skill — already deployable via existing AI Foundry bicep
- **NEW role assignments** on Loom's managed identity:
  - `Cognitive Services User` on the AI Services account
  - `Storage Blob Data Contributor` on the data source storage account (already present for general Loom storage access)
  - `Storage Blob Data Contributor` on the knowledge store storage account (may be same account; ensure assignment scope covers it)

## Estimated effort

**3 focused sessions.**

- **Session 1 (~2.5h):** Catalog wiring — add `ai-search-skillset`, `ai-search-indexer`, `ai-search-datasource` to `fabric-item-types.ts`, wire editors into `registry.ts`, scaffold backend CRUD routes for all three (`GET`/`PUT`/`DELETE`), and the `reset` + `test` actions. Add the AI Services bicep module + role assignments.
- **Session 2 (~3h):** Frontend — skills DataGrid + ordered list + drag-to-reorder, per-skill drawer for the **top 10 most-used skills** (Split, OCR, ImageAnalysis, KeyPhrase, EntityRecognition v3, LanguageDetection, Merge, Translation, AzureOpenAIEmbedding, CustomWebApi). Cognitive services attach tab. Billable-skill MessageBar gate.
- **Session 3 (~2.5h):** Knowledge store projections tab · Index projections tab · DAG graph view · `Test skill` flow · debug-session deep-link · remaining 15 built-in skills (drawers can reuse a generic "key/value JSON inputs" form behind a "Skill type not yet fully typed in Loom" badge until they're individually invested in) · UAT harness coverage for at least the OCR + KeyPhrase + Embedding path (the canonical RAG ingest sequence).

Drops Loom AI Search Skillset from **F (absent)** to **A (full CRUD on the skill graph, real REST, sibling indexer/datasource wired, real backing cognitive-services resource deployable from bicep)**. A+ achievable once UAT covers all 25 built-in skill types end-to-end against a freshly-deployed environment.
