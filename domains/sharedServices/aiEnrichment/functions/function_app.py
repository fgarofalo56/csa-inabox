"""Azure Functions for AI Document Enrichment Service.

Provides HTTP and Blob-triggered functions for enriching documents
using Azure AI Services (Form Recognizer, Text Analytics, OpenAI).
Part of the CSA-in-a-Box shared services layer.
"""

import json
import logging
import os
from datetime import datetime, timezone

import azure.functions as func

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
AI_ENDPOINT = os.environ.get("AZURE_AI_ENDPOINT", "")
AI_KEY_SECRET = os.environ.get("AZURE_AI_KEY", "")  # From Key Vault reference
STORAGE_CONNECTION = os.environ.get("AzureWebJobsStorage", "")
ENRICHED_CONTAINER = os.environ.get("ENRICHED_CONTAINER", "enriched")
INBOX_CONTAINER = os.environ.get("INBOX_CONTAINER", "inbox")


def _get_ai_client():
    """Lazy-initialize Azure AI Text Analytics client."""
    try:
        from azure.ai.textanalytics import TextAnalyticsClient
        from azure.core.credentials import AzureKeyCredential

        if not AI_ENDPOINT or not AI_KEY_SECRET:
            return None
        return TextAnalyticsClient(
            endpoint=AI_ENDPOINT,
            credential=AzureKeyCredential(AI_KEY_SECRET),
        )
    except ImportError:
        logging.warning("azure-ai-textanalytics not installed")
        return None


def _get_form_recognizer_client():
    """Lazy-initialize Azure AI Document Intelligence client."""
    try:
        from azure.ai.formrecognizer import DocumentAnalysisClient
        from azure.core.credentials import AzureKeyCredential

        if not AI_ENDPOINT or not AI_KEY_SECRET:
            return None
        return DocumentAnalysisClient(
            endpoint=AI_ENDPOINT,
            credential=AzureKeyCredential(AI_KEY_SECRET),
        )
    except ImportError:
        logging.warning("azure-ai-formrecognizer not installed")
        return None


def _enrich_text(text: str) -> dict:
    """Run text enrichment pipeline: language detection, sentiment, entities, PII."""
    results = {
        "enriched_at": datetime.now(timezone.utc).isoformat(),
        "language": None,
        "sentiment": None,
        "key_phrases": [],
        "entities": [],
        "pii_entities": [],
    }

    client = _get_ai_client()
    if not client:
        results["error"] = "AI client not configured"
        return results

    try:
        # Language detection
        lang_result = client.detect_language(documents=[{"id": "1", "text": text[:5120]}])
        if lang_result and not lang_result[0].is_error:
            detected = lang_result[0].primary_language
            results["language"] = {
                "name": detected.name,
                "iso_code": detected.iso6391_name,
                "confidence": detected.confidence_score,
            }

        # Sentiment analysis
        sentiment_result = client.analyze_sentiment(documents=[{"id": "1", "text": text[:5120]}])
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
        phrases_result = client.extract_key_phrases(documents=[{"id": "1", "text": text[:5120]}])
        if phrases_result and not phrases_result[0].is_error:
            results["key_phrases"] = list(phrases_result[0].key_phrases)

        # Named entity recognition
        entity_result = client.recognize_entities(documents=[{"id": "1", "text": text[:5120]}])
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
        pii_result = client.recognize_pii_entities(documents=[{"id": "1", "text": text[:5120]}])
        if pii_result and not pii_result[0].is_error:
            results["pii_entities"] = [
                {
                    "text": f"{e.text[:3]}***",  # Redact in results
                    "category": e.category,
                    "subcategory": e.subcategory,
                    "confidence": e.confidence_score,
                }
                for e in pii_result[0].entities
            ]

    except Exception as e:
        logging.exception("Text enrichment failed")
        results["error"] = str(e)

    return results


def _analyze_document(blob_data: bytes, content_type: str) -> dict:
    """Analyze document using Azure AI Document Intelligence."""
    results = {
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "pages": 0,
        "tables": 0,
        "key_value_pairs": [],
        "content_preview": "",
    }

    client = _get_form_recognizer_client()
    if not client:
        results["error"] = "Document Intelligence client not configured"
        return results

    try:
        poller = client.begin_analyze_document(
            model_id="prebuilt-document",
            document=blob_data,
            content_type=content_type,
        )
        result = poller.result()

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

    except Exception as e:
        logging.exception("Document analysis failed")
        results["error"] = str(e)

    return results


# ---------------------------------------------------------------------------
# HTTP Trigger: On-demand text enrichment
# ---------------------------------------------------------------------------
@app.route(route="enrich", methods=["POST"])
def enrich_text(req: func.HttpRequest) -> func.HttpResponse:
    """Enrich text with AI analysis (language, sentiment, entities, PII).

    POST /api/enrich
    Body: { "text": "Your text to analyze" }
    Returns: JSON with enrichment results
    """
    logging.info("AI enrichment request received")

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON body"}),
            status_code=400,
            mimetype="application/json",
        )

    text = body.get("text", "")
    if not text:
        return func.HttpResponse(
            json.dumps({"error": "Missing 'text' field"}),
            status_code=400,
            mimetype="application/json",
        )

    if len(text) > 125000:
        return func.HttpResponse(
            json.dumps({"error": "Text exceeds 125,000 character limit"}),
            status_code=413,
            mimetype="application/json",
        )

    results = _enrich_text(text)
    results["input_length"] = len(text)

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
def process_inbox_document(blob: func.InputStream, outputBlob: func.Out[str]):
    """Automatically process documents dropped into the inbox container.

    Triggered by new blobs in the inbox container. Runs document analysis
    and text enrichment, then writes results to the enriched container.
    """
    logging.info(f"Processing blob: {blob.name}, Size: {blob.length} bytes")

    blob_data = blob.read()
    content_type = blob.name.rsplit(".", 1)[-1].lower() if blob.name else ""

    enrichment = {
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
        doc_results = _analyze_document(blob_data, mime_map.get(content_type, "application/octet-stream"))
        enrichment["document_analysis"] = doc_results

        # Also run text enrichment on extracted content
        if doc_results.get("content_preview"):
            enrichment["text_enrichment"] = _enrich_text(doc_results["content_preview"])

    elif content_type in ("txt", "csv", "json", "md"):
        text_content = blob_data.decode("utf-8", errors="replace")
        enrichment["text_enrichment"] = _enrich_text(text_content[:125000])

    else:
        enrichment["skipped"] = True
        enrichment["reason"] = f"Unsupported content type: {content_type}"
        logging.warning(f"Skipping unsupported file type: {content_type}")

    output_json = json.dumps(enrichment, default=str, indent=2)
    outputBlob.set(output_json)
    logging.info(f"Enrichment complete for {blob.name}")


# ---------------------------------------------------------------------------
# HTTP Trigger: Health check
# ---------------------------------------------------------------------------
@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health_check(req: func.HttpRequest) -> func.HttpResponse:
    """Health check endpoint for monitoring.

    GET /api/health
    Returns: JSON with service status and capability checks
    """
    status = {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "capabilities": {
            "text_analytics": _get_ai_client() is not None,
            "document_intelligence": _get_form_recognizer_client() is not None,
        },
        "configuration": {
            "ai_endpoint_configured": bool(AI_ENDPOINT),
            "storage_configured": bool(STORAGE_CONNECTION),
            "inbox_container": INBOX_CONTAINER,
            "enriched_container": ENRICHED_CONTAINER,
        },
    }
    return func.HttpResponse(
        json.dumps(status),
        status_code=200,
        mimetype="application/json",
    )
