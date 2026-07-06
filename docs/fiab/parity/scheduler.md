# scheduler — parity with Azure Data Factory / Synapse **Triggers & Monitoring** + Fabric **scheduling**

Source UI:
- ADF/Synapse *Manage → Triggers* (schedule triggers) + *Monitor → Pipeline runs*
  — https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers
- Azure ML *Jobs → Schedule* (recurrence) — https://learn.microsoft.com/azure/machine-learning/how-to-schedule-pipeline-job
- Fabric per-item *Schedule* (Notebook / Pipeline / Semantic model refresh)

Loom slug: `/scheduler` (rel-T81). A single **cross-item** scheduler that replaces
the two bespoke per-item surfaces (`semantic-model/[id]/refresh-schedule`,
`notebook/[id]/schedule`) with one place to schedule + monitor recurring jobs.

## Azure/Fabric feature inventory

| # | Capability (real UI) | Where in Azure/Fabric |
|---|----------------------|-----------------------|
| 1 | Create a **schedule trigger** on a recurrence (minute/hour/day/week/month, interval, time, days, timezone) | ADF Manage → Triggers → New; AML Schedule (recurrence) |
| 2 | **Visual** recurrence builder (dropdowns/pickers), NOT a raw cron string | ADF/AML dialogs |
| 3 | Preview the **next fire times** | ADF trigger "Next occurrences" |
| 4 | Attach the trigger to a **job** — pipeline run / Spark job / command | ADF trigger→pipeline; AML schedule→job |
| 5 | Pass **job parameters** | ADF trigger parameters |
| 6 | **Enable / disable** (start/stop) a schedule | ADF Start/Stop trigger; AML isEnabled |
| 7 | **Run now** (manual trigger) | ADF Trigger now; AML "Submit" |
| 8 | **Run history** with status + start + duration | Monitor → Pipeline/Trigger runs |
| 9 | **Exit value / output** surfaced per run | Monitor run output |
| 10 | **Failure alerts** (email / webhook / action group) | ADF Monitor → Alerts; Azure Monitor action groups |
| 11 | **Edit** an existing schedule | ADF edit trigger |
| 12 | **Delete** a schedule | ADF delete trigger |

## Loom coverage

| # | Loom | State | Backend per control |
|---|------|-------|---------------------|
| 1 | `CronWizard` (frequency→interval/minute/hour/dow/dom/timezone) | ✅ built | pure `lib/scheduler/cron.ts` → 5-field cron persisted to Cosmos `schedules` |
| 2 | Fully visual — no raw cron field (loom_no_freeform_config); resulting cron shown read-only | ✅ built | `buildCron()` |
| 3 | Live "Next N runs" preview in the chosen timezone | ✅ built | `nextFireTimes()` (tz-aware via `Intl`) |
| 4 | Job kind dropdown → structured job config | ✅ built | `lib/scheduler/run-adapters.ts` |
| 5 | ADF pipeline parameters (typed object) | ✅ built | `adf-client.runPipeline(name, params)` |
| 6 | Enable/disable Switch per card + PATCH `{enabled}` | ✅ built | Cosmos `schedules` upsert |
| 7 | **Run now** — triggers the REAL backend + records the run | ✅ built | adapters → `runPipeline` / `executeMgmtCommand`/`executeQuery` / `submitAmlSparkCell` / Livy session+statement |
| 8 | Run-history dialog (status, trigger, start, duration) | ✅ built | Cosmos `schedule-runs` (90-day TTL) |
| 9 | Exit value column (runId / row-count+ms / job name / error) | ✅ built | `TriggerResult.exitValue` |
| 10 | Failure notifications — in-app inbox (always) + webhook (real POST) + email relay | ✅ built / ⚠️ email relay | `lib/scheduler/notify.ts`; in-app = `notifications` container, webhook = `fetch`, email = `LOOM_SCHEDULER_EMAIL_WEBHOOK` relay (honest gate when unset — alert still lands in the Loom inbox) |
| 11 | Edit dialog (reuses the create dialog) → PATCH | ✅ built | Cosmos upsert |
| 12 | Delete (card menu) → DELETE | ✅ built | Cosmos delete |
| — | **Scheduled firing** (unattended) | ✅ built | `POST /api/internal/scheduler/tick` — token-gated (`LOOM_INTERNAL_TOKEN`), driven by an external once-a-minute timer (ACA cron Job / GitHub Actions / Azure Monitor scheduled query); (lastTickAt, now] window + per-schedule watermark = idempotent |

Zero ❌. The only ⚠️ is the **email relay** channel: without
`LOOM_SCHEDULER_EMAIL_WEBHOOK` we do not fake SMTP — the failure still reaches the
owner's Loom inbox and (if configured) the webhook, and the response notes the
relay is unset. That is an honest infra gate per `no-vaporware.md`, not a stub.

## Backend per control (summary)

- **Store:** Cosmos `schedules` (PK `/tenantId`) + `schedule-runs` (PK
  `/scheduleId`, 90-day TTL), created lazily via `createIfNotExists` — no extra
  ARM step beyond the Cosmos account (`lib/azure/scheduler-store.ts`).
- **Job backends (Azure-native, reuse existing clients):**
  - `adf-pipeline` → `adf-client.runPipeline` (ADF/Synapse pipeline)
  - `adx-command` → `kusto-client.executeMgmtCommand` / `executeQuery` (ADX)
  - `aml-spark` → `aml-spark-client.submitAmlSparkCell` (AML serverless Spark)
  - `synapse-livy` → `synapse-livy-client` session + statement (Synapse Spark)
- **No Fabric dependency:** every job kind maps to an Azure-native backend; there
  is no `fabricWorkspaceId` read and no `api.fabric.microsoft.com` call.

## Env / bicep

- No new bicep param (256-param ceiling respected). No new **emitted** env var —
  the store uses `LOOM_COSMOS_ENDPOINT` and each backend reuses its existing gate
  (`LOOM_ADF_NAME`, `LOOM_KUSTO_CLUSTER_URI`, `LOOM_AML_SPARK`,
  `LOOM_SYNAPSE_WORKSPACE`/`LOOM_SYNAPSE_SPARK_POOL`). The tick endpoint reuses the
  bicep-wired `LOOM_INTERNAL_TOKEN`.
- One opt-in, intentionally-unset var — `LOOM_SCHEDULER_EMAIL_WEBHOOK` — is
  allowlisted in `scripts/ci/check-env-sync.mjs`.

## Verification

- Guard cascade (bff-errors, route-guards, env-sync, no-freeform, bicep-sync,
  docs-hygiene): all PASS.
- Real-data path: `Run now` on any schedule calls the live backend and records
  the run + exit value; the honest gate renders when a backend env var is unset.
