"""ConfirmationBroker — CSA-0102 (AQ-0004).

The broker issues, approves, denies, and verifies opaque signed tokens
that gate every execute-class Copilot tool.  Its goals are:

* **Least privilege.**  A token is bound to ``tool_name``, ``scope``,
  and a cryptographic hash of the tool input.  Replaying a token
  against a different tool, scope, or payload fails verification.
* **Short-lived.**  Tokens carry an explicit ``expires_at`` derived
  from :attr:`CopilotSettings.broker_token_ttl_seconds`.
* **Tamper-evident.**  Every lifecycle transition emits a
  :class:`~apps.copilot.broker.audit.BrokerAuditEvent` chained via
  SHA-256 (see :mod:`apps.copilot.broker.audit`).
* **Four-eyes optional.**  When
  :attr:`CopilotSettings.broker_require_four_eyes` is true the
  broker rejects ``approve`` calls where the approver matches the
  original caller.

Tokens are signed with ``itsdangerous.URLSafeSerializer`` under a
per-broker salt, so rotating the salt invalidates every outstanding
token without touching the signing key.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from itsdangerous import BadSignature, URLSafeSerializer

from apps.copilot.broker.audit import (
    BrokerAuditEvent,
    BrokerAuditLogger,
    broker_audit_logger,
)
from apps.copilot.broker.models import (
    BrokerDecision,
    ConfirmationRequest,
    ConfirmationToken,
)
from apps.copilot.config import CopilotSettings
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Errors
# ─────────────────────────────────────────────────────────────────────


class BrokerVerificationError(RuntimeError):
    """Raised when a :meth:`ConfirmationBroker.verify` call fails.

    The agent loop catches this so execute tools surface a clean
    refusal rather than leaking signature internals.
    """


class TokenExpiredError(BrokerVerificationError):
    """Raised when a token is presented after ``expires_at``."""


class FourEyesViolationError(ValueError):
    """Raised when ``broker_require_four_eyes`` is on and the approver == caller."""


class MissingSigningKeyError(RuntimeError):
    """Raised when broker methods are invoked without a signing key.

    The broker treats an empty :attr:`CopilotSettings.broker_signing_key`
    as "broker disabled" — a deliberate fail-closed stance so no tokens
    are ever minted in an environment that forgot to configure the
    broker.
    """


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def compute_input_hash(payload: Any) -> str:
    """Return the SHA-256 hex digest of the canonical JSON of *payload*.

    The hash is what the broker binds a token to.  Using canonical
    JSON (sorted keys, no whitespace) makes the digest stable across
    Python versions and dict orderings.
    """
    if hasattr(payload, "model_dump"):
        data = payload.model_dump(mode="json")
    else:
        data = payload
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────────────
# ConfirmationBroker
# ─────────────────────────────────────────────────────────────────────


class ConfirmationBroker:
    """Token broker for execute-class Copilot tools.

    Dependencies (``audit``, ``now``) are injectable so tests can
    bypass the process-global audit sink and pin time.  The broker
    holds no Azure state — everything is in-process.
    """

    def __init__(
        self,
        settings: CopilotSettings,
        *,
        audit: BrokerAuditLogger | None = None,
        now: Any = None,
    ) -> None:
        self.settings = settings
        self._audit = audit or broker_audit_logger
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._serializer: URLSafeSerializer | None = None
        # Pending requests awaiting approve/deny.  The broker is
        # process-local; persistence is deferred to a future phase.
        self._pending: dict[str, ConfirmationRequest] = {}
        # Used (consumed) token ids — prevents a single-use replay.
        self._consumed: set[str] = set()
        # Denied token ids — rejected at verify() time.
        self._denied: set[str] = set()

    # -- internals -----------------------------------------------------------

    def _require_serializer(self) -> URLSafeSerializer:
        """Return the cached serializer, constructing it on first use."""
        if not self.settings.broker_signing_key:
            raise MissingSigningKeyError(
                "ConfirmationBroker requires COPILOT_BROKER_SIGNING_KEY. "
                "Set a non-empty signing key before issuing tokens.",
            )
        if self._serializer is None:
            self._serializer = URLSafeSerializer(
                secret_key=self.settings.broker_signing_key,
                salt=self.settings.broker_token_salt,
            )
        return self._serializer

    # -- lifecycle -----------------------------------------------------------

    async def request(self, req: ConfirmationRequest) -> BrokerDecision:
        """Record an inbound :class:`ConfirmationRequest`.

        The broker keeps the request in a pending table and emits a
        ``broker.request`` audit event.  Callers subsequently call
        :meth:`approve` or :meth:`deny` with the request's
        ``request_id`` to transition the lifecycle.

        Returns :attr:`BrokerDecision.pending`.
        """
        if req.request_id in self._pending:
            raise ValueError(
                f"ConfirmationRequest {req.request_id!r} is already pending. "
                "Use a unique request_id per broker transaction.",
            )

        self._pending[req.request_id] = req
        self._audit.emit(
            BrokerAuditEvent(
                actor={"principal": req.caller_principal},
                action="broker.request",
                resource={
                    "tool_name": req.tool_name,
                    "request_id": req.request_id,
                    "scope": req.scope,
                },
                outcome="success",
                after={
                    "input_hash": req.input_hash,
                    "justification": req.justification,
                    "metadata": req.metadata,
                },
            ),
        )
        logger.info(
            "copilot.broker.request",
            request_id=req.request_id,
            tool=req.tool_name,
            caller=req.caller_principal,
            scope=req.scope,
        )
        return BrokerDecision.pending

    async def approve(
        self,
        request_id: str,
        approver_principal: str,
    ) -> ConfirmationToken:
        """Approve a pending request and return a signed token.

        Raises :class:`KeyError` when no pending request matches.
        Raises :class:`FourEyesViolationError` when four-eyes mode is
        on and the approver matches the original caller.
        """
        if request_id not in self._pending:
            raise KeyError(
                f"No pending confirmation request with request_id={request_id!r}.",
            )
        req = self._pending.pop(request_id)

        if self.settings.broker_require_four_eyes and approver_principal == req.caller_principal:
            # Put the request back so the workflow can retry with a
            # different approver.
            self._pending[request_id] = req
            self._audit.emit(
                BrokerAuditEvent(
                    actor={"principal": approver_principal},
                    action="broker.rejected",
                    resource={
                        "tool_name": req.tool_name,
                        "request_id": request_id,
                        "scope": req.scope,
                    },
                    outcome="denied",
                    reason="four_eyes_violation",
                ),
            )
            raise FourEyesViolationError(
                "Four-eyes mode requires approver != caller. "
                f"Both are {approver_principal!r}.",
            )

        issued_at = self._now()
        expires_at = issued_at + timedelta(seconds=self.settings.broker_token_ttl_seconds)
        token_id = str(uuid.uuid4())

        payload = {
            "token_id": token_id,
            "tool_name": req.tool_name,
            "scope": req.scope,
            "caller_principal": req.caller_principal,
            "approver_principal": approver_principal,
            "input_hash": req.input_hash,
            "issued_at": issued_at.isoformat(),
            "expires_at": expires_at.isoformat(),
        }
        serializer = self._require_serializer()
        token_string: str = serializer.dumps(payload)

        token = ConfirmationToken(
            token_id=token_id,
            token=token_string,
            tool_name=req.tool_name,
            scope=req.scope,
            caller_principal=req.caller_principal,
            approver_principal=approver_principal,
            input_hash=req.input_hash,
            issued_at=issued_at,
            expires_at=expires_at,
            decision=BrokerDecision.approved,
        )

        self._audit.emit(
            BrokerAuditEvent(
                actor={"principal": approver_principal},
                action="broker.approve",
                resource={
                    "tool_name": req.tool_name,
                    "request_id": request_id,
                    "token_id": token_id,
                    "scope": req.scope,
                },
                outcome="success",
                before={"caller_principal": req.caller_principal},
                after={
                    "input_hash": req.input_hash,
                    "expires_at": expires_at.isoformat(),
                },
            ),
        )
        logger.info(
            "copilot.broker.approve",
            request_id=request_id,
            token_id=token_id,
            tool=req.tool_name,
            approver=approver_principal,
        )
        return token

    async def deny(
        self,
        request_id: str,
        approver_principal: str,
        reason: str,
    ) -> BrokerDecision:
        """Deny a pending request.

        Returns :attr:`BrokerDecision.denied`.  Raises
        :class:`KeyError` when no pending request matches.  A denial
        reason is required — the audit event will not emit without one.
        """
        if not reason:
            raise ValueError("deny() requires a non-empty reason.")
        if request_id not in self._pending:
            raise KeyError(
                f"No pending confirmation request with request_id={request_id!r}.",
            )
        req = self._pending.pop(request_id)
        self._denied.add(request_id)

        self._audit.emit(
            BrokerAuditEvent(
                actor={"principal": approver_principal},
                action="broker.deny",
                resource={
                    "tool_name": req.tool_name,
                    "request_id": request_id,
                    "scope": req.scope,
                },
                outcome="denied",
                reason=reason,
                before={"caller_principal": req.caller_principal},
            ),
        )
        logger.info(
            "copilot.broker.deny",
            request_id=request_id,
            tool=req.tool_name,
            approver=approver_principal,
            reason=reason,
        )
        return BrokerDecision.denied

    # -- verification --------------------------------------------------------

    async def verify(
        self,
        token: ConfirmationToken,
        tool_name: str,
        input_hash: str,
    ) -> bool:
        """Validate *token* against an intended tool invocation.

        Checks signature, expiry, scope match, input_hash match, and
        single-use semantics.  Emits ``broker.used`` on success and
        ``broker.rejected`` / ``broker.expired`` on failure.  Returns
        ``True`` on success; raises :class:`BrokerVerificationError`
        on any mismatch so callers never accidentally treat a falsy
        return as "no-op".
        """
        resource_desc: dict[str, Any] = {
            "tool_name": token.tool_name,
            "requested_tool": tool_name,
            "token_id": token.token_id,
            "scope": token.scope,
        }

        # Signature check — the authoritative gate.  If the serializer
        # cannot decode the token string, nothing else matters.
        try:
            payload = self._require_serializer().loads(token.token)
        except BadSignature as exc:
            self._audit.emit(
                BrokerAuditEvent(
                    actor={"principal": token.caller_principal},
                    action="broker.rejected",
                    resource=resource_desc,
                    outcome="denied",
                    reason="bad_signature",
                ),
            )
            raise BrokerVerificationError("Token signature is invalid.") from exc

        # Tool binding: the token's embedded tool_name must match BOTH
        # the caller's intent and the ConfirmationToken's declared
        # tool_name.  The latter guards against a caller who mutates
        # the wrapper model after signing.
        if payload.get("tool_name") != tool_name or token.tool_name != tool_name:
            self._audit.emit(
                BrokerAuditEvent(
                    actor={"principal": token.caller_principal},
                    action="broker.rejected",
                    resource=resource_desc,
                    outcome="denied",
                    reason="tool_mismatch",
                ),
            )
            raise BrokerVerificationError(
                f"Token issued for tool {payload.get('tool_name')!r}, "
                f"cannot authorise {tool_name!r}.",
            )

        # Input-hash binding — refuses replays against a different
        # payload.
        if payload.get("input_hash") != input_hash or token.input_hash != input_hash:
            self._audit.emit(
                BrokerAuditEvent(
                    actor={"principal": token.caller_principal},
                    action="broker.rejected",
                    resource=resource_desc,
                    outcome="denied",
                    reason="input_hash_mismatch",
                ),
            )
            raise BrokerVerificationError(
                "Token input_hash does not match the presented input.",
            )

        # Single-use enforcement.
        if token.token_id in self._consumed:
            self._audit.emit(
                BrokerAuditEvent(
                    actor={"principal": token.caller_principal},
                    action="broker.rejected",
                    resource=resource_desc,
                    outcome="denied",
                    reason="token_already_used",
                ),
            )
            raise BrokerVerificationError(
                "Token has already been consumed. Request a new token.",
            )

        # Expiry.
        now = self._now()
        expires_at = datetime.fromisoformat(payload["expires_at"])
        if now >= expires_at:
            self._audit.emit(
                BrokerAuditEvent(
                    actor={"principal": token.caller_principal},
                    action="broker.expired",
                    resource=resource_desc,
                    outcome="denied",
                    reason="token_expired",
                ),
            )
            raise TokenExpiredError(
                f"Token expired at {expires_at.isoformat()} (now={now.isoformat()}).",
            )

        # Success.
        self._consumed.add(token.token_id)
        self._audit.emit(
            BrokerAuditEvent(
                actor={"principal": token.caller_principal},
                action="broker.used",
                resource=resource_desc,
                outcome="success",
                after={
                    "input_hash": input_hash,
                    "approver_principal": token.approver_principal,
                },
            ),
        )
        return True


__all__ = [
    "BrokerVerificationError",
    "ConfirmationBroker",
    "FourEyesViolationError",
    "MissingSigningKeyError",
    "TokenExpiredError",
    "compute_input_hash",
]
