"""Tests for the APIClient HTTP wrapper."""

from __future__ import annotations

import json
import urllib.error
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from portal.cli.client import APIClient, APIError


# ── Helpers ────────────────────────────────────────────────────────────────────


def _make_http_error(code: int, body: str) -> urllib.error.HTTPError:
    """Build a realistic urllib HTTPError for testing."""
    return urllib.error.HTTPError(
        url="http://test/",
        code=code,
        msg="Test error",
        hdrs=None,  # type: ignore[arg-type]
        fp=BytesIO(body.encode()),
    )


def _make_url_error(reason: str) -> urllib.error.URLError:
    return urllib.error.URLError(reason=reason)


# ── URL building ───────────────────────────────────────────────────────────────


class TestURLBuilding:
    def test_base_url_trailing_slash_stripped(self):
        client = APIClient("http://localhost:8000/api/v1/")
        url = client._url("/sources")
        assert url == "http://localhost:8000/api/v1/sources"

    def test_params_appended(self):
        client = APIClient("http://localhost:8000/api/v1")
        url = client._url("/sources", params={"domain": "hr", "limit": "50"})
        assert "domain=hr" in url
        assert "limit=50" in url

    def test_none_params_excluded(self):
        client = APIClient("http://localhost:8000/api/v1")
        url = client._url("/sources", params={"domain": None, "limit": "50"})
        assert "domain" not in url
        assert "limit=50" in url

    def test_no_params(self):
        client = APIClient("http://localhost:8000/api/v1")
        url = client._url("/sources")
        assert url == "http://localhost:8000/api/v1/sources"
        assert "?" not in url


# ── Headers ────────────────────────────────────────────────────────────────────


class TestHeaders:
    def test_default_headers_no_token(self):
        client = APIClient("http://localhost:8000/api/v1")
        headers = client._headers()
        assert headers["Accept"] == "application/json"
        assert "Authorization" not in headers

    def test_bearer_token_added(self):
        client = APIClient("http://localhost:8000/api/v1", token="my-secret-token")
        headers = client._headers()
        assert headers["Authorization"] == "Bearer my-secret-token"


# ── Error handling ─────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_http_error_raises_api_error(self):
        client = APIClient("http://localhost:8000/api/v1")
        error = _make_http_error(404, json.dumps({"detail": "Not found"}))
        with patch("urllib.request.urlopen", side_effect=error):
            with pytest.raises(APIError) as exc_info:
                client.get("/sources/missing")
        assert exc_info.value.status == 404
        assert "Not found" in exc_info.value.detail

    def test_url_error_raises_api_error_with_status_zero(self):
        client = APIClient("http://localhost:8000/api/v1")
        error = _make_url_error("[Errno 111] Connection refused")
        with patch("urllib.request.urlopen", side_effect=error):
            with pytest.raises(APIError) as exc_info:
                client.get("/sources")
        assert exc_info.value.status == 0
        assert "Connection error" in exc_info.value.detail

    def test_http_error_non_json_body(self):
        client = APIClient("http://localhost:8000/api/v1")
        error = _make_http_error(502, "Bad Gateway — non-JSON")
        with patch("urllib.request.urlopen", side_effect=error):
            with pytest.raises(APIError) as exc_info:
                client.get("/sources")
        assert exc_info.value.status == 502
        assert "Bad Gateway" in exc_info.value.detail

    def test_api_error_str(self):
        exc = APIError(404, "Not found")
        assert "404" in str(exc)
        assert "Not found" in str(exc)


# ── Successful requests ────────────────────────────────────────────────────────


class TestSuccessfulRequests:
    def _mock_response(self, data) -> MagicMock:
        body = json.dumps(data).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = body
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def test_get_returns_parsed_json(self):
        client = APIClient("http://localhost:8000/api/v1")
        mock_resp = self._mock_response([{"id": "src-001"}])
        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = client.get("/sources")
        assert result == [{"id": "src-001"}]

    def test_post_sends_json_body(self):
        client = APIClient("http://localhost:8000/api/v1")
        mock_resp = self._mock_response({"id": "src-new"})
        captured_req = {}

        def capture(req, **_):
            captured_req["data"] = req.data
            return mock_resp

        with patch("urllib.request.urlopen", side_effect=capture):
            result = client.post("/sources", body={"name": "Test"})

        assert result == {"id": "src-new"}
        assert captured_req["data"] is not None
        payload = json.loads(captured_req["data"])
        assert payload["name"] == "Test"

    def test_post_no_body_sends_none(self):
        client = APIClient("http://localhost:8000/api/v1")
        mock_resp = self._mock_response({"status": "ok"})
        captured_req = {}

        def capture(req, **_):
            captured_req["data"] = req.data
            return mock_resp

        with patch("urllib.request.urlopen", side_effect=capture):
            client.post("/sources/src-001/decommission")

        assert captured_req["data"] is None


# ── Domain-specific methods ────────────────────────────────────────────────────


class TestDomainMethods:
    """Smoke-test that domain methods call the right paths."""

    def setup_method(self):
        self.client = APIClient("http://localhost:8000/api/v1")
        self._captured = {}

    def _make_patcher(self, response_data):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(response_data).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        def capture(req, **_):
            self._captured["url"] = req.full_url
            self._captured["method"] = req.get_method()
            return mock_resp

        return patch("urllib.request.urlopen", side_effect=capture)

    def test_list_sources_calls_sources_path(self):
        with self._make_patcher([]):
            self.client.list_sources()
        assert "/sources" in self._captured["url"]

    def test_get_source_calls_correct_path(self):
        with self._make_patcher({}):
            self.client.get_source("src-001")
        assert "/sources/src-001" in self._captured["url"]

    def test_decommission_source_is_post(self):
        with self._make_patcher({}):
            self.client.decommission_source("src-001")
        assert self._captured["method"] == "POST"
        assert "decommission" in self._captured["url"]

    def test_trigger_pipeline_is_post(self):
        with self._make_patcher({}):
            self.client.trigger_pipeline("pl-001")
        assert self._captured["method"] == "POST"
        assert "trigger" in self._captured["url"]

    def test_list_products_calls_marketplace_path(self):
        with self._make_patcher([]):
            self.client.list_products()
        assert "marketplace/products" in self._captured["url"]

    def test_platform_stats_calls_stats_path(self):
        with self._make_patcher({}):
            self.client.platform_stats()
        assert "/stats" in self._captured["url"]

    def test_all_domains_calls_domains_path(self):
        with self._make_patcher([]):
            self.client.all_domains()
        assert "/domains" in self._captured["url"]
