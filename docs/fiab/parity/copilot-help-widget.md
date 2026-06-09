# copilot-help-widget — parity with a contextual AI help assistant

**Surface:** the global Help Copilot widget mounted in the app shell.
Components: `apps/fiab-console/lib/components/help-copilot/widget.tsx`
(+ `messages.tsx`, `citations.tsx`, `empty-state.tsx`).
Orchestration: `apps/fiab-console/lib/azure/help-copilot-orchestrator.ts`.
Routes: `apps/fiab-console/app/api/help-copilot/{chat,reindex,sessions}/route.ts`.
Doc corpus index: `apps/fiab-console/lib/azure/loom-docs-index.ts`.

**Source UI (Microsoft):** the real-product analog is the **Azure portal's
contextual help + AI assistant** — a docked panel that answers product
questions, streams the answer, and cites the documentation it used.
- Copilot in Azure (in-portal assistant) — <https://learn.microsoft.com/azure/copilot/overview>
- Grounding answers with retrieval + citations — <https://learn.microsoft.com/azure/ai-services/openai/concepts/use-your-data>

> A contextual help assistant lets you (a) open it from anywhere, (b) start from
> suggested prompts, (c) ask a free-form question, (d) read a streamed answer,
> and (e) follow citations back to the source docs. Loom reproduces all five
> **on the Azure-native default backend** — Azure OpenAI chat-completions with a
> `searchDocs` tool over the Loom docs/repo corpus (AI Search when configured,
> Cosmos substring fallback otherwise). **No Fabric / Power BI dependency**;
> works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. When AOAI is not wired the
> widget shows an honest gate; when AI Search is absent it shows an honest
> "degraded to substring search" bar — both render, neither blocks.

## Source-UI feature inventory (grounded in Learn)

| # | Assistant capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | Open from anywhere (button + shortcut) | A persistent entry point opens the panel over the current page |
| 2 | Page-context awareness | The assistant knows which page/item you are on |
| 3 | Suggested starter prompts (empty state) | First-open shows clickable example questions |
| 4 | Free-form question + send | Type a question, submit with Enter or a Send button |
| 5 | Streamed answer | The answer renders progressively |
| 6 | Citations | Source chips link back to the docs that grounded the answer |
| 7 | New-conversation / reset | Clear the thread and start over |
| 8 | Hand off to the deep agent | Escalate an "act" request to the full orchestrator |
| 9 | Graceful unconfigured state | A clear message when the model / index is unavailable |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Open via top-right Sparkle button + **Ctrl/Cmd + /** | built ✅ | `openHelpCopilot()` / `toggleHelpCopilot()` events; widget `data-testid="help-copilot-widget"` |
| 2 | Page-context awareness | built ✅ | `pageContextFromPath()` derives `{path,label,itemType,itemId}` → posted as `context` to the chat route → grounding |
| 3 | Starter prompts | built ✅ | `HelpEmptyState` renders `data-testid="help-starter"` example chips |
| 4 | Free-form ask + send | built ✅ | `data-testid="help-input"` + `data-testid="help-send"` (Enter also sends) |
| 5 | Streamed answer (SSE) | built ✅ | `POST /api/help-copilot/chat` → `orchestrateHelp()` `HelpStep` events; `MessageList` renders `help-msg-copilot` progressively |
| 6 | Citation chips | built ✅ | `citation` step → `data-testid="citation-chip"` with heading + preview (`data-testid="citation-label"`) |
| 7 | New-conversation reset | built ✅ | "New conversation" button (`aria-label`) clears thread |
| 8 | Hand off to `/copilot` | built ✅ | `data-testid="help-handoff-link"` when the agent detects an act-request |
| 9 | Honest AOAI gate + search-degraded bar | honest-gate ⚠️ | `503 {gate:'aoai'}` → `AoaiGateBar` (`data-testid="help-aoai-gate"`); no AI Search → `SearchDegradedBar` (`data-testid="help-search-degraded"`); reindex probe reports `backend:'ai-search'|'cosmos'` |

Zero ❌.

## Backend per control

| Control | Calls |
| --- | --- |
| Ask → stream | `POST /api/help-copilot/chat` `{prompt, sessionId?, context}` → `orchestrateHelp()` → AOAI `chat/completions` with a `searchDocs` tool; prefers `helpAgentDeployment` then falls back via `resolveAoaiTarget()`; SSE `session`/`step`/`done` |
| Citations | the `searchDocs` tool → `loom-docs-index` (AI Search hybrid when `LOOM_AI_SEARCH_SERVICE` set; Cosmos substring fallback otherwise) → `citation` step |
| Sessions | `GET /api/help-copilot/sessions` → `listSessions()` |
| Reindex (admin) | `GET /api/help-copilot/reindex` → `isSearchConfigured()` status; `POST` → `reindex()` rebuilds the docs/lib/PRP/ADR corpus |

## Azure-native / no-Fabric

No Fabric / Power BI host on any path. The backend is Azure OpenAI +
(optionally) Azure AI Search; the Cosmos substring fallback means the widget
still answers with citations even with no AI Search service deployed.

## Bicep sync

- Reuses `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_AUDIENCE`
  from `admin-plane/main.bicep` (lines 1583–1594).
- Optional `LOOM_AI_SEARCH_SERVICE` upgrades the corpus from Cosmos substring to
  AI Search hybrid; absent → honest degraded bar, not a failure.
- Cosmos `copilot-sessions` container reused (created via `createIfNotExists`).

## Per-cloud notes

| Concern | Commercial / GCC | GCC-High / IL5 / DoD |
| --- | --- | --- |
| AOAI scope / endpoint | `cognitiveservices.azure.com` / `*.openai.azure.com` | `cognitiveservices.azure.us` / `*.openai.azure.us` (via `LOOM_AOAI_AUDIENCE`) |
| AI Search host | `*.search.windows.net` | `*.search.azure.us` (Gov) — or omit and use the Cosmos fallback |
| Fabric / Power BI host | never contacted | never contacted |

## Verification

`pnpm uat` — the mocked SSE walk in `e2e/help-copilot.uat.ts` (open via Sparkle
+ Ctrl+/, ask, assert streamed answer + ≥1 citation chip) plus the live AOAI
opt-in (`HELP_COPILOT_LIVE=1`). `e2e/copilot.uat.ts` re-asserts the open + ask +
honest-gate path as part of the whole-surface sweep. Receipt screenshot under
`test-results/uat/artifacts/`.

Grade: **A** (every inventory row built ✅ or honest-gate ⚠️; real AOAI + doc
index backend; UAT-covered, mocked + live).
