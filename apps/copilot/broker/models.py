"""Pydantic contracts for the confirmation broker (CSA-0102).

All models are ``frozen`` — callers cannot mutate a
:class:`ConfirmationRequest` after it has been passed to the broker,
and a :class:`ConfirmationToken` is value-semantic (re-serialisable
without losing information).

The ``token`` field on :class:`ConfirmationToken` is an opaque signed
string produced by :mod:`itsdangerous`.  The broker keeps the
authoritative signing key and re-verifies every token before honouring
it — clients never interpret the signature themselves.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class BrokerDecision(str, Enum):
    """Terminal states for a confirmation request.

    ``approved`` and ``denied`` are the normal outcomes.  ``expired``
    is set when a token that was previously approved is used after
    ``expires_at``; ``rejected`` is used when verification fails for
    any other reason (bad signature, input hash mismatch, scope
    mismatch).
    """

    pending = "pending"
    approved = "approved"
    denied = "denied"
    expired = "expired"
    rejected = "rejected"


class ConfirmationRequest(BaseModel):
    """Inbound request asking the broker to issue a confirmation token.

    The request binds the caller's principal, the tool they want to
    invoke, and a cryptographic hash of the tool input so the token
    cannot later be reused against a different payload.  Scope is a
    free-form string — by convention, include the environment
    (``"dev"``, ``"stage"``, ``"prod"``) and any resource identifier
    the approver needs to see.
    """

    request_id: str = Field(description="Client-generated unique id for the request.")
    tool_name: str = Field(description="Registered name of the execute-class tool.")
    caller_principal: str = Field(
        description="Identity of the principal asking for the token (e.g., email, UPN).",
    )
    scope: str = Field(description="Free-form scope string surfaced to the approver.")
    input_hash: str = Field(
        description=(
            "SHA-256 hex digest of the canonical JSON for the tool input. "
            "The broker binds the token to this hash."
        ),
    )
    justification: str = Field(
        default="",
        description="Optional human-readable justification logged with the request.",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Additional structured context surfaced to approvers and audit.",
    )

    model_config = ConfigDict(frozen=True)


class ConfirmationToken(BaseModel):
    """Opaque signed token returned by an approved :class:`ConfirmationRequest`.

    The broker emits this object after a successful ``approve`` call.
    Tool callers must pass the full :class:`ConfirmationToken` (not
    just the string) to ``tool.__call__`` so the agent loop can
    re-verify the signature before the side-effect fires.

    Equality compares on the signed token string; frozen Pydantic
    semantics guarantee no field can be mutated after construction.
    """

    token_id: str = Field(description="Broker-generated unique id for the token.")
    token: str = Field(description="Opaque HMAC-signed token string.")
    tool_name: str = Field(description="The tool this token authorises.")
    scope: str = Field(description="Scope string carried through from the request.")
    caller_principal: str = Field(description="Principal that requested the token.")
    approver_principal: str = Field(description="Principal that approved the token.")
    input_hash: str = Field(description="Bound SHA-256 input hash.")
    issued_at: datetime = Field(description="UTC issuance timestamp.")
    expires_at: datetime = Field(description="UTC expiry timestamp.")
    decision: BrokerDecision = Field(
        default=BrokerDecision.approved,
        description="State of the token. Always 'approved' when returned by request()/approve().",
    )

    model_config = ConfigDict(frozen=True)

    def is_expired(self, *, now: datetime | None = None) -> bool:
        """Return True when *now* (UTC) is past ``expires_at``."""
        current = now or datetime.now(timezone.utc)
        return current >= self.expires_at


__all__ = [
    "BrokerDecision",
    "ConfirmationRequest",
    "ConfirmationToken",
]
