# copilot-cross-item — parity with an Azure AI Foundry tool-using agent

**Surface:** the full-screen Loom Copilot orchestrator console.
Landing page `apps/fiab-console/app/copilot/page.tsx` → shared
`CopilotConsoleView` in `apps/fiab-console/lib/editors/cross-item-copilot-editor.tsx`
(also embedded at `/items/cross-item-copilot/<id>` via `CrossItemCopilotEditor`).
Orchestration core: `apps/fiab-console/lib/azure/copilot-orchestrator.ts`.

**Source UI (Microsoft):** the real-product analog is an **Azure AI Foundry
agent with tools** — a single natural-language assistant that plans, calls a
registered tool catalog, streams each tool call/result, and persists threads.
- Azure AI Foundry Agent Service overview — <https://learn.microsoft.com/azure/ai-foundry/agents/overview>
- Function/tool calling — <https://learn.microsoft.com/azure/ai-services/openai/how-to/function-calling>
- Threads (session persistence) — <https://learn.microsoft.com/azure/ai-foundry/agents/concepts/threads-runs-messages>

> Foundry's agent playground lets you (a) type one prompt, (b) watch the agent
> select and call tools, (c) see streamed step output, (d) keep a thread/session
> history, and (e) inspect the agent's registered tool catalog. Loom reproduces
> all five **on the Azure-native default backend** — Azure OpenAI
> chat-completions with a **37-tool function schema** spanning Synapse, ADLS /
> Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Activator, the
> Foundry hub, and Loom workspace CRUD — with **no Fabric or Power BI capacity
> dependency**. The console works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset
> (per `no-fabric-dependency.md`); when AOAI is not wired it shows an honest
> config gate naming the env vars, and the 37 tools remain individually callable.

## Source-UI feature inventory (grounded in Learn + the Foundry agent playground)

| # | Foundry agent capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | Single NL prompt → planned tool use | Type intent; the agent decides which tools to call |
| 2 | Streamed steps (tool_call → tool_result → final) | Each action streams as it happens, not one final blob |
| 3 | Tool catalog inspection | A panel lists every registered tool grouped by source |
| 4 | Thread / session history | Prior runs are listed and re-openable |
| 5 | Readiness / model status | The UI shows which chat model is bound and whether it's reachable |
| 6 | Final grounded answer | The model summarizes the real tool outputs |
| 7 | Graceful unconfigured state | A clear message when no model deployment is bound |

## Loom coverage

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | NL prompt → 37-tool function-calling plan | built ✅ | `CopilotConsoleView` Textarea → "Ask CSA Loom Copilot" → `POST /api/copilot/orchestrate`; `orchestrate()` drives AOAI `chat/completions` with the tool schema from `buildDefaultRegistry()` |
| 2 | Streamed steps (SSE `session` → `step` × N → `done`) | built ✅ | `OrchestratorStep` events (`thought`/`tool_call`/`tool_result`/`final`/`error`) render as `StepCard`s; the route streams `text/event-stream` |
| 3 | Tool registry right rail (grouped by service) | built ✅ | `GET /api/copilot/tools` → `getRegistry().list()` → Fluent `Accordion` per service; `GET /api/copilot/status` `byService` drives the landing-page capability tiles |
| 4 | Session history (list + re-open) | built ✅ | `GET /api/copilot/sessions` → `listSessions(userOid)` (Cosmos `copilot-sessions`, PK `/sessionId`); landing-page tile/table view; `New`/`Refresh` ribbon events |
| 5 | Readiness badge + bound model | built ✅ | `GET /api/copilot/status` → `resolveAoaiTarget()` (endpoint + deployment + tool count + recent-session count) → hero "Ready · N tools" chip |
| 6 | Final grounded answer | built ✅ | terminal `final` step renders the model's synthesis of real tool outputs |
| 7 | Honest no-AOAI gate | honest-gate ⚠️ | `NoAoaiDeploymentError` → orchestrate returns `503 {ok:false,error}`; console shows Fluent `MessageBar intent="warning"` "No AOAI deployment" + "Go to AI Foundry"; status banner names `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` and the tenant-settings picker |

Zero ❌. The 37 registered tools (2 ADF, 3 ADX, 3 APIM, 2 Activator, 4
Databricks, 3 Fabric, 1 Foundry, 3 Lakehouse, 7 Loom, 3 Power BI, 6 Synapse)
each call a **real** Azure REST / data-plane backend — see
`lib/azure/copilot-orchestrator.ts` `buildDefaultRegistry()`.

## Backend per control

| Control | Calls |
| --- | --- |
| Ask CSA Loom Copilot | `POST /api/copilot/orchestrate` `{prompt, sessionId?}` → `orchestrate()` → AOAI `chat/completions` (37-tool function schema) → real per-tool Azure REST; SSE `session`/`step`/`done` |
| Tools right rail | `GET /api/copilot/tools` → `getRegistry().list()` (name/description/service/parameters, grouped) |
| Status / readiness | `GET /api/copilot/status` → `resolveAoaiTarget(tenantConfig)` + `getRegistry().list()` + `listSessions()` |
| Sessions list | `GET /api/copilot/sessions` → `listSessions(userOid)` (Cosmos `copilot-sessions`) |
| Cell-fix (notebook handoff) | `POST /api/copilot/sessions` `{mode:'cell-fix'}` → AOAI single corrected-code proposal, persisted as a session record |
| Tool execution | each tool → its own real client (e.g. Synapse `synapse-sql-client`, ADLS `adls-client`, Databricks `databricks-client`, ADX `kusto-client`, ADF `adf-client`, Power BI `powerbi-client`, Activator `monitor-client`, Loom workspace CRUD + `runSelfAudit`/`applyFix`) |

The AOAI target is resolved tenant-admin-pick → `LOOM_AOAI_ENDPOINT` +
`LOOM_AOAI_DEPLOYMENT` → Foundry-hub discovery, inside `resolveAoaiTarget()`.
Item-type arguments from the model are normalized through `ITEM_TYPE_ALIASES` +
`normalizeItemType()` before any `createItem` tool runs (guards hallucinated
type slugs).

## Azure-native / no-Fabric

No Fabric / Power BI host is contacted on the default path. The orchestrator is
Azure OpenAI only; the Fabric/Power BI **tools** in the catalog are opt-in and
fire real Fabric/Power BI REST only when the user's prompt selects them and the
relevant backend is configured. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset.

## Bicep sync

- `platform/fiab/bicep/modules/admin-plane/main.bicep` emits
  `LOOM_AOAI_ENDPOINT` (line 1583), `LOOM_AOAI_DEPLOYMENT` (1589), and
  `LOOM_AOAI_AUDIENCE` (1594) into the Console Container App `env[]` when
  `agentFoundryEnabled=true` (sourced from
  `platform/fiab/bicep/modules/ai/foundry-project.bicep`).
- The **Cognitive Services OpenAI User** role to the Console UAMI already ships
  in `foundry-project.bicep` (`raCognitiveServicesOpenAIUser`).
- Cosmos `copilot-sessions` container — created on first write via the
  cosmos-client `createIfNotExists` path (PK `/sessionId`); no separate bicep
  deployment script required.

## Per-cloud notes

| Concern | Commercial / GCC | GCC-High / IL5 / DoD |
| --- | --- | --- |
| AOAI bearer scope | `cogScope()` → `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` (driven by `LOOM_AOAI_AUDIENCE`, stamped `.us` by bicep when the storage suffix is non-commercial) |
| AOAI endpoint | `*.openai.azure.com` (`LOOM_AOAI_ENDPOINT`) | `*.openai.azure.us` (Foundry-project output uses the Gov suffix) |
| Tool backends | per-service commercial hosts | per-service Gov hosts (each tool's client already routes by cloud) |
| Fabric / Power BI host | never on the default path | never on the default path |

## Verification

`pnpm uat` (`e2e/copilot.uat.ts` → "Cross-item Copilot orchestrator" block):
navigate `/copilot`, **Launch Copilot**, type *"list my workspaces"*, **Ask CSA
Loom Copilot** → assert the SSE stream emits `session` → `step(tool_call)` →
`step(tool_result)` → `step(final)` → `done`, OR a `503 {code/error}` AOAI
honest gate (both are valid; a generic 500 is not). `GET /api/copilot/status`
asserts `tools.count > 0`. Screenshot receipt at
`test-results/uat/artifacts/copilot-cross-item-receipt.png`.

Grade: **A** (every inventory row built ✅ or honest-gate ⚠️; real 37-tool AOAI
backend; UAT-covered).
