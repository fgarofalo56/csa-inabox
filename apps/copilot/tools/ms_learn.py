"""Microsoft Learn MCP retrieval tool (CSA-0162).

This module defines :class:`SearchMicrosoftLearnTool`, a read-class
Copilot tool that supplements local AI Search retrieval with results
from Microsoft's hosted Learn MCP server (default endpoint:
``https://learn.microsoft.com/api/mcp``).

Design notes
------------

The csa-inabox corpus does not (and intentionally never will) duplicate
the full Microsoft Azure documentation. Users asking platform-level
questions ("how do I configure ADLS Gen2 lifecycle management?") still
expect grounded answers. This tool fills that gap by calling Microsoft's
official ``microsoft_docs_search`` MCP tool over Streamable HTTP and
converting each hit into a :class:`RetrievedChunk` carrying the source
URL as its citation.

Retrieval semantics:

* The tool is **read-class**, never side-effecting. No
  ``ConfirmationToken`` is required.
* Each hit is materialised into a chunk with ``doc_type = "external"``
  so the grounding policy can decide whether to count those chunks
  toward coverage. As of CSA-0162-phase-1 the existing grounding policy
  is unchanged — external chunks are returned to the agent for context
  but the *coverage gate* still requires ≥ ``min_grounded_chunks``
  local hits. Phase-2 will optionally relax that gate when external
  context is high quality (tracked separately).
* The MCP client is lazily constructed on first invocation and reused
  for the lifetime of the tool, avoiding TCP setup cost on each call.

Failure model:

* Network / transport failures raise :class:`ToolInvocationError`. The
  agent loop logs the failure and continues with whatever local chunks
  it already gathered — MS Learn is supplemental, not required.
* Schema mismatches (Microsoft changing the MCP response shape) are
  caught and surfaced as :class:`ToolInvocationError` rather than
  propagating raw ``KeyError`` / ``TypeError`` to the agent.
"""

from __future__ import annotations

import asyncio
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.models import RetrievedChunk
from apps.copilot.tools.base import ToolCategory, ToolInvocationError


class SearchMicrosoftLearnInput(BaseModel):
    """Input for :class:`SearchMicrosoftLearnTool`."""

    query: str = Field(
        min_length=1,
        description=(
            "Natural-language search string forwarded to the Microsoft "
            "Learn MCP server's microsoft_docs_search tool."
        ),
    )
    top_k: int = Field(
        default=5,
        ge=1,
        le=20,
        description=(
            "Maximum number of search hits to return. Capped by the "
            "ms_learn_max_results config to protect the prompt budget."
        ),
    )

    model_config = ConfigDict(frozen=True)


class SearchMicrosoftLearnOutput(BaseModel):
    """Output of :class:`SearchMicrosoftLearnTool`."""

    chunks: list[RetrievedChunk] = Field(
        default_factory=list,
        description=(
            "External-source chunks (doc_type='external') with content "
            "drawn from Microsoft Learn and citation URLs pointing back "
            "to the canonical docs page."
        ),
    )

    model_config = ConfigDict(frozen=True)


class SearchMicrosoftLearnTool:
    """Search Microsoft Learn via its MCP server, return grounded chunks.

    The tool wraps Microsoft's hosted Learn MCP service. It is
    intentionally narrow — only ``microsoft_docs_search`` is exposed.
    The other MCP-server tools (``microsoft_docs_fetch``,
    ``microsoft_code_sample_search``) can be added as sibling tools
    when the agent needs them.

    Parameters
    ----------
    mcp_url:
        Full URL of the MS Learn MCP endpoint. Defaults to the public
        Microsoft hosted endpoint when not provided.
    max_results:
        Hard cap on the number of chunks emitted per call, regardless
        of the requested ``top_k``. Protects the agent prompt from
        oversize external context.
    timeout_seconds:
        Per-request timeout in seconds.
    client_factory:
        Optional callable that produces an MCP client session. The
        default uses the official ``mcp.client.streamable_http`` module.
        Tests substitute a fake factory to avoid real network calls.
    """

    name: str = "search_microsoft_learn"
    category: ToolCategory = "read"
    description: str = (
        "Search the official Microsoft Learn documentation for Azure, "
        ".NET, M365, and related Microsoft platform topics. Use when "
        "the csa-inabox corpus does not cover the requested service "
        "or API. Returns citation-bearing chunks linking back to "
        "learn.microsoft.com."
    )
    input_model: type[SearchMicrosoftLearnInput] = SearchMicrosoftLearnInput
    output_model: type[SearchMicrosoftLearnOutput] = SearchMicrosoftLearnOutput

    def __init__(
        self,
        *,
        mcp_url: str = "https://learn.microsoft.com/api/mcp",
        max_results: int = 5,
        timeout_seconds: float = 20.0,
        client_factory: Any | None = None,
    ) -> None:
        self._mcp_url = mcp_url
        self._max_results = max_results
        self._timeout_seconds = timeout_seconds
        self._client_factory = client_factory

    async def __call__(
        self, input_value: SearchMicrosoftLearnInput
    ) -> SearchMicrosoftLearnOutput:
        cap = min(input_value.top_k, self._max_results)
        try:
            raw_hits = await asyncio.wait_for(
                self._call_mcp(input_value.query, cap),
                timeout=self._timeout_seconds,
            )
        except TimeoutError as exc:
            raise ToolInvocationError(
                f"Microsoft Learn MCP search timed out after "
                f"{self._timeout_seconds:.0f}s for query "
                f"{input_value.query!r}.",
            ) from exc
        except ToolInvocationError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            raise ToolInvocationError(
                f"Microsoft Learn MCP search failed: {type(exc).__name__}: {exc}",
            ) from exc

        chunks = [self._hit_to_chunk(hit, rank=i) for i, hit in enumerate(raw_hits[:cap])]
        return SearchMicrosoftLearnOutput(chunks=chunks)

    # -- internals -----------------------------------------------------------

    async def _call_mcp(self, query: str, top_k: int) -> list[dict[str, Any]]:
        """Invoke ``microsoft_docs_search`` on the MS Learn MCP server.

        Returns the raw list of hits (each a dict with keys like
        ``title``, ``content``, ``contentUrl``) as documented at
        https://learn.microsoft.com/api/mcp. Exact response shape is
        validated only loosely so transient Microsoft-side schema
        evolution surfaces as a content quality issue rather than an
        exception.
        """
        if self._client_factory is not None:
            client_cm = self._client_factory(self._mcp_url)
        else:
            client_cm = _default_mcp_client(self._mcp_url)

        async with client_cm as session:
            result = await session.call_tool(
                "microsoft_docs_search",
                arguments={"query": query},
            )

        hits = _extract_hits(result)
        return hits[:top_k]

    @staticmethod
    def _hit_to_chunk(hit: dict[str, Any], *, rank: int) -> RetrievedChunk:
        """Convert one MS Learn search hit into a :class:`RetrievedChunk`.

        We mark these chunks as ``doc_type="external"`` so the grounding
        policy can apply distinct rules (or downweight them) compared
        to local AI Search hits. The ``similarity`` is the reciprocal
        rank since the MCP response does not surface raw similarity
        scores. Title + URL are preserved in ``metadata`` so the
        citation surface can build a learn.microsoft.com link.
        """
        title = str(hit.get("title") or "Microsoft Learn result")
        text = str(hit.get("content") or hit.get("excerpt") or "").strip()
        url = str(hit.get("contentUrl") or hit.get("url") or "").strip()
        return RetrievedChunk(
            id=f"ms-learn:{rank}:{_safe_id_suffix(url or title)}",
            source_path=url or "https://learn.microsoft.com/",
            text=text,
            similarity=1.0 / (rank + 1),
            doc_type="external",
            metadata={"title": title, "url": url, "source": "ms-learn"},
        )


def _safe_id_suffix(value: str) -> str:
    """Build a deterministic, filesystem-safe id segment from a URL/title."""
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in value).strip("-")
    return cleaned[:80] or "result"


def _extract_hits(mcp_result: Any) -> list[dict[str, Any]]:
    """Best-effort extraction of search hits from an MCP CallToolResult.

    The MCP SDK surfaces tool output via ``result.content`` (a list of
    content parts). Microsoft's ``microsoft_docs_search`` returns its
    payload as a single JSON text part. We parse that and pull the
    ``results`` (or top-level list) out of it.
    """
    import json

    content = getattr(mcp_result, "content", None)
    if not content:
        return []

    for part in content:
        text = getattr(part, "text", None)
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, list):
            return [h for h in parsed if isinstance(h, dict)]
        if isinstance(parsed, dict):
            for key in ("results", "hits", "items"):
                values = parsed.get(key)
                if isinstance(values, list):
                    return [h for h in values if isinstance(h, dict)]
            # A dict that carries any of the recognized content fields is
            # treated as a single bare hit. An otherwise empty / unknown
            # dict means "no results".
            if any(k in parsed for k in ("title", "content", "excerpt", "contentUrl", "url")):
                return [parsed]
            return []

    return []


def _default_mcp_client(mcp_url: str) -> Any:
    """Construct the default MCP Streamable-HTTP client session manager.

    Returns an async context manager that yields an initialised
    :class:`mcp.ClientSession`. Tests substitute via ``client_factory``.
    """
    # Local import — the mcp package pulls in optional transport
    # dependencies that we don't want loaded at module import time.
    from contextlib import asynccontextmanager

    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    @asynccontextmanager
    async def _ctx() -> Any:
        async with (
            streamablehttp_client(mcp_url) as (read_stream, write_stream, _),
            ClientSession(read_stream, write_stream) as session,
        ):
            await session.initialize()
            yield session

    return _ctx()


__all__ = [
    "SearchMicrosoftLearnInput",
    "SearchMicrosoftLearnOutput",
    "SearchMicrosoftLearnTool",
]
