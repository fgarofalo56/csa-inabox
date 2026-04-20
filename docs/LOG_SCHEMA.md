[Home](../README.md) > [Docs](./) > **Log Schema**

# Log Schema

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Data Engineers

> [!NOTE]
> **Quick Summary**: Structured JSON logging schema for all CSA-in-a-Box Python services via structlog — baseline fields (service, timestamp, level, event, trace_id, correlation_id), per-trigger binding conventions (HTTP, Blob, Event Hub, Timer, CLI), and KQL queries for Log Analytics parsing.

All Python services in CSA-in-a-Box emit structured JSON log lines via
`governance.common.logging` (which wraps [structlog](https://www.structlog.org)).
Each line is a single-line JSON object so that Azure Log Analytics can
parse it with a single KQL expression regardless of which service emitted
it.

## 📑 Table of Contents

- [📋 1. Baseline Fields](#-1-baseline-fields)
- [⚙️ 2. Services and Their Canonical Events](#️-2-services-and-their-canonical-events)
- [🔗 3. Trigger Bindings](#-3-trigger-bindings)
  - [HTTP triggers](#http-triggers)
  - [Blob triggers](#blob-triggers)
  - [Event Hub (batch) triggers](#event-hub-batch-triggers)
  - [Timer triggers](#timer-triggers)
  - [CLI entry points](#cli-entry-points)
- [📊 4. Log Analytics Parsing](#-4-log-analytics-parsing)
  - [Follow a single request end-to-end](#follow-a-single-request-end-to-end)
  - [Top error events per service in the last hour](#top-error-events-per-service-in-the-last-hour)
  - [Batch throughput for the event processor](#batch-throughput-for-the-event-processor)
- [💻 5. Local and Console Output](#-5-local-and-console-output)

---

## 📋 1. Baseline Fields

Every log line contains these fields, always at the top level:

| Field | Type | Example | Notes |
|---|---|---|---|
| `service` | string | `"csa-ai-enrichment"` | Set at process start via `configure_structlog(service=...)`. The source-of-truth mapping from service name to logical component is this table — add a row whenever a new service starts emitting logs. |
| `timestamp` | string (ISO-8601, UTC) | `"2026-04-10T15:23:47.123456Z"` | Always UTC. Uses structlog's `TimeStamper(fmt="iso", utc=True)`. |
| `level` | string | `"info"` | Lowercase: `debug`, `info`, `warning`, `error`, `critical`. |
| `event` | string | `"request.received"` | The message id. Follow dotted-namespaced verbs (`request.received`, `enrichment.text_failed`, `batch.completed`). |
| `trace_id` | string (32-hex) | `"0af7651916cd43dd8448eb211c80319c"` | W3C trace id. Added automatically inside `bind_trace_context(...)`. Same value across all log lines emitted for the same request / batch. |
| `correlation_id` | string (UUID4) | `"8e1a3c74-…"` | Correlation id bound for the current unit of work. Same value across all log lines for the run, but may differ from trace_id when the caller supplies a business-level correlation id. |

Any additional key/value pairs come from the caller (via `logger.info("event", foo="bar")`) or from fields bound at trigger entry (`bind_trace_context(request_path=..., batch_size=...)`).

---

## ⚙️ 2. Services and Their Canonical Events

| Service | Emitting module | Canonical events |
|---|---|---|
| `csa-data-quality` | `csa_platform/csa_platform/governance/dataquality/run_quality_checks.py` | `data_quality.run_started`, `data_quality.run_completed`, `dbt.test_failed`, `volume.check_result`, `freshness.result`, `report.emitted` |
| `csa-ai-enrichment` | `csa_platform/functions/aiEnrichment/functions/function_app.py` | `request.received`, `request.invalid_json`, `request.missing_field`, `request.payload_too_large`, `request.completed`, `blob.received`, `blob.unsupported_type`, `blob.completed`, `enrichment.text_failed`, `enrichment.document_failed`, `ai_client.import_failed` |
| `csa-event-processing` | `csa_platform/functions/eventProcessing/functions/function_app.py` | `batch.received`, `batch.completed`, `event.invalid_json`, `event.processing_failed`, `replay.request_received`, `replay.invalid_json`, `replay.empty_payload`, `replay.completed`, `heartbeat`, `timer.past_due` |

> [!IMPORTANT]
> When a service adds a new event, add it here so operators have a single
> index of what can appear in the log stream.

---

## 🔗 3. Trigger Bindings

`bind_trace_context(...)` is the only sanctioned way to attach per-request
fields. The conventions per trigger type:

### HTTP triggers

```python
trace_id = extract_trace_id_from_headers(dict(req.headers))
with bind_trace_context(
    trace_id=trace_id,  # None -> a new one is generated
    request_method="POST",
    request_route="/api/enrich",
):
    logger.info("request.received")
    ...
```

Logs will carry: `trace_id`, `correlation_id`, `request_method`, `request_route`.

### Blob triggers

```python
with bind_trace_context(
    trigger="blob",
    blob_name=blob.name,
    blob_size=blob.length,
):
    logger.info("blob.received")
```

### Event Hub (batch) triggers

```python
with bind_trace_context(
    trigger="eventhub",
    batch_size=len(events),
    first_sequence_number=events[0].sequence_number if events else None,
):
    logger.info("batch.received")
```

### Timer triggers

```python
with bind_trace_context(trigger="timer", schedule="0 */5 * * * *"):
    logger.info("heartbeat")
```

### CLI entry points

Bind a run-scoped `correlation_id` at the top of `main()` so every log
line from a single invocation shares the same id:

```python
from structlog.contextvars import bind_contextvars
bind_contextvars(correlation_id=new_correlation_id(), suite=args.suite)
```

---

## 📊 4. Log Analytics Parsing

Azure Functions ingests stdout into Application Insights `traces`, which
Log Analytics exposes as the `AppTraces` table. Because we emit JSON, a
single KQL expression unpacks the whole schema:

```kql
AppTraces
| where TimeGenerated > ago(24h)
| extend payload = parse_json(Message)
| extend
    service = tostring(payload.service),
    event_name = tostring(payload.event),
    trace_id = tostring(payload.trace_id),
    correlation_id = tostring(payload.correlation_id),
    level = tostring(payload.level),
    logger = tostring(payload.logger)
| project TimeGenerated, service, level, event_name, trace_id, correlation_id, payload
| order by TimeGenerated desc
```

### Follow a single request end-to-end

```kql
AppTraces
| extend payload = parse_json(Message)
| where tostring(payload.trace_id) == "<trace-id-from-bad-request>"
| project TimeGenerated, service = tostring(payload.service), event_name = tostring(payload.event), payload
| order by TimeGenerated asc
```

### Top error events per service in the last hour

```kql
AppTraces
| where TimeGenerated > ago(1h)
| extend payload = parse_json(Message)
| where tostring(payload.level) in ("error", "critical")
| summarize count() by service = tostring(payload.service), event_name = tostring(payload.event)
| order by count_ desc
```

### Batch throughput for the event processor

```kql
AppTraces
| where TimeGenerated > ago(24h)
| extend payload = parse_json(Message)
| where tostring(payload.service) == "csa-event-processing"
| where tostring(payload.event) == "batch.completed"
| extend processed = toint(payload.processed), errors = toint(payload.errors)
| summarize total_events = sum(processed), total_errors = sum(errors) by bin(TimeGenerated, 5m)
```

---

## 💻 5. Local and Console Output

For local development set `LOG_FORMAT=console` to switch from JSON to the
human-readable console renderer:

```bash
export LOG_FORMAT=console
python csa_platform/governance/dataquality/run_quality_checks.py --suite bronze
```

All other behaviour (trace context binding, service tags) is identical;
only the serialisation changes.

---

## 🔗 Related Documentation

- [Troubleshooting](TROUBLESHOOTING.md) — Common issues and fixes
- [Production Checklist](PRODUCTION_CHECKLIST.md) — Production readiness checklist
- [Platform Services](PLATFORM_SERVICES.md) — Platform component deep-dive
