"""Shared pytest fixtures for the API surface tests."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from apps.copilot.broker.broker import ConfirmationBroker
from apps.copilot.config import CopilotSettings
from apps.copilot.conversation import ConversationState, InMemoryConversationStore
from apps.copilot.grounding import GroundingPolicy
from apps.copilot.models import (
    AnswerChunk,
    AnswerResponse,
    Citation,
    ConversationHandle,
)
from apps.copilot.surfaces.api.app import build_app
from apps.copilot.surfaces.api.auth import get_principal
from apps.copilot.surfaces.api.dependencies import (
    get_agent,
    get_broker,
    get_registry,
)
from apps.copilot.surfaces.config import SurfacesSettings
from apps.copilot.tools.registry import ToolRegistry

# Ensure auth stays disabled in local/demo for API tests — the portal
# auth module runs a startup gate on import but checks env at validation
# time, so we simply pin ENVIRONMENT=local when the fixture is imported.
os.environ.setdefault("ENVIRONMENT", "local")
os.environ.setdefault("AUTH_DISABLED", "true")


class StubAgent:
    """In-memory :class:`CopilotAgent` stand-in for API tests.

    The stub implements the methods the router touches (``ask``,
    ``ask_stream``, ``ask_in_conversation``, ``start_conversation``)
    with deterministic responses.  No network calls, no Azure clients.
    """

    def __init__(self) -> None:
        settings = CopilotSettings(broker_signing_key="test-key")
        self.settings = settings
        self.conversation_store = InMemoryConversationStore()
        self.conversation_ttl_seconds = 3600
        # A cheap summarizer that mirrors the production contract — not
        # used in most tests but required by the chat streaming path.
        from apps.copilot.conversation import ConversationSummarizer

        self.summarizer = ConversationSummarizer(
            max_history_tokens=settings.conversation_max_history_tokens,
        )
        self.policy = GroundingPolicy(
            min_similarity=0.2,
            min_chunks=1,
            refusal_message="I cannot answer that.",
            off_scope_classifier="similarity",
        )
        self.ask_calls: list[str] = []

    async def ask(self, question: str) -> AnswerResponse:
        self.ask_calls.append(question)
        return AnswerResponse(
            question=question,
            answer=f"echo: {question}",
            citations=[
                Citation(
                    id=1,
                    source_path="docs/test.md",
                    excerpt="test excerpt",
                    similarity=0.9,
                    chunk_id="abc123",
                ),
            ],
            groundedness=0.9,
            refused=False,
        )

    async def ask_stream(
        self,
        question: str,
        *,
        extra_context: str = "",  # noqa: ARG002
    ) -> AsyncIterator[AnswerChunk]:
        yield AnswerChunk(kind="status", payload="retrieve-start")
        yield AnswerChunk(kind="status", payload="retrieve-complete")
        yield AnswerChunk(kind="token", payload="echo: ")
        yield AnswerChunk(kind="token", payload=question)
        final = AnswerResponse(
            question=question,
            answer=f"echo: {question}",
            citations=[],
            groundedness=0.9,
            refused=False,
        )
        yield AnswerChunk(kind="done", payload=final)

    async def start_conversation(self) -> ConversationHandle:
        import uuid
        from datetime import datetime, timezone

        conv_id = uuid.uuid4().hex
        state = ConversationState(
            conversation_id=conv_id,
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await self.conversation_store.set(state, ttl_seconds=3600)
        return ConversationHandle(conversation_id=conv_id)

    async def ask_in_conversation(
        self,
        handle: ConversationHandle,  # noqa: ARG002
        question: str,
    ) -> AnswerResponse:
        return await self.ask(question)

    async def reset_conversation(self, handle: ConversationHandle) -> None:
        await self.conversation_store.delete(handle.conversation_id)


@pytest.fixture
def surface_settings() -> SurfacesSettings:
    """Baseline settings suitable for local/test runs."""
    return SurfacesSettings(
        api_auth_enabled=False,
        api_rate_limit_per_minute=0,  # disabled for base tests
        api_cors_origins=[],
    )


@pytest.fixture
def stub_agent() -> StubAgent:
    return StubAgent()


@pytest.fixture
def broker() -> ConfirmationBroker:
    settings = CopilotSettings(broker_signing_key="test-signing-key")
    return ConfirmationBroker(settings)


@pytest.fixture
def registry() -> ToolRegistry:
    return ToolRegistry()


@pytest.fixture
def app(
    surface_settings: SurfacesSettings,
    stub_agent: StubAgent,
    broker: ConfirmationBroker,
    registry: ToolRegistry,
) -> Any:
    """Build the FastAPI app with all dependencies overridden to stubs."""
    app = build_app(settings=surface_settings)
    app.dependency_overrides[get_agent] = lambda: stub_agent
    app.dependency_overrides[get_broker] = lambda: broker
    app.dependency_overrides[get_registry] = lambda: registry
    # Force a deterministic principal for tests.
    app.dependency_overrides[get_principal] = lambda: "test@example.com"
    return app


@pytest.fixture
def client(app: Any) -> TestClient:
    return TestClient(app)
