"""Tests for the Copilot web demo surface."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from apps.copilot.models import AnswerChunk, AnswerResponse
from apps.copilot.surfaces.config import SurfacesSettings
from apps.copilot.surfaces.web.app import WebStartupConfigurationError, build_app


class _StubAgent:
    async def ask(self, question: str) -> AnswerResponse:  # pragma: no cover
        return AnswerResponse(
            question=question,
            answer="ok",
            citations=[],
            groundedness=0.5,
            refused=False,
        )

    async def ask_stream(
        self,
        question: str,
        *,
        extra_context: str = "",  # noqa: ARG002
    ) -> AsyncIterator[AnswerChunk]:
        yield AnswerChunk(kind="status", payload="retrieve-start")
        yield AnswerChunk(kind="token", payload="hello ")
        yield AnswerChunk(kind="token", payload=question)
        yield AnswerChunk(
            kind="done",
            payload=AnswerResponse(
                question=question,
                answer=f"hello {question}",
                citations=[],
                groundedness=0.5,
                refused=False,
            ),
        )


@pytest.fixture
def demo_settings() -> SurfacesSettings:
    return SurfacesSettings(
        web_local_demo_mode=True,
        web_brand_title="Test Copilot",
    )


@pytest.fixture
def client(demo_settings: SurfacesSettings) -> TestClient:
    app = build_app(settings=demo_settings, agent_factory=_StubAgent)
    return TestClient(app)


def test_index_renders_template(client: TestClient) -> None:
    """`GET /` returns HTML with the brand title rendered."""
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "Test Copilot" in resp.text
    assert "Demo mode" in resp.text  # demo banner visible
    assert 'data-sse-endpoint="/chat/send"' in resp.text


def test_index_no_demo_banner_when_disabled(demo_settings: SurfacesSettings) -> None:
    """When demo mode is off the banner does not render."""
    settings = demo_settings.model_copy(update={"web_local_demo_mode": False})
    app = build_app(settings=settings, agent_factory=_StubAgent)
    with TestClient(app) as client:
        resp = client.get("/")
        assert resp.status_code == 200
        assert "Demo mode" not in resp.text


def test_static_assets_served(client: TestClient) -> None:
    """The CSS and JS assets are served under /static/."""
    css = client.get("/static/app.css")
    assert css.status_code == 200
    assert "--bg" in css.text

    js = client.get("/static/app.js")
    assert js.status_code == 200
    assert "EventSource" in js.text


def test_chat_send_streams_tokens(client: TestClient) -> None:
    """The SSE endpoint streams token events then terminates with done."""
    with client.stream(
        "GET",
        "/chat/send",
        params={"question": "world"},
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]
        body = b"".join(resp.iter_bytes())
    text = body.decode("utf-8")
    assert "event: token" in text
    assert "event: done" in text


def test_chat_send_rejects_empty_question(client: TestClient) -> None:
    """Empty question fails Pydantic validation → 422."""
    resp = client.get("/chat/send", params={"question": ""})
    assert resp.status_code == 422


def test_healthz(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


# ─── Startup gate ────────────────────────────────────────────────────────


def test_staging_with_demo_mode_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """Staging env + demo mode + no BFF → refuses to boot."""
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.delenv("AUTH_MODE", raising=False)
    monkeypatch.setenv("AZURE_TENANT_ID", "t")
    settings = SurfacesSettings(web_local_demo_mode=True)
    with pytest.raises(WebStartupConfigurationError, match="demo"):
        build_app(settings=settings, agent_factory=_StubAgent)


def test_staging_behind_bff_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """Staging + BFF mode may run in demo mode (BFF gates at the edge)."""
    monkeypatch.setenv("ENVIRONMENT", "staging")
    monkeypatch.setenv("AUTH_MODE", "bff")
    monkeypatch.setenv("AZURE_TENANT_ID", "t")
    settings = SurfacesSettings(web_local_demo_mode=True)
    # Construction succeeds; we don't serve traffic here.
    app = build_app(settings=settings, agent_factory=_StubAgent)
    assert app.title == "CSA Copilot Web"


def test_production_requires_auth_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Production without demo mode off and without BFF → refuses."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("AUTH_MODE", raising=False)
    monkeypatch.delenv("AZURE_TENANT_ID", raising=False)
    settings = SurfacesSettings(web_local_demo_mode=False)
    with pytest.raises(WebStartupConfigurationError):
        build_app(settings=settings, agent_factory=_StubAgent)


def test_local_env_serves_freely(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local env is allowed to run in demo mode without auth."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    settings = SurfacesSettings(web_local_demo_mode=True)
    app = build_app(settings=settings, agent_factory=_StubAgent)
    with TestClient(app) as client:
        assert client.get("/").status_code == 200
