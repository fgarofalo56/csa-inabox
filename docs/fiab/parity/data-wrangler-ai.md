# data-wrangler-ai — parity with Microsoft Fabric Data Wrangler (AI-assisted prep)

Source UI:
- **Fabric Data Wrangler → AI-powered capabilities** — inside the notebook Data
  Wrangler, an AI panel that (a) surfaces suggested cleaning operations from the
  data profile, (b) applies AI functions to a column, and (c) turns a
  natural-language request into a transform previewed before it is added, with
  the generated code inserted back into the notebook.
  - https://learn.microsoft.com/fabric/data-science/data-wrangler-ai
  - https://blog.fabric.microsoft.com/en-US/blog/enhance-data-prep-with-ai-powered-capabilities-in-data-wrangler-preview/

Loom surface: the notebook **Data Wrangler** panel
(`apps/fiab-console/lib/components/notebook/data-wrangler-panel.tsx`) now has two
tabs — **Prepare** (the existing operation gallery + live pandas-host preview)
and **AI assist** (`lib/components/notebook/wrangler-ai-tab.tsx`). The AI tab is
backed by `app/api/notebook/[id]/wrangler-ai/route.ts` (suggestions + NL codegen,
Azure OpenAI) and the merged item-scoped AI-function batch endpoint
`app/api/items/[type]/[id]/ai-function/route.ts` (per-column apply). The
suggestion + validation logic lives in `lib/notebook/wrangler-ai.ts`. No
Microsoft Fabric or Power BI dependency — every AI call hits the same Azure
OpenAI Foundry deployment the cross-item Copilot uses; the pandas host executes
every applied step.

## Fabric feature inventory (grounded in Learn)

| # | Capability | Where in Fabric |
|---|------------|-----------------|
| 1 | Suggested cleaning operations from the data profile (drop nulls, fix types, dedupe, trim, encode) | Data Wrangler AI "suggestions" |
| 2 | Per-column AI function (summarize / classify / sentiment / extract / translate) applied over the sampled column | Data Wrangler + Fabric AI functions |
| 3 | Natural-language → transform, previewed on the sample before apply | Data Wrangler "Copilot / describe a change" |
| 4 | Generated code inserted as a real notebook cell (pandas / PySpark) | Data Wrangler "Add code to notebook" |
| 5 | Preview reflects the transform BEFORE it is committed (diff-before-apply) | Data Wrangler operation preview |
| 6 | Honest state when the AI backend isn't available | (Fabric requires a capacity; Loom shows an infra gate) |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Suggested cleaning operations | ✅ built | `buildRuleSuggestions` derives steps from REAL column profiles (nulls / distinct / dtype / whitespace / constant / duplicates); AOAI proposes additional gallery-constrained steps when configured. Each "Apply" appends a structured op to the recipe → executed by the pandas host. |
| 2 | Per-column AI function | ✅ built | `AI assist → AI function on a column` calls the merged ai-function batch endpoint (`inputs[]`, bounded concurrency, real Azure OpenAI) over the sampled column and previews the enriched column; "Insert as cell" emits runnable `ai_functions` pandas code for the full DataFrame. |
| 3 | NL → transform, previewed | ✅ built | `AI assist → Describe a change` sends the prompt to AOAI (notebook-persona system prompt) → an ordered list of gallery operations, validated against the closed gallery. Applying appends them; the pandas host preview updates live (diff-before-commit). |
| 4 | Generated code → notebook cell | ✅ built | Applied steps generate the equivalent pandas + PySpark from the host; the panel's **Insert pandas / PySpark cell** buttons land it as a real cell. Per-column AI apply inserts `import ai_functions as ai; df['x'] = ai.<fn>(df['col'])`. |
| 5 | Preview-before-apply | ✅ built | All AI outputs resolve to structured steps that run on the real pandas host preview before commit — no arbitrary code executes; nothing mutates the notebook until the user inserts a cell. |
| 6 | Honest AI-unavailable state | ✅ honest-gate | Suggestions degrade to the rule-based floor with an info note; codegen + per-column apply show a Fluent `MessageBar intent="warning"` naming `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT`. The full surface still renders. |

Zero ❌ — every inventory row is built ✅ or honest-gate ⚠️.

## Backend per control

| Control | Backend |
|---------|---------|
| Get suggestions (rule) | `lib/notebook/wrangler-ai.ts::buildRuleSuggestions` over the live `/api/notebook/wrangler` column summary (real pandas host) — deterministic, no AOAI needed |
| Get suggestions (AI) | `POST /api/notebook/[id]/wrangler-ai` action `suggest` → Azure OpenAI (`aoaiChatJson`) → gallery-validated steps |
| Apply suggestion / generated step | appended to the recipe → `POST /api/notebook/wrangler` → loom-wrangler-host (real pandas) |
| AI function on a column | `POST /api/items/[type]/[id]/ai-function` with `inputs[]` → `callAiFnBatch` → live Azure OpenAI chat-completions (bounded concurrency) |
| Insert AI-function cell | client-side codegen → notebook cell running the `ai_functions` package (`apps/copilot/ai_functions`) on AML compute |
| Describe a change | `POST /api/notebook/[id]/wrangler-ai` action `codegen` → Azure OpenAI → gallery-validated steps + explanation |
| Insert generated pandas/PySpark cell | loom-wrangler-host code output for the applied steps |

## No-freeform / no-Fabric compliance

- Every AI output resolves to operations from the **closed** `WRANGLER_OPERATIONS`
  gallery (validated by `validateWranglerSteps`) — the AI never emits arbitrary
  config or code that bypasses the real backend. The only free-text inputs are the
  natural-language prompt and per-function options (labels / fields / target
  language), which are content, not item config.
- Azure OpenAI + the pandas host are the only backends; works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. No `api.fabric.microsoft.com` /
  `api.powerbi.com` call on any path.

## Verification

- `lib/notebook/__tests__/wrangler-ai.test.ts` — rule suggestions + step validation.
- `lib/azure/__tests__/ai-functions-batch.test.ts` — batch concurrency / per-row
  error / empty passthrough / honest-gate rethrow.
- `app/api/notebook/[id]/wrangler-ai/__tests__/route.test.ts` — suggest (rule +
  AI merge + degrade) and codegen (validated steps + 503 gate) routes.
