<!-- parity-doc-meta
Reviewed-on: 2026-08-07
Validated-against:
  - apps/fiab-console/lib/components/governance/insight-digests-panel.tsx
  - apps/fiab-console/app/governance/insights/page.tsx
  - apps/fiab-console/lib/insights/digest-model.ts
  - apps/fiab-console/lib/insights/digest-store.ts
  - apps/fiab-console/lib/insights/digest-gate.ts
  - apps/fiab-console/app/api/insights/digests
  - azure-functions/report-subscriptions/src/insights-engine.ts
  - azure-functions/report-subscriptions/src/insight-digest-model.ts
  - azure-functions/report-subscriptions/src/delivery-payload.ts
  - azure-functions/report-subscriptions/src/main.ts
  - platform/fiab/bicep/modules/admin-plane/report-subscriptions-job.bicep
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
> **One scheduler.** Digests are processed by the EXISTING report-subscriptions
> Container App Job (`loom-report-subscriptions`, Schedule trigger) in the SAME
> execution that delivers report subscriptions (`src/main.ts` → the delivery
> pass, then `runInsightDigests`), through the SAME delivery Logic App. No
> second scheduler, no second workflow, no second O365 connection.

> ### Correction — this pane was INERT from 2026-07-28 to 2026-08-07 (fixed)
>
> The row below was previously marked ✅ end-to-end. It was not. The repo held
> **two** report-subscriptions Functions:
>
> | | `apps/fiab-report-subscriptions` | `azure-functions/report-subscriptions` |
> |---|---|---|
> | Created | #1008 | #2373 (WS-C2) |
> | Rendering | Power BI **ExportTo** — violates `no-fabric-dependency.md` | paginated-report-renderer (Azure-native, Gov-safe) |
> | Deployed by | **nothing** | `csa-loom-post-deploy-bootstrap.yml` |
> | Held `insights-engine.ts` (B-N19d) | **yes** | no |
>
> So the digest engine shipped into the app **no deployer references**, while the
> deployed Function had no digest code at all. `POST /api/insights/digests/[id]/run`
> stamped `runNowRequestedAt` for a consumer that was never running: **no
> scheduled digest ever delivered.**
>
> Fixed by porting the engine (plus `cron-match` / `insight-digest-model`) onto
> the DEPLOYED Function, wiring it into that Function's tick, and deleting the
> orphaned Power-BI-dependent duplicate.
>
> ### Runtime: the Y1 blocker is RESOLVED (C3 #3068, merged 2026-08-07)
>
> When the port was first written, the host was a Linux **Y1 Consumption
> Function** — documented non-functional on this estate
> (`docs/fiab/deployment/functions-to-aca-jobs.md`). C3 has since migrated
> report-subscriptions to an in-VNet **Container App Job**
> (`loom-report-subscriptions`, Schedule trigger, every 15 minutes, running as
> the console UAMI), and proved a real execution on the estate. This PR is
> rebased onto that migration: the digest pass now runs from `src/main.ts`
> inside the ACA-job execution, so it has a runtime that actually fires.
>
> C3's own doc listed `apps/fiab-report-subscriptions` as an orphan holding the
> digest engine and handed it to C2; that finding is closed here.
>
> **RBAC note.** The job runs as the CONSOLE UAMI, which already holds
> Monitoring Reader at subscription scope via
> `admin-plane/monitoring-reader-rbac.bicep` (`consolePrincipalId`). The
> `digestPrincipalId` parameter in that module is now deliberately `''` — it
> granted the retired Function App's system-assigned identity, which no longer
> exists. Digest RBAC is satisfied without it; do not "restore" it.
>
> Per `deploy-integrity.md` R2 this remains **merged, not deployed** until the
> job image is rebuilt and a digest is observed delivering on the estate.

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
| Send now | ✅ (honest semantics) | **Send** stamps `runNowRequestedAt`; the report-subscriptions ACA job consumes + clears it on its next execution. The console never sends mail, and the response says so verbatim rather than implying an instant send. |
| See the content before it ships | ✅ **(exceeds source)** | **Preview** runs the digest for real against Azure Monitor + Copilot and renders the exact delivered body — Power BI has no equivalent |
| Choose the payload | ✅ | Resource-type multiselect over the live `METRIC_CATALOG`; include/exclude fired alerts |
| Comparison window | ✅ | 1h / 6h / 24h / 3d / 7d, each compared against the immediately preceding window of equal length |
| Anomaly sensitivity | ✅ | 10 / 15 / 25 / 50 / 100 % change threshold |
| Narration mode | ✅ | Copilot narration (grounded, refuse-don't-guess prompt) or a deterministic grounded summary with no model call |
| Delivery-infra gate | ⚠️ honest gate + Fix-it | Shares the registered `svc-report-subscriptions` gate; the pane renders a warning MessageBar with an inline **Fix it** into `/admin/gates?gate=svc-report-subscriptions`. Definitions still save and begin delivering when the infra lands. |
| Monitor-not-configured | ⚠️ honest gate | Preview returns 503 `{ gate: { missing, message } }` naming `LOOM_SUBSCRIPTION_ID` + the Monitoring Reader grant — the same shape every other Monitor-backed surface uses |
| Kill switch | ✅ | `n19d-insight-digests` runtime flag (default ON, fail-open) |

**Zero ❌** on capability, with one honest caveat above: scheduled delivery is
code-complete and unit-proved but **merged, not deployed**. The runtime blocker
is gone (C3's ACA job), so the remaining step is a job-image rebuild; it becomes
✅ on the estate when a digest is observed delivering.

## Backend per control

| Control | Backend |
|---|---|
| List / create / edit / delete / pause | Cosmos `insight-digests` (PK `/tenantId`) |
| Run history | Cosmos `insight-digest-log` (PK `/digestId`) — written by BOTH the console preview (`preview: true`) and the ACA-job delivery |
| Preview | `monitor-client.listResources` + `fetchMetrics` (real `microsoft.insights/metrics`) + `listAlertHistory` (real `Microsoft.AlertsManagement/alerts`) + `aoaiChat` |
| Scheduled delivery | `azure-functions/report-subscriptions/src/insights-engine.ts`, run from `src/main.ts` in the `loom-report-subscriptions` ACA job — ARM resources/metrics/alerts REST + AOAI chat REST + the delivery Logic App |
| Send (queue) | `runNowRequestedAt` stamp consumed by the ACA job |
| Audit | `emitAuditEvent` on create / update / delete / preview / queue-run |

## Notes

- **Metric plan.** `METRIC_CATALOG` lives only in the console. On save the BFF
  resolves the selected resource types into `metricPlan` (resourceType, metric,
  aggregation, label) and stores it on the doc, so the job executes a plan
  and carries no copy of the catalog.
- **Deliberate port.** `azure-functions/report-subscriptions/src/insight-digest-model.ts`
  is a narrow copy of the console's pure delta/prompt/HTML helpers (the two trees
  have no shared workspace package). Both export `DIGEST_MODEL_VERSION` and both
  suites assert the same golden vectors.

  This note previously claimed "so an unmirrored change fails CI". That was
  **false**: no workflow ran the Function-side suite — every vitest suite under
  `azure-functions/` was dark (5 packages, **5 spec files, 121 assertions** at
  merge-base). The claim is true now:
  `scripts/ci/check-standalone-vitest-suites.mjs` discovers and runs them in
  `loom-guardrails`, and it is mutation-proved (break a spec → exit 1;
  `it.skip` every test → exit 1; drop a package out of discovery → exit 1).
- **Delivery payload contract.** The Function's Logic App body is built in ONE
  pure place (`delivery-payload.ts`) and asserted against the workflow's real
  trigger schema in `delivery-contract.test.ts` — it reads the bicep, not a
  fixture. It caught a real contract defect: the deployed tree posted
  `contentBytes` / `fileName` / an ARRAY `recipients`, none of which the
  workflow reads.

  **Correction (2026-08-07).** An earlier revision of this note said that
  defect meant "every scheduled report emailed with no attachment while the
  Function recorded `succeeded`". **That is false and is retracted.** No
  scheduled report was ever affected, because that code has never executed:

  - `csa-loom-post-deploy-bootstrap.yml` has **7 runs in its entire history**;
    its last success was **2026-07-19**, and the step that publishes this
    Function's code was added **2026-07-21** (#2373). The Function App has
    therefore never received code.
  - the orphaned tree that WAS the older implementation already posted the
    correct payload (`subscription-engine.ts` — `recipients.join(';')`,
    `attachmentName`, `attachmentContentType`, `attachmentBase64`, `bodyHtml`),
    and it was never deployed either.

  The honest form is the same as the digest engine's: **a real contract defect
  in code that has never run.** Worth fixing, worth a guard — but it broke
  nothing, and claiming otherwise invents an incident.
- **Logic App change.** The delivery workflow accepts an optional `bodyHtml`
  and an optional attachment. A report subscription (attachment, no `bodyHtml`)
  renders byte-identically to the pre-N19d workflow.
