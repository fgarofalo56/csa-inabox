"""Tests for the portal AI router (``/api/v1/ai/*``).

These tests pin the **wiring** behavior of the router:

* When :class:`RAGService` cannot be constructed in the current
  environment (the default in CI / local dev), each endpoint must
  return a clearly labelled demo response — never a misleading
  fake — and ``model="demo-stub"`` must be present in chat/embed.
* When a service *can* be constructed (we monkey-patch the helpers
  to inject a fake), each endpoint must delegate to it and surface
  its outputs.

This replaces the prior hard-coded fake responses that lived in
``portal/shared/api/routers/ai.py`` and shipped misleading sources.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from portal.shared.api.routers import ai as ai_router


# ── Demo-stub fallback path (no service configured) ────────────────────────


class TestDemoStubFallback:
    """When the RAG stack is not configured, the router must not lie."""

    def test_chat_returns_demo_stub_when_unconfigured(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: None)
        response = client.post(
            "/api/v1/ai/chat",
            json={"query": "what is a data mesh?"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["model"] == "demo-stub"
        assert "what is a data mesh?" in body["answer"]
        assert "[demo-stub]" in body["answer"]
        assert body["sources"] == []
        assert body["usage"]["total_tokens"] == 0

    def test_embed_returns_zero_vectors_when_unconfigured(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_embedder", lambda: None)
        response = client.post(
            "/api/v1/ai/embed",
            json={"texts": ["hello", "world"]},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["model"] == "demo-stub"
        assert body["dimensions"] == 1536
        assert len(body["embeddings"]) == 2
        assert all(v == 0.0 for v in body["embeddings"][0])

    def test_search_returns_empty_when_unconfigured(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: None)
        response = client.post(
            "/api/v1/ai/search",
            json={"query": "finance"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["query"] == "finance"
        assert body["total"] == 0
        assert body["results"] == []

    def test_status_reports_unavailable_when_unconfigured(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: None)
        response = client.get("/api/v1/ai/status")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "unavailable"
        assert body["vector_store"] == "disconnected"


# ── Wired path (RAGService injected via monkeypatch) ──────────────────────


class _FakeUsage:
    prompt_tokens = 12
    completion_tokens = 34
    total_tokens = 46


class _FakeCitation:
    def __init__(self, source: str, score: float) -> None:
        self.source = source
        self.score = score
        self.metadata = {"snippet": f"snippet for {source}", "url": f"https://x/{source}"}


class _FakeAnswer:
    answer = "real answer from RAG"
    model = "azure-openai"
    usage = _FakeUsage()
    sources = [_FakeCitation("doc-a", 0.91), _FakeCitation("doc-b", 0.77)]


class _FakeRetriever:
    async def search_async(self, **kwargs: Any) -> list[Any]:
        class _R:
            id = "r1"
            text = "match-text"
            score = 0.88
            metadata = {"k": "v"}

        return [_R()]


class _FakeEmbedder:
    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3] for _ in texts]


class _FakeService:
    def __init__(self) -> None:
        self.retriever = _FakeRetriever()
        self.embedder = _FakeEmbedder()

        class _S:
            class _AOAI:
                embedding_deployment = "emb-dep"
                chat_deployment = "chat-dep"

            azure_openai = _AOAI()

        self.settings = _S()

    async def query(self, *, question: str, **_: Any) -> _FakeAnswer:
        return _FakeAnswer()

    async def __aenter__(self) -> "_FakeService":
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None


class TestWiredPath:
    """When a RAGService is available, the router must delegate to it."""

    def test_chat_delegates_to_rag_service(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: _FakeService())
        response = client.post("/api/v1/ai/chat", json={"query": "x"})
        assert response.status_code == 200
        body = response.json()
        assert body["answer"] == "real answer from RAG"
        assert body["model"] == "azure-openai"
        assert body["usage"]["total_tokens"] == 46
        assert len(body["sources"]) == 2
        assert body["sources"][0]["title"] == "doc-a"

    def test_search_delegates_and_surfaces_results(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: _FakeService())
        response = client.post(
            "/api/v1/ai/search",
            json={"query": "match", "top_k": 5},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert body["results"][0]["id"] == "r1"
        assert body["results"][0]["content"] == "match-text"

    def test_embed_uses_real_embedder(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_embedder", lambda: _FakeEmbedder())
        response = client.post(
            "/api/v1/ai/embed",
            json={"texts": ["a", "b", "c"]},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["model"] != "demo-stub"
        assert body["dimensions"] == 3
        assert len(body["embeddings"]) == 3

    def test_status_reports_healthy_when_configured(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: _FakeService())
        response = client.get("/api/v1/ai/status")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "healthy"
        assert body["embedding_model"] == "emb-dep"
        assert body["chat_model"] == "chat-dep"
        assert body["vector_store"] == "connected"


# ── Error path ─────────────────────────────────────────────────────────────


class TestErrorPath:
    """If the wired service raises, the router must return 500, not lie."""

    def test_chat_propagates_service_errors_as_500(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class _BoomService(_FakeService):
            async def query(self, **_: Any) -> _FakeAnswer:  # type: ignore[override]
                raise RuntimeError("upstream failed")

        monkeypatch.setattr(ai_router, "_try_get_rag_service", lambda: _BoomService())
        response = client.post("/api/v1/ai/chat", json={"query": "x"})
        assert response.status_code == 500
