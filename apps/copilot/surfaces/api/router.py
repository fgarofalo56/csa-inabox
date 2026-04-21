"""Mountable ``APIRouter`` for the Copilot FastAPI surface.

Routes exposed under the caller-chosen prefix (default ``/copilot`` in
the standalone launcher)::

    POST /ask          — one-shot question (JSON or SSE).
    POST /chat         — multi-turn question (cookie or body conversation_id).
    POST /ingest       — trigger a corpus re-index (broker-gated).
    GET  /tools        — list registered tools.
    GET  /skills       — list skills (empty list when the skills pkg is absent).
    POST /broker/request
    POST /broker/approve
    POST /broker/deny

All routes honour the JWT bearer contract via
:func:`apps.copilot.surfaces.api.auth.get_principal`.
Non-streaming responses use the :class:`AskResponse` envelope; streaming
responses emit ``text/event-stream`` shaped by
:mod:`apps.copilot.surfaces.api.sse`.
"""

from __future__ import annotations

import hashlib
import importlib.util
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sse_starlette.sse import EventSourceResponse

from apps.copilot.broker.broker import (
    BrokerVerificationError,
    ConfirmationBroker,
    FourEyesViolationError,
)
from apps.copilot.broker.models import ConfirmationRequest
from apps.copilot.models import AnswerResponse
from apps.copilot.surfaces.api.auth import get_principal
from apps.copilot.surfaces.api.dependencies import (
    get_agent,
    get_broker,
    get_registry,
)
from apps.copilot.surfaces.api.models import (
    AskRequest,
    AskResponse,
    BrokerApproveBody,
    BrokerDenyBody,
    BrokerDenyResponse,
    BrokerRequestBody,
    BrokerRequestResponse,
    BrokerTokenResponse,
    IngestPendingResponse,
    IngestRequest,
)
from apps.copilot.surfaces.api.sse import _answer_chunk_to_event
from csa_platform.common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from apps.copilot.agent import CopilotAgent
    from apps.copilot.tools.registry import ToolRegistry

logger = get_logger(__name__)


router = APIRouter(tags=["copilot"])


def _hash_question(question: str) -> str:
    """Return a short SHA-256 prefix of *question* for structured logs."""
    return hashlib.sha256(question.encode("utf-8")).hexdigest()[:16]


def _load_skill_specs() -> list[dict[str, Any]]:
    """Return a list of lightweight skill dicts from the shipped catalog.

    Uses the :class:`apps.copilot.skills.catalog.SkillCatalog` API when
    available.  Any failure (missing package, broken YAML, API drift)
    collapses to an empty list — callers should log at warning level
    but never propagate exceptions from this helper.
    """
    from apps.copilot.skills.catalog import SkillCatalog

    catalog = SkillCatalog.from_shipped()
    out: list[dict[str, Any]] = []
    for spec in catalog.list():
        out.append(
            {
                "id": spec.id,
                "name": getattr(spec, "name", spec.id),
                "description": getattr(spec, "description", ""),
            },
        )
    return out


async def _stream_events(
    agent: CopilotAgent,
    question: str,
    *,
    extra_context: str = "",
) -> AsyncIterator[dict[str, str]]:
    """Yield SSE-starlette-shaped events from :meth:`CopilotAgent.ask_stream`."""
    async for chunk in agent.ask_stream(question, extra_context=extra_context):
        raw = _answer_chunk_to_event(chunk)
        # Extract event+data from the wire format so sse-starlette can
        # re-render it with its own heartbeat.
        text = raw.decode("utf-8")
        event_line, data_line, _ = text.split("\n", 2)
        yield {
            "event": event_line.removeprefix("event: ").strip(),
            "data": data_line.removeprefix("data: ").strip(),
        }
        if chunk.kind == "done":
            return


# ─── /ask ─────────────────────────────────────────────────────────────────


@router.post(
    "/ask",
    response_model=AskResponse,
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": "Missing or invalid bearer token."},
        status.HTTP_429_TOO_MANY_REQUESTS: {"description": "Rate limit exceeded."},
    },
    summary="Grounded Q&A (single-turn).",
)
async def ask(
    body: AskRequest,
    request: Request,  # noqa: ARG001 - reserved for future rate-limit metadata
    principal: str = Depends(get_principal),
    agent: CopilotAgent = Depends(get_agent),
) -> Any:
    """One-shot grounded Q&A with optional SSE streaming.

    When ``stream=true`` the response is ``text/event-stream``
    terminating with a single ``done`` event carrying the
    :class:`AnswerResponse` JSON.  Otherwise the response is the
    JSON :class:`AskResponse` envelope.
    """
    started = time.perf_counter()
    question_hash = _hash_question(body.question)
    logger.info(
        "copilot.api.ask.start",
        surface="api",
        method="ask",
        caller_principal=principal,
        question_hash=question_hash,
        conversation_id=body.conversation_id,
        stream=body.stream,
    )

    if body.stream:
        return EventSourceResponse(
            _stream_events(agent, body.question),
            ping=15,
            media_type="text/event-stream",
        )

    response: AnswerResponse = await agent.ask(body.question)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "copilot.api.ask.done",
        surface="api",
        method="ask",
        caller_principal=principal,
        question_hash=question_hash,
        elapsed_ms=elapsed_ms,
        status="refused" if response.refused else "ok",
        refusal_reason=response.refusal_reason,
    )
    if not body.show_citations:
        response = response.model_copy(update={"citations": []})
    return AskResponse(answer=response, conversation_id=body.conversation_id)


# ─── /chat ────────────────────────────────────────────────────────────────


@router.post(
    "/chat",
    response_model=AskResponse,
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": "Missing or invalid bearer token."},
        status.HTTP_429_TOO_MANY_REQUESTS: {"description": "Rate limit exceeded."},
    },
    summary="Multi-turn grounded Q&A.",
)
async def chat(
    body: AskRequest,
    request: Request,  # noqa: ARG001 - reserved for future cookie inspection
    response: Response,
    principal: str = Depends(get_principal),
    agent: CopilotAgent = Depends(get_agent),
) -> Any:
    """Multi-turn chat endpoint — conversation state persists across calls.

    The conversation id flows either via the request body
    (``conversation_id``) or via a signed cookie the server sets on
    first use.  Streaming mode returns SSE in the same shape as
    :func:`ask`.
    """
    started = time.perf_counter()
    question_hash = _hash_question(body.question)

    # Resolve / mint the conversation handle.
    handle_id = body.conversation_id
    if handle_id is None:
        handle = await agent.start_conversation()
        handle_id = handle.conversation_id

    logger.info(
        "copilot.api.chat.start",
        surface="api",
        method="chat",
        caller_principal=principal,
        question_hash=question_hash,
        conversation_id=handle_id,
        stream=body.stream,
    )

    if body.stream:
        state = await agent.conversation_store.get(handle_id)
        context = agent.summarizer.condense(state) if state else ""

        async def _gen() -> AsyncIterator[dict[str, str]]:
            async for event in _stream_events(agent, body.question, extra_context=context):
                yield event

        sse_response = EventSourceResponse(
            _gen(),
            ping=15,
            media_type="text/event-stream",
        )
        # Include the conversation id so the client can pin subsequent
        # calls even when using the streaming path.
        sse_response.headers["X-Copilot-Conversation-Id"] = handle_id
        return sse_response

    from apps.copilot.models import ConversationHandle

    handle_obj = ConversationHandle(conversation_id=handle_id)
    answer = await agent.ask_in_conversation(handle_obj, body.question)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "copilot.api.chat.done",
        surface="api",
        method="chat",
        caller_principal=principal,
        question_hash=question_hash,
        conversation_id=handle_id,
        elapsed_ms=elapsed_ms,
        status="refused" if answer.refused else "ok",
        refusal_reason=answer.refusal_reason,
    )
    response.headers["X-Copilot-Conversation-Id"] = handle_id
    if not body.show_citations:
        answer = answer.model_copy(update={"citations": []})
    return AskResponse(answer=answer, conversation_id=handle_id)


# ─── /tools ───────────────────────────────────────────────────────────────


@router.get(
    "/tools",
    summary="List registered tools.",
)
async def list_tools(
    principal: str = Depends(get_principal),
    registry: ToolRegistry = Depends(get_registry),
) -> dict[str, Any]:
    """Enumerate the tool catalogue.

    Returns a JSON envelope with ``tools`` as a list of
    :class:`~apps.copilot.tools.registry.ToolSpec` model dumps.
    """
    specs = registry.list_tools()
    logger.info(
        "copilot.api.tools.list",
        surface="api",
        method="tools.list",
        caller_principal=principal,
        count=len(specs),
        status="ok",
    )
    return {"tools": [spec.model_dump(mode="json") for spec in specs]}


# ─── /skills ──────────────────────────────────────────────────────────────


@router.get(
    "/skills",
    summary="List available skills.",
)
async def list_skills(
    principal: str = Depends(get_principal),
) -> dict[str, Any]:
    """Return registered skills; empty when the skills package is absent.

    The skills package is owned by another team; this endpoint
    feature-detects it via :func:`importlib.util.find_spec` so the API
    surface stays decoupled from its release cadence.
    """
    spec = importlib.util.find_spec("apps.copilot.skills")
    if spec is None:
        logger.info(
            "copilot.api.skills.list",
            surface="api",
            method="skills.list",
            caller_principal=principal,
            count=0,
            status="absent",
        )
        return {"skills": []}

    try:
        skills = _load_skill_specs()
    except Exception as exc:  # pragma: no cover - feature-flag path
        logger.warning(
            "copilot.api.skills.list_error",
            surface="api",
            method="skills.list",
            caller_principal=principal,
            error=str(exc),
        )
        return {"skills": []}

    logger.info(
        "copilot.api.skills.list",
        surface="api",
        method="skills.list",
        caller_principal=principal,
        count=len(skills),
        status="ok",
    )
    return {"skills": skills}


# ─── /ingest ──────────────────────────────────────────────────────────────


@router.post(
    "/ingest",
    response_model=IngestPendingResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request a corpus re-index (broker-gated).",
)
async def ingest(
    body: IngestRequest,
    principal: str = Depends(get_principal),
) -> IngestPendingResponse:
    """Trigger a corpus re-index.

    Ingestion is **execute-class** — the endpoint does not perform the
    re-index directly; it returns the URL a caller must POST to with
    a :class:`BrokerRequestBody` to obtain the required
    :class:`~apps.copilot.broker.models.ConfirmationToken`.
    """
    logger.info(
        "copilot.api.ingest.request",
        surface="api",
        method="ingest",
        caller_principal=principal,
        dry_run=body.dry_run,
        roots_count=len(body.roots) if body.roots else 0,
        status="pending_confirmation",
    )
    return IngestPendingResponse(
        status="pending_confirmation",
        token_request_url="/copilot/broker/request",
        message=(
            "Ingestion is execute-class. POST to /copilot/broker/request "
            "with tool_name='copilot.ingest' to obtain a ConfirmationToken, "
            "then invoke the ingestion worker with the token."
        ),
    )


# ─── /broker/* ────────────────────────────────────────────────────────────


@router.post(
    "/broker/request",
    response_model=BrokerRequestResponse,
    summary="Request a confirmation token for an execute-class tool.",
)
async def broker_request(
    body: BrokerRequestBody,
    principal: str = Depends(get_principal),
    broker: ConfirmationBroker = Depends(get_broker),
) -> BrokerRequestResponse:
    """Record a :class:`ConfirmationRequest` and return pending metadata.

    The returned ``request_id`` is the id the caller must pass to
    ``/broker/approve`` or ``/broker/deny`` to transition the lifecycle.
    """
    import uuid as _uuid

    request_id = _uuid.uuid4().hex
    req = ConfirmationRequest(
        request_id=request_id,
        tool_name=body.tool_name,
        caller_principal=principal,
        scope=body.scope,
        input_hash=body.input_hash,
        justification=body.justification,
        metadata=body.metadata,
    )
    decision = await broker.request(req)
    logger.info(
        "copilot.api.broker.request",
        surface="api",
        method="broker.request",
        caller_principal=principal,
        request_id=request_id,
        tool=body.tool_name,
        status=decision.value,
    )
    return BrokerRequestResponse(
        request_id=request_id,
        decision=decision,
        approve_url="/copilot/broker/approve",
        deny_url="/copilot/broker/deny",
    )


@router.post(
    "/broker/approve",
    response_model=BrokerTokenResponse,
    summary="Approve a pending broker request.",
)
async def broker_approve(
    body: BrokerApproveBody,
    principal: str = Depends(get_principal),
    broker: ConfirmationBroker = Depends(get_broker),
) -> BrokerTokenResponse:
    """Approve a pending :class:`ConfirmationRequest` and return a token."""
    try:
        token = await broker.approve(body.request_id, body.approver_principal)
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except FourEyesViolationError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc

    logger.info(
        "copilot.api.broker.approve",
        surface="api",
        method="broker.approve",
        caller_principal=principal,
        request_id=body.request_id,
        token_id=token.token_id,
        status="ok",
    )
    return BrokerTokenResponse(
        token_id=token.token_id,
        token=token.token,
        tool_name=token.tool_name,
        scope=token.scope,
        expires_at=token.expires_at.isoformat(),
    )


@router.post(
    "/broker/deny",
    response_model=BrokerDenyResponse,
    summary="Deny a pending broker request.",
)
async def broker_deny(
    body: BrokerDenyBody,
    principal: str = Depends(get_principal),
    broker: ConfirmationBroker = Depends(get_broker),
) -> BrokerDenyResponse:
    """Deny a pending :class:`ConfirmationRequest` with a reason."""
    try:
        decision = await broker.deny(
            body.request_id,
            body.approver_principal,
            body.reason,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except BrokerVerificationError as exc:  # pragma: no cover - defensive
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    logger.info(
        "copilot.api.broker.deny",
        surface="api",
        method="broker.deny",
        caller_principal=principal,
        request_id=body.request_id,
        status="denied",
    )
    return BrokerDenyResponse(
        request_id=body.request_id,
        decision=decision,
        reason=body.reason,
    )


__all__ = ["router"]
