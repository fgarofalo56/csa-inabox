<!-- parity-doc-meta
Reviewed-on: 2026-07-28
Validated-against:
  - apps/fiab-console/lib/components/governance/insight-digests-panel.tsx
  - apps/fiab-console/app/governance/insights/page.tsx
  - apps/fiab-console/lib/insights/digest-model.ts
  - apps/fiab-console/lib/insights/digest-store.ts
  - apps/fiab-console/lib/insights/digest-gate.ts
  - apps/fiab-console/app/api/insights/digests
  - apps/fiab-report-subscriptions/src/insights-engine.ts
  - apps/fiab-report-subscriptions/src/insight-digest-model.ts
  - platform/fiab/bicep/modules/admin-plane/report-subscriptions-function.bicep
  - platform/fiab/bicep/modules/integration/report-subscription-logicapp.bicep
-->

# insight-digests — parity with **Power BI / Fabric subscriptions + Azure Monitor "Insights" digests**

Source UI:

- Power BI "Subscribe to report" (schedule, recipients, pause/resume, run history) —
  <https://learn.microsoft.com/power-bi/collaborate-share/end-user-subscribe>
- Azure Monitor metrics explorer + fired-alert list (the data this narrates) —
  <https://learn.microsoft.com/azure/azure-monitor/essentials/metrics-getting-started>
- Azure Functions timer trigger / NCRONTAB (the schedule grammar) —
  <https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer>

> **Scope note (no Fabric dependency).** A digest never touches Fabric, Power BI,
> or OneLake. Its signals are Azure Monitor platform metrics
> (`microsoft.insights/metrics`) and fired alert instances
> (`Microsoft.AlertsManagement/alerts`); the narration runs on the Loom Azure
> OpenAI deployment in-boundary; delivery is a Consumption Logic App with an
> Office 365 connection. `LOOM_DEFAULT_FABRIC_WORKSPACE` is never read.
>
> **One scheduler.** Digests are processed by the EXISTING C5
> report-subscriptions timer Function on the SAME tick that delivers report
> subscriptions (`functions/reportSubscriptions.ts` → `runSubscriptions` then
> `runInsightDigests`), through the SAME delivery Logic App. No second scheduler,
> no second workflow, no second O365 connection.

## Source feature inventory → Loom coverage

| Capability (source UI) | Loom | Where / backend |
|---|---|---|
| Create a scheduled delivery | ✅ | `POST /api/insights/digests` → Cosmos `insight-digests` |
| Named subscription + description | ✅ | `name` / `description`, validated in `digest-model.validateDigestInput` |
| Schedule picker (daily / weekday / weekly / monthly / hourly / 15-min) | ✅ | `SCHEDULE_PRESETS` (the SAME presets report subscriptions use) |
| Advanced/custom schedule expression | ✅ | Custom NCRONTAB field, validated by `validateNcrontab` (6-field, identical to the Function's `cron-match.parseCron`) |
| Recipient list | ✅ | Comma-separated, per-address email validation, capped at 50 |
| Pause / resume | ✅ | Row `Switch` → `PATCH { enabled }` |
| Edit an existing subscription | ✅ | Row **Edit** re-opens the same dialog → `PATCH` |
| Delete | ✅ | Row delete → `DELETE /api/insights/digests/[id]` |
| Run history with per-run status + error | ✅ | Cosmos `insight-digest-log`, `GET /api/insights/digests/[id]` |
| Last-run status on the list row | ✅ | `lastStatus` / `lastRunAt` badges (succeeded / failed / skipped / never run) |
| Send now | ✅ (honest semantics) | **Send** stamps `runNowRequestedAt`; the C5 Function consumes + clears it on its next tick. The console never sends mail, and the response says so verbatim rather than implying an instant send. |
| See the content before it ships | ✅ **(exceeds source)** | **Preview** runs the digest for real against Azure Monitor + Copilot and renders the exact delivered body — Power BI has no equivalent |
| Choose the payload | ✅ | Resource-type multiselect over the live `METRIC_CATALOG`; include/exclude fired alerts |
| Comparison window | ✅ | 1h / 6h / 24h / 3d / 7d, each compared against the immediately preceding window of equal length |
| Anomaly sensitivity | ✅ | 10 / 15 / 25 / 50 / 100 % change threshold |
| Narration mode | ✅ | Copilot narration (grounded, refuse-don't-guess prompt) or a deterministic grounded summary with no model call |
| Delivery-infra gate | ⚠️ honest gate + Fix-it | Shares the registered `svc-report-subscriptions` gate; the pane renders a warning MessageBar with an inline **Fix it** into `/admin/gates?gate=svc-report-subscriptions`. Definitions still save and begin delivering when the infra lands. |
| Monitor-not-configured | ⚠️ honest gate | Preview returns 503 `{ gate: { missing, message } }` naming `LOOM_SUBSCRIPTION_ID` + the Monitoring Reader grant — the same shape every other Monitor-backed surface uses |
| Kill switch | ✅ | `n19d-insight-digests` runtime flag (default ON, fail-open) |

**Zero ❌.**

## Backend per control

| Control | Backend |
|---|---|
| List / create / edit / delete / pause | Cosmos `insight-digests` (PK `/tenantId`) |
| Run history | Cosmos `insight-digest-log` (PK `/digestId`) — written by BOTH the console preview (`preview: true`) and the Function delivery |
| Preview | `monitor-client.listResources` + `fetchMetrics` (real `microsoft.insights/metrics`) + `listAlertHistory` (real `Microsoft.AlertsManagement/alerts`) + `aoaiChat` |
| Scheduled delivery | `apps/fiab-report-subscriptions/src/insights-engine.ts` — ARM resources/metrics/alerts REST + AOAI chat REST + the delivery Logic App |
| Send (queue) | `runNowRequestedAt` stamp consumed by the Function |
| Audit | `emitAuditEvent` on create / update / delete / preview / queue-run |

## Notes

- **Metric plan.** `METRIC_CATALOG` lives only in the console. On save the BFF
  resolves the selected resource types into `metricPlan` (resourceType, metric,
  aggregation, label) and stores it on the doc, so the Function executes a plan
  and carries no copy of the catalog.
- **Deliberate port.** `apps/fiab-report-subscriptions/src/insight-digest-model.ts`
  is a narrow copy of the console's pure delta/prompt/HTML helpers (the two apps
  have no shared workspace package). Both export `DIGEST_MODEL_VERSION` and both
  test suites assert the same golden vectors, so an unmirrored change fails CI.
- **Logic App change.** The delivery workflow now accepts an optional `bodyHtml`
  and an optional attachment. A report subscription (attachment, no `bodyHtml`)
  renders byte-identically to the pre-N19d workflow.
