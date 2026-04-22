[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Data Pipeline Failure**

# Data Pipeline Failure Runbook (CSA-0059)

> **Last Updated:** 2026-04-20 | **Last Drilled:** _not yet drilled — see Drill Log below_ | **Status:** Active | **Audience:** Operations, Data Engineering

!!! note
    **Quick Summary**: First-response procedure for ADF / Synapse pipeline failures — triage by trigger vs. activity scope, classify severity, apply the right retry / backfill strategy, and escalate. Covers trigger mis-fires, activity-level failures (Copy, Databricks, Dataflow), transient vs. deterministic errors, and the backfill-by-watermark pattern.

## Before First Use — Customization Checklist

This runbook ships with placeholders. Populate these in a PR before your
first real on-call rotation:

- [ ] Populate the [Contact Information](#-contact-information) table with
      your Platform / Data Engineering leads.
- [ ] Wire the Data Factory instance names in [§4.1](#41-identify-the-failed-run)
      to your real factories (dev / staging / prod).
- [ ] Confirm which ADF pipelines are tagged as *critical* in your RBAC
      matrix — those get P2 on first failure, not P3.
- [ ] Confirm the ADF diagnostic-settings workspace ID used by the KQL
      queries below.

## 📑 Table of Contents

- [📋 1. Scope](#-1-scope)
- [🔒 2. Severity Classification](#-2-severity-classification)
- [🚀 3. Initial Response](#-3-initial-response)
- [🧪 4. Common Scenarios](#-4-common-scenarios)
  - [4.1 Identify the failed run](#41-identify-the-failed-run)
  - [4.2 Trigger did not fire](#42-trigger-did-not-fire)
  - [4.3 Copy activity failure (source / sink)](#43-copy-activity-failure-source--sink)
  - [4.4 Databricks notebook activity failure](#44-databricks-notebook-activity-failure)
  - [4.5 Dataflow activity OOM / skew](#45-dataflow-activity-oom--skew)
  - [4.6 Self-Hosted IR offline](#46-self-hosted-ir-offline)
- [🔁 5. Retry vs. Backfill](#-5-retry-vs-backfill)
- [📋 6. Evidence Preservation](#-6-evidence-preservation)
- [📝 7. Communication Templates](#-7-communication-templates)
- [📎 8. Contact Information](#-8-contact-information)
- [🗓️ 9. Drill Log](#️-9-drill-log)
- [🔗 10. Related Documentation](#-10-related-documentation)

---

## 📋 1. Scope

Covers failure response for:

- Azure Data Factory (ADF) pipelines — trigger, activity, and Self-Hosted IR failures.
- Synapse pipeline activities (Pipelines experience in Synapse Workspace).
- Databricks notebook activities invoked by ADF.
- Copy activities reading from / writing to ADLS Gen2, Event Hubs, SQL DB, Cosmos DB.

Out of scope: real-time streaming failures (see `dead-letter.md`), dbt
model failures inside the lakehouse (see `dbt-ci.md`), platform-wide
region outages (see `dr-drill.md`).

---

## 🔒 2. Severity Classification

| Severity    | Description                                                                                               | Response Time | Escalation              |
| ----------- | --------------------------------------------------------------------------------------------------------- | ------------- | ----------------------- |
| P1 — Critical | Critical pipeline (governance-tagged `tier=critical`) failed in prod with customer-facing data impact | 1 hour        | Data Eng Lead + CISO    |
| P2 — High   | Any pipeline feeding a Gold-layer product with SLA freshness breached                                     | 4 hours       | Data Eng Lead           |
| P3 — Medium | Non-critical pipeline failed; backfill window still open                                                  | 24 hours      | On-call engineer        |
| P4 — Low    | Retry succeeded automatically; post-mortem needed for the deterministic failure cause                     | 72 hours      | Team queue              |

---

## 🚀 3. Initial Response

### Step 1: Confirm the alert is real
```kql
// Recent pipeline failures across the subscription
ADFPipelineRun
| where TimeGenerated > ago(2h)
| where Status == "Failed"
| project TimeGenerated, PipelineName, RunId, Status, FailureType, Message
| order by TimeGenerated desc
```

### Step 2: Classify severity
- [ ] Is the failed pipeline tagged `tier=critical` in the governance RBAC matrix?
- [ ] Is the downstream product SLA breached (check `portal/api/v1/marketplace/products`)?
- [ ] Has retry already succeeded? (see `Status` transitions in KQL below)

### Step 3: Contain
- [ ] If the same pipeline has failed **3 times consecutively**, pause the
      trigger to stop alert storms:
      ```bash
      az datafactory trigger stop \
        --factory-name <factory> \
        --resource-group <rg> \
        --name <trigger-name>
      ```
- [ ] Open an incident ticket linking the ADF run ID.

### Step 4: Investigate
Use the scenario playbook in §4.

### Step 5: Recover
Pick one of: automatic-retry-in-place, manual rerun of failed activities,
or watermark backfill (see §5).

### Step 6: Post-Incident
- [ ] File a follow-up task tagged `data-pipeline-followup` within one business day.
- [ ] Update detection thresholds if a legitimate failure went to P3 when it should have been P2.

---

## 🧪 4. Common Scenarios

### 4.1 Identify the failed run
```kql
ADFActivityRun
| where TimeGenerated > ago(24h)
| where Status == "Failed"
| project TimeGenerated, PipelineName, ActivityName, ActivityType,
          ActivityRunId, Error = tostring(Error.message), ErrorCode = tostring(Error.errorCode)
| order by TimeGenerated desc
```

### 4.2 Trigger did not fire

**Symptom:** Expected pipeline run did not show up in `ADFPipelineRun`.

- [ ] Check trigger state:
      ```bash
      az datafactory trigger show \
        --factory-name <factory> --resource-group <rg> --name <trigger>
      ```
- [ ] If `runtimeState != "Started"`, the trigger is stopped. Restart:
      ```bash
      az datafactory trigger start \
        --factory-name <factory> --resource-group <rg> --name <trigger>
      ```
- [ ] If trigger is started but no run occurred, check managed-identity
      permissions on the storage account or event source.
- [ ] Run a manual rerun for the missed window (see §5).

### 4.3 Copy activity failure (source / sink)

**Symptom:** `ActivityType == "Copy"`, `ErrorCode` like `2xxx` or `UserErrorSourceDataContractMismatch`.

- [ ] Check the error class:
      - `UserError*` → deterministic, will not self-heal. Fix the source or schema.
      - `SystemError*` → transient. Retry the activity in place once.
- [ ] Validate the source dataset is reachable (firewall, managed-identity
      RBAC). Cross-check `DiagnosticsResourceHealth`.
- [ ] For `UserErrorSourceDataContractMismatch`, review data contracts under
      `governance/contracts/`. The schema drift detector will have fired
      — do not retry blindly; the upstream owner owns the fix.

### 4.4 Databricks notebook activity failure

**Symptom:** `ActivityType == "DatabricksNotebook"` with an exit code.

- [ ] Pull the notebook run URL from the activity output and open it.
- [ ] If the error is `ExecutionFailed` with a Spark OOM, reduce partition
      count or move the job to a larger cluster type in the Databricks
      instance pool config.
- [ ] If the failure is `LibraryInstallFailed`, your cluster-wide library
      manifest drifted — rebuild the cluster from the Bicep definition.
- [ ] For transient `JobRequestTimedOut`, rerun once; escalate if it
      recurs within the same hour.

### 4.5 Dataflow activity OOM / skew

**Symptom:** `ActivityType == "ExecuteDataFlow"` with memory errors.

- [ ] Increase integration-runtime core count (AutoResolveIntegrationRuntime
      compute type General → Memory Optimized).
- [ ] If the skew is caused by a hotspot join key, add a partition
      override to the dataflow sink partitioning settings.
- [ ] For recurring skew, promote the job to Databricks — dataflow's
      cost model does not forgive skew.

### 4.6 Self-Hosted IR offline

**Symptom:** `Integration runtime is not available or unhealthy`.

- [ ] Check IR status:
      ```bash
      az datafactory integration-runtime show \
        --factory-name <factory> --resource-group <rg> --name <ir-name>
      ```
- [ ] See `docs/SELF_HOSTED_IR.md` for the full restart procedure. TL;DR:
      restart the Windows service on the VM hosting the IR, confirm
      outbound firewall rules for 443 are still intact, re-register with
      the factory key if the IR was re-imaged.

---

## 🔁 5. Retry vs. Backfill

| Situation                                                              | Strategy                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Transient error, `ActivityRetryCount` not yet exhausted                | Let ADF retry automatically. Watch for third failure.                    |
| Deterministic error, fix deployed                                      | Manual `Rerun from failed activity` in ADF Studio.                       |
| Missed trigger window < 7 days old                                     | Watermark backfill: trigger `pipeline_param.startTime`/`endTime` for the missed window. |
| Missed window ≥ 7 days                                                 | Open a data-correctness task; coordinate with the downstream consumer.   |
| Bronze data corrupted (wrote bad data)                                 | Roll back bronze partition from ADLS versioning; rerun silver/gold.      |

Manual rerun command:
```bash
az datafactory pipeline create-run \
  --factory-name <factory> \
  --resource-group <rg> \
  --name <pipeline> \
  --parameters '{"startTime":"2026-04-20T00:00:00Z","endTime":"2026-04-20T23:59:59Z"}'
```

---

## 📋 6. Evidence Preservation

Before remediation, capture:

- [ ] ADF run ID (`RunId`) and all activity run IDs.
- [ ] The full `Error.message` and `Error.failureType` JSON payload.
- [ ] KQL query results from `ADFActivityRun` for the last 24 hours.
- [ ] For Copy activities: source/sink URLs, row counts read vs. written.
- [ ] For Databricks: notebook run URL and the job cluster's log bundle.

---

## 📝 7. Communication Templates

### Internal notification (P1/P2)

> **Subject:** [P1/P2] ADF Pipeline Failure — `<pipeline_name>`
>
> **Run ID:** `<ADF run ID>`
> **Detected:** `<timestamp UTC>`
> **Impact:** `<which products / SLAs affected>`
> **Status:** Investigating / Contained / Remediated
> **Actions taken:** `<bullet list>`
> **Next update:** `<time>`

### Backfill notice to consumers

> **Subject:** Backfill planned for `<product>` — `<date range>`
>
> Pipeline `<pipeline_name>` failed on `<date>` and we are replaying
> the window `<start>` → `<end>`. Expect duplicated / late-arriving
> rows in `<table>` between `<start-of-replay>` and `<end-of-replay>`.
> Downstream consumers with idempotent joins should see no impact.

---

## 📎 8. Contact Information

!!! warning
    **Action Required:** Populate these before first production use.

| Role                 | Contact                                       | Phone                          | Escalation                  |
| -------------------- | --------------------------------------------- | ------------------------------ | --------------------------- |
| Data Eng On-Call     | *(set via your org's on-call roster)*         | *(see PagerDuty / OpsGenie)*   | First responder             |
| Data Eng Lead        | *(set via your org's data eng DL)*            | *(see PagerDuty / OpsGenie)*   | P1/P2 escalation            |
| Platform Team Lead   | *(set via your org's platform team)*          | *(see PagerDuty / OpsGenie)*   | Infra / IR failures         |
| Upstream Source Owner| *(per-pipeline — see governance RBAC matrix)* | *(DL)*                         | Source data contract issues |
| Azure Support        | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A | ADF platform-level issues |

---

## 🗓️ 9. Drill Log

Run this runbook in tabletop form quarterly. Add one row per drill.

| Quarter   | Date  | Type (tabletop / live) | Scenario exercised | Lead  | Gaps identified | Fixes tracked |
| --------- | ----- | ---------------------- | ------------------ | ----- | --------------- | ------------- |
| Q1 — Jan  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q2 — Apr  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q3 — Jul  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q4 — Oct  | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |

---

## 🔗 10. Related Documentation

- [dbt CI](./dbt-ci.md) — dbt test failures and CI gate recovery
- [Dead Letter](./dead-letter.md) — streaming dead-letter recovery
- [DR Drill](./dr-drill.md) — region-level failover
- [SELF_HOSTED_IR](../SELF_HOSTED_IR.md) — Self-Hosted Integration Runtime ops
- [Troubleshooting](../TROUBLESHOOTING.md) — general triage
