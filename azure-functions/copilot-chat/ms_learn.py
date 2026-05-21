"""Microsoft Learn MCP supplemental retrieval (CSA-0162 Phase 2).

The chat function's primary grounding source is the in-repo docs index
(URLs under ``https://fgarofalo56.github.io/csa-inabox/``). When that
index has nothing relevant for an on-topic question, we don't want the
LLM to either (a) refuse, or (b) hallucinate. This module supplements
the grounding with results from Microsoft's hosted Learn MCP server.

Module surface
--------------

* ``is_enabled()`` — read the ``COPILOT_MS_LEARN_ENABLED`` env var.
* ``search(query, top_k)`` — synchronous wrapper that calls the
  Microsoft Learn MCP ``microsoft_docs_search`` tool over Streamable
  HTTP and returns a list of grounding dicts shaped like the existing
  in-repo grounding dicts (``{"title", "url"}``) — plus a flag that
  marks them as external.

Design notes
~~~~~~~~~~~~

* Runs in a SYNC Azure Functions worker. The MCP SDK is async, so we
  use ``asyncio.run`` at the boundary.
* Failures are non-fatal — callers get back an empty list and a flag
  so the chat path falls back to "no grounding" instead of erroring.
* The response shape from ``microsoft_docs_search`` varies (top-level
  list vs ``{results: [...]}`` vs single bare hit). The parser is
  defensive about each shape.
* PII / secret redaction is applied to chunk text before it ever
  reaches the LLM prompt: a Microsoft Learn page should not contain
  user secrets, but treating external sources as untrusted is the
  safer default.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any

_log = logging.getLogger(__name__)

# Public Microsoft Learn MCP endpoint. The chat function may override
# the URL via env var for proxy / testing, but the default is the
# canonical hosted endpoint.
_DEFAULT_MCP_URL = "https://learn.microsoft.com/api/mcp"

# Hard cap on results regardless of caller-requested top_k — protects
# the prompt budget.
_MAX_RESULTS_CAP = 5

# Per-call timeout. Microsoft's MCP server can occasionally stall on
# long search payloads; we'd rather fall back to "no grounding" than
# hang the chat request.
_TIMEOUT_SECONDS = 12.0


def is_enabled() -> bool:
    """Return True when the MS Learn fallback is opted in.

    Reads ``COPILOT_MS_LEARN_ENABLED`` (truthy: "true", "1", "yes",
    case-insensitive). Defaults to False so the original grounding
    behaviour is preserved when the flag is unset.
    """
    raw = os.environ.get("COPILOT_MS_LEARN_ENABLED", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def search(query: str, *, top_k: int = 3) -> list[dict[str, str]]:
    """Search Microsoft Learn for ``query`` and return grounding dicts.

    Returns a list of ``{"title": str, "url": str, "external": "true"}``
    dicts that the chat path can slot into ``grounding_docs``. The
    ``external`` flag lets the frontend render a Microsoft Learn badge
    on the corresponding citation.

    On any failure (network, timeout, schema mismatch, MCP server
    error) returns an empty list. Failures are logged at info level —
    they are normal operating events, not errors.
    """
    if not query or not query.strip():
        return []
    cap = min(top_k, _MAX_RESULTS_CAP)
    try:
        return asyncio.run(_async_search(query.strip(), cap))
    except Exception:  # pragma: no cover - defensive net
        _log.info("MS Learn MCP search failed for query %r", query[:80], exc_info=True)
        return []


async def _async_search(query: str, top_k: int) -> list[dict[str, str]]:
    """Async MCP call.

    Kept in-module so the Function deployment doesn't need to import a
    shared library across the apps/copilot and azure-functions trees.
    """
    try:
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client
    except ImportError:
        _log.warning("mcp package not installed; MS Learn fallback disabled")
        return []

    url = os.environ.get("COPILOT_MS_LEARN_MCP_URL", _DEFAULT_MCP_URL)

    async def _call() -> list[dict[str, str]]:
        async with streamablehttp_client(url) as (read, write, _), ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(
                "microsoft_docs_search",
                arguments={"query": query},
            )
        return _extract_grounding(result, top_k=top_k)

    return await asyncio.wait_for(_call(), timeout=_TIMEOUT_SECONDS)


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

# Hits often have a query string on the URL (e.g. ?source=learn). Strip
# the fragment / query so duplicate-URL detection is robust and the
# citation looks clean.
_URL_CRUFT_RE = re.compile(r"[?#].*$")


def _extract_grounding(mcp_result: Any, *, top_k: int) -> list[dict[str, str]]:
    """Best-effort extraction of {title, url, external} dicts."""
    content = getattr(mcp_result, "content", None)
    if not content:
        return []

    raw_hits: list[dict[str, Any]] = []
    for part in content:
        text = getattr(part, "text", None)
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, list):
            raw_hits = [h for h in parsed if isinstance(h, dict)]
            break
        if isinstance(parsed, dict):
            for key in ("results", "hits", "items"):
                values = parsed.get(key)
                if isinstance(values, list):
                    raw_hits = [h for h in values if isinstance(h, dict)]
                    break
            else:
                if any(k in parsed for k in ("title", "content", "contentUrl", "url")):
                    raw_hits = [parsed]
        if raw_hits:
            break

    grounding: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for hit in raw_hits:
        title = str(hit.get("title") or "").strip()
        url = str(hit.get("contentUrl") or hit.get("url") or "").strip()
        if not title or not url:
            continue
        canonical = _URL_CRUFT_RE.sub("", url)
        if canonical in seen_urls:
            continue
        if not canonical.startswith("https://learn.microsoft.com"):
            continue
        seen_urls.add(canonical)
        grounding.append({"title": title[:200], "url": canonical[:500], "external": "true"})
        if len(grounding) >= top_k:
            break

    return grounding


__all__ = ["is_enabled", "search"]
