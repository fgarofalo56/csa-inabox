# copilot-help-widget — parity with a contextual AI help assistant (now the unified Copilot window)

> **audit-t155:** the floating Help Copilot widget and the right-rail Copilot
> pane are now **ONE window with ONE launcher**. Clicking the topbar Sparkle
> used to open BOTH popups (both components listened to the same
> `csaloom:open-copilot` event + Ctrl+/). The widget
> (`help-copilot/widget.tsx`, `messages.tsx`, `empty-state.tsx`) is retired;
> the single `CopilotPane` absorbs every capability below, and a server-side
> intent router decides per turn which agent answers. The docs-site widget
> (`azure-functions/copilot-chat` + `apps/copilot`) is deliberately separate
> per ADR 0022 and is unaffected.

**Surface:** the single Loom Copilot window mounted in the app shell.
Components: `apps/fiab-console/lib/components/copilot-pane.tsx`
(+ `help-copilot/citations.tsx`, `copilot-diff.tsx`, `copilot-chips.tsx`).
Routing: `apps/fiab-console/lib/azure/copilot-router.ts` (intent classifier +
agent attribution). Orchestration: `lib/azure/copilot-orchestrator.ts` (build &
data agent) and `lib/azure/help-copilot-orchestrator.ts` (docs/help agent).
Routes: `POST /api/copilot/orchestrate` (unified SSE; runs the router),
`/api/help-copilot/{chat,reindex,sessions}` (docs agent direct API, kept for
programmatic/API parity).

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
> Cosmos substring fallback otherwise) — and adds (f) **intent-based agent
> routing with inline attribution**: a docs question is answered by the
> docs/help agent, a build/data request by the cross-item build agent, and each
> answer carries a badge naming the agent + why it was chosen. **No Fabric /
> Power BI dependency**; works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. When
> AOAI is not wired the window shows an honest gate; when AI Search is absent
> the docs agent degrades to the Cosmos substring index — both render, neither
> blocks.

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
| 10 | One assistant, many skills | The portal shows ONE Copilot; skills are routed internally, never two popups |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | Open via the single top-right Sparkle button + **Ctrl/Cmd + /** | built ✅ | `openCopilot()` / `toggleCopilot()`; pane `data-testid="copilot-pane"`; the retired widget testid is asserted ABSENT in UAT |
| 2 | Page-context awareness | built ✅ | `pageContextFromPath()` in `copilot-pane.tsx` → posted as `helpContext` to `/api/copilot/orchestrate`; editor panes additionally register per-pane personas via `use-copilot-context` |
| 3 | Starter prompts | built ✅ | `CopilotChips` renders context-aware suggested prompts grounded in real editor symbols |
| 4 | Free-form ask + send | built ✅ | `data-testid="copilot-input"` + `data-testid="copilot-send"` (Enter also sends) |
| 5 | Streamed answer (SSE) | built ✅ | `POST /api/copilot/orchestrate` → `routeCopilot()` → the chosen agent's step stream |
| 6 | Citation chips | built ✅ | docs-agent `citation` steps → `CitationChips` (`data-testid="citation-chip"`) under the answer |
| 7 | New-conversation reset / clear chat / history | built ✅ | Clear chat (DELETE session) + History drawer (GET /api/copilot/sessions) |
| 8 | Hand off to the deep agent | built ✅ | docs-agent `handoff` step → **in-window** "Do it with the build agent" button (`data-testid="copilot-handoff-btn"`) re-asks the build agent — no navigation, no second popup |
| 9 | Honest AOAI gate + content-safety gate + search-degraded | honest-gate ⚠️ | 503 → AOAI MessageBar with Foundry CTA; `/api/copilot/status` → Content Safety warning; docs agent reports its `ai-search`/`cosmos` backend |
| 10 | ONE window, routed agents, inline attribution | built ✅ | `lib/azure/copilot-router.ts`: forced-`tool_choice` AOAI classifier (docs vs build) + `agent` SSE step → `data-testid="copilot-agent-badge"` (agent name; tooltip = why) |

Zero ❌.

## Backend per control

| Control | Calls |
| --- | --- |
| Ask → route → stream | `POST /api/copilot/orchestrate` `{prompt, sessionId?, persona?, contextSlug?, contextPayload?, helpContext?, forceAgent?}` → `routeCopilot()`. Global launcher: one forced-`tool_choice` AOAI call (`route` function, docs vs build; deployment = tenant `routerDeployment` → chat deployment) then delegate. Editor pane / explicit persona: straight to `orchestrate()` (no classifier round-trip). Tutorial step: forced to the docs agent. |
| Attribution badge | the router's `agent` SSE step `{agentId, agentName, reason}` — agentName from the REAL persona registry (`resolvePersona` / `getPanePersona`), reason from the classifier or the surface binding |
| Docs answers + citations | `orchestrateHelp()` → AOAI + `searchDocs`/`searchRepo` over `loom-docs-index` (AI Search hybrid when configured; Cosmos substring fallback) |
| Build answers | `orchestrate()` → AOAI + the 38-tool cross-item registry (Synapse/ADLS/Databricks/ADX/ADF/PBI/Foundry/Activator); Gov MAF Container-App tier auto-routes unchanged |
| In-window handoff | docs-agent `handoff` step → button re-sends `suggestedPrompt` through the same route (classifies to build) |
| Feedback / clear / history | `PATCH`/`DELETE`/`GET /api/copilot/sessions[/:id]` (Cosmos) |
| Router model picker | `/admin/tenant-settings → Copilot & Agents` → optional **Intent router model** dropdown (real ARM-listed deployments) persisted as `routerDeployment` in the Cosmos `copilot-config` doc |

## Azure-native / no-Fabric

No Fabric / Power BI host on any default path. Routing never selects a
Fabric-gated tool path as the only answer in Gov (`assertFabricFamilyAvailable`
honest gates still apply inside the build agent's tools). Both agents + the
classifier run on Azure OpenAI in Commercial and Gov (`*.openai.azure.us`).

## Bicep sync

- **No new env vars, no new resources** — the router reuses the resolved AOAI
  target; the optional dedicated router model is tenant config (Cosmos), edited
  via the admin dropdown, not an env var. Existing knobs unchanged in
  `platform/fiab/bicep/modules/admin-plane/main.bicep` / `ai-foundry.bicep` /
  `modules/copilot/maf.bicep`.
- Optional `LOOM_AI_SEARCH_SERVICE` still upgrades the docs corpus; absent →
  honest degraded behavior, not a failure.
- Cosmos `copilot-sessions` + `copilot-help-sessions` containers reused
  (created via `createIfNotExists`).

## Per-cloud notes

| Concern | Commercial / GCC | GCC-High / IL5 / DoD |
| --- | --- | --- |
| AOAI scope / endpoint | `cognitiveservices.azure.com` / `*.openai.azure.com` | `cognitiveservices.azure.us` / `*.openai.azure.us` (via `LOOM_AOAI_AUDIENCE`) |
| Build agent tier | direct AOAI loop | MAF Container App when `isGovCloud() && LOOM_MAF_ENDPOINT` — identical SSE contract, attribution step emitted by the router before delegation |
| AI Search host | `*.search.windows.net` | `*.search.azure.us` (Gov) — or omit and use the Cosmos fallback |
| Fabric / Power BI host | never contacted on default paths | never contacted |

## Verification

`pnpm uat` — `e2e/help-copilot.uat.ts` proves the acceptance criteria with a
deterministic mocked SSE keyed on prompt intent: (1) one launcher → exactly one
window and zero `help-copilot-widget`; (2) a docs question → "Help & docs"
badge + ≥1 citation chip; (3) a build question → "Build & data" badge — same
window. Ctrl+/ toggle covered; live AOAI opt-in via `UNIFIED_COPILOT_LIVE=1`.
`e2e/copilot.uat.ts` re-asserts the single-window invariant + the docs agent's
real backend (or honest AOAI gate). Unit:
`lib/azure/__tests__/copilot-router.test.ts` (auto-route decision, decision
parsing, agent identity from the REAL persona registry, classifier degradation,
delegation).

Grade: **A** (every inventory row built ✅ or honest-gate ⚠️; real AOAI
classifier + two real orchestrators; unit + UAT covered).
