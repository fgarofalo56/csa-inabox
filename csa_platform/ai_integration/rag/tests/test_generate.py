"""Tests for :mod:`csa_platform.ai_integration.rag.generate`."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

from csa_platform.ai_integration.rag.generate import (
    SYSTEM_PROMPT,
    USER_PROMPT_TEMPLATE,
    build_prompt,
    generate_answer_async,
)
from csa_platform.ai_integration.rag.retriever import SearchResult


class TestBuildPrompt:
    def test_empty_results_produces_empty_sources(self) -> None:
        msg, sources = build_prompt("What is CSA?", [])
        assert sources == []
        assert "Question: What is CSA?" in msg

    def test_prompt_contains_source_markers(self) -> None:
        results = [
            SearchResult(id="r1", text="Alpha text.", score=0.9, source="docs/a.md"),
            SearchResult(id="r2", text="Beta text.", score=0.8, source="docs/b.md"),
        ]
        msg, sources = build_prompt("Explain.", results)
        assert "[Source: docs/a.md]" in msg
        assert "Alpha text." in msg
        assert "[Source: docs/b.md]" in msg
        assert "Beta text." in msg
        assert [s["id"] for s in sources] == ["r1", "r2"]
        assert sources[0]["score"] == 0.9

    def test_template_is_exported(self) -> None:
        assert "{context}" in USER_PROMPT_TEMPLATE
        assert "{question}" in USER_PROMPT_TEMPLATE
        assert "helpful assistant" in SYSTEM_PROMPT


class TestGenerateAnswerAsync:
    def _mock_client(self, content: str) -> MagicMock:
        choice = MagicMock()
        choice.message.content = content
        response = MagicMock()
        response.choices = [choice]
        client = MagicMock()
        client.chat.completions.create = AsyncMock(return_value=response)
        return client

    def test_returns_answer_text(self) -> None:
        client = self._mock_client("The answer is 42.")
        out = asyncio.run(
            generate_answer_async(
                client=client,
                deployment="gpt-4o",
                user_message="ctx + question",
            )
        )
        assert out == "The answer is 42."
        client.chat.completions.create.assert_awaited_once()
        _, kwargs = client.chat.completions.create.await_args
        assert kwargs["model"] == "gpt-4o"
        assert kwargs["messages"][0]["content"] == SYSTEM_PROMPT
        assert kwargs["messages"][1]["content"] == "ctx + question"

    def test_empty_content_returns_empty_string(self) -> None:
        client = self._mock_client("")
        out = asyncio.run(
            generate_answer_async(
                client=client,
                deployment="gpt-4o",
                user_message="x",
            )
        )
        assert out == ""

    def test_system_prompt_override(self) -> None:
        client = self._mock_client("ok")
        asyncio.run(
            generate_answer_async(
                client=client,
                deployment="gpt-4o",
                user_message="x",
                system_prompt="custom",
            )
        )
        _, kwargs = client.chat.completions.create.await_args
        assert kwargs["messages"][0]["content"] == "custom"
