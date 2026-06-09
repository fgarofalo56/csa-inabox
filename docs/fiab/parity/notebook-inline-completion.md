# notebook-inline-completion — parity with Fabric Notebook AI inline code completion

Source UI: Fabric Notebook Copilot inline completions — https://learn.microsoft.com/fabric/data-engineering/copilot-notebooks-overview#copilot-inline-code-completion
Component: `apps/fiab-console/lib/components/notebook/code-cell.tsx` (registers the Monaco provider)
Provider: `apps/fiab-console/lib/components/editor/inline-completion.ts` (Monaco `InlineCompletionsProvider` — debounce + abort + ghost text)
Toggle: `apps/fiab-console/lib/components/editor/use-inline-complete-toggle.ts` (per-session sparkle toggle)
Prompt: `apps/fiab-console/lib/copilot/inline-complete-prompt.ts` (pure message builder + completion cleaner)
Deployment resolver: `apps/fiab-console/lib/copilot/inline-complete.ts` (`resolveCompletionTarget()` — `LOOM_AOAI_COMPLETION_DEPLOYMENT` over the chat deployment)
Backend: `apps/fiab-console/app/api/copilot/complete/route.ts` (real AOAI chat-completions; no Fabric Copilot dependency)

## Fabric feature inventory

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | AI suggests the next characters as gray ghost text while you type in a code cell | Code cell editor |
| 2 | Tab accepts the suggestion | Code cell editor |
| 3 | Esc / keep typing dismisses it | Code cell editor |
| 4 | Suggestions are debounced — they appear after a brief pause, not on every keystroke | Code cell editor |
| 5 | Context-aware — uses prior cells + the lakehouse/table schema | Notebook session |
| 6 | Per-user on/off control for inline completion | Notebook settings |
| 7 | Capacity / Copilot-license gated (F2+/P-class) | Tenant + capacity |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | ✅ | `registerInlineCompletion(editor, monaco, getCtx)` registers a Monaco `InlineCompletionsProvider`; items returned with an empty range at the cursor so Monaco renders gray ghost text |
| 2 | ✅ | Tab accepts (native Monaco inline-suggest behaviour) |
| 3 | ✅ | Esc / continued typing dismisses; the provider yields no items when the prefix is blank |
| 4 | ✅ | 300 ms debounce per model (`DEBOUNCE_MS`); a per-model `AbortController` cancels the in-flight fetch on every new keystroke |
| 5 | ✅ | `priorCells` (last 3) + `schemaContext` threaded from `code-cell.tsx` into the prompt (`buildInlineMessages`) |
| 6 | ✅ | Sparkle toolbar toggle (`useInlineCompleteToggle`, `localStorage`, cross-tab synced); plus an org-wide `ai.inlineCodeComplete` tenant-settings gate read in the route |
| 7 | ✅→Azure-native | NO capacity / Copilot-license gate. Ghost text calls Azure OpenAI chat-completions directly via the AI Foundry deployment — works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset |

## Backend per control

- All keystroke suggestions → `POST /api/copilot/complete` → AOAI chat-completions.
- Deployment resolution: `resolveCompletionTarget()` layers `LOOM_AOAI_COMPLETION_DEPLOYMENT` (a dedicated low-latency / cheaper slot, e.g. `gpt-4o-mini`) on top of `resolveAoaiTarget()`. When the env var is unset it falls back **silently** to the chat deployment (`LOOM_AOAI_DEPLOYMENT`) — no canned suggestion, no error.
- AAD bearer minted against the sovereign-correct cognitiveservices scope via `cogScope()` (`.azure.us` for GCC-High / IL5, `.azure.com` elsewhere).
- Response surfaces the real AOAI `usage` block + the serving `deployment` so the network call is verifiable end-to-end.
- Honest gate: AOAI not configured → `503 {code:'no_aoai', hint}`; the cell silently yields no ghost text (the provider returns no items). Tenant toggle off → `403 {code:'disabled'}`.
- No Fabric / Power BI host on any path.

## Bicep / bootstrap

- `platform/fiab/bicep/modules/ai/foundry-project.bicep` — optional `completionDeploymentName` param deploys a dedicated inline-completion model (default `gpt-4o-mini`, `2024-07-18`, `GlobalStandard`) only when non-empty; emits `output completionDeployment`.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — `loomAoaiCompletionDeployment` param → `completionDeploymentName` on the foundry module and the `LOOM_AOAI_COMPLETION_DEPLOYMENT` Console env var (falls back to `''` ⇒ chat deployment).
- `platform/fiab/bicep/main.bicep` — threads `loomAoaiCompletionDeployment` to the admin-plane module.
- `docs/fiab/v3-tenant-bootstrap.md` — documents the optional `LOOM_AOAI_COMPLETION_DEPLOYMENT` env var.

Grade: **A (all inventory rows built + real AOAI backend; `resolveCompletionTarget()` unit-tested via `inline-complete.test.ts`; deployment-resolution + Gov-scope hardening added).**
