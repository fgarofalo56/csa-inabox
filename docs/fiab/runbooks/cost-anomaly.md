# Runbook — Cost-anomaly monitor (C3)

**What it is:** a scheduled in-VNet Container App Job (`loom-cost-anomaly-monitor`)
that evaluates the enabled `loom-cost-anomaly-rules` once per schedule (default
daily 06:00 UTC) against the **real** Cost Management daily series, and — when a
day is anomalous — writes an in-product notification (`loom-notifications`) and
dispatches an email through the **shared** action group
(`LOOM_ALERT_ACTION_GROUP_ID`, O1).

Per the 2026-07-23 estate constraint this is an **ACA Job, not a Y1 Function**
(Y1 Linux Consumption is structurally broken on this estate). The job is a thin
`node e2e/run-cost-anomaly.mjs` that POSTs the console's
`/api/internal/cost-anomaly/run` with the shared internal token; the console
process runs the real detection so there is one source of truth with the
`/admin/finops` UI.

## What red means

| Signal | Meaning | First response |
| --- | --- | --- |
| A **P2/P3 "Cost anomaly detected"** alert / notification | A day's spend cleared the rule's σ / % threshold (and the `minAbsDelta` floor). | Open `/admin/finops` → **Anomaly feed**, drill to the day, confirm the spike is real (a new resource, a runaway job, a pricing change) vs. a one-off. |
| The job **execution Failed** (non-zero exit) | The runner could not reach the console / bad internal token — a real regression (NOT an honest cost gate, which exits 0). | Check the job's execution logs (`az containerapp job execution list`); verify `LOOM_INTERNAL_TOKEN` matches the console and the console is up. |
| The run reports `configGate` | Cost Management is not configured (`svc-cost-management`). | Grant the Console UAMI **Cost Management Reader** (redeploy with `skipRoleGrants=false`) / set `LOOM_SUBSCRIPTION_ID`. The monitor resumes automatically. |

## Tuning

- **Thresholds + recipients:** `/admin/finops` → **Anomaly rules** (audited,
  `kind:'finops.anomaly-rule'`). Each rule: `method` (`3sigma` | `pct`),
  `threshold`, `minAbsDelta` (absolute floor), `timeframe`, `alertSeverity`,
  `recipients` (Entra oids; empty → the bootstrap tenant admin).
- **Schedule:** `observabilityConfig.costAnomalyCron` (default `0 6 * * *`).
- **Opt out:** `LOOM_COST_ANOMALY_ENABLED=false`, or
  `observabilityConfig.costAnomalyEnabled=false` (removes the job).

## Per-cloud

- **Commercial / Gov GCC-High:** identical; Gov uses `management.usgovcloudapi.net`
  + the `.us` action group.
- **IL5/air-gapped:** Cost Management is unreachable → the monitor evaluates the
  C1 CSV-export-ingest series; the **in-product notification** is the primary
  channel (external email is honest-gated when no in-boundary email receiver
  exists on the action group).

## Rollback

Set `observabilityConfig.costAnomalyEnabled=false` and redeploy (removes the
job), or one-shot `az containerapp job stop`. The seeded rules are inert without
the job. Last-known-good runner = the prior `loom-uat` image tag (rebuild via
`scripts/csa-loom/deploy-loom-uat-job.sh`); roll back by pointing the module's
`image` at the prior tag. Drill via the existing `bicep-rollback` DR scenario.
