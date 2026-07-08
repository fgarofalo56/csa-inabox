# CSA Loom — Azure Service Tie-Ins That Enhance Analytics & AI

**Title:** Azure service integrations — net-new AI-enrichment, media, geospatial, health-data, and reliability capabilities beyond current Loom wiring
**Date:** 2026-07-08
**Status:** proposed
**Scope:** `apps/fiab-console` (clients, BFF routes, editors, pipeline canvas, catalog) + `platform/fiab/bicep`, Azure Commercial **and** Azure Government (GCC / GCC-High / DoD IL4–IL6).
**Sources consulted:** repo inventory of `apps/fiab-console/lib/azure/` (170+ client files), `lib/components/deploy-planner/service-catalog.ts`, `lib/components/pipeline/activity-catalog.ts`, `lib/apps/content-bundles/app-healthcare-popmgt.ts`, `platform/fiab/bicep/modules/deploy-planner/batch.bicep`; Microsoft Learn MCP for 2025/2026 GA + FedRAMP / Azure Government scope per service.
**Cross-cutting rules honored:** `no-vaporware.md`, `no-fabric-dependency.md`, `ui-parity.md`, no-freeform-config (dropdowns / wizards / canvas only), Web-5.0 (Fluent v9 + Loom tokens + `canvas-node-kit`), bicep-synced, dual-cloud.

---

## 1. Executive summary

Loom is Fabric-class analytics and AI on **pure Azure + OSS**, on Commercial and Gov, with no
real Microsoft Fabric or Power BI service ever on the default path. The estate already integrates a
deep set of Azure services — AOAI, AI Search, Synapse, ADLS, ADX, Databricks, AAS, Content Safety,
Managed Grafana, Maps. This PRP closes the **highest-value analytics/AI services that Loom does not
yet wire up**, and it deliberately excludes anything the audit already graded BUILT so no reviewer
re-litigates settled ground.

The strategic gap is concentrated in one place: **Loom can move and shape data, but it cannot yet
*enrich* it with Azure's AI services inside a pipeline.** The deploy-planner already lists Document
Intelligence, Computer Vision, Language, Speech, and Translator as bicep toggles
(`service-catalog.ts:419-439`), but not one of them has a client, a BFF route, an editor, or a
pipeline activity — they are dashboard checkboxes that provision an account nobody calls. The
pipeline activity catalog (`activity-catalog.ts`) has **no AI/Cognitive activity family at all** —
only Copy / Lookup / GetMetadata / Databricks / Spark / Script. That is the single largest,
lowest-novelty-risk build in the backlog: real AI-enrichment steps for the data-pipeline canvas and
real cognitive skillsets for AI Search, riding the **exact Entra-auth REST client pattern
`foundry-cs-client.ts` already proves out**. Everything downstream — RAG document-cracking, media
analytics, bulk inferencing — hangs off that one client family.

Around that spine sit six net-new services that materially widen what Loom's analytics/AI can
ingest and prove: **Azure Health Data Services** (a real FHIR/DICOM/de-identification backend behind
the Healthcare bundle that today fakes a FHIR-shaped lakehouse with a manual Safe-Harbor claim and
*no* de-identification call), **Content Understanding** (unified multimodal document-cracking for
RAG chunking), **Azure Batch** (already fully bicep-provisioned with a comment promising a navigator
that does not exist — bulk parallel AI fan-out), **Video Indexer** (media analytics into a Delta
table), **Planetary Computer / Open Datasets** (near-zero-effort public shortcuts that reuse the
already-proven shortcut engine), **Confidential Ledger** (tamper-evident audit trail for governance
actions Cosmos alone cannot make non-repudiable), and **Graph Data Connect** (bulk M365
organizational analytics). Reliability tooling (Load Testing / Chaos Studio) is folded in with an
explicit hand-off to the enterprise-hardening PRP, which already owns the load-test design.

Every item obeys the die-hard law: Azure-native by default, real backend end-to-end with a
no-vaporware receipt, no JSON textareas, Fluent v9 + Loom tokens, and an **honest Gov MessageBar
gate** wherever a service is Commercial-only or not yet at the tenant's impact level — never a
silent omission and never a Fabric/Power BI dependency.

---

## 2. Cross-cutting requirements (every item obeys these)

1. **Dual-cloud, no literals.** Every new client resolves host / scope / authority via the existing
   `cloud-endpoints.ts` / `detectLoomCloud()` helpers (the same path `foundry-cs-client.ts` uses).
   Name the Gov audiences explicitly — `*.azure.us` / `*.usgovcloudapi.net` cognitive, ARM, and
   data-plane hosts, authority `login.microsoftonline.us`. Where a service is **absent or degraded
   in Gov**, ship an **honest `MessageBar intent="warning"` gate** naming the exact env var / region
   requirement, and an OSS substitute where one exists — never a silent drop, never a Commercial host
   reached from a Gov tenant.
2. **No-vaporware end-to-end.** Every control calls a real Azure REST / data-plane endpoint and
   returns `{ok, data, error}` with a real-data E2E receipt in the PR (endpoint hit + first 300
   chars of a real response + a browser shot or Playwright trace). No `return []`, no `useState(MOCK)`.
3. **No-freeform-config.** Pipeline-activity properties, skillset chains, analyzer field schemas,
   pool autoscale — all rendered as typed forms / dropdowns / card-list builders / canvas nodes via
   `canvas-node-kit` and the existing pipeline form system. The only allowed textarea is a 1:1
   ADF/Synapse expression builder.
4. **No Fabric / Power BI dependency.** Nothing here reaches `api.fabric.microsoft.com` /
   `api.powerbi.com` / OneLake on a default path. The Healthcare bundle's Power BI dashboard framing
   is replaced by the Loom-native report/semantic path per `no-fabric-dependency.md`.
5. **Bicep-synced.** Every new Azure resource, env var, role assignment, and Cosmos container is
   wired into `platform/fiab/bicep/**` and the `admin-plane` env list, and a from-scratch
   `az deployment sub create` reproduces the feature set.
6. **Migration-safe.** Every new backend ships behind a `LOOM_<SERVICE>_*` flag / env var with a
   documented reversible default (default-on where Gov-safe and cost-benign; default-off / honest-gate
   where it provisions a metered account).

---

## 3. Work items

| # | Item | Capability | State | Priority | Effort |
|---|------|-----------|-------|----------|--------|
| 1 | **AI-enrichment pipeline activities** | Doc Intelligence / Vision / Language / Translator as real transform steps in the data-pipeline canvas | 🟡 partial | **P0** | L |
| 2 | **AI Search cognitive skillsets** | OCR / Vision / Doc-Intel / Entity / Translation skill-chain authoring (Import-and-vectorize parity) | 🟡 partial | **P1** | L |
| 3 | **Azure Health Data Services** | Real FHIR + DICOM + de-identification backend behind the Healthcare bundle | ⚫ missing | **P1** | XL |
| 4 | **Content Understanding** | Unified multimodal (doc/image/video/audio) analyzer for RAG document-cracking | ⚫ missing | **P2** | M |
| 5 | **Azure Batch app wiring** | Pool/job/task navigator + `BatchExecute` activity for bulk parallel AI fan-out | 🟡 partial | **P2** | M |
| 6 | **Azure AI Video Indexer** | Media analytics (transcript/faces/OCR/sentiment) landed as a Delta table | ⚫ missing | **P2** | M |
| 7 | **Planetary Computer + Open Datasets** | Public STAC geospatial + curated open-data shortcuts (reuse shortcut engine) | ⚫ missing | **P3** | S |
| 8 | **Content Safety pipeline activity** | `ModerateText` step screening ingested free-text (extends the built client) | 🟢 built (extend) | **P3** | S |
| 9 | **Azure Confidential Ledger** | Tamper-evident audit receipts for classification / access-grant / publish actions | ⚫ missing | **P3** | M |
| 10 | **Microsoft Graph Data Connect** | Bulk M365 org-analytics (Teams/SharePoint/Exchange) into the lakehouse | ⚫ missing | **P3** | L |
| 11 | **Chaos Studio reliability panel** | Fault-injection DR-runbook proof (Load Testing deferred to enterprise-hardening PRP) | ⚫ missing | **P3** | M |

Legend: 🟢 built · 🟡 partial · 🔴 weak · ⚫ absent.

Dependency note: **item 1's four clients are the foundation** for items 2, 4, 5, and 6 (they all reuse
the same Cognitive/AIServices account + `foundry-cs-client.ts` Entra-auth pattern). Build item 1 first.

---

## Item 1 — AI-enrichment pipeline activities (P0, L)

**Capability.** Bring Azure AI transform steps into Loom's data-pipeline canvas so free-text,
documents, and images landing in bronze can be enriched into silver/gold — the ADF / Fabric "AI"
activity family Loom is missing.

**Source-product grounding.**
- Document Intelligence — layout / prebuilt analysis: https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/layout
- FedRAMP High / DoD IL audit scope (Computer Vision, Language, Translator, Doc Intelligence): https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope

**Current Loom state — PARTIAL.**
- `lib/components/deploy-planner/service-catalog.ts:419-439` lists `documentIntelligence` (`bicepFlag: documentIntelligenceEnabled`), `visionServices` (`visionServicesEnabled`), `speechServices`, `languageServices`, and `translator` (`planOnly: true`) as `category: 'ai'` deploy-planner toggles with **zero application wiring** — a checkbox that provisions an account no code calls.
- `lib/components/pipeline/activity-catalog.ts` defines Copy / ExecuteWranglingDataflow / ExecuteDataFlow / Lookup / GetMetadata / Delete / Databricks / Spark / ExecutePipeline / Script / StoredProcedure / Web — **no AI/Cognitive activity type exists** (confirmed: no `category: 'ai'`, no `DocumentIntelligence*`, no `Vision*` entry).
- The Entra-auth REST pattern is already proven in `lib/azure/foundry-cs-client.ts` (Content Safety) — `ChainedTokenCredential` + `cloud-endpoints.ts` scope resolution incl. Gov audiences.

**Azure-first / OSS build.**
- **Clients:** `lib/azure/doc-intelligence-client.ts`, `vision-client.ts`, `language-client.ts`, `translator-client.ts` — Entra-auth REST wrappers each following the `foundry-cs-client.ts` shape exactly (ChainedTokenCredential; scope + host from `cloud-endpoints.ts` with the Gov cognitive audience). Each exposes the primary analyze/extract/translate op returning `{ok,data,error}`.
- **Pipeline activities:** add 4 `activity-catalog.ts` entries — `DocumentIntelligenceAnalyze`, `VisionAnalyzeImage`, `LanguageExtract`, `TranslateText`, all `category: 'move-transform'` — with typed property schemas (model/prebuilt id, input field, output-field mappings) rendered by the **existing pipeline canvas form system** (no JSON). Wire real execution into the pipeline run executor — `dataflow-engine-client.ts` / `dataflow-run.ts` already fans activities out; add the executor branch that calls the matching client and writes the enriched columns to the sink.
- **BFF:** the activities execute inside the existing pipeline-run route; add per-service preview routes (`app/api/items/ai-enrich/<service>/preview/route.ts`) so the canvas node has a "test on a sample" affordance (real call, honest-gate when the account env var is unset).
- **Catalog wiring:** the 4 activities appear in the canvas palette under a new **"AI enrich"** group; no new catalog *item type* needed (they are activities, not items).
- **Bicep:** promote the 4 `service-catalog` entries from `planOnly` to real toggles in `platform/fiab/bicep/modules/deploy-planner` — single-kind Cognitive Services accounts (`FormRecognizer`, `ComputerVision`, `TextAnalytics`, `TextTranslation`), Entra-only auth (`disableLocalAuth: true`), mirroring the Content-Safety account pattern; grant the Console UAMI `Cognitive Services User` on each. Add `LOOM_DOCINTEL_ENDPOINT` / `LOOM_VISION_ENDPOINT` / `LOOM_LANGUAGE_ENDPOINT` / `LOOM_TRANSLATOR_ENDPOINT` to the `apps[]` env list.
- **Gov.** All four are in the FedRAMP High / DoD IL4–IL5 audit-scope list — **safe to enable by default in Gov**; resolve the Gov cognitive host via `cloud-endpoints.ts`. Speech is intentionally deferred (no analytics-pipeline use in this wave).

**Acceptance (no-vaporware receipt).** A pipeline with a `DocumentIntelligenceAnalyze` node runs
against a real Document Intelligence account (`LOOM_DEFAULT_FABRIC_WORKSPACE` unset), extracts layout
from a sample PDF in ADLS, and lands the parsed fields in a silver Delta table — run id + first 300
chars of the real analyze response in the PR. Repeat for one of Vision/Language/Translator. Canvas
palette shows the "AI enrich" group; every node property is a typed control, zero JSON textareas.

---

## Item 2 — AI Search cognitive skillsets (P1, L)

**Capability.** Author chained built-in cognitive skills (OCR → Vision → Doc-Intel → Entity/Key-phrase
→ Translation → AOAI embedding) on an AI Search indexer — parity with the Azure/Fabric
"Import and vectorize data" wizard, so unstructured content is enriched *and* vectorized in one pass.

**Source-product grounding.**
- Debug a skillset (skill chain semantics): https://learn.microsoft.com/azure/search/cognitive-search-how-to-debug-skillset

**Current Loom state — PARTIAL.**
- `lib/azure/aisearch-client.ts:165-238` implements **only the debug-session lifecycle** (`listDebugSessions` / create / delete / status over `…/debugSessions`) for *tracing* an existing indexer + skillset. There is **no skillset CRUD and no skill-chain authoring UI** anywhere. Loom already emits an AOAI embedding skill for its vector indexes, but the user cannot compose the enrichment chain that feeds it.

**Azure-first / OSS build.**
- **Client:** extend `aisearch-client.ts` with skillset CRUD (`PUT/GET/DELETE /skillsets/{name}?api-version=…`) composing built-in skills — `OcrSkill`, `ImageAnalysisSkill` (Vision), `EntityRecognitionSkill` / `KeyPhraseExtractionSkill` (Language), a Document-Intelligence-layout custom skill (calls item 1's `doc-intelligence-client`), `TextTranslationSkill` — chained into the AOAI embedding skill Loom already produces.
- **UI:** add a **"Skillset"** tab to the AI Search editor — an **ordered skill-chain builder** (a `canvas-node-kit` card list, one card per skill, each with input/output field-mapping dropdowns bound to the index schema; reorder by drag). Reuses the already-built indexer status polling to show enrichment progress; the existing debug-session view becomes the "trace" affordance on the same tab.
- **BFF:** `app/api/items/ai-search/[id]/skillset/route.ts` (GET/PUT/DELETE) → skillset client; validation of session + real Search REST.
- **Catalog wiring:** no new item — extends the existing `ai-search` catalog item's editor surface (`ui-parity` inventory row added to `docs/fiab/parity/ai-search.md`).
- **Bicep:** none new — reuses the AI Search service + the item-1 Cognitive account the skills bind to (skillsets reference a Cognitive Services key/identity; wire the Console UAMI or the account's identity per Learn's keyless skillset pattern).
- **Gov.** AI Search, Vision, and Language are Gov GA; Document Intelligence is Gov GA via the sovereign audience — the skill chain runs in Gov. Honest-gate any individual skill whose backing account env var is unset.

**Acceptance.** Creating a skillset in the editor produces a real `PUT /skillsets`, an indexer run
enriches a sample document set (OCR + entities landed as index fields) and vectorizes via the existing
AOAI embedding skill — skillset JSON returned by a real GET + a browser shot of the chain builder in
the PR. Zero ❌ rows in `docs/fiab/parity/ai-search.md`.

---

## Item 3 — Azure Health Data Services (P1, XL)

**Capability.** A real FHIR service + DICOM service + de-identification backend behind the
"Healthcare Population Health" content bundle, replacing the synthetic-CSV shim and the *manual*
Safe-Harbor claim with live FHIR ingestion and a real de-identification call.

**Source-product grounding.**
- Health Data Services overview: https://learn.microsoft.com/azure/healthcare-apis/healthcare-apis-overview
- FHIR/DICOM regional availability: https://learn.microsoft.com/azure/healthcare-apis/services-features-regional-availability

**Current Loom state — MISSING (with an active vaporware smell to correct).**
- `lib/apps/content-bundles/app-healthcare-popmgt.ts` builds a FHIR-R4-**shaped** Delta lakehouse
  (`bronze.patients` / `encounters` / `diagnoses`, lines ~56-78) and carries a **manual** disclaimer
  ("HIPAA Safe Harbor, synthetic-data-only", lines ~9-15) — there is **no de-identification service
  call and no FHIR service**. `grep healthcareapis|fhir-service|dicom` across `apps/fiab-console`
  returns zero backend hits. The bundle also frames its dashboards as **Power BI** (line ~9) — a
  `no-fabric-dependency` framing violation to fix in the same pass.

**Azure-first / OSS build.**
- **Clients:** `lib/azure/fhir-client.ts` (data-plane REST against the FHIR service — Entra RBAC per Learn's FHIR-service auth, resource search + CRUD) and `lib/azure/deidentify-client.ts` (`$deidentify` / `$export` operations).
- **Catalog item:** new `fhir-service` item with a **FHIR resource browser editor** — Patient / Encounter / Condition / Observation search + CRUD grids, same shape as the existing `cosmos-db` data browser (typed search forms, result grid, resource detail panel).
- **Pipeline activity:** `FhirExport` running the OSS **FHIR Analytics Pipelines** `$export → parquet` job, landing into the **same bronze/silver/gold tables the bundle already declares** — replacing the seed-CSV shim with a live export. The de-identify call runs as a step so bronze lands de-identified for real (retiring the manual claim).
- **Bundle fix:** re-point the Healthcare bundle at `fhir-service` as its source and swap the Power BI dashboard framing for the Loom-native report/semantic path (`no-fabric-dependency`).
- **BFF:** `app/api/items/fhir-service/[id]/{search,resource,export,deidentify}/route.ts`.
- **Bicep:** new `platform/fiab/bicep/modules/health/health-data-services.bicep` — Health Data Services workspace + FHIR service (system-assigned identity), granting the Console UAMI `FHIR Data Contributor`; optional DICOM service. Add `LOOM_FHIR_SERVICE_URL` to the env list. Gated `healthDataServicesEnabled` (default-off — provisions a metered workspace; honest-gate in the bundle install when unset).
- **Gov.** The FHIR/DICOM regional-availability table lists commercial regions explicitly — **do not assume Gov parity**. Resolve the region at deploy time and, when Health Data Services is unavailable in the target Gov region, show an honest `MessageBar` in the bundle install and the `fhir-service` editor naming the requirement, per `no-vaporware.md`, rather than silently falling back to the CSV shim.

**Acceptance.** A `FhirExport` pipeline pulls real FHIR resources from a live FHIR service through the
de-identify step into bronze Delta, and the `fhir-service` editor searches a real Patient resource —
export run id + first 300 chars of a real FHIR `Bundle` in the PR. The Healthcare bundle installs
against the real backend with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, no Power BI reference remains,
and the manual Safe-Harbor disclaimer is replaced by a real de-identification receipt.

---

## Item 4 — Azure AI Content Understanding (P2, M)

**Capability.** A unified multimodal analyzer (document / image / video / audio) for document-cracking
pipelines and RAG chunking — define extraction fields once, run against any modality.

**Source-product grounding.**
- What's new (GA API 2025-11-01): https://learn.microsoft.com/azure/ai-services/content-understanding/whats-new
- Azure Government service comparison (confirms commercial-only status): https://learn.microsoft.com/azure/azure-government/compare-azure-government-global-azure

**Current Loom state — MISSING.** No `contentunderstanding` hits anywhere in `apps/fiab-console`.

**Azure-first / OSS build.**
- **Client:** `lib/azure/content-understanding-client.ts` (analyzer CRUD + `begin-analyze` + poll) riding the **same Cognitive Services / AIServices account** `foundry-cs-client.ts` already resolves — **no new resource** needed.
- **Surface (two options, ship the analyzer item):** a standalone `content-understanding-analyzer` catalog item with a **schema-builder editor** — define extraction fields (name/type/description) via a typed field-list builder, then "test against a sample" doc/image/video/audio (mirrors Foundry's prebuilt-analyzers playground). Also expose a 6th pipeline activity `ContentUnderstandingAnalyze` alongside the item-1 family for in-pipeline document-cracking.
- **BFF:** `app/api/items/content-understanding/[id]/{analyzers,analyze}/route.ts`.
- **Bicep:** none new (reuses the AIServices account); add `LOOM_CONTENT_UNDERSTANDING_ENDPOINT` env.
- **Gov.** **Commercial-only** in the Azure Government comparison as of mid-2026 — ship with an explicit, honest **Gov-unavailable `MessageBar`** on the item and the pipeline node (per `ui-parity` / `no-vaporware` disclosure), and register the catalog item `preview: false` but `govAvailable: false`. Never silently omit.

**Acceptance.** Defining an analyzer schema and running it against a sample multimodal file returns a
real `begin-analyze` result (extracted fields) — operation id + first 300 chars in the PR. In a Gov
build the item renders fully with the honest Gov-unavailable MessageBar and the analyze button gated.

---

## Item 5 — Azure Batch application wiring (P2, M)

**Capability.** A pool/job/task navigator and a `BatchExecute` pipeline activity for
embarrassingly-parallel bulk transforms and **bulk AI inferencing fan-out** (e.g. Document
Intelligence / Content Understanding over millions of files).

**Source-product grounding.**
- FedRAMP High + all DoD impact levels incl. IL6: https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope

**Current Loom state — PARTIAL (bicep-only).**
- `platform/fiab/bicep/modules/deploy-planner/batch.bicep` fully provisions the Batch account + auto-storage + a Contributor grant, and its own comment claims a navigator manages pools/jobs over ARM — but **no `lib/azure/batch-client.ts`, no editor, and no pipeline activity exist** in `apps/fiab-console`. It provisions capacity nothing drives.

**Azure-first / OSS build.**
- **Client:** `lib/azure/batch-client.ts` — ARM pool/job/task CRUD + data-plane task submission authenticated via the account's managed identity + auto-storage.
- **Catalog item:** `batch-pool` with an **ADF-Studio-style navigator editor** (pool size / VM SKU / autoscale formula via typed controls, jobs list, task grid with stdout/stderr links) — matching the 12 existing service navigators.
- **Pipeline activity:** `BatchExecute` (`category: 'orchestration'`) fans one task per pipeline run — the canonical use is bulk item-1 / item-4 scoring across a file set.
- **BFF:** `app/api/items/batch-pool/[id]/{pools,jobs,tasks}/route.ts`.
- **Bicep:** promote `batch.bicep` from planner-only to a wired toggle; add `LOOM_BATCH_ACCOUNT` env; confirm the Console UAMI has the ARM + data-plane roles the navigator needs.
- **Gov.** **Strongest posture in this PRP** — Batch is GA across FedRAMP High and **all** DoD impact levels including IL6 (Azure Secret). Default-on in Gov where the account is deployed.

**Acceptance.** The `batch-pool` editor lists real pools/jobs/tasks over ARM, and a `BatchExecute`
pipeline node submits a real task that scores a sample file set — task id + first 300 chars of the
real task/job response in the PR. Autoscale formula and VM SKU are typed controls, no JSON.

---

## Item 6 — Azure AI Video Indexer (P2, M)

**Capability.** Media / unstructured-video analytics ingestion — transcript, faces, OCR, keyframes,
sentiment timeline — landed as a Delta table for downstream analytics.

**Source-product grounding.**
- Gov product roadmap (Video Indexer Gov GA at FedRAMP High / DoD IL4): https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap

**Current Loom state — MISSING.** No `videoindexer` hits anywhere in `apps/fiab-console`.

**Azure-first / OSS build.**
- **Client:** `lib/azure/video-indexer-client.ts` — account access + upload / index / insights REST, with the sovereign/Gov endpoint variant via `cloud-endpoints.ts`.
- **Pipeline activity:** `VideoIndexerAnalyze` landing insights into a `silver.video_insights` Delta table — the same medallion pattern the healthcare/media bundles already use.
- **Editor:** a new **media item type** with a video player + insights-timeline overlay (transcript scrub, face / OCR chips) at the depth of the existing `kql-dashboard` tile pattern.
- **BFF:** `app/api/items/video-indexer/[id]/{index,insights}/route.ts`.
- **Bicep:** `platform/fiab/bicep/modules/media/video-indexer.bicep` (`Microsoft.VideoIndexer/accounts` bound to a storage account + the existing Cognitive Services account); add `LOOM_VIDEO_INDEXER_ACCOUNT` env; default-off toggle.
- **Gov.** GA at FedRAMP High + DoD IL4 per the Gov roadmap; **not yet IL5/IL6** — fine for most Gov tenants; gate IL5+ deployments with an honest MessageBar naming the impact-level limit.

**Acceptance.** Uploading a sample video runs a real index job and the editor renders the real
transcript + face/OCR insights over the player; a `VideoIndexerAnalyze` node lands
`silver.video_insights` — job id + first 300 chars of the real insights JSON in the PR.

---

## Item 7 — Planetary Computer + Azure Open Datasets shortcuts (P3, S)

**Capability.** Public STAC geospatial / climate rasters and curated Azure Open Datasets as new
public "shortcut" targets — a near-zero-effort extension of an already-proven pattern that feeds the
existing geo editors.

**Source-product grounding.** Microsoft Planetary Computer STAC API; Azure Open Datasets blob
endpoints (public/SAS — no doc gate required for the build shape).

**Current Loom state — MISSING (pattern already proven).**
- The Healthcare bundle already proves the public-shortcut pattern (`cms-public-data`, `npi-registry`, `ahrq-ccs-mapping` shortcuts in `app-healthcare-popmgt.ts`, executed by `shortcut-engines.ts` / `shortcut-credentials.ts`). No `planetary-computer` or Open Datasets entries exist.

**Azure-first / OSS build.**
- Add **2 shortcut-engine entries**: `planetary-computer-stac` (STAC API browse + Blob SAS read for geospatial/climate rasters, feeding the **already-built `geo-map` / `geo-query` editors**) and `azure-open-datasets` (curated public datasets — weather, census, safety — via the Open Datasets blob endpoints).
- **No new bicep** — pure data-plane REST against public / SAS endpoints, reusing the existing shortcut abstraction + credential store end-to-end.
- **Gov.** Public endpoints reachable from Gov with egress allowed; honest-gate if the tenant blocks public egress, naming the required allow-list host.

**Acceptance.** A `planetary-computer-stac` shortcut resolves a real STAC item and its raster renders
in the `geo-map` editor; an `azure-open-datasets` shortcut lists real curated data — STAC response +
first 300 chars in the PR. No new resource deployed.

---

## Item 8 — Content Safety pipeline activity (P3, S) — extend the built client

**Capability.** Screen ingested free-text fields for harmful content **before** they land in
silver/gold, reusing the fully-built Content Safety client as a pipeline transform.

**Source-product grounding.** Azure AI Content Safety (already integrated).

**Current Loom state — BUILT (extend only).**
- Content Safety is wired end-to-end and **must not be re-proposed**: `lib/azure/foundry-client.ts` (real `shieldPrompt` / `moderateContent` REST), `app/api/items/content-safety/route.ts` + `blocklists` + `rai-policies` routes, `lib/editors/foundry-sub-editors.tsx` `ContentSafetyEditor`, contract tests in `lib/azure/__tests__/foundry-content-safety.test.ts`, plus the Copilot guardrail wiring.

**Azure-first / OSS build.** The only gap is pipeline reach: add **one** `activity-catalog.ts` entry
`ModerateText` (`category: 'move-transform'`) + one executor branch calling the existing
`moderateContent` — screen a free-text column, route flagged rows to a quarantine table. No new
client, BFF, or bicep. Gov: Content Safety is Gov GA — default-on.

**Acceptance.** A `ModerateText` node screens a sample free-text column against the real Content Safety
endpoint and quarantines a flagged row — run id + first 300 chars of the real moderation response.

---

## Item 9 — Azure Confidential Ledger (P3, M)

**Capability.** A tamper-evident, append-only audit trail for governance-sensitive actions
(classification changes, access-policy grants, data-product publish/approve) — non-repudiation beyond
a mutable Cosmos change-feed, which appeals directly to FedRAMP High / DoD audiences.

**Source-product grounding.** Azure Confidential Ledger (`Microsoft.ConfidentialLedger/ledgers`,
AAD member auth). Gov/DoD compliance scope is narrower than mainstream PaaS — verify at deploy time.

**Current Loom state — MISSING.** No `confidentialledger` hits in `apps/fiab-console`. The existing
governance audit trail (`governance-catalog-index.ts`, `plan-approval-client.ts`) writes **only to
Cosmos**, which is mutable by a sufficiently-privileged principal.

**Azure-first / OSS build.**
- **Client:** `lib/azure/confidential-ledger-client.ts` (write-append receipts + verified read).
- **Hook:** into the existing Cosmos-write paths for classification changes / access-policy grants / data-product approvals so each **also** POSTs an immutable receipt.
- **UI:** an **"Audit Ledger"** read-only tab on `govern-admin.tsx` showing verified receipts (receipt id, action, principal, transaction id, verification state).
- **BFF:** `app/api/admin/audit-ledger/route.ts`.
- **Bicep:** `platform/fiab/bicep/modules/governance/confidential-ledger.bicep` (`Microsoft.ConfidentialLedger/ledgers`, AAD member granting the Console UAMI `Administrator`); default-off toggle; `LOOM_CONFIDENTIAL_LEDGER` env.
- **Gov.** Compliance scope is narrower than mainstream PaaS — **verify Gov/DoD availability before enabling by default**; gate with an honest infra-check MessageBar rather than assuming parity.

**Acceptance.** A classification change writes both the Cosmos record and a real ledger receipt, and
the Audit Ledger tab reads back the **verified** receipt from the real ledger — transaction id +
first 300 chars of the real receipt in the PR.

---

## Item 10 — Microsoft Graph Data Connect (P3, L)

**Capability.** Bulk M365 organizational-analytics ingestion (Teams / SharePoint / Exchange usage
signals) into the lakehouse for people-analytics and collaboration insights.

**Source-product grounding.** Microsoft Graph Data Connect (dataset agreements + pipeline
provisioning to ADLS; requires app consent + M365 E5 / GDC add-on).

**Current Loom state — MISSING.** No Graph Data Connect hits in `apps/fiab-console`; the existing
Linked Services / Datasets UI has no GDC connector type.

**Azure-first / OSS build.**
- **Client:** `lib/azure/graph-data-connect-client.ts` (dataset-agreement + pipeline provisioning, landing to the **same ADLS Gen2 target the lakehouse already writes**).
- **Surface:** a new **linked-service type** in the existing Linked Services UI (typed dataset/agreement selection, no JSON).
- **BFF:** `app/api/items/linked-service/gdc/route.ts`.
- **Tenant gate:** GDC requires a **Graph Data Connect application consent + M365 E5 / GDC add-on** — surface as an explicit **tenant-gated honest MessageBar** (same disclosure pattern already used for Purview auto-onboard), never a default-on path.
- **Bicep:** the ADF/Synapse pipeline that runs the GDC extraction; add `LOOM_GDC_ENABLED` gate.
- **Gov.** GDC has **limited GCC-High / DoD availability** — treat as commercial-first with an honest Gov gate.

**Acceptance.** With consent granted, a GDC linked service provisions a real dataset agreement and a
pipeline lands a sample M365 dataset into ADLS — agreement id + first 300 chars of the real response.
Without consent the linked-service form renders with the honest tenant-action MessageBar.

---

## Item 11 — Chaos Studio reliability panel (P3, M) — Load Testing deferred

**Capability.** Pre-go-live **fault-injection** proof of Loom's DR runbooks against a non-prod DLZ,
complementing the quarterly teardown+redeploy validation.

**De-duplication note.** **Azure Load Testing is already owned by the enterprise-hardening PRP**
(`PRPs/active/enterprise-hardening/appendix-ops-slo-loadtest.md` §2 — full 60k profile, VNet-injected
`load-testing.bicep`, admin pane, k6/Locust harness). **Do not build a second Load Testing surface
here.** This item scopes to the net-new **Chaos Studio** capability only and links the Load Testing
work to that appendix.

**Source-product grounding.** Azure Chaos Studio (fault library, targets/capabilities registration).
Gov availability is limited/preview for several fault types.

**Current Loom state — MISSING.** No `microsoft.chaos` hits in `apps/fiab-console`; DR runbooks have
no automated fault-injection tooling.

**Azure-first / OSS build.**
- **Client:** `lib/azure/chaos-studio-client.ts` (experiment CRUD + start/stop + target/capability registration).
- **UI:** extend the ops **"Reliability"** admin panel (shared with the enterprise-hardening Load pane) with a Chaos experiment launcher — pick a fault (VM shutdown / network latency / AKS) from a **dropdown**, target a non-prod DLZ, run, and read the experiment result to exercise DR runbooks. No-freeform: faults + targets are typed selectors, not a JSON experiment doc.
- **BFF:** `app/api/admin/chaos/{experiments,runs}/route.ts`.
- **Bicep:** `platform/fiab/bicep/modules/reliability/chaos-studio.bicep` (experiment + target/capability registration on resources under test); default-off; `LOOM_CHAOS_ENABLED` gate.
- **Gov.** Chaos Studio Gov availability is limited/preview for several fault types — **verify per fault type** before enabling; honest-gate unavailable faults in the dropdown.

**Acceptance.** A Chaos experiment injects a real fault against a non-prod DLZ resource and the panel
reads the real experiment run status — experiment id + first 300 chars of the real run response in the
PR. Faults/targets are dropdowns; unavailable-in-Gov faults are honest-gated.

---

## 4. Sequencing & priority

- **P0 — build first (unblocks the AI family):** Item 1 (AI-enrichment activities + the 4 clients).
  Every other AI item (2, 4, 5, 6, 8) reuses these clients + the same Cognitive/AIServices account.
- **P1:** Item 2 (AI Search skillsets — the RAG-enrichment complement) and Item 3 (Health Data
  Services — closes a live vaporware smell in the Healthcare bundle).
- **P2:** Items 4 (Content Understanding), 5 (Batch), 6 (Video Indexer) — each a self-contained
  analytics-widening capability on the item-1 foundation.
- **P3:** Items 7 (public-data shortcuts — smallest, ship opportunistically), 8 (Content Safety
  activity — trivial extension), 9 (Confidential Ledger), 10 (Graph Data Connect), 11 (Chaos Studio).

## 5. How to use this PRP

- **Implementing agents:** build item 1 before any other AI item. Honor §2 in every PR; attach the
  real-data E2E receipt (endpoint + first 300 chars + browser/Playwright evidence) and a
  Commercial-and-Gov build/smoke note. Add/extend the `docs/fiab/parity/<slug>.md` row for any surface
  claiming parity.
- **Reviewers:** reject any PR lacking the receipt, the feature-flag/reversibility note, or the
  dual-cloud handling; reject any default-path Fabric/Power BI dependency; reject any JSON-textarea
  config; reject a Commercial-only service (items 4, 10, and parts of 3/6/11) that omits the honest
  Gov MessageBar gate instead of surfacing it.

## 6. Sources (Microsoft Learn)

- Document Intelligence layout / prebuilt — analyze REST.
- FedRAMP High / DoD IL audit-scope list (Doc Intelligence, Computer Vision, Language, Translator, Batch).
- AI Search — debug + author a skillset (built-in cognitive skills, skill chaining).
- Azure Health Data Services overview + FHIR/DICOM regional availability.
- Content Understanding — what's new (GA 2025-11-01) + Azure Government service comparison (commercial-only).
- Azure Government product roadmap (Video Indexer FedRAMP High / IL4).
- Azure Confidential Ledger, Microsoft Graph Data Connect, Azure Chaos Studio (Gov availability caveats verified per service).
