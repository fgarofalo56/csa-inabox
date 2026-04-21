"""Tests for the SSE adapter."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest

from apps.copilot.models import AnswerChunk, AnswerResponse, Citation
from apps.copilot.surfaces.api.sse import (
    _answer_chunk_to_event,
    answer_chunks_to_sse,
    sse_format,
)


def test_sse_format_handles_dict() -> None:
    """Dicts are JSON-encoded compactly."""
    raw = sse_format(event="status", data={"a": 1})
    assert raw == b'event: status\ndata: {"a":1}\n\n'


def test_sse_format_handles_string() -> None:
    """Strings are emitted verbatim."""
    raw = sse_format(event="token", data="hello")
    assert raw == b"event: token\ndata: hello\n\n"


def test_answer_chunk_to_event_renders_response() -> None:
    """Terminal ``done`` events carry the full AnswerResponse JSON."""
    response = AnswerResponse(
        question="q",
        answer="a",
        citations=[],
        groundedness=1.0,
        refused=False,
    )
    chunk = AnswerChunk(kind="done", payload=response)
    raw = _answer_chunk_to_event(chunk)
    event_line, data_line, _ = raw.decode("utf-8").split("\n", 2)
    assert event_line == "event: done"
    payload = json.loads(data_line.removeprefix("data: "))
    assert payload["answer"] == "a"


def test_answer_chunk_to_event_renders_citation() -> None:
    """Citation events carry the citation dump."""
    citation = Citation(
        id=1,
        source_path="docs/foo.md",
        excerpt="x",
        similarity=0.5,
        chunk_id="c",
    )
    chunk = AnswerChunk(kind="citation", payload=citation)
    raw = _answer_chunk_to_event(chunk)
    assert b"event: citation" in raw


async def _make_stream(chunks: list[AnswerChunk]) -> AsyncIterator[AnswerChunk]:
    for chunk in chunks:
        yield chunk


@pytest.mark.asyncio
async def test_answer_chunks_to_sse_emits_done_and_stops() -> None:
    """The SSE adapter terminates after forwarding a done event."""
    final = AnswerResponse(
        question="q",
        answer="a",
        citations=[],
        groundedness=1.0,
        refused=False,
    )
    stream = _make_stream(
        [
            AnswerChunk(kind="status", payload="retrieve-start"),
            AnswerChunk(kind="token", payload="he"),
            AnswerChunk(kind="token", payload="llo"),
            AnswerChunk(kind="done", payload=final),
        ],
    )
    events = [event async for event in answer_chunks_to_sse(stream, heartbeat_seconds=5.0)]
    joined = b"".join(events).decode("utf-8")
    assert "event: status" in joined
    assert "event: token" in joined
    assert "event: done" in joined
    # The adapter must not keep emitting after done.
    assert joined.count("event: done") == 1
