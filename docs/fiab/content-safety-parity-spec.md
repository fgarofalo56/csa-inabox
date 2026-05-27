# Loom Content Safety Editor — AI Foundry parity spec

> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Sources: Microsoft Learn — [Content Safety in Foundry portal](https://learn.microsoft.com/azure/foundry-classic/ai-services/content-safety-overview), [Prompt Shields](https://learn.microsoft.com/azure/ai-services/content-safety/concepts/jailbreak-detection), [Default safety policies](https://learn.microsoft.com/azure/ai-foundry/openai/concepts/default-safety-policies), [Configure content filters](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/content-filters), [Mitigate false results](https://learn.microsoft.com/azure/ai-services/content-safety/how-to/improve-performance). Cross-checked against `apps/fiab-console/lib/editors/foundry-sub-editors.tsx::ContentSafetyEditor` (lines 379–436) and BFF route `app/api/items/content-safety/route.ts`.

## What it is

**Azure AI Content Safety** is a moderation service that classifies prompts and completions across four harm categories with four severity levels each, plus six specialised classifiers (Prompt Shields jailbreak / indirect, protected material text / code, groundedness, custom categories). It exposes both a stand-alone REST API and a content-filter integration inside Azure OpenAI / AI Foundry deployments.

The Foundry portal surfaces four operator workflows:

- **Try it / Playground** — interactive moderation of a single piece of text, image, or document with the current severity thresholds
- **Blocklists** — per-resource keyword / regex term lists that always block (or always allow) regardless of classifier output
- **Custom categories** — train and deploy a custom binary classifier (positive / negative term sets, model versions, deployment status)
- **Content filter configurations** — named bundles of category thresholds + Prompt Shields + protected material + custom blocklists, assigned to one or more Azure OpenAI deployments
- **Monitoring** — incidents and metrics from filters in production

## UI components

### Page chrome
- Title bar: resource name, region, pricing tier
- Right-side actions: **+ New configuration**, **Refresh**, **Settings**, **Share**, **Open in Azure portal**

### Try-it / Playground (default tab)
- Radio: **Text** / **Image** / **Multimodal (text + image)** / **Document** (with embedded prompt-injection check)
- Input area: text box or file upload (image / PDF)
- **Harm category sliders** (4 sliders, 0–7 severity scale, default 4 = Medium): **Hate / Fairness**, **Sexual**, **Violence**, **Self-Harm**
- Toggle row: **Prompt Shields — direct (jailbreak)**, **Prompt Shields — indirect (XPIA)**, **Protected material — text**, **Protected material — code**, **Groundedness** (when "Document" is selected)
- **Custom categories** multi-select: lists deployed custom classifier versions
- **Blocklist** multi-select: lists blocklists bound to this resource
- **Run test** button → calls `/text:analyze` or `/image:analyze` or `/text:shieldPrompt` and shows:
  - Per-category result chips: category name + severity score + pass/block badge
  - Prompt-shield boolean (attackDetected) + sub-type (Attempt to change system rules / Conversation mockup / Role-Play / Encoding / Manipulated content / Allowing compromised LLM access / Information gathering / Availability / Fraud / Malware)
  - Protected material match annotations (citation + license)
  - Raw response JSON expander
- **Compare with ground truth** panel: paste expected verdict, get false-positive / false-negative diagnosis

### Blocklists tab
- Grid of blocklists: **Name**, **Description**, **Term count**, **Created**, **Modified**
- **+ New blocklist** → name, description, then per-blocklist editor: terms grid (`text`, `isRegex` bool, `description`); bulk import from CSV
- Per-term match type: exact / regex / fuzzy
- **Test blocklist** sub-panel: enter sample text, see which terms hit

### Custom categories tab
- Grid: **Name**, **Definition**, **# positive samples**, **# negative samples**, **Latest version**, **Status** (NotStarted / Training / Succeeded / Failed)
- **+ Build a custom category** wizard:
  - Step 1: name + plain-English definition (used as the seed prompt for the classifier)
  - Step 2: positive samples (≥50 recommended) + negative samples (≥50)
  - Step 3: training options — model version, training compute size
  - Step 4: review + submit; submission writes to `{resource}/text/categories/{name}/versions/{version}:build`
- Per-version detail: training metrics (accuracy, precision, recall, F1), deploy / undeploy actions, test panel

### Content filter configurations tab
- Grid of configurations: **Name**, **Used by # deployments**, **Created**, **Modified**
- **+ Create configuration** wizard (Azure OpenAI integration path):
  - Step 1 — Basics: name, description
  - Step 2 — Input filter (prompt): per-category severity threshold (Low / Medium / High / Off) + Prompt Shields (direct on/off, indirect on/off) + blocklist multi-select + custom-categories multi-select
  - Step 3 — Output filter (completion): per-category severity + Protected material text on/off + Protected material code on/off + groundedness on/off + blocklist + custom categories
  - Step 4 — Apply to deployments: multi-select Azure OpenAI deployments
  - Step 5 — Review + create
- Per-config detail: deployment list, sample-request inspector, defaults reset button

### Monitoring tab
- Time-windowed chart of: blocked-prompt rate, blocked-completion rate, total requests
- Top categories triggered
- Recent incidents table: timestamp, deployment, category, severity, snippet (subject to abuse-monitoring data-retention rules)

## What Loom has

Current `ContentSafetyEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` lines 379–436) is real-REST wired to a Content Safety resource via `lib/azure/foundry-client.ts::moderateText / moderateImage / listContentSafetyPolicies` and BFF route `GET|POST /api/items/content-safety`. The client is env-gated: when `LOOM_CONTENT_SAFETY_ENDPOINT` is unset, the BFF returns 503 + `notDeployed:true` and the editor surfaces an honest "Not yet provisioned" warning bar.

- Loads the default policies summary (single hard-coded entry: `{ name: 'default', thresholds: { hate:4, selfHarm:4, sexual:4, violence:4 } }`)
- **Text moderation** card: textarea + **Analyze text** button → POSTs `{ kind:'text', text }`, calls `/contentsafety/text:analyze?api-version=2024-09-01`, dumps result JSON in `<pre>`
- **Image moderation** card: file picker (base64 client-side) + **Analyze image** button → POSTs `{ kind:'image', imageBase64 }`, calls `/contentsafety/image:analyze?api-version=2024-09-01`
- Errors / not-deployed surface honestly via `ErrorBar`
- No blocklists, no custom categories, no filter configurations, no Prompt Shields, no monitoring

That is: Loom can run a single moderation call against the default category set and render raw JSON, but everything else in the Foundry portal is missing.

## Gaps for parity

1. **Harm-category sliders** — the four severity thresholds are not exposed in the UI; the call uses the resource default (Medium across the board). Foundry shows 4 sliders 0–7.
2. **Prompt Shields** — no UI for `/text:shieldPrompt`, no toggle for direct (jailbreak) vs indirect (XPIA / document-embedded) attacks, no rendering of the 9 sub-type categories.
3. **Protected material** — no toggle / no display of citation + license annotations when text or code matches a known protected source.
4. **Groundedness detection** — no UI for document-grounded moderation (requires document embedding format).
5. **Blocklists** — no list view, no editor, no per-term match-type picker, no CSV bulk import.
6. **Custom categories** — no wizard to train a custom classifier, no version list, no train/deploy actions.
7. **Content filter configurations** — no UI for the named-bundle abstraction (input vs output filters, deployment binding); this is the bridge between Content Safety and Azure OpenAI deployments.
8. **Multimodal (text + image)** — only text or image alone; the combined call is missing.
9. **Document upload** — no PDF / docx ingest with embedded-instruction detection.
10. **Ground-truth comparison panel** — no false-positive / false-negative triage aid (called out in the Microsoft "Mitigate false results" guide as the recommended operator workflow).
11. **Monitoring** — no incidents view, no blocked-rate chart, no top-categories surface.
12. **Policies stub is fake-honest** — `listContentSafetyPolicies` returns a single hard-coded "default" entry. Should be replaced with real reads from `{resource}/text/blocklists`, `{resource}/text/categories`, and (for OpenAI integration) `{aoai-resource}/contentFilters?api-version=...` once those are wired.

## Backend mapping

Two REST surfaces: the **Content Safety data plane** at `https://{resource}.cognitiveservices.azure.com/contentsafety/...` and the **Azure OpenAI ARM resource provider** at `Microsoft.CognitiveServices/accounts/{aoai}/raiPolicies/...` for filter configurations.

| Loom surface | Backend call |
|---|---|
| Analyze text (with sliders + custom categories + blocklists) | `POST {ep}/contentsafety/text:analyze?api-version=2024-09-01` body `{ text, categories?, blocklistNames?, haltOnBlocklistHit?, outputType? }` (wired; UI under-uses it) |
| Analyze image | `POST {ep}/contentsafety/image:analyze?api-version=2024-09-01` (wired) |
| Multimodal | `POST {ep}/contentsafety/multimodal:analyze?api-version=2024-09-15-preview` |
| Prompt Shields | `POST {ep}/contentsafety/text:shieldPrompt?api-version=2024-09-01` body `{ userPrompt, documents[] }` |
| Detect protected material — text | `POST {ep}/contentsafety/text:detectProtectedMaterial?api-version=2024-09-01` |
| Detect protected material — code | `POST {ep}/contentsafety/text:detectProtectedMaterialForCode?api-version=2024-09-15-preview` |
| Groundedness | `POST {ep}/contentsafety/text:detectGroundedness?api-version=2024-09-15-preview` |
| List blocklists | `GET {ep}/contentsafety/text/blocklists?api-version=2024-09-01` |
| CRUD blocklist | `PATCH / DELETE {ep}/contentsafety/text/blocklists/{name}` |
| CRUD blocklist items | `POST .../blocklists/{name}:addOrUpdateBlocklistItems`, `:removeBlocklistItems` |
| List custom categories | `GET {ep}/contentsafety/text/categories?api-version=2024-09-15-preview` |
| Build custom category | `POST {ep}/contentsafety/text/categories/{name}/versions/{ver}:build` |
| Deploy custom category | `POST {ep}/contentsafety/text/categories/{name}/versions/{ver}:deploy` |
| List filter configurations (AOAI-side) | `GET {arm}/.../accounts/{aoai}/raiPolicies?api-version=2024-10-01` |
| Create / update filter config | `PUT {arm}/.../accounts/{aoai}/raiPolicies/{name}` |
| Monitoring metrics | `POST {arm}/.../accounts/{aoai}/providers/microsoft.insights/metrics:query` for `BlockedPrompts` / `BlockedCompletions` |

New helpers required in `foundry-client.ts`: `shieldPrompt`, `detectProtectedMaterial`, `detectGroundedness`, `listBlocklists`, `upsertBlocklist`, `addBlocklistItems`, `removeBlocklistItems`, `listCustomCategories`, `buildCustomCategory`, `deployCustomCategory`, `listRaiPolicies`, `upsertRaiPolicy`.

## Required Azure resources

- **Azure AI Content Safety** resource (`Microsoft.CognitiveServices/accounts` kind=`ContentSafety`) — env var `LOOM_CONTENT_SAFETY_ENDPOINT` already gates the editor; Standard tier required for custom categories and blocklists (Free tier limits)
- **Loom UAMI roles**: `Cognitive Services User` on the Content Safety account; `Cognitive Services Contributor` to write blocklists / categories / RAI policies
- **Azure OpenAI** account (`Microsoft.CognitiveServices/accounts` kind=`OpenAI`) — required for the **Content filter configurations** tab (raiPolicies live on the AOAI resource); UAMI needs `Cognitive Services OpenAI Contributor`
- **Storage** — none required for moderation itself, but custom-category training data and exported results land in the workspace storage account
- **Bicep**: add `modules/cognitive/content-safety.bicep` (already partially present in the AI Foundry orchestrator) and a role-assignment block for the Loom UAMI. Wire the endpoint into `apps[]` env in `admin-plane/main.bicep` as `LOOM_CONTENT_SAFETY_ENDPOINT`.

`MessageBar intent="warning"` triggers: `LOOM_CONTENT_SAFETY_ENDPOINT` unset (already honest), Free-tier resource selected (custom categories disabled), Loom UAMI missing `Cognitive Services Contributor` (blocklist / category writes will 403).

## Estimated effort

**3 sessions** to reach grade B:

- **Session N+1 (~2 hrs):** Replace raw-JSON dump with structured result cards. Add the four harm-category sliders + Prompt Shields toggle + Protected material toggles to the Try-it tab. Wire `shieldPrompt` and `detectProtectedMaterial` helpers.
- **Session N+2 (~2.5 hrs):** Blocklists tab — list, create, term editor with regex / exact / fuzzy, CSV bulk import, "Test blocklist" sub-panel. Replace the hard-coded `listContentSafetyPolicies` with real `listBlocklists` + category reads.
- **Session N+3 (~3 hrs):** Custom categories tab (4-step training wizard, version list, deploy action). Content filter configurations tab (named bundles, input + output filters, deployment binding via `raiPolicies` PUT). Multimodal + Document analysis branches.

Grade A+ adds Vitest coverage on the blocklist regex validation, a Playwright walk against a seeded resource with one blocklist + one custom category + one filter config, and bicep wiring the Content Safety resource into the FiaB orchestrator (already documented in `no-vaporware.md` as a required infra side-car).
