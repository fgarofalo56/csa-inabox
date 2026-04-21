"""Server-Sent Events helpers for the Copilot API surface.

Every streaming endpoint returns ``text/event-stream`` with events
matching the SSE spec::

    event: <kind>
    data: <JSON payload>

The ``kind`` mirrors :class:`apps.copilot.models.AnswerChunk.kind`
(``status``, ``token``, ``citation``, ``done``) so clients can
multiplex on the event type without parsing the payload.

A heartbeat ``event: ping`` is emitted every ``heartbeat_seconds`` to
keep idle connections alive through proxies that cull silent streams.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from apps.copilot.models import AnswerChunk, AnswerResponse, Citation


def sse_format(*, event: str, data: object) -> bytes:
    """Serialise one SSE event to bytes."""
    payload: str
    if isinstance(data, (dict, list)):
        payload = json.dumps(data, separators=(",", ":"))
    elif isinstance(data, str):
        payload = data
    else:
        payload = json.dumps(data, default=str, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n".encode()


def _answer_chunk_to_event(chunk: AnswerChunk) -> bytes:
    """Render an :class:`AnswerChunk` to a formatted SSE event."""
    payload: object
    if isinstance(chunk.payload, (AnswerResponse, Citation)):
        payload = chunk.payload.model_dump(mode="json")
    else:
        payload = chunk.payload  # str
    return sse_format(event=chunk.kind, data=payload)


async def answer_chunks_to_sse(
    stream: AsyncIterator[AnswerChunk],
    *,
    heartbeat_seconds: float = 15.0,
) -> AsyncIterator[bytes]:
    """Adapt an :class:`AnswerChunk` async iterator to SSE bytes.

    The adapter wraps each received chunk in the SSE wire format and
    interleaves a ``ping`` event every *heartbeat_seconds* when the
    upstream iterator is idle.  The loop terminates either when the
    upstream iterator is exhausted or after a ``done`` event is
    forwarded — whichever comes first.
    """
    iterator = stream.__aiter__()
    pending: asyncio.Task[AnswerChunk] | None = None

    async def _next() -> AnswerChunk:
        return await iterator.__anext__()

    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(_next())
            done, _ = await asyncio.wait(
                {pending},
                timeout=heartbeat_seconds,
            )
            if pending in done:
                try:
                    chunk = pending.result()
                except StopAsyncIteration:
                    return
                pending = None
                yield _answer_chunk_to_event(chunk)
                if chunk.kind == "done":
                    return
            else:
                # heartbeat — keeps connections warm through proxies.
                yield sse_format(event="ping", data={"ts": "heartbeat"})
    finally:
        if pending is not None and not pending.done():
            pending.cancel()
            import contextlib

            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration, Exception):
                await pending


__all__ = [
    "answer_chunks_to_sse",
    "sse_format",
]
