# AI Builder Model Editor — model-types parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (AI Builder overview · model types · custom + prebuilt models · AI Builder in Power Apps + Power Automate) and inspection of `apps/fiab-console/lib/editors/powerplatform-editors.tsx::AiBuilderModelEditor` + `apps/fiab-console/lib/azure/powerplatform-client.ts`. Loom has working Dataverse `msdyn_aimodel` read with template-name expand (UAT-verified); this spec compares Loom's current surface against the full AI Builder authoring UX inside Power Apps / Power Automate.

## Overview

AI Builder is Power Platform's low-code AI engine. Models live as Dataverse records in `msdyn_aimodel`, are exposed through Power Apps (formula-bar Power Fx functions + AI Builder canvas/model-driven components) and Power Automate (`AI Builder` connector actions), and split into two build types:

- **Prebuilt** — Microsoft-trained, ready to use immediately, scoped to common cross-industry scenarios
- **Custom** — Maker-trained on the maker's own data (text · documents · images · structured rows), iteratively refined and published to the env

Each model has a template (the underlying schema and inference engine — e.g., `SentimentAnalysis`, `EntityExtraction`, `DocumentScanning`, `BinaryPrediction`, `ObjectDetection`), a state (Active / Inactive), a status (Draft / Trained / Published / Training / Training-failed / Publishing), training data references, optional version history, and a usage / capacity consumption profile (each model type has its own per-call rate).

## AI Builder model catalog

### Model types by data category

| Category | Type | Template (`msdyn_aitemplate.UniqueName`) | Build |
|---|---|---|---|
| **Text** | Sentiment analysis | `SentimentAnalysis` | Prebuilt |
| **Text** | Key phrase extraction | `KeyPhraseExtraction` | Prebuilt |
| **Text** | Language detection | `LanguageDetection` | Prebuilt |
| **Text** | Text translation | `TextTranslation` | Prebuilt |
| **Text** | Entity extraction | `EntityExtraction` | Prebuilt + Custom |
| **Text** | Category classification | `TextClassificationV2` | Prebuilt + Custom |
| **Text** | Text generation with GPT (4o / 4o-mini) | `GptPowerPrompt` | Prebuilt |
| **Documents** | Business card reader | `BusinessCard` | Prebuilt |
| **Documents** | Receipt processing | `ReceiptScanning` | Prebuilt |
| **Documents** | Invoice processing | `InvoiceProcessing` | Prebuilt |
| **Documents** | ID reader | `IdentityDocument` | Prebuilt (preview) |
| **Documents** | Contract processing | `ContractDocument` | Prebuilt (preview) |
| **Documents** | Document processing (form extraction) | `DocumentScanning` | Custom |
| **Documents** | Text recognition (OCR) | `TextRecognition` | Prebuilt |
| **Images** | Image description | `ImageDescription` | Prebuilt (preview) |
| **Images** | Object detection | `ObjectDetection` | Custom |
| **Structured** | Prediction (binary or multi-class) | `BinaryPrediction` / `GenericPrediction` | Custom |
| **Bring-your-own** | Azure Machine Learning model | (BYO) | Custom |

### Build-a-custom-model UX (e.g., Document Processing)
1. **Choose model type** — pick from gallery of cards
2. **Add training data** — upload PDF/JPG/PNG documents (5+ minimum, 50+ recommended)
3. **Define fields / classes / objects** — annotate the data: tag fields on documents, tag entities in text, label categories, draw bounding boxes on images, choose target column for prediction
4. **Train** — async job (minutes to hours depending on data volume + model type); progress bar + estimated time
5. **Evaluate** — per-class precision · recall · F1 · accuracy; confusion matrix; per-row prediction
6. **Publish** — make the model callable from Power Apps + Power Automate
7. **Use in app / flow** — model picker appears in `AI Builder` connector actions + Power Apps `Predict()` / `AIClassify()` formula functions
8. **Retrain on new data** — version each train, can revert
9. **Quick test** — paste sample text / drop a sample file → live inference with confidence scores

### Per-model detail screen
- Name · description · category · template · build type
- State (Active / Inactive toggle) · Status badge (Draft / Trained / Published / Training / Training-failed / Publishing)
- Training data tab: list of source files / Dataverse table / column mapping
- Schema tab: fields / classes / labels
- Evaluation tab: precision · recall · F1 · confusion matrix · per-example correctness
- Versions tab: train history with restore
- Usage tab: per-day inference count · failure rate · top consumers (apps / flows that use it)
- Settings tab: API throttling, retry, scheduled retraining cadence
- Security: who can use the model (security roles · sharing)
- **Quick test** flyout: live inference UI per model type

### AI Hub
- Catalog of all prebuilt + your custom models
- Filter by data type · build type · published-only
- Marketplace-style cards
- Per-card metrics: total inferences this month, last-used app/flow

### Use-in-Power-Apps surface
- **Power Fx formulas (preview)**: `AISentiment("text")`, `AIClassify("text", model)`, `AIExtract(model, "text")`
- **Components (canvas)**: Business card reader · Receipt processor · Text recognizer · Form processor · Object detector — drag-and-drop onto a screen, configure `OnDetect` to act on result
- **Components (model-driven)**: Business card reader as a quick-create form control

### Use-in-Power-Automate surface
- AI Builder connector actions (one per template), e.g.:
  - `Analyze positive or negative sentiment in text` → Sentiment analysis
  - `Extract information from documents` → Document processing
  - `Predict whether something will happen by record ID` → Prediction
  - `Create text with GPT using a prompt` → AI prompts (`GptPowerPrompt`)
- Each action requires the model GUID + input + asynchronous-pattern setting **On**

### Capacity + licensing
- AI Builder is metered by **service credits** (per-call cost varies by model type)
- Each env has an allocation: credits/month
- Per-call rate card in the Microsoft Power Platform Licensing Guide
- Throttling: e.g., language detection / sentiment / key phrase share a 400-calls-per-60-seconds-per-env limit

## What Loom has today

From `apps/fiab-console/lib/editors/powerplatform-editors.tsx::AiBuilderModelEditor` and `apps/fiab-console/lib/azure/powerplatform-client.ts`:

- **Environment picker** (shared)
- **List models** — `GET /api/data/v9.2/msdyn_aimodels?$select=msdyn_aimodelid,msdyn_name,msdyn_modelcreationcontext,msdyn_typename,_msdyn_templateid_value,statecode,statuscode,createdon,modifiedon&$expand=msdyn_TemplateId($select=msdyn_name)`
- **Models table** — Name (clickable) · Template / Type · State badge (Active / Inactive) · Status badge (Draft / Trained / Published / Training / Training-failed / Publishing) · Modified
- Status enum is correctly mapped (`statuscode` 1–6 → human label)
- **Click a model** → detail view
- **Get model** — `GET .../msdyn_aimodels(<id>)?$expand=msdyn_TemplateId($select=msdyn_name)`
- **Detail metadata grid** — Name · Model ID · Template · Type · Creation context · State badge · Status badge · Created · Modified
- Reload button + error MessageBar with hint
- Ribbon stub: Reload · Open in Power Platform

## Gaps for parity

1. **No `+ New model` create flow** — can't pick template (Sentiment / Entity extraction / Category classification / Document processing / Prediction / Object detection / Text recognition / GPT prompt) and instantiate a Draft model
2. **No training-data attach** — can't upload PDFs / images, can't bind a Dataverse table + column for Prediction, can't bind a folder for Object detection
3. **No annotation UI** — can't tag fields on a document (Document processing), can't tag entities in text (Entity extraction), can't draw bounding boxes (Object detection), can't label rows (Category classification)
4. **No train / retrain** — can't kick off a training job, can't show training progress (estimated time, queued / running / done)
5. **No evaluation surface** — precision · recall · F1 · confusion matrix · per-example correctness not rendered
6. **No publish / unpublish** — Loom shows `Published` status (3) but can't transition Draft → Trained → Published from inside the editor
7. **No quick test / inference UI** — can't paste sample text or drop a sample file to see live model output
8. **No versions tab** — train history not surfaced; can't restore a previous trained version
9. **No usage metrics** — no per-day inference count, no failure rate, no top consumers (which apps / flows use this model)
10. **No service-credit consumption** — env-level AI Builder credit usage vs allocation not surfaced (governance gap — AI Builder is metered)
11. **No state toggle** — Active / Inactive not editable from Loom
12. **No share / security role binding** — can't grant other security roles the right to use this model
13. **Inference invocation** — no direct call to `msdyn_RunModel` / connector action from Loom for an ad-hoc test
14. **Prebuilt-model catalog** — Loom lists only models that exist in `msdyn_aimodels`; the **AI Hub** card view that shows every available prebuilt template (whether instantiated or not) is missing — makers can't discover "Microsoft already ships a sentiment-analysis model, I don't need to build one"
15. **Power Fx formula hand-off** — for canvas-app use, no copy-to-clipboard snippet `AIClassify(<modelId>, …)` for the model
16. **Power Automate hand-off** — no copy-to-clipboard for the AI Builder connector action with the model GUID prefilled
17. **BYO Azure ML model** — `byo-model` template type and the upload flow not surfaced
18. **GPT-prompt template** — `GptPowerPrompt` model type (Text generation with GPT-4o / 4o-mini) is special — it's a "prompt library" inside AI Builder — and Loom doesn't surface the prompt body, input variables, output schema, or test play
19. **Throttling indicator** — when an env is rate-limited, no MessageBar surfaces the per-env per-template throttling cap
20. **Region availability** — some AI Builder model types aren't available in every region (notably Gov clouds); Loom doesn't warn at create-time

## Backend mapping

Live Dataverse Web API is the canonical path (Loom has read working):
- **Models** — `msdyn_aimodels` (id `msdyn_aimodelid`, name `msdyn_name`, template `_msdyn_templateid_value` → `msdyn_aitemplates`, type `msdyn_typename`, creation context `msdyn_modelcreationcontext`, state `statecode`, status `statuscode`)
- **Templates** — `msdyn_aitemplates` (one row per built-in template — `SentimentAnalysis`, `EntityExtraction`, etc.); read-only
- **Create model** — `POST /api/data/v9.2/msdyn_aimodels` with `{ msdyn_name, "msdyn_TemplateId@odata.bind": "/msdyn_aitemplates(<templateId>)" }`
- **Update model** — `PATCH .../msdyn_aimodels(<id>)`
- **Delete model** — `DELETE .../msdyn_aimodels(<id>)` (only when state = Inactive)
- **Training data** — depends on template; e.g., `msdyn_aibuilderfile` for uploaded documents, `msdyn_aibuilderdatasetfile` for image-collection-bound object-detection data
- **Train** — `POST .../msdyn_aimodels(<id>)/Microsoft.Dynamics.CRM.msdyn_AIModelTrain` (unbound action)
- **Publish** — `POST .../msdyn_aimodels(<id>)/Microsoft.Dynamics.CRM.msdyn_AIModelPublish`
- **Unpublish** — `POST .../msdyn_aimodels(<id>)/Microsoft.Dynamics.CRM.msdyn_AIModelUnpublish`
- **Quick-test / inference** — invoke via the Power Automate AI Builder connector (`https://api.flow.microsoft.com/.../runActions` against an AI Builder action), or via the per-template prediction endpoint (`POST .../msdyn_RunModel` style unbound actions; specifics vary per template)
- **Evaluation results** — `msdyn_aimodelevaluation` / `msdyn_aimodelevaluationdetail`
- **Versions** — `msdyn_aimodelversion`
- **Usage telemetry** — `msdyn_aibuildermetric` per-env credit consumption
- **BYO model** — `msdyn_byoaimodel` row + Azure ML workspace + endpoint URL

## Required Azure resources / tenant settings

- Dataverse-enabled Power Platform environment (AI Builder requires Dataverse)
- MSAL Web App SP as Application User with `System Administrator` (full CRUD) or `AI Builder Maker` security role on each env
- AI Builder license: per-user OR per-env service-credit allocation; without credits, training jobs fail and inference is throttled
- For BYO Azure ML model: Azure ML workspace (`Microsoft.MachineLearningServices/workspaces`) + deployed online endpoint + auth key
- Region availability — confirm each template is GA in the env's region (Gov clouds have partial availability; document processing + prediction + custom classification typically yes, GPT-based + ID reader + Contract processing typically preview-only or absent)
- For GPT prompt (`GptPowerPrompt`) template: tenant-level toggle "AI Builder generative AI features" must be enabled by the Power Platform admin

## Estimated effort

4 sessions. State toggle + Publish / Unpublish + Delete (when inactive) + quick-test inference (deep-link out to maker portal for the test UI) is ~0.5 session. Create model from a template + AI Hub catalog (read `msdyn_aitemplates` and merge with instantiated models) is ~1 session. Training-data attach + annotation hand-off (deep-link out to `make.powerapps.com/.../aibuilder/explore/model/<id>/build` for full annotation UI) + train / retrain async with progress is ~1 session. Evaluation tab (read `msdyn_aimodelevaluation`) + versions tab + usage metrics + service-credit consumption card is ~1 session. Power Fx + Power Automate copy-to-clipboard snippets + BYO Azure ML + GPT-prompt-library full authoring are smaller follow-ups (~0.5 session). Full in-Loom annotation UI is **not feasible** — recommend deep-link to the AI Builder authoring surface and focus Loom on metadata + governance + lifecycle.
