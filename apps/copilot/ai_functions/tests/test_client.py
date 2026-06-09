"""Tests for ai_functions._client — request shaping, retries, and typed errors.

The HTTP layer is mocked (no live AOAI). API-key auth is used so no Azure token
acquisition is attempted. These assert the request shape, the reasoning-model
temperature fallback, the 429 retry budget, and that every failure path raises
a typed, actionable error rather than returning an empty string.
"""

from __future__ import annotations

import pytest


class _FakeResponse:
    def __init__(self, status_code: int, *, json_body=None, text: str = "") -> None:
        self.status_code = status_code
        self._json = json_body if json_body is not None else {}
        self.text = text

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self):
        return self._json


def _ok_body(content: str = "result text") -> dict:
    return {"choices": [{"message": {"content": content}}], "usage": {"total_tokens": 7}}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    import ai_functions._client as mod

    # API-key auth so no Azure token is fetched; a configured endpoint.
    monkeypatch.setenv("LOOM_AOAI_ENDPOINT", "https://aoai.openai.azure.com")
    monkeypatch.setenv("LOOM_AOAI_DEPLOYMENT", "gpt-4o")
    monkeypatch.setenv("LOOM_AOAI_KEY", "secret-key")
    monkeypatch.delenv("LOOM_AOAI_AUDIENCE", raising=False)
    return mod


def test_happy_path_returns_content(client, monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}

    def fake_post(url, json, headers, timeout):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return _FakeResponse(200, json_body=_ok_body("hello"))

    monkeypatch.setattr(client.requests, "post", fake_post)

    out = client.call_chat("sys prompt", "user text", max_tokens=42)
    assert out == "hello"
    assert "/openai/deployments/gpt-4o/chat/completions" in captured["url"]
    assert captured["headers"]["api-key"] == "secret-key"
    assert "authorization" not in captured["headers"]
    assert captured["json"]["max_tokens"] == 42
    assert captured["json"]["messages"][0] == {"role": "system", "content": "sys prompt"}
    assert captured["json"]["messages"][1] == {"role": "user", "content": "user text"}
    assert captured["json"]["temperature"] == 0


def test_missing_endpoint_raises_config_error(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOOM_AOAI_ENDPOINT", raising=False)
    with pytest.raises(client.AoaiBridgeConfigError, match="LOOM_AOAI_ENDPOINT"):
        client.call_chat("s", "u")


def test_temperature_fallback_on_400(client, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_post(url, json, headers, timeout):
        calls.append(json)
        if "temperature" in json:
            return _FakeResponse(
                400,
                text="unsupported_value: 'temperature' does not support 0",
            )
        return _FakeResponse(200, json_body=_ok_body("ok-no-temp"))

    monkeypatch.setattr(client.requests, "post", fake_post)

    out = client.call_chat("s", "u")
    assert out == "ok-no-temp"
    assert len(calls) == 2
    assert "temperature" in calls[0]
    assert "temperature" not in calls[1]


def test_429_retries_then_raises_rate_limit(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client.time, "sleep", lambda _s: None)
    attempts = {"n": 0}

    def fake_post(url, json, headers, timeout):
        attempts["n"] += 1
        return _FakeResponse(429, text="rate limited")

    monkeypatch.setattr(client.requests, "post", fake_post)

    with pytest.raises(client.AoaiBridgeRateLimitError):
        client.call_chat("s", "u")
    assert attempts["n"] == 3  # _MAX_RETRIES


def test_404_raises_deployment_error(client, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_post(url, json, headers, timeout):
        return _FakeResponse(404, text="DeploymentNotFound")

    monkeypatch.setattr(client.requests, "post", fake_post)
    with pytest.raises(client.AoaiBridgeDeploymentError, match="gpt-4o"):
        client.call_chat("s", "u")


def test_generic_error_on_500(client, monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_post(url, json, headers, timeout):
        return _FakeResponse(500, text="boom")

    monkeypatch.setattr(client.requests, "post", fake_post)
    with pytest.raises(client.AoaiBridgeError, match="500"):
        client.call_chat("s", "u")


def test_strips_code_fences(client, monkeypatch: pytest.MonkeyPatch) -> None:
    fenced = "```json\n{\"a\": 1}\n```"

    def fake_post(url, json, headers, timeout):
        return _FakeResponse(200, json_body=_ok_body(fenced))

    monkeypatch.setattr(client.requests, "post", fake_post)
    assert client.call_chat("s", "u") == '{"a": 1}'
