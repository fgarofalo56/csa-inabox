"""Tests for the AI Enrichment Azure Function (aiEnrichment/functions/function_app.py).

Covers all three triggers (HTTP enrich, Blob inbox, HTTP health) plus the
two async enrichment pipelines (_enrich_text, _analyze_document) and the
synchronous capability probes.

Mocking strategy
----------------
Azure AI SDK clients are mocked at the module level using ``unittest.mock.patch``
targeting the import path inside function_app.  Every async client is replaced
with an ``AsyncMock`` so ``async with`` and ``await`` both work transparently.
The function_app module is imported dynamically in a fixture so the
module-level ``configure_structlog()`` call runs after the logging state is
reset — this avoids polluting other test modules.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from governance.common.logging import reset_logging_state


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests so module-level configure_structlog works."""
    reset_logging_state()
    yield
    reset_logging_state()


@pytest.fixture()
def function_app() -> types.ModuleType:
    """Import (or reimport) the AI enrichment function_app module.

    We add the function directory to sys.path so ``function_app`` resolves.
    The reimport ensures module-level side effects (configure_structlog, env
    reads) happen after the autouse logging reset fixture runs.
    """
    func_dir = "domains/sharedServices/aiEnrichment/functions"
    if func_dir not in sys.path:
        sys.path.insert(0, func_dir)
    # Force a fresh import each time
    if "function_app" in sys.modules:
        del sys.modules["function_app"]
    mod = importlib.import_module("function_app")
    return mod


def _make_http_request(
    *,
    method: str = "POST",
    url: str = "/api/enrich",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> MagicMock:
    """Build a mock ``azure.functions.HttpRequest``."""
    import azure.functions as func

    req = MagicMock(spec=func.HttpRequest)
    req.method = method
    req.url = url
    req.headers = headers or {}

    if body is not None:
        req.get_json.return_value = json.loads(body)
    else:
        from json import JSONDecodeError

        req.get_json.side_effect = JSONDecodeError("", "", 0)

    return req


def _make_blob(
    name: str = "inbox/test.txt",
    data: bytes = b"Hello world",
    length: int | None = None,
) -> MagicMock:
    """Build a mock ``azure.functions.InputStream``."""
    import azure.functions as func

    blob = MagicMock(spec=func.InputStream)
    blob.name = name
    blob.read.return_value = data
    blob.length = length if length is not None else len(data)
    return blob


# ---------------------------------------------------------------------------
# Capability probe tests
# ---------------------------------------------------------------------------
class TestTextAnalyticsAvailable:
    def test_returns_false_when_no_endpoint(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "")
        assert function_app._text_analytics_available() is False

    def test_returns_false_when_no_key(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "")
        assert function_app._text_analytics_available() is False

    def test_returns_true_when_configured_and_sdk_available(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")
        # The real import may or may not be available; mock it
        mock_module = MagicMock()
        monkeypatch.setitem(sys.modules, "azure.ai.textanalytics.aio", mock_module)
        assert function_app._text_analytics_available() is True


class TestFormRecognizerAvailable:
    def test_returns_false_when_no_endpoint(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "")
        assert function_app._form_recognizer_available() is False

    def test_returns_true_when_configured_and_sdk_available(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")
        mock_module = MagicMock()
        monkeypatch.setitem(sys.modules, "azure.ai.formrecognizer.aio", mock_module)
        assert function_app._form_recognizer_available() is True


# ---------------------------------------------------------------------------
# _enrich_text pipeline tests
# ---------------------------------------------------------------------------
class TestEnrichText:
    @pytest.mark.asyncio()
    async def test_returns_error_when_sdk_not_importable(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """When azure.ai.textanalytics.aio is not installed, returns graceful error."""
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")
        # Make the import fail
        original_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__

        def _block_import(name: str, *args: Any, **kwargs: Any) -> Any:
            if "textanalytics" in name:
                raise ImportError("mocked")
            return original_import(name, *args, **kwargs)

        monkeypatch.setattr("builtins.__import__", _block_import)
        result = await function_app._enrich_text("Hello world")
        assert "error" in result

    @pytest.mark.asyncio()
    async def test_returns_error_when_endpoint_empty(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "")
        result = await function_app._enrich_text("Hello world")
        assert result["error"] == "AI client not configured"

    @pytest.mark.asyncio()
    async def test_successful_enrichment(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Full happy-path: mock the Text Analytics client and verify all fields."""
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")

        # Build mock language result
        mock_lang = MagicMock()
        mock_lang.is_error = False
        mock_lang.primary_language.name = "English"
        mock_lang.primary_language.iso6391_name = "en"
        mock_lang.primary_language.confidence_score = 0.99

        # Build mock sentiment result
        mock_sentiment = MagicMock()
        mock_sentiment.is_error = False
        mock_sentiment.sentiment = "positive"
        mock_sentiment.confidence_scores.positive = 0.9
        mock_sentiment.confidence_scores.neutral = 0.08
        mock_sentiment.confidence_scores.negative = 0.02

        # Build mock key phrases result
        mock_phrases = MagicMock()
        mock_phrases.is_error = False
        mock_phrases.key_phrases = ["test", "analytics"]

        # Build mock entities result
        mock_entity = MagicMock()
        mock_entity.text = "Azure"
        mock_entity.category = "Organization"
        mock_entity.subcategory = None
        mock_entity.confidence_score = 0.95
        mock_entities = MagicMock()
        mock_entities.is_error = False
        mock_entities.entities = [mock_entity]

        # Build mock PII result
        mock_pii_entity = MagicMock()
        mock_pii_entity.text = "john@example.com"
        mock_pii_entity.category = "Email"
        mock_pii_entity.subcategory = None
        mock_pii_entity.confidence_score = 0.98
        mock_pii = MagicMock()
        mock_pii.is_error = False
        mock_pii.entities = [mock_pii_entity]

        # Build the async client mock
        mock_client = AsyncMock()
        mock_client.detect_language.return_value = [mock_lang]
        mock_client.analyze_sentiment.return_value = [mock_sentiment]
        mock_client.extract_key_phrases.return_value = [mock_phrases]
        mock_client.recognize_entities.return_value = [mock_entities]
        mock_client.recognize_pii_entities.return_value = [mock_pii]

        # Make async context manager work
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.ai.textanalytics.aio": MagicMock(TextAnalyticsClient=MagicMock(return_value=mock_client)),
            "azure.core.credentials": MagicMock(),
        }):
            result = await function_app._enrich_text("This is a test")

        assert result["language"]["name"] == "English"
        assert result["language"]["iso_code"] == "en"
        assert result["sentiment"]["overall"] == "positive"
        assert result["key_phrases"] == ["test", "analytics"]
        assert len(result["entities"]) == 1
        assert result["entities"][0]["text"] == "Azure"
        assert len(result["pii_entities"]) == 1
        assert result["pii_entities"][0]["category"] == "Email"
        # PII text should be redacted
        assert "***" in result["pii_entities"][0]["text"]

    @pytest.mark.asyncio()
    async def test_handles_sdk_exception(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """When the SDK raises, we get a graceful error instead of an unhandled exception."""
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")

        mock_client = AsyncMock()
        mock_client.detect_language.side_effect = RuntimeError("SDK boom")
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.ai.textanalytics.aio": MagicMock(TextAnalyticsClient=MagicMock(return_value=mock_client)),
            "azure.core.credentials": MagicMock(),
        }):
            result = await function_app._enrich_text("test")

        assert "error" in result


# ---------------------------------------------------------------------------
# _analyze_document pipeline tests
# ---------------------------------------------------------------------------
class TestAnalyzeDocument:
    @pytest.mark.asyncio()
    async def test_returns_error_when_endpoint_empty(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "")
        result = await function_app._analyze_document(b"%PDF-1.4", "application/pdf")
        assert "error" in result

    @pytest.mark.asyncio()
    async def test_successful_document_analysis(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")

        # Build mock analysis result
        mock_result = MagicMock()
        mock_result.pages = [MagicMock(), MagicMock()]  # 2 pages
        mock_result.tables = [MagicMock()]  # 1 table
        mock_result.content = "Extracted document text"

        mock_kvp = MagicMock()
        mock_kvp.key.content = "Invoice Number"
        mock_kvp.value.content = "INV-001"
        mock_kvp.confidence = 0.95
        mock_result.key_value_pairs = [mock_kvp]

        mock_poller = AsyncMock()
        mock_poller.result.return_value = mock_result

        mock_client = AsyncMock()
        mock_client.begin_analyze_document.return_value = mock_poller
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.ai.formrecognizer.aio": MagicMock(DocumentAnalysisClient=MagicMock(return_value=mock_client)),
            "azure.core.credentials": MagicMock(),
        }):
            result = await function_app._analyze_document(b"%PDF-1.4", "application/pdf")

        assert result["pages"] == 2
        assert result["tables"] == 1
        assert result["content_preview"] == "Extracted document text"
        assert len(result["key_value_pairs"]) == 1
        assert result["key_value_pairs"][0]["key"] == "Invoice Number"

    @pytest.mark.asyncio()
    async def test_handles_sdk_exception(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(function_app, "AI_ENDPOINT", "https://test.cognitiveservices.azure.com")
        monkeypatch.setattr(function_app, "AI_KEY_SECRET", "test-key")

        mock_client = AsyncMock()
        mock_client.begin_analyze_document.side_effect = RuntimeError("SDK boom")
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch.dict("sys.modules", {
            "azure.ai.formrecognizer.aio": MagicMock(DocumentAnalysisClient=MagicMock(return_value=mock_client)),
            "azure.core.credentials": MagicMock(),
        }):
            result = await function_app._analyze_document(b"data", "application/pdf")

        assert "error" in result


# ---------------------------------------------------------------------------
# HTTP Trigger: enrich_text
# ---------------------------------------------------------------------------
class TestEnrichTextTrigger:
    @pytest.mark.asyncio()
    async def test_200_success(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        """Happy path: valid JSON body with text field."""
        # Bypass the actual enrichment — we tested that above
        async def _mock_enrich(text: str) -> dict[str, Any]:
            return {"enriched_at": "2024-01-01T00:00:00Z", "language": None}

        monkeypatch.setattr(function_app, "_enrich_text", _mock_enrich)
        req = _make_http_request(body=json.dumps({"text": "Hello world"}).encode())
        resp = await function_app.enrich_text(req)
        assert resp.status_code == 200
        body = json.loads(resp.get_body())
        assert body["input_length"] == 11

    @pytest.mark.asyncio()
    async def test_400_invalid_json(self, function_app: types.ModuleType) -> None:
        req = _make_http_request(body=None)  # triggers JSONDecodeError
        resp = await function_app.enrich_text(req)
        assert resp.status_code == 400
        body = json.loads(resp.get_body())
        assert "Invalid JSON" in body["error"]

    @pytest.mark.asyncio()
    async def test_400_missing_text(self, function_app: types.ModuleType) -> None:
        req = _make_http_request(body=json.dumps({"other": "field"}).encode())
        resp = await function_app.enrich_text(req)
        assert resp.status_code == 400
        body = json.loads(resp.get_body())
        assert "text" in body["error"]

    @pytest.mark.asyncio()
    async def test_413_too_large(self, function_app: types.ModuleType) -> None:
        big_text = "x" * 130000
        req = _make_http_request(body=json.dumps({"text": big_text}).encode())
        resp = await function_app.enrich_text(req)
        assert resp.status_code == 413


# ---------------------------------------------------------------------------
# Blob Trigger: process_inbox_document
# ---------------------------------------------------------------------------
class TestProcessInboxDocument:
    @pytest.mark.asyncio()
    async def test_pdf_routes_to_document_analysis(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        analyze_called = False

        async def _mock_analyze(blob_data: bytes, content_type: str) -> dict[str, Any]:
            nonlocal analyze_called
            analyze_called = True
            return {"content_preview": "extracted text", "pages": 1, "tables": 0}

        async def _mock_enrich(text: str) -> dict[str, Any]:
            return {"language": {"name": "English"}}

        monkeypatch.setattr(function_app, "_analyze_document", _mock_analyze)
        monkeypatch.setattr(function_app, "_enrich_text", _mock_enrich)

        blob = _make_blob(name="inbox/test.pdf", data=b"%PDF-1.4")
        output = MagicMock()

        await function_app.process_inbox_document(blob, output)

        assert analyze_called
        output.set.assert_called_once()
        result = json.loads(output.set.call_args[0][0])
        assert "document_analysis" in result
        assert "text_enrichment" in result

    @pytest.mark.asyncio()
    async def test_txt_routes_to_text_enrichment(self, function_app: types.ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
        async def _mock_enrich(text: str) -> dict[str, Any]:
            return {"language": {"name": "English"}}

        monkeypatch.setattr(function_app, "_enrich_text", _mock_enrich)

        blob = _make_blob(name="inbox/readme.txt", data=b"Hello world text file")
        output = MagicMock()

        await function_app.process_inbox_document(blob, output)

        output.set.assert_called_once()
        result = json.loads(output.set.call_args[0][0])
        assert "text_enrichment" in result
        assert "document_analysis" not in result

    @pytest.mark.asyncio()
    async def test_unsupported_type_is_skipped(self, function_app: types.ModuleType) -> None:
        blob = _make_blob(name="inbox/binary.exe", data=b"\x00\x01\x02")
        output = MagicMock()

        await function_app.process_inbox_document(blob, output)

        output.set.assert_called_once()
        result = json.loads(output.set.call_args[0][0])
        assert result["skipped"] is True
        assert "exe" in result["reason"]


# ---------------------------------------------------------------------------
# HTTP Trigger: health_check
# ---------------------------------------------------------------------------
class TestHealthCheck:
    @pytest.mark.asyncio()
    async def test_returns_200_with_schema(self, function_app: types.ModuleType) -> None:
        req = _make_http_request(method="GET", url="/api/health")
        resp = await function_app.health_check(req)
        assert resp.status_code == 200
        body = json.loads(resp.get_body())
        assert body["status"] == "healthy"
        assert "timestamp" in body
        assert "capabilities" in body
        assert "text_analytics" in body["capabilities"]
        assert "document_intelligence" in body["capabilities"]
        assert "configuration" in body
