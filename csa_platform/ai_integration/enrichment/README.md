# `csa_platform.ai_integration.enrichment`

AI-powered enrichment building blocks used by the medallion pipeline. Each
module exposes a class with both **synchronous** (batch-friendly) and
**async** (request-path safe) entry points.

## Modules

| Module | Class | Sync API | Async API |
| ------ | ----- | -------- | --------- |
| `document_classifier` | `DocumentClassifier` | `classify`, `classify_single`, `classify_records` | `classify_async`, `classify_single_async` |
| `entity_extractor`    | `EntityExtractor`    | `extract_entities`, `extract_entities_from_records`, `enrich_bronze_to_silver` | `extract_entities_async`, `extract_entities_from_records_async` |
| `text_summarizer`     | `TextSummarizer`     | `summarize`, `summarize_batch` | `summarize_async`, `summarize_batch_async` |

## When to use sync vs async (CSA-0117)

**Use the sync API when…**

- You are inside a batch worker, dbt hook, Spark job, scheduled function,
  CLI script, or any other context that already runs on a thread of its own.
- You are calling from a synchronous test.
- You explicitly want the simplest possible call shape and do not care about
  blocking the current thread for the duration of the API round-trip.

**Use the async API (`*_async` methods) when…**

- You are inside a FastAPI request handler, an `async def` background task,
  or any code path that must not block the event loop.
- You are fanning many calls out concurrently with `asyncio.gather` or
  similar primitives.
- You want the rate-limiter to use `asyncio.sleep` instead of `time.sleep`
  (the sync limiter falls back to `time.sleep`, which stalls the event
  loop if mistakenly called from async code).

The sync methods log a `rate_limit.blocking_sleep_in_async` warning when
they detect a running event loop, which is a strong hint that the caller
should switch to the corresponding `*_async` variant.

## Implementation notes

- The async variants currently delegate to the sync code via
  `asyncio.to_thread`, plus an `asyncio.sleep`-based rate limiter where
  applicable. This keeps the dependency surface unchanged — no new SDK
  packages — while still giving callers a non-blocking entry point.
- Future work can replace the `to_thread` adapter with native async SDK
  clients (`AsyncAzureOpenAI`, `aio` Text Analytics) without changing the
  public API.

## See also

- [`csa_platform.ai_integration.rag`](../rag/) — RAG pipeline that consumes
  these enrichers.
- [`docs/best-practices/data-engineering.md`](../../../docs/best-practices/data-engineering.md)
  — Bronze→Silver enrichment patterns at the pipeline level.
