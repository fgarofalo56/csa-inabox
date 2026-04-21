# Copilot Telemetry

OpenTelemetry tracing + span helpers + log enrichment for the CSA Copilot.

## Design goals

1. **Zero hard dependency on the OTel SDK at import time.** The package
   imports and runs without `opentelemetry-api` installed; every helper
   no-ops in that environment. This keeps CI lean and the copilot usable
   in minimal installs.
2. **Production-grade attribute hygiene.** Canonical attribute names are
   defined once in `SpanAttribute` (frozen Enum). Sensitive values are
   redacted before export.
3. **Log correlation out of the box.** A structlog processor injects
   `trace_id`/`span_id` into every log event emitted inside a
   `copilot_span` block.

## Activation

Set these environment variables in production:

| Variable                                 | Purpose                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `COPILOT_OTEL_EXPORTER_OTLP_ENDPOINT`    | OTLP endpoint (gRPC or HTTP). When unset, tracing is a no-op.          |
| `COPILOT_OTEL_SERVICE_NAME`              | Optional service name (defaults to `csa-copilot`).                     |
| `COPILOT_OTEL_DISABLE`                   | Truthy to force-disable OTel even when the endpoint is set.            |

## Typical usage

```python
from apps.copilot.telemetry import SpanAttribute, copilot_span

async with copilot_span(
    "copilot.retrieve",
    attributes={
        SpanAttribute.QUESTION_HASH: "abcd1234",
        SpanAttribute.TOP_K: 6,
    },
) as span:
    chunks = await retriever.search_async(...)
    span.set_attribute(SpanAttribute.RETRIEVAL_RESULTS, len(chunks))
```

## Canonical span names

| Stage                 | Span name                 |
| --------------------- | ------------------------- |
| Retrieval             | `copilot.retrieve`        |
| Coverage gate         | `copilot.coverage_gate`   |
| Generation            | `copilot.generate`        |
| Citation verification | `copilot.verify_citations`|
| Skill invocation      | `copilot.skill.<id>`      |
| Tool call             | `copilot.tool.<name>`     |
| Broker action         | `copilot.broker.<action>` |
| Eval case             | `copilot.eval.<case_id>`  |

## Log correlation (structlog)

Register the processor once at startup:

```python
import structlog
from apps.copilot.telemetry import structlog_trace_processor

structlog.configure(processors=[
    structlog.contextvars.merge_contextvars,
    structlog_trace_processor,
    structlog.processors.JSONRenderer(),
])
```

Every event emitted inside a `copilot_span` will now carry `trace_id`
and `span_id` fields suitable for cross-linking between logs and traces
in dashboards.
