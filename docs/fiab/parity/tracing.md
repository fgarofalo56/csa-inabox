# tracing — parity with Azure AI Foundry tracing (observability)

Source UI: **Azure AI Foundry — Tracing** (`https://ai.azure.com/tracing`):
GenAI trace + span observability over the project's Application Insights.
<https://learn.microsoft.com/azure/ai-foundry/how-to/develop/trace-application>,
<https://learn.microsoft.com/azure/ai-foundry/concepts/observability>.
Underlying store: Application Insights `dependencies` / `requests` /
`traces` (GenAI semantic-convention spans). No Microsoft Fabric dependency
(`no-fabric-dependency.md`).

Editor: `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` → `TracingEditor`.
Catalog: `fabric-item-types.ts` slug `tracing`, category **Azure AI Foundry**.

## Azure/Fabric feature inventory

1. **List traces** over a time window, filterable by operation.
2. **Trace row detail** — timestamp, operation, name, duration, success, result code.
3. **Drill into a trace** → its full span tree (parent → child).
4. **Span detail** — kind, GenAI model, token usage (in/out), duration, success.
5. **Open in Foundry** (deep-link to `ai.azure.com/tracing`).
6. (Foundry extras) evaluation/annotation on a trace, per-span input/output payload inspection, live streaming/auto-refresh.

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | List traces (window + operation) | ✅ | Window (hrs) + Operation inputs → `GET /api/items/tracing?hours&operation` (App Insights `queryTraces`). |
| 2 | Trace row detail | ✅ | Table: time / operation / name / duration / success (Badge) / result code. |
| 3 | Drill → span tree | ✅ | "View spans" → `GET /api/items/tracing/[traceId]`; client builds the depth-tagged parent→child tree (`buildSpanTree`). |
| 4 | Span detail (model / tokens) | ✅ | Span table: kind, GenAI model, input/output tokens, duration, success. |
| 5 | Open in Foundry | ✅ | Ribbon deep-link to `https://ai.azure.com/tracing`. |
| 6 | Evaluation/annotation, raw payload inspection, live streaming | ❌ | Not built; the surface is read/inspect over App Insights, not an evaluation harness. |

## Backend per control

- Trace list → `app/api/items/tracing/route.ts` → `foundry-client.queryTraces({hours, operation})`.
- Span tree → `app/api/items/tracing/[traceId]/route.ts` → `foundry-client.queryTraceDetail(traceId)`.
- **Honest gate:** both routes throw `NotDeployedError` → 503 `{notDeployed:true, hint}`
  when the Foundry hub's Application Insights isn't bound; the editor's
  `ErrorBar` renders the hint rather than fabricating traces (`no-vaporware.md`).
  `FoundryError` maps to the upstream status.
