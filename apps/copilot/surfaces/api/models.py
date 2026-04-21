"""Pydantic request / response DTOs for the FastAPI surface.

All models are frozen — once a request arrives, its shape cannot be
mutated by downstream handlers.  The response models mirror the Copilot
core DTOs (``AnswerResponse``, ``Citation``, etc.) but re-declare them
with transport-layer concerns (e.g. an HTTP-friendly error envelope).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.broker.models import BrokerDecision
from apps.copilot.models import AnswerResponse

# ─── Ask / Chat ──────────────────────────────────────────────────────────


class AskRequest(BaseModel):
    """Body for ``POST /copilot/ask`` and ``POST /copilot/chat``."""

    question: str = Field(
        min_length=1,
        max_length=4_000,
        description="The natural-language question (<=4000 chars).",
    )
    conversation_id: str | None = Field(
        default=None,
        description=(
            "Opaque conversation id returned by a prior ``/chat`` call.  "
            "Omit to start a new conversation (or when calling ``/ask``)."
        ),
    )
    stream: bool = Field(
        default=False,
        description=(
            "When true, the server returns ``text/event-stream`` instead "
            "of a JSON :class:`AnswerResponse`."
        ),
    )
    show_citations: bool = Field(
        default=True,
        description="Include verified citations in the response payload.",
    )

    model_config = ConfigDict(frozen=True)


class AskResponse(BaseModel):
    """Envelope wrapping an :class:`AnswerResponse` with transport metadata."""

    answer: AnswerResponse = Field(description="The grounded Copilot answer.")
    conversation_id: str | None = Field(
        default=None,
        description="Populated on chat endpoints so clients can pin future calls.",
    )

    model_config = ConfigDict(frozen=True)


# ─── Broker ──────────────────────────────────────────────────────────────


class BrokerRequestBody(BaseModel):
    """Body for ``POST /copilot/broker/request``."""

    tool_name: str = Field(min_length=1, description="Registered execute-class tool.")
    scope: str = Field(min_length=1, description="Free-form scope string shown to approvers.")
    input_hash: str = Field(
        min_length=16,
        description=(
            "SHA-256 hex digest of the canonical JSON for the tool input.  "
            "Compute via ``apps.copilot.broker.broker.compute_input_hash``."
        ),
    )
    justification: str = Field(default="", description="Optional human reason.")
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(frozen=True)


class BrokerRequestResponse(BaseModel):
    """Response for ``POST /copilot/broker/request``."""

    request_id: str = Field(description="Broker-assigned pending request id.")
    decision: BrokerDecision = Field(description="Current decision state.")
    approve_url: str = Field(description="URL to POST to with an approver principal.")
    deny_url: str = Field(description="URL to POST to with an approver principal + reason.")

    model_config = ConfigDict(frozen=True)


class BrokerApproveBody(BaseModel):
    """Body for ``POST /copilot/broker/approve``."""

    request_id: str = Field(min_length=1)
    approver_principal: str = Field(min_length=1)

    model_config = ConfigDict(frozen=True)


class BrokerDenyBody(BaseModel):
    """Body for ``POST /copilot/broker/deny``."""

    request_id: str = Field(min_length=1)
    approver_principal: str = Field(min_length=1)
    reason: str = Field(min_length=1)

    model_config = ConfigDict(frozen=True)


class BrokerTokenResponse(BaseModel):
    """Response for ``POST /copilot/broker/approve`` (opaque token envelope)."""

    token_id: str = Field(description="Broker-assigned token id.")
    token: str = Field(description="Opaque signed token string.")
    tool_name: str
    scope: str
    expires_at: str = Field(description="ISO-8601 UTC timestamp.")

    model_config = ConfigDict(frozen=True)


class BrokerDenyResponse(BaseModel):
    """Response for ``POST /copilot/broker/deny``."""

    request_id: str
    decision: BrokerDecision
    reason: str

    model_config = ConfigDict(frozen=True)


# ─── Ingest ──────────────────────────────────────────────────────────────


class IngestRequest(BaseModel):
    """Body for ``POST /copilot/ingest``."""

    roots: list[str] | None = Field(
        default=None,
        description=(
            "Repo-relative corpus roots.  Omit to reuse the configured "
            "``COPILOT_CORPUS_ROOTS`` / defaults."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description="Walk + chunk only; skip embedding and Azure AI Search upsert.",
    )

    model_config = ConfigDict(frozen=True)


class IngestPendingResponse(BaseModel):
    """Response indicating a confirmation token is required before ingesting."""

    status: str = Field(default="pending_confirmation")
    token_request_url: str = Field(description="Where to POST a broker request.")
    message: str = Field(description="Explanation for the caller.")

    model_config = ConfigDict(frozen=True)


# ─── Error envelope ──────────────────────────────────────────────────────


class ErrorResponse(BaseModel):
    """Uniform error envelope returned for every non-2xx response."""

    error: str = Field(description="Short machine-readable code.")
    detail: str = Field(description="Human-readable message.")

    model_config = ConfigDict(frozen=True)


__all__ = [
    "AskRequest",
    "AskResponse",
    "BrokerApproveBody",
    "BrokerDenyBody",
    "BrokerDenyResponse",
    "BrokerRequestBody",
    "BrokerRequestResponse",
    "BrokerTokenResponse",
    "ErrorResponse",
    "IngestPendingResponse",
    "IngestRequest",
]
