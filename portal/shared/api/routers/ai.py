"""AI service endpoints — RAG chat, embeddings, semantic search.

These endpoints expose the AI integration layer
(``csa_platform.ai_integration.rag``) as REST APIs, enabling
consumption through APIM and the portal frontend.

Wiring policy
-------------
Each handler attempts to instantiate :class:`RAGService` from
environment-driven settings (see ``csa_platform.ai_integration.rag.config``).

* If construction succeeds (Azure OpenAI + AI Search settings present
  and importable), the request is delegated to the real service.
* If construction fails for any reason — missing optional dependency,
  unset env var, network error — the handler falls back to a clearly
  labelled **demo response** with ``model="demo-stub"`` so the caller
  can tell at a glance that the platform is not configured. The
  fallback exists so the portal stays runnable in local-only / docs
  builds; it is never silent.

This replaces the previous hard-coded fakes (which carried
``TODO(prod)`` markers and shipped misleading source URLs).

Endpoints
---------
POST   /api/v1/ai/chat      — RAG-powered conversational AI
POST   /api/v1/ai/embed     — generate text embeddings
POST   /api/v1/ai/search    — semantic search across indexed data products
GET    /api/v1/ai/status    — AI services health check
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException

from ..models.ai import (
    AIServiceStatus,
    ChatRequest,
    ChatResponse,
    EmbedRequest,
    EmbedResponse,
    SearchRequest,
    SearchResponse,
    SearchResult,
    SourceReference,
    TokenUsage,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ── AI_MODE control (W-C3) ───────────────────────────────────────────────────
#
# AI_MODE gates whether the demo-stub fallback is allowed:
#   * disabled — AI endpoints are turned off; every call returns an honest 503.
#   * demo     — (default) the labelled demo-stub fallback is served when the
#                real stack isn't configured (keeps local/docs builds runnable).
#   * live     — the real stack is REQUIRED; if it isn't configured, endpoints
#                return an honest 503 naming the missing deps — NEVER a silent
#                demo response. This is what a production profile sets so it can
#                never masquerade as configured.

import os  # noqa: E402  (grouped with the mode helpers for locality)

_VALID_AI_MODES = ("disabled", "demo", "live")

# Required settings per dependency, keyed to the exact env vars (rag/config.py
# prefixes: AZURE_OPENAI_* / AZURE_SEARCH_*). endpoint + a deployment/index are
# the load-bearing indicators; api_key is omitted because AAD auth is supported.
_AI_DEPENDENCIES: dict[str, list[str]] = {
    "azure_openai": ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_CHAT_DEPLOYMENT", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"],
    "azure_search": ["AZURE_SEARCH_ENDPOINT", "AZURE_SEARCH_INDEX_NAME"],
}

_DEP_REMEDIATION = {
    "azure_openai": "Provision Azure OpenAI + set its endpoint and the chat/embedding deployment names.",
    "azure_search": "Provision Azure AI Search + set its endpoint and the index name.",
}


def ai_mode() -> str:
    """Resolve AI_MODE (disabled | demo | live), defaulting to ``demo``."""
    raw = (os.environ.get("AI_MODE") or "demo").strip().lower()
    return raw if raw in _VALID_AI_MODES else "demo"


def _dependency_readiness() -> list[dict[str, Any]]:
    """Per-dependency readiness from the current env (no remote probe)."""
    out: list[dict[str, Any]] = []
    for name, required in _AI_DEPENDENCIES.items():
        missing = [v for v in required if not (os.environ.get(v) or "").strip()]
        out.append(
            {
                "name": name,
                "configured": not missing,
                "missing": missing,
                "detail": "" if not missing else _DEP_REMEDIATION.get(name, f"Set {', '.join(missing)}."),
            }
        )
    return out


def _readiness_reasons(deps: list[dict[str, Any]]) -> list[str]:
    return [
        f"{d['name']}: missing {', '.join(d['missing'])}"
        for d in deps
        if not d["configured"]
    ]


def _live_unavailable_error() -> HTTPException:
    """503 for AI_MODE=live when the real stack isn't configured — honest gate,
    per-dependency reasons, never a silent demo response."""
    deps = _dependency_readiness()
    reasons = _readiness_reasons(deps)
    return HTTPException(
        status_code=503,
        detail={
            "code": "ai_not_configured",
            "mode": "live",
            "message": (
                "AI_MODE=live but the AI stack is not configured. Configure the "
                "missing dependencies below (or set AI_MODE=demo for a labelled "
                "demo response). The service will NOT return a demo-stub in live mode."
            ),
            "dependencies": deps,
            "reasons": reasons,
        },
    )


def _guard_mode() -> None:
    """Raise 503 when AI_MODE=disabled — called at the top of each endpoint."""
    if ai_mode() == "disabled":
        raise HTTPException(
            status_code=503,
            detail={
                "code": "ai_disabled",
                "mode": "disabled",
                "message": "AI endpoints are disabled in this deployment (AI_MODE=disabled). Set AI_MODE=demo or live to enable.",
            },
        )


# ── Service factory ─────────────────────────────────────────────────────────


def _try_get_rag_service() -> Any | None:
    """Return a configured :class:`RAGService` or ``None``.

    Failures (missing dependency, unset env var, missing SDK creds) are
    logged at INFO level — they are *expected* in local/dev environments
    where the portal runs without Azure connectivity. We never raise
    from this helper; callers fall back to the demo response path.
    """
    try:
        # Imported lazily so the portal can boot without the AI extras.
        from csa_platform.ai_integration.rag.service import RAGService  # type: ignore

        return RAGService.from_settings()
    except Exception as exc:  # pragma: no cover - depends on environment
        logger.info(
            "ai_router.rag_service_unavailable",
            extra={"reason": type(exc).__name__, "detail": str(exc)},
        )
        return None


def _try_get_embedder() -> Any | None:
    """Return a configured embedder, or ``None`` for demo fallback."""
    try:
        from csa_platform.ai_integration.rag.config import get_settings  # type: ignore
        from csa_platform.ai_integration.rag.indexer import (  # type: ignore
            EmbeddingGenerator,
        )

        settings = get_settings()
        return EmbeddingGenerator(settings=settings.azure_openai)
    except Exception as exc:  # pragma: no cover
        logger.info(
            "ai_router.embedder_unavailable",
            extra={"reason": type(exc).__name__, "detail": str(exc)},
        )
        return None


# ── Endpoints ───────────────────────────────────────────────────────────────


@router.post(
    "/chat",
    response_model=ChatResponse,
    status_code=200,
    summary="RAG-powered chat",
)
async def chat(request: ChatRequest) -> ChatResponse:
    """RAG-powered conversational AI.

    Delegates to :meth:`RAGService.query` when configured. Returns a
    clearly labelled demo response (``model="demo-stub"``) when the
    AI stack is not configured — this makes local dev painless without
    misleading consumers about whether the platform is wired up.
    """
    _guard_mode()
    start = time.perf_counter()
    service = _try_get_rag_service()

    if service is None:
        # AI_MODE=live must NEVER silently serve a demo response — honest 503.
        if ai_mode() == "live":
            raise _live_unavailable_error()
        latency = (time.perf_counter() - start) * 1000
        return ChatResponse(
            answer=(
                "[demo-stub] The portal AI stack is not configured in this "
                "environment. Configure RAG settings (see "
                "csa_platform.ai_integration.rag.config.RAGSettings and "
                ".env.example) to enable real responses. "
                f"Echoed query: {request.query}"
            ),
            sources=[],
            model="demo-stub",
            usage=TokenUsage(prompt_tokens=0, completion_tokens=0, total_tokens=0),
            latency_ms=round(latency, 2),
        )

    try:
        async with service as svc:  # uses RAGService.__aenter__
            answer_response = await svc.query(
                question=request.query,
                k=request.max_results,
                system_prompt=request.system_prompt,
            )
        sources = [
            SourceReference(
                title=getattr(c, "source", "unknown"),
                url=(c.metadata or {}).get("url") if hasattr(c, "metadata") else None,
                chunk=(getattr(c, "metadata", {}) or {}).get("snippet", "")[:500]
                or getattr(c, "source", ""),
                score=float(min(max(getattr(c, "score", 0.0), 0.0), 1.0)),
            )
            for c in (answer_response.sources or [])
        ]
        usage_obj = getattr(answer_response, "usage", None)
        usage = TokenUsage(
            prompt_tokens=int(getattr(usage_obj, "prompt_tokens", 0) or 0),
            completion_tokens=int(getattr(usage_obj, "completion_tokens", 0) or 0),
            total_tokens=int(getattr(usage_obj, "total_tokens", 0) or 0),
        )
        latency = (time.perf_counter() - start) * 1000
        return ChatResponse(
            answer=answer_response.answer,
            sources=sources,
            model=getattr(answer_response, "model", "azure-openai"),
            usage=usage,
            latency_ms=round(latency, 2),
        )
    except Exception as exc:
        logger.exception("Chat endpoint failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/embed",
    response_model=EmbedResponse,
    summary="Generate text embeddings",
)
async def embed_texts(request: EmbedRequest) -> EmbedResponse:
    """Generate text embeddings using Azure OpenAI.

    Delegates to ``EmbeddingGenerator.embed_texts_async`` when configured.
    Falls back to zero-vector placeholders (with ``model="demo-stub"``) if
    the embedder cannot be constructed in the current environment.
    """
    _guard_mode()
    embedder = _try_get_embedder()

    if embedder is None:
        if ai_mode() == "live":
            raise _live_unavailable_error()
        dims = 1536
        embeddings = [[0.0] * dims for _ in request.texts]
        return EmbedResponse(
            embeddings=embeddings,
            model="demo-stub",
            dimensions=dims,
            usage=TokenUsage(prompt_tokens=0, completion_tokens=0, total_tokens=0),
        )

    try:
        # Prefer async if available; fall back to sync.
        if hasattr(embedder, "embed_texts_async"):
            vectors = await embedder.embed_texts_async(request.texts)
        else:
            vectors = embedder.embed_texts(request.texts)
        dims = len(vectors[0]) if vectors and vectors[0] else 0
        token_count = sum(len(t.split()) for t in request.texts)
        return EmbedResponse(
            embeddings=vectors,
            model=request.model,
            dimensions=dims,
            usage=TokenUsage(
                prompt_tokens=token_count,
                completion_tokens=0,
                total_tokens=token_count,
            ),
        )
    except Exception as exc:
        logger.exception("Embed endpoint failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post(
    "/search",
    response_model=SearchResponse,
    summary="Semantic search",
)
async def semantic_search(request: SearchRequest) -> SearchResponse:
    """Semantic search across indexed data products.

    Embeds the query, then delegates to the configured retriever.
    Falls back to an empty result set with ``query`` echoed and a
    log line at INFO level if the AI stack is not configured.
    """
    _guard_mode()
    start = time.perf_counter()
    service = _try_get_rag_service()

    if service is None:
        if ai_mode() == "live":
            raise _live_unavailable_error()
        latency = (time.perf_counter() - start) * 1000
        return SearchResponse(
            results=[],
            query=request.query,
            total=0,
            latency_ms=round(latency, 2),
        )

    try:
        async with service as svc:
            embeddings = await svc.embedder.embed_texts_async([request.query])
            raw = await svc.retriever.search_async(
                query_vector=embeddings[0],
                query_text=request.query,
                top_k=request.top_k,
                score_threshold=request.min_score,
                filters=None,
                use_semantic_reranker=False,
            )
        results = [
            SearchResult(
                id=getattr(r, "id", ""),
                content=getattr(r, "text", ""),
                metadata=dict(getattr(r, "metadata", {}) or {}),
                score=float(min(max(getattr(r, "score", 0.0), 0.0), 1.0)),
            )
            for r in raw
        ]
        latency = (time.perf_counter() - start) * 1000
        return SearchResponse(
            results=results,
            query=request.query,
            total=len(results),
            latency_ms=round(latency, 2),
        )
    except Exception as exc:
        logger.exception("Search endpoint failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get(
    "/status",
    response_model=AIServiceStatus,
    summary="AI services health check",
)
async def ai_status() -> AIServiceStatus:
    """Report AI service health.

    Returns ``healthy`` when :class:`RAGService` can be constructed
    from the current environment, ``unavailable`` otherwise. This is
    intentionally cheap (no remote probe) — wire a deeper readiness
    probe into APIM if you need round-trip Azure OpenAI / AI Search
    health.
    """
    from ..models.ai import AIDependencyStatus  # local import avoids a cycle

    mode = ai_mode()
    now = datetime.now(timezone.utc).isoformat()
    dep_dicts = _dependency_readiness()
    deps = [AIDependencyStatus(**d) for d in dep_dicts]
    reasons = _readiness_reasons(dep_dicts)

    # AI_MODE=disabled → the endpoints are off; report it plainly.
    if mode == "disabled":
        return AIServiceStatus(
            status="disabled", mode=mode, ready=False,
            embedding_model="disabled", chat_model="disabled", vector_store="disabled",
            dependencies=deps, reasons=["AI_MODE=disabled"], last_check=now,
        )

    service = _try_get_rag_service()
    if service is None:
        # Not configured. In live mode this is an outright failure the caller
        # must act on (endpoints 503); in demo mode the fallback is expected.
        return AIServiceStatus(
            status="unavailable",
            mode=mode, ready=False,
            embedding_model="not-configured", chat_model="not-configured",
            vector_store="disconnected", dependencies=deps,
            reasons=reasons or ["RAGService could not be constructed from the current environment"],
            last_check=now,
        )
    try:
        embed_model = service.settings.azure_openai.embedding_deployment
        chat_model = service.settings.azure_openai.chat_deployment
    except Exception:
        embed_model = "unknown"
        chat_model = "unknown"
    return AIServiceStatus(
        status="healthy", mode=mode, ready=True,
        embedding_model=str(embed_model), chat_model=str(chat_model),
        vector_store="connected", dependencies=deps, reasons=[], last_check=now,
    )
