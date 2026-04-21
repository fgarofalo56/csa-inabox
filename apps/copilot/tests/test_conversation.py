"""Tests for multi-turn conversation state (post-Phase-1 Gap 4).

Covers :mod:`apps.copilot.conversation` directly (store + summarizer +
state trimming) and :class:`CopilotAgent` multi-turn methods
(``start_conversation``, ``ask_in_conversation``, ``reset_conversation``).

No Redis is installed in the test environment — the Redis backend
branch is only exercised via its factory error path, not a live
connection.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from apps.copilot.agent import CopilotAgent, GenerationResult
from apps.copilot.config import CopilotSettings
from apps.copilot.conversation import (
    ConversationNotFoundError,
    ConversationState,
    ConversationSummarizer,
    CosmosConversationStore,
    InMemoryConversationStore,
    approx_token_count,
    build_conversation_store,
)
from apps.copilot.models import (
    AnswerResponse,
    ConversationHandle,
    ConversationTurn,
)
from csa_platform.ai_integration.rag.pipeline import SearchResult

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------


class StubEmbedder:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [[0.1] * 4 for _ in texts]


class StubRetriever:
    def __init__(self, results: list[SearchResult]) -> None:
        self._results = results
        self.calls: list[str] = []

    async def search_async(
        self,
        query_vector: list[float],  # noqa: ARG002
        query_text: str = "",
        top_k: int = 5,  # noqa: ARG002
        score_threshold: float = 0.0,  # noqa: ARG002
        filters: str | None = None,  # noqa: ARG002
        use_semantic_reranker: bool = False,  # noqa: ARG002
    ) -> list[SearchResult]:
        self.calls.append(query_text)
        return list(self._results)


class StubLLM:
    def __init__(self, outputs: list[GenerationResult]) -> None:
        self._outputs = list(outputs)
        self.prompts: list[str] = []

    async def generate(self, prompt: str) -> GenerationResult:
        self.prompts.append(prompt)
        if not self._outputs:
            raise RuntimeError("StubLLM exhausted")
        return self._outputs.pop(0)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _result(cid: str, score: float, text: str = "Evidence.") -> SearchResult:
    return SearchResult(
        id=cid,
        text=text,
        score=score,
        source="docs/ARCHITECTURE.md",
        metadata={"source_path": "docs/ARCHITECTURE.md", "doc_type": "overview"},
    )


@pytest.fixture
def settings() -> CopilotSettings:
    return CopilotSettings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="fake-key",
        azure_search_endpoint="https://fake.search.windows.net",
        azure_search_api_key="fake-key",
        min_grounding_similarity=0.45,
        min_grounded_chunks=1,
        top_k=3,
        max_citation_verification_retries=0,
        conversation_max_turns=4,
        conversation_max_history_tokens=200,
    )


# ---------------------------------------------------------------------------
# approx_token_count + Summarizer
# ---------------------------------------------------------------------------


class TestApproxTokenCount:
    def test_empty_string_is_zero(self) -> None:
        assert approx_token_count("") == 0

    def test_short_string_is_at_least_one(self) -> None:
        assert approx_token_count("hi") == 1

    def test_longer_strings_are_proportional(self) -> None:
        short = approx_token_count("abcd")
        long = approx_token_count("abcd" * 10)
        assert long >= short * 5


class TestConversationSummarizer:
    def test_empty_state_returns_empty_string(self) -> None:
        summarizer = ConversationSummarizer(max_history_tokens=100)
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        assert summarizer.condense(state) == ""

    def test_condenses_turns_as_qa_transcript(self) -> None:
        summarizer = ConversationSummarizer(max_history_tokens=1000)
        turn = ConversationTurn(
            turn_index=0,
            question="What is Bicep?",
            answer="Azure's IaC DSL.",
            approx_tokens=10,
        )
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[turn],
        )
        text = summarizer.condense(state)
        assert "Q (turn 0): What is Bicep?" in text
        assert "A: Azure's IaC DSL." in text

    def test_refused_turns_are_labelled(self) -> None:
        summarizer = ConversationSummarizer(max_history_tokens=1000)
        turn = ConversationTurn(
            turn_index=0,
            question="tell me a joke",
            answer="(refusal message)",
            refused=True,
            refusal_reason="no_coverage",
            approx_tokens=5,
        )
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[turn],
        )
        text = summarizer.condense(state)
        assert "REFUSED:" in text

    def test_trims_oldest_when_budget_exceeded(self) -> None:
        summarizer = ConversationSummarizer(max_history_tokens=10)
        turns = [
            ConversationTurn(
                turn_index=i,
                question=f"question {i}",
                answer=f"answer {i}",
                approx_tokens=50,
            )
            for i in range(3)
        ]
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=turns,
        )
        text = summarizer.condense(state)
        # Newest turn must be preserved.
        assert "question 2" in text
        # Oldest dropped first.
        assert "question 0" not in text


# ---------------------------------------------------------------------------
# InMemoryConversationStore
# ---------------------------------------------------------------------------


class TestInMemoryStore:
    @pytest.mark.asyncio
    async def test_set_and_get_roundtrip(self) -> None:
        store = InMemoryConversationStore()
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await store.set(state, ttl_seconds=60)
        got = await store.get("c1")
        assert got is not None
        assert got.conversation_id == "c1"

    @pytest.mark.asyncio
    async def test_missing_id_returns_none(self) -> None:
        store = InMemoryConversationStore()
        assert await store.get("nope") is None

    @pytest.mark.asyncio
    async def test_delete_is_idempotent(self) -> None:
        store = InMemoryConversationStore()
        await store.delete("never-existed")  # does not raise
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await store.set(state, ttl_seconds=60)
        await store.delete("c1")
        assert await store.get("c1") is None

    @pytest.mark.asyncio
    async def test_ttl_expires_record(self) -> None:
        store = InMemoryConversationStore()
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await store.set(state, ttl_seconds=0)
        # TTL of 0 means already expired from the store's perspective.
        # InMemory uses now + 0s = now; get() sees expires <= now → None.
        assert await store.get("c1") is None


# ---------------------------------------------------------------------------
# ConversationState.with_turn_appended
# ---------------------------------------------------------------------------


class TestStateAppend:
    def test_appends_turn(self) -> None:
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        turn = ConversationTurn(
            turn_index=0,
            question="q",
            answer="a",
            approx_tokens=10,
        )
        new_state = state.with_turn_appended(
            turn,
            max_turns=8,
            max_history_tokens=1000,
        )
        assert len(new_state.turns) == 1
        assert new_state.turns[0].question == "q"

    def test_max_turns_drops_oldest(self) -> None:
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[
                ConversationTurn(turn_index=i, question=f"q{i}", answer="a", approx_tokens=5)
                for i in range(3)
            ],
        )
        new_turn = ConversationTurn(turn_index=3, question="q3", answer="a", approx_tokens=5)
        updated = state.with_turn_appended(
            new_turn,
            max_turns=2,
            max_history_tokens=1000,
        )
        assert len(updated.turns) == 2
        assert updated.turns[0].question == "q2"
        assert updated.turns[1].question == "q3"

    def test_token_budget_drops_oldest(self) -> None:
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[
                ConversationTurn(turn_index=0, question="q0", answer="a", approx_tokens=100),
                ConversationTurn(turn_index=1, question="q1", answer="a", approx_tokens=100),
            ],
        )
        new_turn = ConversationTurn(turn_index=2, question="q2", answer="a", approx_tokens=100)
        updated = state.with_turn_appended(
            new_turn,
            max_turns=10,
            max_history_tokens=150,
        )
        # Newest must be preserved; oldest dropped until budget fits.
        assert updated.turns[-1].question == "q2"
        assert sum(t.approx_tokens for t in updated.turns) <= 150


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


class TestStoreFactory:
    def test_memory_backend(self) -> None:
        settings = CopilotSettings(conversation_store="memory")
        store = build_conversation_store(settings)
        assert isinstance(store, InMemoryConversationStore)

    def test_redis_backend_requires_url(self) -> None:
        settings = CopilotSettings(
            conversation_store="redis",
            conversation_redis_url="",
        )
        with pytest.raises(RuntimeError, match="conversation_redis_url"):
            build_conversation_store(settings)

    def test_cosmos_backend_requires_endpoint(self) -> None:
        settings = CopilotSettings(
            conversation_store="cosmos",
            conversation_cosmos_endpoint="",
        )
        with pytest.raises(RuntimeError, match="conversation_cosmos_endpoint"):
            build_conversation_store(settings)

    def test_cosmos_backend_builds_store(self) -> None:
        settings = CopilotSettings(
            conversation_store="cosmos",
            conversation_cosmos_endpoint="https://fake.documents.azure.com:443/",
            conversation_cosmos_database="copilot",
            conversation_cosmos_container="conversations",
        )
        store = build_conversation_store(settings)
        assert isinstance(store, CosmosConversationStore)


# ---------------------------------------------------------------------------
# CosmosConversationStore (CSA-0116) — mocked async client end-to-end
# ---------------------------------------------------------------------------


# Stand-in for ``azure.cosmos.exceptions.CosmosResourceNotFoundError`` —
# the production guard matches on class name + status_code, so a local
# exception type with the same name and a status_code attribute is
# sufficient to exercise the "missing item" branch.
CosmosResourceNotFoundError = type(
    "CosmosResourceNotFoundError",
    (Exception,),
    {"status_code": 404},
)


class _FakeCosmosContainer:
    """Minimal async stand-in for a Cosmos container client."""

    def __init__(self) -> None:
        from unittest.mock import AsyncMock

        self._items: dict[str, dict[str, object]] = {}
        self.read_item = AsyncMock(side_effect=self._read)
        self.upsert_item = AsyncMock(side_effect=self._upsert)
        self.delete_item = AsyncMock(side_effect=self._delete)

    async def _read(self, *, item: str, partition_key: str) -> dict[str, object]:
        assert item == partition_key
        if item not in self._items:
            raise CosmosResourceNotFoundError("not found")
        return dict(self._items[item])

    async def _upsert(self, document: dict[str, object]) -> None:
        self._items[str(document["id"])] = document

    async def _delete(self, *, item: str, partition_key: str) -> None:
        assert item == partition_key
        if item not in self._items:
            raise CosmosResourceNotFoundError("not found")
        self._items.pop(item, None)


class _FakeCosmosDatabase:
    def __init__(self, container: _FakeCosmosContainer) -> None:
        self._container = container

    def get_container_client(self, _name: str) -> _FakeCosmosContainer:
        return self._container


class _FakeCosmosClient:
    def __init__(self, container: _FakeCosmosContainer) -> None:
        self._database = _FakeCosmosDatabase(container)
        self.closed = False

    def get_database_client(self, _name: str) -> _FakeCosmosDatabase:
        return self._database

    async def close(self) -> None:
        self.closed = True


class TestCosmosConversationStore:
    def _store_with_fake_client(
        self,
    ) -> tuple[CosmosConversationStore, _FakeCosmosContainer]:
        container = _FakeCosmosContainer()
        client = _FakeCosmosClient(container)
        store = CosmosConversationStore(
            endpoint="https://fake.documents.azure.com:443/",
            database_name="copilot",
            container_name="conversations",
            client=client,
        )
        return store, container

    def test_rejects_empty_endpoint(self) -> None:
        with pytest.raises(RuntimeError, match="endpoint"):
            CosmosConversationStore(
                endpoint="",
                database_name="copilot",
                container_name="conversations",
            )

    @pytest.mark.asyncio
    async def test_set_get_roundtrip(self) -> None:
        store, container = self._store_with_fake_client()
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await store.set(state, ttl_seconds=600)

        # Upsert called with the right shape.
        container.upsert_item.assert_awaited_once()
        await_args = container.upsert_item.await_args
        assert await_args is not None
        payload = await_args.args[0]
        assert payload["id"] == "c1"
        assert payload["ttl"] == 600
        assert payload["state"]["conversation_id"] == "c1"

        fetched = await store.get("c1")
        assert fetched is not None
        assert fetched.conversation_id == "c1"

    @pytest.mark.asyncio
    async def test_get_missing_returns_none(self) -> None:
        store, _container = self._store_with_fake_client()
        assert await store.get("does-not-exist") is None

    @pytest.mark.asyncio
    async def test_delete_roundtrip(self) -> None:
        store, container = self._store_with_fake_client()
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await store.set(state, ttl_seconds=60)
        await store.delete("c1")
        container.delete_item.assert_awaited_once()
        assert await store.get("c1") is None

    @pytest.mark.asyncio
    async def test_delete_missing_is_idempotent(self) -> None:
        store, _container = self._store_with_fake_client()
        # Should not raise even though nothing is there.
        await store.delete("missing")

    @pytest.mark.asyncio
    async def test_set_includes_ttl_from_caller(self) -> None:
        store, container = self._store_with_fake_client()
        state = ConversationState(
            conversation_id="c1",
            created_at=datetime.now(timezone.utc),
            turns=[],
        )
        await store.set(state, ttl_seconds=123)
        await_args = container.upsert_item.await_args
        assert await_args is not None
        payload = await_args.args[0]
        assert payload["ttl"] == 123

    @pytest.mark.asyncio
    async def test_get_returns_state_with_turns(self) -> None:
        store, _container = self._store_with_fake_client()
        turn = ConversationTurn(
            turn_index=0,
            question="q",
            answer="a",
            approx_tokens=5,
        )
        state = ConversationState(
            conversation_id="c2",
            created_at=datetime.now(timezone.utc),
            turns=[turn],
        )
        await store.set(state, ttl_seconds=60)
        got = await store.get("c2")
        assert got is not None
        assert len(got.turns) == 1
        assert got.turns[0].question == "q"


# ---------------------------------------------------------------------------
# CopilotAgent multi-turn
# ---------------------------------------------------------------------------


def _make_agent(
    settings: CopilotSettings,
    retrieved: list[SearchResult],
    outputs: list[GenerationResult],
) -> tuple[CopilotAgent, StubRetriever, StubLLM, StubEmbedder]:
    retriever = StubRetriever(retrieved)
    llm = StubLLM(outputs)
    embedder = StubEmbedder()
    agent = CopilotAgent(
        settings=settings,
        retriever=retriever,
        embedder=embedder,
        llm=llm,
    )
    return agent, retriever, llm, embedder


class TestAgentMultiTurn:
    @pytest.mark.asyncio
    async def test_start_conversation_returns_unique_handle(
        self,
        settings: CopilotSettings,
    ) -> None:
        agent, *_ = _make_agent(settings, [], [])
        h1 = await agent.start_conversation()
        h2 = await agent.start_conversation()
        assert isinstance(h1, ConversationHandle)
        assert h1.conversation_id != h2.conversation_id

    @pytest.mark.asyncio
    async def test_ask_in_conversation_persists_turn(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9)]
        outputs = [
            GenerationResult(answer="First answer [1].", citations=[1]),
            GenerationResult(answer="Second answer [1].", citations=[1]),
        ]
        agent, _retriever, _llm, _embedder = _make_agent(settings, retrieved, outputs)

        handle = await agent.start_conversation()
        r1 = await agent.ask_in_conversation(handle, "first question")
        r2 = await agent.ask_in_conversation(handle, "second question")

        assert isinstance(r1, AnswerResponse)
        assert not r1.refused
        assert isinstance(r2, AnswerResponse)
        assert not r2.refused

        state = await agent.conversation_store.get(handle.conversation_id)
        assert state is not None
        assert len(state.turns) == 2
        assert state.turns[0].question == "first question"
        assert state.turns[1].question == "second question"

    @pytest.mark.asyncio
    async def test_second_turn_receives_prior_context_in_retrieval(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9)]
        outputs = [
            GenerationResult(answer="First [1].", citations=[1]),
            GenerationResult(answer="Second [1].", citations=[1]),
        ]
        agent, retriever, _llm, _embedder = _make_agent(settings, retrieved, outputs)

        handle = await agent.start_conversation()
        await agent.ask_in_conversation(handle, "what is bicep?")
        await agent.ask_in_conversation(handle, "how does it differ from arm?")

        # First turn's query_text has no prior context.
        assert "what is bicep?" in retriever.calls[0]
        assert "Q (turn" not in retriever.calls[0]
        # Second turn's query_text includes the condensed prior turn.
        assert "how does it differ from arm?" in retriever.calls[1]
        assert "Q (turn 0):" in retriever.calls[1]
        assert "what is bicep?" in retriever.calls[1]

    @pytest.mark.asyncio
    async def test_unknown_handle_raises_typed_error(
        self,
        settings: CopilotSettings,
    ) -> None:
        agent, *_ = _make_agent(settings, [], [])
        bogus = ConversationHandle(conversation_id="not-a-real-id")
        with pytest.raises(ConversationNotFoundError):
            await agent.ask_in_conversation(bogus, "question?")

    @pytest.mark.asyncio
    async def test_reset_conversation_drops_history(
        self,
        settings: CopilotSettings,
    ) -> None:
        retrieved = [_result("c1", 0.9)]
        outputs = [
            GenerationResult(answer="First [1].", citations=[1]),
        ]
        agent, *_ = _make_agent(settings, retrieved, outputs)

        handle = await agent.start_conversation()
        await agent.ask_in_conversation(handle, "q1")
        await agent.reset_conversation(handle)

        state = await agent.conversation_store.get(handle.conversation_id)
        assert state is None

    @pytest.mark.asyncio
    async def test_max_turns_trims_oldest_history(
        self,
        settings: CopilotSettings,
    ) -> None:
        # settings fixture sets max_turns=4.
        retrieved = [_result("c1", 0.9)]
        outputs = [
            GenerationResult(answer=f"Answer [{i}].", citations=[1])
            for i in range(6)
        ]
        # The citations all say [1] which matches retrieved c1 by index 1.
        outputs = [GenerationResult(answer="Answer [1].", citations=[1]) for _ in range(6)]
        agent, *_ = _make_agent(settings, retrieved, outputs)

        handle = await agent.start_conversation()
        for i in range(6):
            await agent.ask_in_conversation(handle, f"question {i}")

        state = await agent.conversation_store.get(handle.conversation_id)
        assert state is not None
        assert len(state.turns) <= 4
        # Oldest should be gone.
        questions = [t.question for t in state.turns]
        assert "question 0" not in questions
        assert "question 5" in questions

    @pytest.mark.asyncio
    async def test_refusal_turn_still_recorded(
        self,
        settings: CopilotSettings,
    ) -> None:
        # No retrieved chunks → refusal path.
        agent, *_ = _make_agent(settings, [], [])
        handle = await agent.start_conversation()
        response = await agent.ask_in_conversation(handle, "question?")
        assert response.refused
        assert response.refusal_reason == "no_coverage"

        state = await agent.conversation_store.get(handle.conversation_id)
        assert state is not None
        assert len(state.turns) == 1
        assert state.turns[0].refused is True
        assert state.turns[0].refusal_reason == "no_coverage"


def test_conversation_state_is_frozen() -> None:
    """State mutation must be blocked by Pydantic frozen config."""
    state = ConversationState(
        conversation_id="c1",
        created_at=datetime.now(timezone.utc),
        turns=[],
    )
    with pytest.raises((TypeError, ValueError)):
        state.conversation_id = "mutated"


def test_conversation_handle_is_frozen() -> None:
    handle = ConversationHandle(conversation_id="c1")
    with pytest.raises((TypeError, ValueError)):
        handle.conversation_id = "mutated"
