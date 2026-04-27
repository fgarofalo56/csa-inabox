# Dead-Letter Queue (DLQ) Operator Runbook

> **Scope:** Canonical DLQ pattern for every ingest pipeline in CSA-in-a-Box.
> **Finding:** CSA-0138  ·  **Decision:** AQ-0033 / Ballot E9
> **Module:** [`deploy/bicep/shared/modules/deadletter/deadletter.bicep`](../../deploy/bicep/shared/modules/deadletter/deadletter.bicep)

---

## Overview

Before CSA-0138, ingest pipelines had no standard failure sink. Bad records were
either silently dropped, or they crashed the pipeline and stalled the whole
workload. Streaming workloads could not reach production without a canonical
quarantine story.

The approved pattern provisions, **per pipeline**:

| Resource                                       | Purpose                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Blob container `deadletter-<pipelineName>`     | Quarantines the raw poison message plus a sidecar metadata JSON.                             |
| Event Grid system topic + filtered subscription | Fires on `Microsoft.Storage.BlobCreated` scoped to the DLQ container — downstream triage.    |
| Log Analytics diagnostic settings              | Captures `StorageRead` / `StorageWrite` + Transaction metrics for audit and replay evidence. |
| Azure Monitor metric alert                     | Fires when container capacity exceeds `alertThresholdBytes` (default 1 GiB).                 |

Every ingest Bicep template (ADF-based, Stream Analytics, Event Hubs consumer,
Databricks Autoloader) should `module ... '../shared/modules/deadletter/deadletter.bicep'`
with a pipeline-specific `pipelineName`.

---

## When a message lands in the DLQ

A pipeline writes to its DLQ container on any of these conditions:

- **Schema mismatch** — record fails Pydantic / JSON-Schema / Avro validation.
- **Encoding error** — bytes that aren't valid UTF-8 / binary payload where JSON is expected.
- **Downstream 5xx / throttling** — persistent failure to write to Bronze after retry budget.
- **AuthN/AuthZ failure** — expired SAS, missing managed-identity role.
- **Poison-message loop** — consumer repeatedly fails on the same offset (Event Hubs / Kafka).

Each quarantined blob is paired with a sidecar `<blobname>.metadata.json`:

```json
{
  "pipeline": "iot-telemetry",
  "source": "eventhubs://evh-csa-prod/iot-telemetry",
  "timestamp": "2026-04-19T14:03:22Z",
  "offset": "12345678",
  "errorKind": "schema_mismatch",
  "errorMessage": "Pydantic validation error: field 'device_id' required",
  "attemptCount": 3,
  "correlationId": "8f3a2b1c-...",
  "auditEventId": "csa-audit-2026-04-19-..."
}
```

The `auditEventId` ties back to the tamper-evident audit log (CSA-0016) so
triage can reconstruct the upstream event history.

---

## Triage

### Step 1 — Acknowledge the alert

The DLQ-size metric alert (`csa-alert-dlq-size-<pipelineName>`) routes through
the pipeline's action group. Acknowledge in the Azure Monitor alert blade:

```text
https://portal.azure.com/#blade/Microsoft_Azure_Monitor/AlertsManagementSummaryBlade
```

If this is the first time the pipeline has ever alerted, verify the module was
deployed by confirming the container exists:

```bash
az storage container show \
  --account-name <storageAccountName> \
  --name deadletter-<pipelineName> \
  --auth-mode login
```

### Step 2 — Enumerate poison messages

```bash
az storage blob list \
  --account-name <storageAccountName> \
  --container-name deadletter-<pipelineName> \
  --auth-mode login \
  --output table \
  --query "[].{name:name, created:properties.creationTime, size:properties.contentLength}"
```

High cardinality of `created` timestamps within a tight window suggests a
spike; cluster those with `jq` / `Sort-Object` before sampling.

### Step 3 — Inspect a representative message

```bash
# download a sample message and its sidecar
az storage blob download \
  --account-name <storageAccountName> \
  --container-name deadletter-<pipelineName> \
  --name <blobname> \
  --file /tmp/dlq-sample.bin \
  --auth-mode login

az storage blob download \
  --account-name <storageAccountName> \
  --container-name deadletter-<pipelineName> \
  --name <blobname>.metadata.json \
  --file /tmp/dlq-sample.metadata.json \
  --auth-mode login

cat /tmp/dlq-sample.metadata.json | jq .
```

### Step 4 — Classify the error

Match `errorKind` from the sidecar to one of:

| errorKind           | Typical cause                                            | Disposition           |
| ------------------- | -------------------------------------------------------- | --------------------- |
| `schema_mismatch`   | Producer shipped a new field or changed a type           | Fix schema → replay   |
| `encoding`          | Bad UTF-8 / corrupted binary                             | Drop with audit event |
| `downstream_5xx`    | Transient Bronze write failure after retry budget        | Replay                |
| `auth`              | Expired SAS, missing RBAC, managed-identity misconfig    | Fix identity → replay |
| `poison_loop`       | Consumer crashes on the same record every attempt        | Drop + escalate       |
| `other`             | Unknown — inspect raw payload and upstream logs          | Case-by-case          |

### Step 5 — Decide disposition

- **Replay** — if the underlying defect is fixed or transient. See *Replay*.
- **Drop** — if the payload is unrecoverable. See *Drop*.
- **Escalate** — if volume or pattern indicates an upstream incident. See *Escalation*.

---

## Replay

### Databricks Autoloader pattern

Point Autoloader at the DLQ container with a one-shot `trigger(availableNow=True)`
read — corrected records flow through the normal Bronze → Silver → Gold path:

```python
(spark.readStream
  .format("cloudFiles")
  .option("cloudFiles.format", "binaryFile")
  .option("cloudFiles.schemaLocation", "/tmp/schema/dlq-iot-telemetry")
  .load(f"abfss://deadletter-iot-telemetry@{storage}.dfs.core.windows.net/")
  .writeStream
  .trigger(availableNow=True)
  .option("checkpointLocation", "/tmp/chk/dlq-replay-iot-telemetry")
  .foreachBatch(lambda df, epoch: replay_batch(df, epoch))
  .start())
```

### ADF copy-with-retry pattern

1. Clone the production ingest pipeline.
2. Replace the source dataset with the DLQ container.
3. Set `retryCount = 3`, `retryIntervalInSeconds = 60`.
4. Enable **Fault tolerance → Skip incompatible rows → Log** so persistent
   failures re-land in DLQ rather than crashing the replay.
5. Trigger manually; after success, delete the replayed blobs from DLQ.

### Event Hubs / Service Bus consumer pattern

Use a standalone replay consumer that reads the DLQ blobs and re-publishes to
the original ingest topic with an `x-replay-attempt` header so downstream
observability can distinguish replayed traffic.

---

## Drop

When a payload is unrecoverable:

1. Emit a **drop audit event** via the tamper-evident logger (CSA-0016) with
   `action = "dlq.drop"`, the `correlationId`, and the operator identity.
2. Delete the blob and its sidecar from the DLQ container.
3. Capture rationale in the per-pipeline triage log (see *Per-pipeline DLQ inventory*).

```bash
az storage blob delete-batch \
  --source deadletter-<pipelineName> \
  --account-name <storageAccountName> \
  --pattern "<blobname>*" \
  --auth-mode login
```

Drop is an **auditable action** — every drop must have an audit event and an
operator signature. If the drop rate exceeds 1 % of ingest volume over a
24-hour window, escalate per below.

---

## Escalation

Page the on-call and open a P1 when any of the following trip:

- DLQ size alert fires **three times in one hour** for the same pipeline.
- Single DLQ container exceeds **10 GiB** regardless of alert threshold.
- Ingest pipeline throughput drops > 25 % simultaneous with DLQ growth.
- `errorKind = poison_loop` observed — indicates consumer-code defect.
- Volume spike correlates with a recent deployment (possible bad release).

Include in the P1 ticket:

- Pipeline name + DLQ container URI
- Last 1 hour of DLQ metrics (KQL snippet)
- Sample sidecar JSON (redact PII)
- Suspected upstream change (git SHA / deployment run)

---

## Per-pipeline DLQ inventory

Teams own the row for their pipeline. Update on deployment.

| Pipeline           | DLQ Container URI                                             | Owner       | Replay SLA  | Replay Procedure                                 |
| ------------------ | ------------------------------------------------------------- | ----------- | ----------- | ------------------------------------------------ |
| _template_         | `https://<storage>.blob.core.windows.net/deadletter-<name>`   | team-alias  | 24 h        | See "Databricks Autoloader pattern" above        |
| `iot-telemetry`    | _(fill on first deploy)_                                      | _(team)_    | 4 h         | _(link to pipeline-specific replay notebook)_    |
| `noaa-weather`     | _(fill on first deploy)_                                      | _(team)_    | 24 h        | _(link)_                                         |
| `aqi-sensors`      | _(fill on first deploy)_                                      | _(team)_    | 1 h         | _(link)_                                         |
| `casino-telemetry` | _(fill on first deploy)_                                      | _(team)_    | 15 min      | _(link)_                                         |

---

## Related

- **Finding:** CSA-0138 — No standard DLQ pattern
- **Decision:** AQ-0033 / Ballot item E9
- **ADR:** [ADR-0005 — Event Hubs over Kafka](../adr/0005-event-hubs-over-kafka.md) (context for streaming DLQ semantics)
- **Audit logger:** [CSA-0016 tamper-evident audit log](../../src/csa_platform/audit/) (drop-event emission)
- **Bicep module:** [`deploy/bicep/shared/modules/deadletter/deadletter.bicep`](../../deploy/bicep/shared/modules/deadletter/deadletter.bicep)
- **Alerts:** Alert rule `csa-alert-dlq-size-<pipelineName>` fires to the pipeline's action group.

---

_Last reviewed: 2026-04-19 · Owner: Platform Reliability · Review cadence: quarterly_
