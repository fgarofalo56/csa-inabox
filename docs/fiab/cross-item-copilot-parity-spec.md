# Loom Cross-Item Copilot Editor — parity spec (Loom-native, no Fabric equivalent)

> Captured 2026-05-26 by catalog agent. This editor is **Loom-native**. There is no single Microsoft service called "cross-item copilot"; the closest reference points are [Azure OpenAI Assistants](https://learn.microsoft.com/azure/ai-services/openai/concepts/assistants), [Azure AI Foundry Agent Service](https://learn.microsoft.com/azure/ai-foundry/concepts/agents), [Fabric Copilot in workloads](https://learn.microsoft.com/fabric/get-started/copilot-fabric-overview), and the [Fabric Data Agent](https://learn.microsoft.com/fabric/data-science/concept-data-agent) (covered in its own parity spec). Loom's cross-item copilot is a tool-using orchestrator that spans **every wired Loom item type** in a single conversation — Synapse SQL, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, Foundry, Cosmos, and workspace management. The "parity" target here is therefore quality-of-experience parity with Foundry's tool-using agent surface, not feature-by-feature parity with a specific Microsoft product. Cross-checked against current Loom code at `apps/fiab-console/lib/editors/cross-item-copilot-editor.tsx::CopilotConsoleView`, the orchestrator at `apps/fiab-console/lib/azure/copilot-orchestrator.ts`, and the BFF route at `app/api/copilot/orchestrate/route.ts`.

## What it is

A natural-language orchestrator that converts a single prompt ("Find the top 10 revenue customers from gold.fact_sales last quarter, write the result to gold/snapshots/customer_top10.parquet, and refresh the Sales semantic model") into a multi-step tool-using plan, executes each tool against the real Azure backing service, streams every step back to the UI, and renders a final answer with full lineage of what was called.

The orchestrator advertises **32 registered tools** as of the current build, spanning:

- **synapse_*** (6 tools): serverless_query, dedicated_query, pool_state, pool_resume, list_pipelines, run_pipeline
- **lakehouse_*** (3 tools): list, read, write
- **databricks_*** (4 tools): run_warehouse_query, run_notebook, list_warehouses, list_jobs
- **apim_*** (3 tools): list_apis, publish_api, list_products
- **adx_*** (3 tools): query, list_databases, list_tables
- **adf_*** (2 tools): run_pipeline, list_pipelines
- **powerbi_*** (3 tools): list_workspaces, list_reports, refresh_dataset
- **fabric_*** (3 tools): list_workspaces, create_notebook, run_notebook
- **foundry_*** (1 tool): list_connections
- **activator_*** (2 tools): list, trigger_rule
- **workspace + item CRUD** (2 tools): workspace_create, item_create

## UI components

### Page chrome
- Title bar: **Loom Copilot** (full-screen) OR item-style chrome (embedded variant at `/items/cross-item-copilot/<id>`)
- Top toolbar (ribbon): **New session**, **Refresh sessions**, **View tool registry**

### Three-column shell (current Loom layout)

#### Left rail — Sessions
- **+ New session** primary button
- Session list (per-user, persisted in Cosmos `copilot-sessions` container partition `/sessionId`)
- Each session item: prompt-prefix (first 60 chars), step-count, last-updated timestamp
- Click → loads the session into the main pane (replays the persisted steps)

#### Main pane — Conversation + step stream
- **Prompt bar (top)**:
  - Textarea (3 rows expandable) with example placeholder
  - **Orchestrate** primary button + spinner during run
  - Tool-count caption ("32 tools registered")
- **AOAI-missing banner**: when `resolveAoaiTarget()` throws `NoAoaiDeploymentError`, a `MessageBar intent="warning"` with **Go to AI Foundry** CTA deep-linking to https://ai.azure.com
- **Steps stream**:
  - Per-step card with kind-coded Badge (`thought` informative, `tool_call` brand, `tool_result` informative or error, `final` success, `error` red)
  - `thought` cards show planner reasoning
  - `tool_call` cards show tool name + pretty-printed JSON args
  - `tool_result` cards show pretty-printed JSON result OR the error string + duration in ms
  - `final` card has a green border and renders the model's natural-language answer
  - `error` card has a red border with the error string
  - Auto-scrolls to bottom as new steps arrive

#### Right rail — Tools registry
- Header: **Tools (32)**
- Accordion grouped by service (synapse, lakehouse, databricks, apim, adx, adf, powerbi, fabric, foundry, activator, workspace, item)
- Per-tool pill: name + description tooltip

### SSE wire protocol (current)
- `event: session` with `{sessionId}` — emitted first
- `event: step` with each `OrchestratorStep` shape (`{kind: 'thought'|'tool_call'|'tool_result'|'final'|'error', ...}`)
- `event: done` with `{sessionId}` — emitted last; client closes the reader

### Per-tool result expanders (future parity target)
- Tool results currently render as raw JSON. The parity target is type-aware rendering:
  - SQL/KQL/DAX query results → table view with sortable columns
  - File listings → tree view
  - Workspace listings → linkable cards
  - Pipeline run states → run-id + portal deep-link
  - Errors → MessageBar with copy-stack-trace button

### Cost / token meter (future)
- Per-session token count + estimated USD cost based on the AOAI deployment's published per-1K-token price
- Hard ceiling guard (configurable per workspace) — refuses to continue mid-run if exceeded

### Replay / branch (future)
- "Replay this session with one tool changed" — edits a step's args inline and re-runs from that point forward
- "Branch from step N" — fork into a new session

### Pin / share (future)
- Pin a session as a "saved playbook" so colleagues can re-run the same prompt
- Share via copy-link (read-only) or workspace-scoped (re-runnable)

## What Loom has

The current `CopilotConsoleView` + `CrossItemCopilotEditor` (`apps/fiab-console/lib/editors/cross-item-copilot-editor.tsx`) is **production-grade for the happy path**:

- Three-column shell with sessions / chat / tools rails — implemented exactly as documented above
- Real SSE streaming from `/api/copilot/orchestrate` — implemented with proper event parsing
- Per-step `StepCard` component with kind-aware badging — implemented
- AOAI-missing 503 → MessageBar + Foundry deep-link — implemented
- Sessions persisted in Cosmos with `sessionId` partition — implemented
- Tools registry pulled live from `/api/copilot/tools` and grouped by service — implemented
- New-session + load-session flow — implemented
- 32 real tools wired to real Azure services via the dedicated client modules in `lib/azure/*` — implemented
- Embedded variant for the item-shell route — implemented
- Grade: **A (production-grade + tested)** — this is the strongest editor in the catalog batch. UAT 113/113 GREEN as of the v3.3 state memo. The remaining gaps are quality-of-life, not correctness.

## Gaps for parity (quality-of-experience parity with Foundry agents)

1. **Type-aware tool-result rendering absent** — every `tool_result` renders as raw JSON `<pre>`. SQL/KQL query results, file listings, workspace listings should each get a typed renderer.
2. **Cost / token meter absent** — no per-session token count, no estimated USD, no hard-ceiling guard.
3. **Replay / branch absent** — cannot edit a step and re-run; cannot fork a session.
4. **Pin / share / playbooks absent** — sessions are private to the creator; no way to publish a "this prompt is the canonical answer to X" playbook.
5. **Tool selection override absent** — the planner picks tools automatically; no UI to force "use synapse_serverless_query not adx_query".
6. **Cancel mid-run absent** — the **Orchestrate** button shows a spinner; there's no Cancel button to abort an in-flight tool call. Long ADX queries / Fabric notebook runs can hold the SSE open for minutes.
7. **Step retry absent** — when a `tool_result` returns an error, there's no inline **Retry with adjusted args** action.
8. **Tool registry filter absent** — the right rail shows all 32 tools grouped by service; no search box, no "tools available given my workspace permissions" filter.
9. **Tool-call breakpoint absent** — "ask me before calling write-class tools (lakehouse_write, adf_run_pipeline, apim_publish_api, item_create, workspace_create)" guard not in the UI.
10. **Approval chain absent** — no "this prompt would have spent >$X / called write tools / hit a production workspace; route through an approver" flow.
11. **Telemetry / tracing absent** — Foundry agents emit OpenTelemetry spans to App Insights; Loom currently logs each step to Cosmos but no App Insights / tracing wiring. Honest gate: a `data-agent`-style Diagnostics tab.
12. **Per-prompt content-safety pre-flight absent** — Foundry agents run Content Safety on prompt + response; Loom does not.
13. **Conversation context window absent** — prompts treat every run as new; no "build on the previous answer" multi-turn affordance even though Cosmos stores the session steps.
14. **Tool-call diff / dry-run absent** — for write-class tools, no "show me what would happen" preview.
15. **Foundry hand-off absent** — once a prompt + tool plan stabilizes, no one-click "promote this to a Foundry Agent so external apps can consume it via the Agent Service API".
16. **Vaporware risk** — the **View tool registry** ribbon button currently emits nothing (it's a label only); either wire it to focus the right rail or remove.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| Orchestrate (planner + tool dispatch) | **Azure OpenAI** deployment on the Foundry hub (auto-discovered via `listConnections()` with env overrides `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT`) | Already wired; uses `cognitiveservices` scope |
| Tool implementations (all 32) | Each wraps an existing Loom Azure client: `synapse-sql-client`, `synapse-dev-client`, `synapse-pool-arm`, `databricks-client`, `apim-client`, `adf-client`, `kusto-client`, `adls-client`, `powerbi-client`, `fabric-client`, `activator-client` | All real-REST wired; tool args validated server-side |
| Session persistence | Cosmos `copilot-sessions` container, PK `/sessionId` | Already wired; both list (`/api/copilot/sessions`) and detail (`/api/copilot/sessions/{id}`) endpoints exist |
| SSE streaming | Standard `ReadableStream` from Next.js route handler with `text/event-stream` content-type and `x-accel-buffering: no` | Already wired correctly |
| Auth (Loom → AOAI) | `ChainedTokenCredential(ManagedIdentityCredential({clientId: LOOM_UAMI_CLIENT_ID}), DefaultAzureCredential)` | Already wired |
| Auth (Loom → backing services per tool) | Each wrapped client owns its own credential chain (most use the same UAMI; PBI uses delegated user token where required) | Already wired |
| Cancel mid-run | New: server-side abort token tied to `sessionId`; new endpoint `POST /api/copilot/sessions/{id}/cancel` flips a Cosmos doc field that the orchestrate loop polls between steps | Not yet implemented |
| Cost / token meter | Each AOAI call's response includes `usage.prompt_tokens` + `completion_tokens`; sum per session, persist on the Cosmos doc; render in the prompt bar | Hook in the existing orchestrate loop |
| App Insights tracing | `@azure/monitor-opentelemetry` SDK, emit a span per step with `kind=tool_call`, `tool_name`, `duration_ms` attributes | Already deployed via `appinsights-csa-loom` per Loom bicep |
| Content Safety pre-flight | Azure AI Content Safety endpoint (same Foundry hub) — `POST /contentsafety/text:analyze` against the prompt; block if hate/sexual/violence/self-harm > threshold | Configurable per workspace |
| Foundry hand-off | Foundry Agent Service `POST /agents` with the tool list + system prompt; returns an `agentId` consumable via the Agent Service public REST | New endpoint `POST /api/copilot/sessions/{id}/promote-to-foundry` |
| Playbook publishing | Cosmos `items` container, partition `cross-item-copilot-playbook` | New item subtype; same `_lib/item-crud` pattern as everything else |

## Required Azure resources

- **Azure AI Foundry hub + project** (already deployed; `aifoundry-csa-loom-eastus2`)
- **Azure OpenAI deployment** of gpt-4o (or gpt-4 / gpt-4.1) on the Foundry hub — required for the planner; auto-discovered via Foundry connections
- **Azure Content Safety** (provisioned alongside Foundry — shared resource) — for the optional content-safety pre-flight
- **App Insights** (`appinsights-csa-loom` — already deployed) — for telemetry / tracing
- **Cosmos DB** `loomdb / copilot-sessions` container (PK `/sessionId`) — already deployed in `platform/fiab/bicep/modules/cosmos/`
- **User-Assigned Managed Identity** (`LOOM_UAMI_CLIENT_ID`) with the union of all per-tool RBAC roles already required by the wired editors (`Synapse Administrator`, `Storage Blob Data Contributor`, `Databricks Workspace Contributor`, `API Management Service Contributor`, `Data Explorer Database User`, `Data Factory Contributor`, `Power BI Service Principal`, `Fabric Workspace Contributor`, `Foundry User`, `Cosmos DB Built-in Data Contributor`) — all already wired by previous editor work
- **No new tenant-level admin step** beyond the ones already documented for the constituent editors

## Estimated effort

- **Session N+1 (~3 hrs)** — type-aware tool-result renderers (SQL/KQL/DAX table, file tree, workspace cards, pipeline run cards) — five renderer components, dispatched by tool name prefix
- **Session N+2 (~2 hrs)** — Cancel mid-run: server-side abort token + cancel endpoint + Cancel button in the prompt bar
- **Session N+3 (~2 hrs)** — Cost / token meter: per-step usage accumulation, prompt-bar surface, hard-ceiling guard
- **Session N+4 (~3 hrs)** — App Insights OTel tracing per step + Diagnostics tab (latency, success-rate, failure samples — parity with the Foundry agent diagnostics surface)
- **Session N+5 (~2 hrs)** — Tool-call breakpoint UX: classify write-class tools, require explicit confirm before dispatching unless an "auto-approve write tools" toggle is on
- **Session N+6 (~2 hrs)** — Step retry / args editing for failed `tool_result` cards; tool selection override picker
- **Session N+7 (~3 hrs)** — Playbook publishing + sharing: persist a session as a re-runnable `cross-item-copilot-playbook` item; "Use playbook" button on the prompt bar
- **Session N+8 (~3 hrs)** — Foundry hand-off: promote a stable session into a Foundry Agent via the Agent Service REST; surface the resulting `agentId` for external consumption
- **Session N+9 (~1 hr)** — Content Safety pre-flight (configurable per workspace); remove the vaporware **View tool registry** ribbon label or wire it; Vitest + Playwright

Total: **~21 hrs** across 9 sessions. Current grade: **A**. Target: **A+** — this editor is already the showcase surface; the gaps above are about reaching parity with Foundry Agents' production-grade UX (cost guards, tracing, approval, sharing, content-safety) rather than functional parity with any single Microsoft product.
