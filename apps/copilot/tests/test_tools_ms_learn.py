"""Tests for :mod:`apps.copilot.tools.ms_learn` (CSA-0162).

The Microsoft Learn MCP search tool is exercised end-to-end against a
fake MCP client factory so the test never touches the real
``learn.microsoft.com`` endpoint. Coverage focuses on:

* Happy path: hits convert into :class:`RetrievedChunk` objects with
  the correct ``doc_type``, ``metadata`` payload, and reciprocal-rank
  ``similarity`` scores.
* ``top_k`` honours both the input value and the tool's ``max_results``
  cap (whichever is smaller wins).
* Timeouts surface as :class:`ToolInvocationError` rather than raw
  :class:`TimeoutError`.
* Schema variants returned by the MCP server (``results`` key, plain
  list, bare hit object) all parse to the same chunk shape.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

import pytest

from apps.copilot.tools.base import ToolInvocationError
from apps.copilot.tools.ms_learn import (
    SearchMicrosoftLearnInput,
    SearchMicrosoftLearnTool,
)

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeContentPart:
    """Stands in for an MCP ``TextContent`` part."""

    def __init__(self, text: str) -> None:
        self.text = text


class _FakeCallToolResult:
    """Minimal stand-in for the MCP SDK's ``CallToolResult`` shape."""

    def __init__(self, content: list[_FakeContentPart]) -> None:
        self.content = content


class _FakeSession:
    """Async client session that returns a preset payload."""

    def __init__(self, payload: Any, *, delay_seconds: float = 0.0) -> None:
        self._payload = payload
        self._delay = delay_seconds
        self.calls: list[dict[str, Any]] = []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> _FakeCallToolResult:
        self.calls.append({"name": name, "arguments": arguments})
        if self._delay:
            await asyncio.sleep(self._delay)
        return _FakeCallToolResult(
            content=[_FakeContentPart(text=json.dumps(self._payload))],
        )


def _factory(payload: Any, *, delay_seconds: float = 0.0):
    """Build a ``client_factory(url) -> async-context-manager`` for tests."""

    @asynccontextmanager
    async def _make(_url: str):
        yield _FakeSession(payload, delay_seconds=delay_seconds)

    return _make


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_returns_chunks_with_expected_metadata() -> None:
    payload = {
        "results": [
            {
                "title": "ADLS Gen2 lifecycle management",
                "content": "Use lifecycle management to transition blobs to cool / archive tiers...",
                "contentUrl": "https://learn.microsoft.com/azure/storage/blobs/lifecycle-management",
            },
            {
                "title": "Hierarchical namespace",
                "content": "ADLS Gen2 adds a hierarchical namespace on top of Blob storage...",
                "contentUrl": "https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-namespace",
            },
        ],
    }
    tool = SearchMicrosoftLearnTool(client_factory=_factory(payload), max_results=5)

    result = await tool(SearchMicrosoftLearnInput(query="adls gen2 lifecycle", top_k=5))

    assert len(result.chunks) == 2
    first, second = result.chunks
    assert first.doc_type == "external"
    assert first.metadata["source"] == "ms-learn"
    assert first.metadata["title"] == "ADLS Gen2 lifecycle management"
    assert first.metadata["url"].endswith("lifecycle-management")
    # Reciprocal rank scoring: rank 0 -> 1.0, rank 1 -> 0.5.
    assert first.similarity == pytest.approx(1.0)
    assert second.similarity == pytest.approx(0.5)
    # Chunk id is deterministic + filesystem-safe.
    assert first.id.startswith("ms-learn:0:")
    assert "/" not in first.id
    assert " " not in first.id


# ---------------------------------------------------------------------------
# Result-shape robustness
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handles_plain_list_response() -> None:
    payload = [
        {"title": "A", "content": "ax", "url": "https://learn.microsoft.com/a"},
        {"title": "B", "content": "bx", "url": "https://learn.microsoft.com/b"},
    ]
    tool = SearchMicrosoftLearnTool(client_factory=_factory(payload))
    result = await tool(SearchMicrosoftLearnInput(query="q"))
    assert [c.metadata["title"] for c in result.chunks] == ["A", "B"]


@pytest.mark.asyncio
async def test_handles_bare_single_hit_response() -> None:
    payload = {
        "title": "Solo",
        "content": "single result",
        "contentUrl": "https://learn.microsoft.com/solo",
    }
    tool = SearchMicrosoftLearnTool(client_factory=_factory(payload))
    result = await tool(SearchMicrosoftLearnInput(query="q"))
    assert len(result.chunks) == 1
    assert result.chunks[0].metadata["title"] == "Solo"


@pytest.mark.asyncio
async def test_empty_content_yields_empty_chunks() -> None:
    tool = SearchMicrosoftLearnTool(client_factory=_factory({}))
    result = await tool(SearchMicrosoftLearnInput(query="q"))
    assert result.chunks == []


# ---------------------------------------------------------------------------
# top_k and max_results caps
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_top_k_is_capped_by_max_results() -> None:
    payload = {
        "results": [
            {"title": f"hit-{i}", "content": "...", "contentUrl": f"https://learn.microsoft.com/{i}"}
            for i in range(10)
        ],
    }
    tool = SearchMicrosoftLearnTool(client_factory=_factory(payload), max_results=3)
    result = await tool(SearchMicrosoftLearnInput(query="q", top_k=8))
    assert len(result.chunks) == 3


@pytest.mark.asyncio
async def test_top_k_below_cap_wins() -> None:
    payload = {
        "results": [
            {"title": f"hit-{i}", "content": "...", "contentUrl": f"https://learn.microsoft.com/{i}"}
            for i in range(10)
        ],
    }
    tool = SearchMicrosoftLearnTool(client_factory=_factory(payload), max_results=10)
    result = await tool(SearchMicrosoftLearnInput(query="q", top_k=2))
    assert len(result.chunks) == 2


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_raises_tool_invocation_error() -> None:
    tool = SearchMicrosoftLearnTool(
        client_factory=_factory({"results": []}, delay_seconds=0.5),
        timeout_seconds=0.05,
    )
    with pytest.raises(ToolInvocationError) as excinfo:
        await tool(SearchMicrosoftLearnInput(query="anything"))
    assert "timed out" in str(excinfo.value).lower()
