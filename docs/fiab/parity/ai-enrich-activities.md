# ai-enrich-activities — parity with the ADF / Fabric "AI" pipeline activity family

Source UI:
- Azure Data Factory / Fabric Data pipeline **Activities** pane — the AI / Cognitive
  transform steps that enrich data in-flow.
- Azure AI Document Intelligence — layout / prebuilt analyze
  (https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/layout).
- Azure AI Vision — Image Analysis 4.0
  (https://learn.microsoft.com/azure/ai-services/computer-vision/how-to/call-analyze-image-40).
- Azure AI Language — analyze-text (PII / sentiment / entities / key phrases).
- Azure AI Translator — Text Translation v3.0.
- Azure AI Content Safety — text:analyze (SVC-8).

Loom builds these as a first-class **"AI enrich"** palette group on the data-pipeline
canvas. Each activity is a **real ADF `WebActivity`** that calls the cognitive
data-plane endpoint with the factory's **managed identity** (no key), discriminated by
a `_loomKind` user property (mirroring the ApprovalWebhook pattern) so it saves +
validates + runs against the deployed Data Factory — **no Microsoft Fabric dependency**.
Every property is a typed control; the request URL + body are composed for the user
(no JSON textarea). A live **"Test on a sample"** button runs the real cognitive call
via the preview BFF route.

## Source feature inventory (every capability)

| # | Capability (ADF/Fabric AI activity) | Loom coverage |
|---|-------------------------------------|---------------|
| 1 | Document extraction (OCR, layout, tables, key-value, prebuilt fields) | ✅ `DocumentIntelligenceAnalyze` — prebuilt model dropdown + source-URL expression |
| 2 | Image analysis (caption, OCR read, tags, objects, people) | ✅ `VisionAnalyzeImage` — feature multiselect + image-URL expression |
| 3 | Text PII detection / redaction | ✅ `LanguageAnalyzeText` (PiiEntityRecognition) |
| 4 | Sentiment analysis | ✅ `LanguageAnalyzeText` (SentimentAnalysis) |
| 5 | Entity recognition | ✅ `LanguageAnalyzeText` (EntityRecognition) |
| 6 | Key-phrase extraction | ✅ `LanguageAnalyzeText` (KeyPhraseExtraction) |
| 7 | Machine translation (one/many target languages, auto-detect source) | ✅ `TranslateText` — target-language list + optional source |
| 8 | Harmful-content moderation of ingested free text | ✅ `ModerateText` (SVC-8) — category multiselect |
| 9 | Typed property panel (no raw JSON) | ✅ dropdowns / multiselect / expression fields; URL + body composed |
| 10 | Managed-identity auth to the cognitive endpoint | ✅ WebActivity `authentication.type = MSI`, resource `cognitiveservices.azure.com` |
| 11 | "Test on a sample" before running the pipeline | ✅ preview route hits the real cognitive backend |
| 12 | Sovereign-cloud (Gov) support | ✅ token audience via `cogScope()` (`cognitiveservices.azure.us` in Gov); all five services are in the FedRAMP High / DoD IL audit scope |
| 13 | Honest infra gate when the account is not deployed | ✅ MessageBar names `LOOM_<SVC>_ENDPOINT` + `cognitive-account.bicep` |

## Backend per control

| Control | Backend REST (data plane) |
|---------|---------------------------|
| DocumentIntelligenceAnalyze (Test) | `POST {ep}/documentintelligence/documentModels/{model}:analyze` → poll `operation-location` (`lib/azure/doc-intelligence-client.ts`) |
| VisionAnalyzeImage (Test) | `POST {ep}/computervision/imageanalysis:analyze?features=…` (`lib/azure/ai-vision-client.ts`) |
| LanguageAnalyzeText (Test) | `POST {ep}/language/:analyze-text` (`lib/azure/ai-language-client.ts`) |
| TranslateText (Test) | `POST {ep}/translator/text/v3.0/translate?to=…` (`lib/azure/ai-translator-client.ts`) |
| ModerateText (Test) | `POST {ep}/contentsafety/text:analyze` (existing `lib/azure/foundry-client.ts` `moderateText`) |
| In-pipeline run | ADF `WebActivity` (MSI) → the same endpoint, executed by the deployed factory |
| Preview BFF | `POST /api/items/ai-enrich/[service]/preview` (session-gated, stateless cognitive probe) |

Auth: the Console UAMI (preview route) **and** the ADF factory managed identity
(in-pipeline run) each need **Cognitive Services User** on the account —
granted by `platform/fiab/bicep/modules/deploy-planner/cognitive-account.bicep`.

## Provisioning (bicep-synced)

Each service is an independent single-kind Cognitive Services account (Entra-only,
custom subdomain):

| Service | Kind | main.bicep toggle |
|---------|------|-------------------|
| Document Intelligence | `FormRecognizer` | `documentIntelligenceEnabled` (`dpDocIntel`) |
| Vision | `ComputerVision` | `visionServicesEnabled` (`dpVision`) |
| Language | `TextAnalytics` | `languageServicesEnabled` (`dpLanguage`) |
| Translator | `TextTranslation` | `translatorEnabled` (`dpTranslator`, added by SVC-1) |
| Content Safety | `ContentSafety` | `contentSafetyEnabled` (default ON) |

Endpoints are wired per deployment via `/admin/env-config`
(`LOOM_DOCINTEL_ENDPOINT` / `LOOM_VISION_ENDPOINT` / `LOOM_LANGUAGE_ENDPOINT` /
`LOOM_TRANSLATOR_ENDPOINT` / `LOOM_CONTENT_SAFETY_ENDPOINT`, plus their
`NEXT_PUBLIC_` mirror for the canvas URL prefill) — tracked by the `svc-ai-enrich`
self-audit check. Per WAVES.md default-ON/opt-out, the endpoint var is a wiring
selector, not an enablement switch; the only "off" state is the honest infra gate.

## Gov note

All five services are in the FedRAMP High / DoD IL4–IL5 audit scope, so the AI-enrich
family is safe to enable by default in Gov; the token audience resolves to
`cognitiveservices.azure.us` via `cogScope()`. Speech is intentionally deferred
(no analytics-pipeline use in this wave).

Status: **A-grade** — every inventory row is built ✅; zero ❌, zero stub banners.
The only non-functional state is the honest `LOOM_<SVC>_ENDPOINT` infra gate.
