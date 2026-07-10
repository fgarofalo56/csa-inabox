# stream-analytics-job — parity with Azure Stream Analytics

Source UI: **Azure portal — Stream Analytics job**
(`Microsoft.StreamAnalytics/streamingjobs`):
<https://learn.microsoft.com/azure/stream-analytics/stream-analytics-introduction>.
Query editor: <https://learn.microsoft.com/azure/stream-analytics/stream-analytics-quick-create-portal>.
Test with sample data: <https://learn.microsoft.com/azure/stream-analytics/stream-analytics-test-query>.
No-code editor: <https://learn.microsoft.com/azure/stream-analytics/no-code-stream-processing>.

Native Azure service (Fabric's Eventstream/RTI parity is separate). Loom drives
a real ASA job in the configured RG over ARM. No Microsoft Fabric dependency
(`no-fabric-dependency.md`).

Editor: `apps/fiab-console/lib/editors/stream-analytics-editor.tsx`
(tabs: Query · Query Builder · Test · Inputs · Outputs · Functions · Monitoring).
Catalog: `fabric-item-types.ts` slug `stream-analytics-job`, category
**Streaming analytics**.

## Azure/Fabric feature inventory

1. **List jobs** and select one.
2. **Author the SAQL query** (query editor).
3. **No-code / query builder** authoring.
4. **Test the query** — compile + run against sample/live input.
5. **Manage inputs** (stream/reference sources).
6. **Manage outputs** (sinks) — add / delete.
7. **User-defined functions** management.
8. **Start / Stop** the job.
9. **Monitoring** — job metrics (input/output events, watermark, errors).

## Loom coverage    (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | List + select jobs | ✅ | `GET /api/items/stream-analytics-job`; left-rail job buttons. |
| 2 | Author SAQL query | ✅ | Query tab; **Save query** → `…/[name]/query` (dirty-tracked). |
| 3 | Query Builder (no-code) | ✅ | Query Builder tab composes SAQL and hands to the Query/Test tabs. |
| 4 | Test query (compile + run) | ✅ | Test tab → `…/[name]/test` (`compile` / `run`); valid/invalid + status surfaced; honest warning hint when sample input isn't available. |
| 5 | Inputs | ✅ | Inputs tab (count) → `…/[name]/inputs`. |
| 6 | Outputs (add/delete) | ✅ | Outputs tab → `…/[name]/outputs` POST/DELETE. |
| 7 | Functions | ✅ | Functions tab (count) from job detail. |
| 8 | Start / Stop | ✅ | `…/[name]/state` POST; running-state gates the buttons. |
| 9 | Monitoring metrics | ✅ | Monitoring tab → `…/[name]/metrics` (real Azure Monitor metrics; refreshable). |

## Backend per control

- List / detail → `app/api/items/stream-analytics-job/route.ts`,
  `…/[name]/route.ts` (ARM `Microsoft.StreamAnalytics/streamingjobs`).
- Query / test / state / inputs / outputs / metrics →
  `…/[name]/{query,test,state,inputs,outputs,metrics}/route.ts` via
  `stream-analytics-client`.
- **Honest gate:** when ASA is not configured, routes return 501 with a `hint`
  naming the bicep module
  (`platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep`,
  `enableStreamAnalytics=true`) and env vars `LOOM_ASA_RG` (+ `LOOM_ASA_SUB`),
  plus the **Stream Analytics Contributor** role on the RG. The editor renders
  it as a Fluent MessageBar — no mock arrays (`no-vaporware.md`).

## UX-baseline lift (UX-Wave 2 · UX-203)

A UX-only lift adopting shared UX-baseline components; the real ARM/query/test/
metrics calls are unchanged.

| # | Bar item (SC) | State | Where |
| --- | --- | --- | --- |
| 5 | Type-badged preview + timing status bar (SC-5) | ✅ built | The Test "Run test" output rows render via the shared `PreviewTable` — type-badged column headers (Abc / 123 / …) + "Succeeded · Columns N · Rows N" status bar + row search — replacing the plain output table |
| 12 | Teaching banner (SC-6) | ✅ built | `TeachingBanner surfaceKey="stream-analytics-authoring"` — continuous-query guidance, persistent dismiss + Learn-more |
| 11 | Command search Ctrl+Q / Alt+Q (SC-9) | ✅ built | `commandSearch` + `useRegisterRibbonCommands(ribbon, item.slug)` publishes Start / Stop / Save / Query Builder / Test / topology actions |
| 3 | Docked validation-dot inspector (SC-3) | ⚠️ partial | The Query Builder already ships a form-based `AsaTransformInspector` right rail; a full `DockedInspector` validation-dot refactor is deferred to the B-sweep |
| 1 | Input→query→output streaming canvas (SC-1) | ⚠️ honest-defer | The editor ships a guided transform builder + Copilot; a full node-kit streaming diagram is a larger build deferred to the B-sweep rather than duplicate the working builder |
| 14 | Per-surface Copilot (SC-1 slot) | ✅ pre-existing | `CopilotBuilderPane` on the Copilot tab (grounds SAQL on the job's real inputs/outputs) |

Test: `lib/editors/__tests__/stream-analytics-job.test.tsx` (existing 5 specs still green).
