# genai-eval-depth — parity with Azure AI Foundry evaluation + MLflow evaluate

Source UI:
- **Azure AI Foundry → Evaluations** — run evaluation (create evaluation run, pick
  metrics, provide question/answer/context, view per-row scores + aggregate summary).
  https://learn.microsoft.com/azure/ai-foundry/how-to/evaluate-generative-ai-app
- **MLflow `mlflow.evaluate()`** — one-click evaluator API: pass question, answer,
  context; receive groundedness / relevance / coherence / fluency scores from an
  LLM judge.
  https://learn.microsoft.com/azure/machine-learning/how-to-evaluate-llm-models
- **Azure Monitor → Alerts → Scheduled query rules** — continuous alerting based
  on a Log Analytics KQL query (eval regression alert).
  https://learn.microsoft.com/azure/monitor/alerts/alerts-create-log-alert-rule
- **OTel / Azure Monitor Application Insights** — span waterfall / distributed trace view.
  https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-overview

Azure-native backend only — no Microsoft Fabric or Power BI workspace required.
AOAI judge calls go to `LOOM_AOAI_ENDPOINT` / `LOOM_AOAI_DEPLOYMENT` (existing vars).
Span data reads from existing `loom-agent-memory` Cosmos container (no new container).
Alert is a real `Microsoft.Insights/scheduledQueryRules` via existing `monitor-client`.

## Azure AI Foundry / MLflow feature inventory

| # | Feature | Loom coverage | Backend |
|---|---------|--------------|---------|
| 1 | Run evaluation with groundedness metric | ✅ built | POST /api/foundry/agents/eval/judge → AOAI |
| 2 | Run evaluation with relevance metric | ✅ built | POST /api/foundry/agents/eval/judge → AOAI |
| 3 | Run evaluation with tool-call-accuracy metric | ✅ built | POST /api/foundry/agents/eval/judge → AOAI |
| 4 | Run evaluation with task-adherence metric | ✅ built | POST /api/foundry/agents/eval/judge → AOAI |
| 5 | One-click "run all evaluators" | ✅ built | 4× sequential judge calls |
| 6 | Per-evaluator score (1–5) with rationale | ✅ built | AOAI judge → parseJudgeResponse |
| 7 | Aggregate summary (avg, worst, cluster) | ✅ built | clusterFailures() — pure client |
| 8 | Failure cluster analysis / theme grouping | ✅ built | clusterFailures() — keyword-frequency |
| 9 | Context / source grounding input | ✅ built | groundedness-specific context textarea |
| 10 | Tool-call log input | ✅ built | tool-call-accuracy-specific textarea |
| 11 | Honest gate when AOAI not configured | ✅ built | 503 + MessageBar naming LOOM_AOAI_ENDPOINT |

## OTel span-tree feature inventory

| # | Feature | Loom coverage | Backend |
|---|---------|--------------|---------|
| 12 | Span waterfall for multi-tool agent turn | ✅ built | GET /api/foundry/agents/spans → span-tree.ts |
| 13 | Per-span kind badge (agent-turn / tool-call / message-creation / code-interpreter / retrieval) | ✅ built | buildSpanTree() |
| 14 | Per-span status (completed / failed / in_progress) | ✅ built | SpanNode.status |
| 15 | Token rollup (prompt + completion + total) | ✅ built | normalizeUsage() → root span |
| 16 | Latency rollup (total wall-clock ms) | ✅ built | first-start → last-completion |
| 17 | Error span highlight (isError = red badge) | ✅ built | SpanNode.isError |
| 18 | Flat span count | ✅ built | rollupSpanTree().spanCount |
| 19 | Resizable span/rollup split (G3) | ✅ built | SplitPane storageKey="eval-depth-spans" |
| 20 | Honest gate when Cosmos not configured | ✅ built | 503 + MessageBar naming LOOM_COSMOS_ENDPOINT |

## Continuous-eval alert feature inventory

| # | Feature | Loom coverage | Backend |
|---|---------|--------------|---------|
| 21 | Create scheduled-query alert rule | ✅ built | POST /api/admin/agent-quality/eval-alert |
| 22 | Score threshold configuration (dropdown, not freeform) | ✅ built | Dropdown: 4.5/4.0/3.5/3.0 |
| 23 | Enable / disable alert | ✅ built | POST (enabled=true/false) / DELETE |
| 24 | View current alert status | ✅ built | GET → alertRule.enabled |
| 25 | Optional action-group routing | ✅ built | LOOM_EVAL_MONITOR_ACTION_GROUP_ID (opt-in) |
| 26 | skipQueryValidation on fresh estate | ✅ built | buildEvalAlertInput → skipQueryValidation:true |
| 27 | Honest gate when Monitor not configured | ✅ built | 503 + MessageBar naming LOOM_SUBSCRIPTION_ID, LOOM_ALERT_RG |
| 28 | Tenant-admin gated | ✅ built | requireTenantAdmin(session) |

## Backend per control

| Control | REST / data-plane |
|---------|------------------|
| Judge button | `POST /api/foundry/agents/eval/judge` → `aoaiChatJson()` → `LOOM_AOAI_ENDPOINT` |
| Thread dropdown | Existing agent thread records in `loom-agent-memory` Cosmos container |
| Span load | `GET /api/foundry/agents/spans` → `listThreads()` → `buildSpanTree()` |
| Alert create/update | `POST /api/admin/agent-quality/eval-alert` → `upsertScheduledQueryRule()` → `Microsoft.Insights/scheduledQueryRules` |
| Alert disable | `DELETE /api/admin/agent-quality/eval-alert` → `patchScheduledQueryRule(name, false)` |
| Alert status | `GET /api/admin/agent-quality/eval-alert` → `listScheduledQueryRules()` |

## Parity verdict

All 28 rows: ✅ built (zero ❌, zero stub banners). Surface is A-grade pending
in-browser E2E receipt (G1 — attached in PR body).

No Microsoft Fabric or Power BI workspace dependency. Azure-native default on all paths.
