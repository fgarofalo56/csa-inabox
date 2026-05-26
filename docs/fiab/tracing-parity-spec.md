# Loom Tracing Editor — AI Foundry parity spec

> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Sources: Microsoft Learn — [Observability in generative AI](https://learn.microsoft.com/azure/ai-foundry/concepts/observability), [Trace and observe AI agents (classic)](https://learn.microsoft.com/azure/foundry-classic/how-to/develop/trace-agents-sdk), [Configure tracing for AI agent frameworks](https://learn.microsoft.com/azure/foundry/observability/how-to/trace-agent-framework), [Add client-side tracing to Foundry agents](https://learn.microsoft.com/azure/foundry/observability/how-to/trace-agent-client-side), [Enable Observability (Agent Framework)](https://learn.microsoft.com/agent-framework/agents/observability). Cross-checked against `apps/fiab-console/lib/editors/foundry-sub-editors.tsx::TracingEditor` (lines 442–482) and BFF route `app/api/items/tracing/route.ts`.

## What it is

AI Foundry **Tracing** is the observability surface for LLM, tool, and agent execution. It is built on **OpenTelemetry semantic conventions for generative AI** — each request emits a tree of spans (one root, nested children for model calls, tool invocations, RAG retrieval, evaluation steps, agent decisions) — and exports them to **Azure Monitor Application Insights** via the OTLP exporter or the `azure-monitor-opentelemetry` package.

Foundry stitches three sources into one Tracing view:
- **Server-side traces** (auto-captured) for agents and flows running inside the Foundry portal
- **Client-side traces** (opt-in) from user code instrumented with `langchain-azure-ai`, `opentelemetry-instrumentation-openai-agents`, or the Microsoft Agent Framework
- **Evaluation traces** (auto) for runs of built-in / custom evaluators

The portal surface is gated by an **Application Insights** resource bound to the Foundry hub / project.

## UI components

### Page chrome
- Title bar: project name, App Insights connection status, time window picker
- Right-side actions: **Refresh**, **Settings** (sampling rate, content recording), **Export** (CSV, JSON, KQL query), **Open in App Insights**

### Filter bar (always-on)
- Time window: 5m / 1h / 24h / 7d / custom (start/end)
- Free-text search across span names, operation names, attributes, message
- Faceted filters: **Operation name**, **Span kind** (server / client / internal / consumer / producer), **Status** (OK / ERROR / UNSET), **Agent ID** / **Agent reference name**, **Model** (`gen_ai.request.model`), **User** (`enduser.id`), **Session ID**, **Has exception**, **Min duration**

### Traces list (default)
- Tabular grid: one row per **root span / trace**
- Columns: **Timestamp**, **Operation name**, **Root span name**, **Duration**, **Status**, **# spans**, **Tokens (prompt / completion / total)**, **Cost** (when token-pricing is configured), **Error**
- Row click opens **Trace detail** in a side pane (or full page)

### Trace detail — Spans tree view
- **Gantt strip** along the top: each span as a horizontal bar, color-coded by kind (LLM = blue, Tool = orange, Retrieval = green, Agent = purple, Internal = grey); hover for name + duration tooltip
- **Tree** on the left: nested span list with name, kind icon, duration, status badge
- **Detail pane** on the right (selected span):
  - **Attributes** tab: OTel semantic-convention keys (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `gen_ai.response.finish_reason`, `tool.name`, `tool.input`, `tool.output`, `enduser.id`, `agent.id`, plus custom)
  - **Events** tab: timestamped events on the span (e.g. `gen_ai.choice`, `tool.start`, `tool.end`, exception events)
  - **Input / Output** tab: rendered chat messages (system / user / assistant) when `AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED=true`; tool I/O JSON
  - **Exceptions** tab: stack trace + message when status=ERROR
  - **Linked spans** tab: cross-trace links (e.g. evaluation run → original flow trace)

### Latency breakdown panel
- Stacked horizontal bar: time spent in LLM calls vs Tool calls vs Retrieval vs Agent logic vs Other
- "Slowest span" callout with link
- Token usage breakdown (prompt vs completion vs total) per LLM call

### Search / advanced filter
- Free-text → KQL preview drawer that shows the underlying Log Analytics query against the App Insights `traces`, `dependencies`, `customEvents` tables
- Saved searches
- "Find similar" on a span: queries the same operation + same model

### Comparison view (multi-select traces)
- Side-by-side metric strip: duration, total tokens, # LLM calls, # tool calls, status
- Diff view of root prompt / response when both have content recording on

### Live tail
- Toggle to stream new traces as they arrive (refresh every 10s, max 100 rows)

### Export
- **CSV** (current filtered list), **JSON** (full trace with spans + attributes), **Copy KQL** (the equivalent Log Analytics query)

### Settings
- Sampling rate (% of requests sampled)
- Content recording toggle (warns about PII)
- Retention window (read-only, surfaces App Insights retention policy)

## What Loom has

Current `TracingEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` lines 442–482) is real-REST wired to Application Insights via `lib/azure/foundry-client.ts::queryTraces` and BFF route `GET /api/items/tracing`. The client resolves the Foundry hub's bound `applicationInsights` resource id, runs a KQL `union traces, dependencies, customEvents` query, and returns up to 200 rows.

- **Window (hrs)** input (default 24, max enforced server-side at 168 hours)
- **Operation** filter input (free-text)
- **Reload** button
- Results table columns: **Time**, **Operation**, **Name**, **Duration (ms)**, **Success** (true/false badge), **Result** (resultCode)
- Errors / not-deployed surface honestly via `ErrorBar` (e.g. when the hub has no App Insights bound: `NotDeployedError('Application Insights', 'Bind one in the hub workspace properties.')`)

That is: Loom can show a flat list of recent spans with filtering by time + operation name, but everything else — the span tree, attributes, latency breakdown, exception view, gen-AI-specific surface, KQL drawer, export — is missing.

## Gaps for parity

1. **Spans tree** — Loom shows a flat row per span. Foundry pivots on the **root trace** and renders the full parent / child tree with a Gantt bar. Needs `operation_Id` grouping + parent-id reconstruction in the query.
2. **Per-span detail pane** — no attributes / events / input-output / exception sub-tabs. Currently no way to inspect a single span beyond what fits in the row.
3. **Gen-AI semantic conventions** — Loom's columns are generic AppInsights (`name`, `operation_Name`, `success`, `resultCode`). Foundry surfaces `gen_ai.request.model`, `gen_ai.usage.*_tokens`, `tool.name`, `agent.id` as first-class columns / facets.
4. **Latency breakdown** — no stacked-bar view of LLM vs Tool vs Retrieval time within a trace.
5. **Token usage / cost** — no aggregation of prompt / completion / total tokens per trace; no cost calculation.
6. **Content recording (Inputs / Outputs)** — chat messages and tool I/O aren't extracted from `customDimensions`; today they're hidden behind the `customDimensions` JSON blob.
7. **Exception drill-down** — no dedicated tab; failed spans only render their `resultCode`.
8. **Search across attributes** — Loom only filters on `operation_Name`. No free-text search across `name`, `message`, `customDimensions.gen_ai.*`.
9. **Faceted filters** — no facets for model, agent ID, user, session, status, span kind.
10. **Comparison view** — no multi-select → side-by-side diff of two traces.
11. **Live tail** — no streaming refresh.
12. **KQL preview / Export** — no drawer showing the underlying query, no CSV / JSON / copy-KQL action.
13. **Settings** — no sampling-rate / content-recording toggles (these write to the App Insights resource).
14. **Linked spans** — no cross-trace navigation (e.g. evaluation trace → originating flow trace).
15. **Time-range presets** — Loom uses a free-form hours input. Foundry has 5m / 1h / 24h / 7d / custom presets.

## Backend mapping

Single backend: **App Insights Log Analytics-backed query API** at `https://management.azure.com/{appInsightsId}/api/query?api-version=2015-05-01` (already wired). Foundry-side annotations come from the same KQL — just richer projections and grouping.

| Loom surface | Backend KQL / API call |
|---|---|
| Traces list (flat, current) | `union traces, dependencies, customEvents \| where timestamp > ago(<h>h) \| project timestamp, name, operation_Name, duration, success, resultCode, message, customDimensions` (current; wired) |
| Traces list (root-rooted, target) | Same union, then `summarize spanCount=count(), rootName=anyif(name, isempty(operation_ParentId)), totalDuration=sum(duration), totalTokens=sumif(toint(customDimensions["gen_ai.usage.total_tokens"]), isnotempty(customDimensions["gen_ai.usage.total_tokens"])) by operation_Id, operation_Name` |
| Trace detail (one trace tree) | `union traces, dependencies \| where operation_Id == "<id>" \| project timestamp, id, parentId=operation_ParentId, name, duration, customDimensions \| order by timestamp asc` (then client-side parent/child stitch) |
| Span attributes | Already in `customDimensions` (JSON in the row); just parse keys matching `gen_ai.*`, `tool.*`, `agent.*`, `enduser.*` |
| Exception drill-down | `exceptions \| where operation_Id == "<id>"` |
| Token / cost aggregation | `customDimensions["gen_ai.usage.prompt_tokens"]` + `_completion_tokens` + price table lookup |
| Faceted counts | `summarize count() by customDimensions["gen_ai.request.model"]` etc. |
| Live tail | Same query with `timestamp > ago(15s)` polled every 10s |
| Sampling rate / content recording | `PATCH {arm}/.../components/{appi}?api-version=2020-02-02-preview` writes the sampling rate; content-recording is set at the SDK side via env vars and surfaced read-only here |
| Get bound App Insights | `getWorkspaceInfo()` already resolves `ws.applicationInsights` (wired) |

New helpers required in `foundry-client.ts`: `queryTraceTree(operationId)`, `queryTraceFacets(window, field)`, `queryTokenUsage(window)`, `queryLiveTail(sinceTimestamp)`. Most of these are KQL variations on the existing `armFetch` + App Insights `/api/query` path; no new RP integration needed.

## Required Azure resources

- **Application Insights** component (`Microsoft.Insights/components`) bound to the Foundry hub / project via `workspace.properties.applicationInsights` — already documented as required; honest `NotDeployedError` surfaces today when it's missing
- **Log Analytics workspace** that backs the App Insights (created automatically when App Insights is workspace-based, which is the default for new resources since 2022)
- **Loom UAMI roles**: `Monitoring Reader` on the App Insights resource (already wired); `Application Insights Component Contributor` to change sampling rate from the Settings panel
- **For content recording**: instrumented apps must set `AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED=true` (Python) or equivalent in their own code — Loom can surface a doc link / instruction in the Settings panel but cannot toggle it remotely
- **Bicep**: confirm `modules/observability/app-insights.bicep` (already present in the FiaB orchestrator) wires the App Insights id into the Foundry hub via `Microsoft.MachineLearningServices/workspaces.properties.applicationInsights`. Loom UAMI role assignments on the App Insights resource go in the same module.

`MessageBar intent="warning"` triggers: hub has no App Insights bound (already honest), Loom UAMI lacks `Monitoring Reader` (queries 403), App Insights retention < query window.

## Estimated effort

**3 sessions** to reach grade B:

- **Session N+1 (~2.5 hrs):** Pivot the list from flat spans to root-traces (group by `operation_Id`, project tokens + span count + total duration). Add 5m / 1h / 24h / 7d preset chips. Parse `customDimensions` to surface `gen_ai.request.model`, token columns. Add faceted filters (model, agent ID, status).
- **Session N+2 (~2.5 hrs):** Trace detail pane with spans tree + Gantt bar. Per-span sub-tabs (Attributes / Events / Inputs-Outputs / Exceptions). Wire `queryTraceTree` helper. Surface the latency breakdown stacked bar.
- **Session N+3 (~2 hrs):** Comparison view (multi-select). Live tail toggle. KQL preview drawer. CSV / JSON export. Settings panel for sampling rate.

Grade A+ adds Vitest coverage on the parent-id stitching reducer (must produce a deterministic tree even when spans arrive out of order or with a missing parent), a Playwright walk against a seeded set of synthetic OTel spans (LangChain + tool + agent), and bicep additions documenting the App Insights → Foundry hub binding so a fresh deployment surfaces real traces without manual portal steps.
