# Functional Audit — AI & Copilot (ai-copilot)

**Auditor:** CSA Loom Functional Auditor (vaporware hunt)
**Date:** 2026-06-26
**Scope:** Every Copilot builder, agent, MCP, and AI feature across `apps/fiab-console`.
**Method:** UI control → BFF route → backend Azure call traced per surface. No-vaporware
greps (`return []`/`return {}`/`MOCK_`/`SAMPLE_`/`TODO`/disabled-with-tooltip/no-op onClick)
run across `lib/editors/**`, `app/api/**`, `lib/azure/**`, `lib/components/**`.

## Headline

The AI & Copilot area is **the strongest area in the product**. Every Copilot
surface routes to a **real Azure OpenAI chat-completions call** (via the shared
`resolveAoaiTarget()` + `orchestrate()` tool-loop in
`lib/azure/copilot-orchestrator.ts`) or a real data-plane (Kusto, Dataverse,
Foundry project endpoint, ARM). **Zero `return []` / mock-array vaporware** was
found in any Copilot/AI route or client. The orchestrator is a genuine
tool-calling agent loop (`callAoai` → `tool_calls` → registry dispatch →
re-prompt), not a façade.

Three real defects found, none of them "fake data": **two config-consistency
bugs** that break two Copilot surfaces in the tenant-config-only deployment mode
the rest of the product supports, and **one disclosed parity gap** in the
Foundry playground. Everything else grades **A/B**.

## Findings table

| Surface | Grade | Symptom / root cause (file:line) | Fix | Priority |
|---|---|---|---|---|
| Governance Copilot (`/api/governance/govern/copilot`) | C | `resolveAoaiTarget()` called **bare** at `app/api/governance/govern/copilot/route.ts:44` — ignores the admin-picked tenant Copilot config. Falsely returns 503 "no AOAI deployment" when the admin selected a Foundry account + chat deployment via the Admin → Tenant settings picker but did NOT also set `LOOM_AOAI_ENDPOINT`/`LOOM_AOAI_DEPLOYMENT` env. The `copilot/status` route documents this exact trap. | `const cfg = await loadTenantCopilotConfig(s.claims.oid); target = await resolveAoaiTarget(cfg);` (mirror dataflow/report/azure-sql routes). | P1 |
| Notebook in-cell Copilot (`/explain /fix /comments /optimize /generate`) → `/api/notebook/[id]/assist` | C | Same bug: `resolveAoaiTarget()` bare at `app/api/notebook/[id]/assist/route.ts:168`. The notebook code-cell Copilot (`lib/components/notebook/code-cell.tsx:373`) breaks in tenant-config-only deployments while the global pane works. | Load tenant config and pass it to `resolveAoaiTarget(cfg)`. | P1 |
| Foundry Playground — "Add your data" (On Your Data) grounding | C | `lib/editors/foundry-playground.tsx:583-602`: the data-grounding control is an **honest hand-off** that opens `ai.azure.com` in a new tab, not an in-product flow. `chat/route.ts` + `foundry-cs-client` accept only `deployment/messages/temperature/maxTokens/topP/stop` — no `data_sources` passthrough. Disclosed per no-vaporware §allowed, but it is a **Fabric/AOAI-portal parity gap**: Azure's playground grounds answers in AI Search/Blob in-product. | Thread a `data_sources[]` array through `/api/foundry/chat` → `chatCompletion` as AOAI `extra_body.data_sources`; add an in-playground AI Search/Blob connection picker. | P2 |
| Foundry Playground — Tools / code-interpreter | C | Same file ~`:605`: "Function tools and the code interpreter attach per-deployment in the Foundry agent surface." is a **caption hand-off**, not a control. Azure playground exposes tool/function attach in-product. | Surface function-tool + code-interpreter toggles wired through the agent run path (the Foundry Agents panel already has the backend). | P2 |
| Global Copilot pane (cross-item) → `/api/copilot/orchestrate` | A | `routeCopilot` classifies intent with a real AOAI `tool_choice` call, badges the answering agent, then runs `orchestrate()` (docs vs build). SSE stream, real tool loop, Content-Safety input pre-flight (`shieldPrompt`+`moderateContent`). Mounted globally in `lib/components/app-shell.tsx:247`. UI streams real SSE (`cross-item-copilot-editor.tsx:501`). | — | — |
| Per-editor build Copilots: dataflow, synapse-pipeline, adf-pipeline, report, semantic-model copilot-structure, azure-sql, powerbi-copilot, report ai-visual | A | All call `resolveAoaiTarget(tenantConfig)` + `orchestrate()`/`callAoai`/`aoaiCompleteJson` with scoped tool sets and 503/502 honest gates (`dataflow/copilot:116`, `report/copilot:51`, `azure-sql.../copilot:102`, `powerbi-copilot:122`, `ai-visual:170+185`, `semantic-model/copilot-structure:74`). Real XMLA Alter on the semantic-model path. | — | — |
| Foundry Agent Service builder (`FoundryAgentsPanel`) → `/api/foundry/agents` | A | `lib/components/foundry/foundry-agents.tsx` (list `:146`, create POST `:226`, delete `:251`) wired into `foundry-hub-editor.tsx:51`. Backend `lib/azure/foundry-agent-client.ts` hits the real Foundry project endpoint (`{endpoint}/agents?api-version=v1`, scope `https://ai.azure.com/.default`) with an honest `FoundryAgentNotConfiguredError` MessageBar gate. | — | — |
| Foundry Hub editor tabs (deployments, model-deployments, models-catalog, quota, rbac, networking, fine-tuning, evaluations, observability, connections, computes, keys, activity) | A | Each tab fetches a real `/api/foundry/*` route delegating to `foundry-cs-client`/`foundry-client` (ARM + Cognitive Services data-plane). `EmptyState`/honest gates, no empty tabs. Verified `agents/run`, `fine-tuning`, `evaluations`, `images`, `audio`, `quota`, `rbac`, `models-catalog`, `computes`, `observability`, `networking` all `await` real client fns. | — | — |
| Data Agent config Copilot (generate instructions/examples) → `/api/items/data-agent/[id]/copilot` | A | `data-agent-config-copilot.tsx:115,140` POSTs `generate`/`apply`; route uses the orchestrator. Buttons disabled only during in-flight loading (correct UX, not a stub). | — | — |
| Data Agent execution (NL → KQL) → `data-agent-execute.ts` | A | Real Kusto execute (`kustoExecute` `:105`) with `kustoConfigGate()` honest gate. | — | — |
| Copilot Studio editors (agent / knowledge / topic / action / channel / publish) | A | `copilot-studio-editors.tsx` fully wired to `/api/items/copilot-studio-*` (agent `:228/271/369`, knowledge `:607/619`, topic `:778/809`, action `:1005/1083`, plus PP flows/connectors). Backend `copilot-studio-client.ts` calls real BAP (`api.bap.microsoft.com`) + per-env Dataverse (`/api/data/v9.2`). | — | — |
| Copilot Studio topic canvas (`copilot-topic-canvas.tsx`) | A | Pure client-side topic designer (message/question/condition steps, trigger phrases); persisted by the parent via `/api/items/copilot-studio-topic`. No own backend by design — not a stub. | — | — |
| AI Builder model train/publish → `/api/items/ai-builder-model/[id]/train` | A | `trainAiBuilderModel` (`powerplatform-client.ts:1697`) POSTs the real Dataverse bound action `msdyn_AIModelTrain`; publish calls `msdyn_AIConfigurationActivate`. | — | — |
| AI Functions (`/api/ai-functions`) → `callAiFn` | A | `ai-functions-client.ts:140` `resolveAoaiTarget()` → real chat-completions. (Note: also bare — low impact, see P2 note below.) | — | — |
| Help Copilot (docs agent) → `/api/help-copilot/chat` | A | `help-copilot-orchestrator.ts` (14 backend calls — AI Search grounding + AOAI). Reindex route real. | — | — |
| Ops Copilot (admin capacity) → `/api/admin/ops-copilot` | A | Real AOAI (`resolveAoaiTarget`+`loadTenantCopilotConfig`), ARM credential, Graph, `classifyOpsIntent` tool dispatch, Cosmos session store. | — | — |
| DSPM-AI posture (`/api/admin/dspm-ai`) | A | `computeDspmAiPosture` real (`:48`). | — | — |
| AutoML / ML Experiment / ML Model editors | B | 9 / 13 / 16 real `/api/...` calls respectively; zero stub markers. Not deep-traced end-to-end this pass but no vaporware signatures. | Spot-verify the train/deploy POSTs hit real ARM/Databricks in a follow-up. | P2 |
| aip-logic run-agent, operations-agent deploy, data-agent m365-copilot publish | A | `runAgentAndInspect` (real Foundry agent run), Dataverse publish for m365. | — | — |

## Cross-cutting note — `resolveAoaiTarget()` config-passing inconsistency

`resolveAoaiTarget(cfg?)` accepts an optional tenant Copilot config (the
admin-picker source of truth). The orchestrate route and most per-editor routes
pass it; **three call sites call it bare** and therefore silently ignore the
admin pick, falling back to env/Foundry-discovery only:

- `app/api/governance/govern/copilot/route.ts:44` (P1 — user-facing 503)
- `app/api/notebook/[id]/assist/route.ts:168` (P1 — user-facing 503)
- `lib/azure/ai-functions-client.ts:140` (P2 — internal AI functions; lower blast radius)

These should all load `loadTenantCopilotConfig(oid)` and pass it. This is the
single most impactful, lowest-effort fix in the area — it removes a class of
"Copilot says not configured even though chat works elsewhere" support tickets.

## What was checked and is genuinely clean

- No `return []` / `return {}` placeholder routes in any AI/Copilot BFF.
- No `useState(MOCK_/SAMPLE_)` in any AI editor.
- No disabled-with-"Phase 1 / deferred / coming soon" buttons in AI editors
  (the only `TODO(parity)` is the disclosed playground grounding hand-off).
- Foundry agent + Copilot Studio + Data Agent + AI Builder all hit real
  data-plane/management endpoints with honest MessageBar gates when unconfigured.

## Verdict

Area grade: **A-**. No vaporware. Fix the two P1 bare-`resolveAoaiTarget()`
call sites (governance + notebook Copilot) and the area is solid; close the
playground On-Your-Data/Tools parity gap (P2) for full AOAI-portal parity.
