# copilot-usage — parity with Azure OpenAI usage metering + cost analytics

**Surface:** Admin → Copilot usage (`/admin/copilot-usage`) + inline panel in
Monitor → Cost. Per-persona Copilot token consumption.

**Source UI:** Azure Monitor / Application Insights "Usage" + Log Analytics
(`AppEvents`/`customEvents`) and the Azure OpenAI per-deployment token metrics
(`Microsoft.CognitiveServices/accounts` → Metrics → ProcessedPromptTokens /
GeneratedCompletionTokens). Grounded in Microsoft Learn:
- Azure OpenAI monitoring / token metrics: https://learn.microsoft.com/azure/ai-services/openai/how-to/monitor-openai
- App Insights custom events + Log Analytics KQL: https://learn.microsoft.com/azure/azure-monitor/app/api-custom-events-metrics
- Workspace-based App Insights table mapping (customEvents→AppEvents): https://learn.microsoft.com/azure/azure-monitor/app/convert-classic-resource

## Why this is a metering surface (not a Fabric object)

Loom owns its Copilot. There is no Fabric Copilot-usage report to mirror; the
1:1 reference is **Azure OpenAI usage metrics + Application Insights usage
analytics**. The panel reproduces the "tokens by deployment / by dimension over
time" experience Azure exposes, broken out by Loom Copilot **persona**.

## Azure feature inventory → Loom coverage

| Capability (Azure usage analytics)                                  | Loom coverage |
|---------------------------------------------------------------------|---------------|
| Total prompt / completion / total tokens over a time window         | ✅ KPI cards (`/api/admin/copilot-usage`, `totals`) |
| Token consumption broken out by a dimension (deployment, app, user) | ✅ By **persona**, by **model**, by **user (hashed)** — three KQL summaries |
| Time-series token trend (per day)                                   | ✅ Daily trend sparkline (`format_datetime(bin(TimeGenerated,1d))`) |
| Call count alongside tokens                                         | ✅ `count()` per persona / model / user |
| Adjustable window (last N days)                                     | ✅ `?days=` (1–90, default 30) → KQL `timespan = P{n}D` |
| Privacy: no raw user identifiers                                    | ✅ `user_oid_hash` = sha256(oid)[:16]; IP hashed in the Function path |
| Roll usage into cost context                                        | ✅ `CopilotUsageInline` mounted in Monitor → Cost tab |
| Honest gate when telemetry backend missing                          | ⚠️ Warning MessageBar naming `LOOM_LOG_ANALYTICS_WORKSPACE_ID` / `APPLICATIONINSIGHTS_CONNECTION_STRING` |

Zero ❌ — every inventory row is built or honest-gated.

## Backend per control (real data plane)

| Control                | Backend |
|------------------------|---------|
| Emit (write path), Console orchestrator | `emitCopilotUsage()` → POST `{IngestionEndpoint}/v2/track` (App Insights track envelope), iKey + endpoint parsed from `APPLICATIONINSIGHTS_CONNECTION_STRING`. Real `prompt_tokens`/`completion_tokens` from the AOAI `usage` field. |
| Emit (write path), copilot-chat Function | `telemetry.track_event("copilot.usage", …)` via OpenCensus `AzureEventHandler`. Real tokens from streaming `stream_options={"include_usage": True}`. persona=`help-chat`. |
| Read path (panel + inline) | `queryLogs(kql, P{n}D)` → Log Analytics `POST /v1/workspaces/{id}/query` against `LOOM_LOG_ANALYTICS_WORKSPACE_ID`. Three KQL summaries over `AppEvents | where Name == "copilot.usage"`. |
| Honest gate | `MonitorNotConfiguredError` → `{ ok:false, gate }` → warning MessageBar. |

## Personas metered

| persona       | Source surface                                  |
|---------------|-------------------------------------------------|
| `cross-item`  | Console cross-item Copilot orchestrator (default) |
| `help-chat`   | copilot-chat Function (help widget)             |
| `notebook`    | reserved — notebook-assist (emit wired when usage capture lands there) |

## Per-cloud matrix

| Cloud            | Write path (emit)                                              | Read path (KQL)                                              |
|------------------|---------------------------------------------------------------|-------------------------------------------------------------|
| Commercial / GCC | `IngestionEndpoint` from conn string → `*.in.applicationinsights.azure.com` | `api.loganalytics.azure.com` via `queryLogs()` |
| GCC-High / IL5   | `IngestionEndpoint` from conn string → `*.in.applicationinsights.us` | `api.loganalytics.us` via `LOOM_LOG_ANALYTICS_ENDPOINT` override |
| DoD              | same — endpoint is self-describing in the connection string   | same as GCC-High |

The write path is sovereign-agnostic: the correct regional ingestion host is
already inside the connection string Bicep provisions per boundary. No
hard-coded Fabric/Power BI host is touched on any path.

## Bicep / infra

No new resources, env vars, or RBAC. Already wired:
- `APPLICATIONINSIGHTS_CONNECTION_STRING` → every Container App
  (`app-deployments.bicep`).
- `LOOM_LOG_ANALYTICS_WORKSPACE_ID` → Console app from `monitoring.bicep`
  workspace output (`admin-plane/main.bicep`).
- Console UAMI already holds Log Analytics Reader on the LAW.

## Acceptance

1. Real Copilot call → orchestrator yields `final` with `usage` → `copilot.usage`
   event POSTed to App Insights (verified by the unit test asserting the
   envelope: persona + string token counts + hashed oid).
2. `AppEvents | where Name == "copilot.usage" | top 5 by TimeGenerated desc`
   returns rows with `Properties.prompt_tokens > 0`.
3. Admin → Copilot usage shows real per-persona token counts; Monitor → Cost
   shows the same totals.
4. With `APPLICATIONINSIGHTS_CONNECTION_STRING` unset: emit no-ops; with
   `LOOM_LOG_ANALYTICS_WORKSPACE_ID` unset: panel renders the honest warning
   MessageBar (no throw, no synthetic zeros).
