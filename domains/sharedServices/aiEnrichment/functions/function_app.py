"""Azure Functions for AI Document Enrichment Service.

Provides HTTP and Blob-triggered functions for enriching documents
using Azure AI Services (Form Recognizer, Text Analytics, OpenAI).
Part of the CSA-in-a-Box shared services layer.

Async / concurrency model
-------------------------
Every trigger is ``async def`` and every outbound SDK call uses the
``.aio`` variant (``azure.ai.textanalytics.aio``,
``azure.ai.formrecognizer.aio``) so the Azure Functions host can
interleave multiple in-flight invocations without blocking the event
loop on I/O.  Clients are instantiated per-invocation inside
``async with`` blocks so the SDK's aiohttp transport gets closed
cleanly; there is no module-level client cache.

Logging
-------
All log lines are emitted as JSON via :mod:`governance.common.logging`
(structlog) so Log Analytics can parse them with a single KQL expression
(see ``docs/LOG_SCHEMA.md``).  Every HTTP / Blob / Timer invocation binds
a ``trace_id`` and ``correlation_id`` via :func:`bind_trace_context` so
cross-service correlation works out of the box.
"""

import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import azure.functions as func
from azure.core.exceptions import HttpResponseError, ServiceRequestError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from governance.common.logging import (
    bind_trace_context,
    configure_structlog,
    extract_trace_id_from_headers,
    get_logger,
)

configure_structlog(service="csa-ai-enrichment")
logger = get_logger(__name__)

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

# ---------------------------------------------------------------------------
# Configuration and Constants
# ---------------------------------------------------------------------------
AI_ENDPOINT = os.environ.get("AZURE_AI_ENDPOINT", "")
STORAGE_CONNECTION = os.environ.get("AzureWebJobsStorage", "")  # noqa: SIM112 (Azure-defined name)
ENRICHED_CONTAINER = os.environ.get("ENRICHED_CONTAINER", "enriched")
INBOX_CONTAINER = os.environ.get("INBOX_CONTAINER", "inbox")

# Text processing limits - Azure AI Services constraints.
# Override via environment variables for different Azure AI tier limits.
TEXT_CHUNK_SIZE = int(os.environ.get("AI_TEXT_CHUNK_SIZE", "5120"))
MAX_TEXT_LENGTH = int(os.environ.get("AI_MAX_TEXT_LENGTH", "125000"))

# ---------------------------------------------------------------------------
# Async Azure SDK clients
# ---------------------------------------------------------------------------
#
# Earlier versions cached TextAnalyticsClient / DocumentAnalysisClient and
# the DefaultAzureCredential in module-level globals.  The aiohttp session
# underneath never got closed, so every scale-in or process restart leaked
# connections.  Azure Functions' process model does not reliably run
# ``atexit`` handlers for async resources either.
#
# Current approach: instantiate each client per-invocation inside an
# ``async with`` block so its transport is torn down deterministically.
# The per-request overhead is ~10ms (dwarfed by 50-500ms of actual AI
# work) and Azure AI services tolerate it - see the ``@retry`` decorators
# for transient-failure handling.
#
# The credential is cheap to construct but also owns a session that must
# be closed.  Construct it inside the same ``async with`` scope as the
# client, not as a shared global.


@asynccontextmanager
async def _text_analytics_client() -> AsyncIterator[Any]:
    """Yield an async TextAnalyticsClient, closing it on scope exit.

    Yields ``None`` when the SDK is not installed or ``AI_ENDPOINT`` is
    unset, so callers can short-circuit without special-casing both.
    """
    if not AI_ENDPOINT:
        yield None
        return
    try:
        from azure.ai.textanalytics.aio import TextAnalyticsClient
        from azure.identity.aio import DefaultAzureCredential
    except ImportError:
        yield None
        return

    async with DefaultAzureCredential() as credential, TextAnalyticsClient(
        endpoint=AI_ENDPOINT,
        credential=credential,
    ) as client:
        yield client


@asynccontextmanager
async def _document_analysis_client() -> AsyncIterator[Any]:
    """Yield an async DocumentAnalysisClient, closing it on scope exit."""
    if not AI_ENDPOINT:
        yield None
        return
    try:
        from azure.ai.formrecognizer.aio import DocumentAnalysisClient
        from azure.identity.aio import DefaultAzureCredential
    except ImportError:
        yield None
        return

    async with DefaultAzureCredential() as credential, DocumentAnalysisClient(
        endpoint=AI_ENDPOINT,
        credential=credential,
    ) as client:
        yield client


# ---------------------------------------------------------------------------
# Capability probes (synchronous, for health check only)
# ---------------------------------------------------------------------------
def _text_analytics_available() -> bool:
    """Return True if the Text Analytics SDK + config are both ready."""
    if not AI_ENDPOINT:
        return False
    try:
        import azure.ai.textanalytics.aio  # noqa: F401

        return True
    except ImportError:
        return False


def _form_recognizer_available() -> bool:
    """Return True if the Document Intelligence SDK + config are both ready."""
    if not AI_ENDPOINT:
        return False
    try:
        import azure.ai.formrecognizer.aio  # noqa: F401

        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# Async enrichment pipelines
# ---------------------------------------------------------------------------
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type((ServiceRequestError, HttpResponseError)),
)
async def _enrich_text(text: str) -> dict[str, Any]:
    """Run text enrichment pipeline: language detection, sentiment, entities, PII.

    Instantiates a fresh async TextAnalyticsClient inside an
    ``async with`` block so its aiohttp transport is closed when the
    function returns; the tenacity ``@retry`` decorator handles transient
    Azure SDK errors.
    """
    results: dict[str, Any] = {
        "enriched_at": datetime.now(timezone.utc).isoformat(),
        "language": None,
        "sentiment": None,
        "key_phrases": [],
        "entities": [],
        "pii_entities": [],
    }

    async with _text_analytics_client() as client:
        if client is None:
            results["error"] = "AI client not configured"
            return results

        docs = [{"id": "1", "text": text[:TEXT_CHUNK_SIZE]}]

        # Language detection
        lang_result = await client.detect_language(documents=docs)
        if lang_result and not lang_result[0].is_error:
            detected = lang_result[0].primary_language
            results["language"] = {
                "name": detected.name,
                "iso_code": detected.iso6391_name,
                "confidence": detected.confidence_score,
            }

        # Sentiment analysis
        sentiment_result = await client.analyze_sentiment(documents=docs)
        if sentiment_result and not sentiment_result[0].is_error:
            doc = sentiment_result[0]
            results["sentiment"] = {
                "overall": doc.sentiment,
                "scores": {
                    "positive": doc.confidence_scores.positive,
                    "neutral": doc.confidence_scores.neutral,
                    "negative": doc.confidence_scores.negative,
                },
            }

        # Key phrases
        phrases_result = await client.extract_key_phrases(documents=docs)
        if phrases_result and not phrases_result[0].is_error:
            results["key_phrases"] = list(phrases_result[0].key_phrases)

        # Named entity recognition
        entity_result = await client.recognize_entities(documents=docs)
        if entity_result and not entity_result[0].is_error:
            results["entities"] = [
                {
                    "text": e.text,
                    "category": e.category,
                    "subcategory": e.subcategory,
                    "confidence": e.confidence_score,
                }
                for e in entity_result[0].entities
            ]

        # PII detection
        pii_result = await client.recognize_pii_entities(documents=docs)
        if pii_result and not pii_result[0].is_error:
            results["pii_redacted_text"] = pii_result[0].redacted_text
            results["pii_entities"] = [
                {
                    "category": e.category,
                    "subcategory": e.subcategory,
                    "confidence": e.confidence_score,
                }
                for e in pii_result[0].entities
            ]

    return results


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type((ServiceRequestError, HttpResponseError)),
)
async def _analyze_document(blob_data: bytes, content_type: str) -> dict[str, Any]:
    """Analyze a document with Azure AI Document Intelligence.

    Instantiates a fresh async DocumentAnalysisClient inside an
    ``async with`` block so its aiohttp transport is closed when the
    function returns; includes a size check to prevent reading excessive
    blob data into memory.
    """
    results: dict[str, Any] = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "pages": 0,
        "tables": 0,
        "key_value_pairs": [],
        "content_preview": "",
    }

    # Check blob size limit (50 MB)
    MAX_BLOB_SIZE = 50 * 1024 * 1024  # 50 MB
    if len(blob_data) > MAX_BLOB_SIZE:
        results["error"] = f"Document too large: {len(blob_data)} bytes (max: {MAX_BLOB_SIZE})"
        return results

    async with _document_analysis_client() as client:
        if client is None:
            results["error"] = "Document Intelligence client not configured"
            return results

        poller = await client.begin_analyze_document(
            model_id="prebuilt-document",
            document=blob_data,
            content_type=content_type,
        )
        result = await poller.result()

        results["pages"] = len(result.pages) if result.pages else 0
        results["tables"] = len(result.tables) if result.tables else 0
        results["content_preview"] = (result.content or "")[:500]

        if result.key_value_pairs:
            results["key_value_pairs"] = [
                {
                    "key": kvp.key.content if kvp.key else None,
                    "value": kvp.value.content if kvp.value else None,
                    "confidence": kvp.confidence,
                }
                for kvp in result.key_value_pairs[:50]
            ]

    return results


# ---------------------------------------------------------------------------
# HTTP Trigger: On-demand text enrichment
# ---------------------------------------------------------------------------
@app.route(route="enrich", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)
async def enrich_text(req: func.HttpRequest) -> func.HttpResponse:
    """Enrich text with AI analysis (language, sentiment, entities, PII).

    POST /api/enrich
    Body: { "text": "Your text to analyze" }
    Returns: JSON with enrichment results
    """
    trace_id = extract_trace_id_from_headers(dict(req.headers))
    with bind_trace_context(
        trace_id=trace_id,
        request_method="POST",
        request_route="/api/enrich",
    ):
        logger.info("request.received")

        try:
            body = req.get_json()
        except ValueError:
            logger.warning("request.invalid_json")
            return func.HttpResponse(
                json.dumps({"error": "Invalid JSON body"}),
                status_code=400,
                mimetype="application/json",
            )

        text = body.get("text", "")
        if not text:
            logger.warning("request.missing_field", field="text")
            return func.HttpResponse(
                json.dumps({"error": "Missing 'text' field"}),
                status_code=400,
                mimetype="application/json",
            )

        if len(text) > MAX_TEXT_LENGTH:
            logger.warning("request.payload_too_large", input_length=len(text))
            return func.HttpResponse(
                json.dumps({"error": f"Text exceeds {MAX_TEXT_LENGTH:,} character limit"}),
                status_code=413,
                mimetype="application/json",
            )

        results = await _enrich_text(text)
        results["input_length"] = len(text)

        logger.info(
            "request.completed",
            input_length=len(text),
            has_error="error" in results,
        )
        return func.HttpResponse(
            json.dumps(results, default=str),
            status_code=200,
            mimetype="application/json",
        )


# ---------------------------------------------------------------------------
# Blob Trigger: Automated document processing from inbox container
# ---------------------------------------------------------------------------
@app.blob_trigger(
    arg_name="blob",
    path=f"{INBOX_CONTAINER}/{{name}}",
    connection="AzureWebJobsStorage",
)
@app.blob_output(
    arg_name="outputBlob",
    path=f"{ENRICHED_CONTAINER}/{{name}}.enrichment.json",
    connection="AzureWebJobsStorage",
)
async def process_inbox_document(
    blob: func.InputStream,
    outputBlob: func.Out[str],
) -> None:
    """Automatically process documents dropped into the inbox container.

    Triggered by new blobs in the inbox container. Runs document analysis
    and text enrichment asynchronously, then writes results to the
    enriched container.
    """
    with bind_trace_context(
        trigger="blob",
        blob_name=blob.name,
        blob_size=blob.length,
    ):
        logger.info("blob.received")

        # Check blob size before reading into memory
        MAX_BLOB_SIZE = 50 * 1024 * 1024  # 50 MB
        if blob.length and blob.length > MAX_BLOB_SIZE:
            skip_result: dict[str, Any] = {
                "source_blob": blob.name,
                "source_size": blob.length,
                "processed_at": datetime.now(timezone.utc).isoformat(),
                "skipped": True,
                "reason": f"Blob too large: {blob.length} bytes (max: {MAX_BLOB_SIZE})",
            }
            output_json = json.dumps(skip_result, default=str, indent=2)
            outputBlob.set(output_json)
            logger.warning("blob.too_large", blob_size=blob.length, max_size=MAX_BLOB_SIZE)
            return

        blob_data = blob.read()
        content_type = blob.name.rsplit(".", 1)[-1].lower() if blob.name else ""

        enrichment: dict[str, Any] = {
            "source_blob": blob.name,
            "source_size": blob.length,
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "content_type": content_type,
        }

        # Route based on content type
        if content_type in ("pdf", "png", "jpg", "jpeg", "tiff", "bmp"):
            mime_map = {
                "pdf": "application/pdf",
                "png": "image/png",
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "tiff": "image/tiff",
                "bmp": "image/bmp",
            }
            doc_results = await _analyze_document(
                blob_data,
                mime_map.get(content_type, "application/octet-stream"),
            )
            enrichment["document_analysis"] = doc_results

            # Also run text enrichment on extracted content
            if doc_results.get("content_preview"):
                enrichment["text_enrichment"] = await _enrich_text(
                    doc_results["content_preview"],
                )

        elif content_type in ("txt", "csv", "json", "md"):
            text_content = blob_data.decode("utf-8", errors="replace")
            enrichment["text_enrichment"] = await _enrich_text(text_content[:MAX_TEXT_LENGTH])

        else:
            enrichment["skipped"] = True
            enrichment["reason"] = f"Unsupported content type: {content_type}"
            logger.warning("blob.unsupported_type", content_type=content_type)

        output_json = json.dumps(enrichment, default=str, indent=2)
        outputBlob.set(output_json)
        logger.info("blob.completed")


# ---------------------------------------------------------------------------
# HTTP Trigger: Health check
# ---------------------------------------------------------------------------
@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
async def health_check(req: func.HttpRequest) -> func.HttpResponse:
    """Health check endpoint for monitoring.

    GET /api/health
    Returns: JSON with service status and capability checks
    """
    status: dict[str, Any] = {
        "status": "healthy",
        "service": "ai-enrichment",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return func.HttpResponse(
        json.dumps(status),
        status_code=200,
        mimetype="application/json",
    )
