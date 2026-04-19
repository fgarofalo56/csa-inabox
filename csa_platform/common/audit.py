"""Tamper-evident audit logging for csa_platform security-relevant events.

Provides a structured, append-only audit sink distinct from the application
logger.  Every emit is:

1. Serialised as a strict :class:`AuditEvent` (actor, action, resource,
   outcome, before / after, correlation id, client context).
2. Hashed into a per-process SHA-256 chain so tampering with any event in
   the sequence is detectable after the fact (``verify_chain``).
3. Written to a dedicated ``csa.audit`` logger (separate namespace from
   application loggers) as a single JSON line — Log Analytics, SIEM
   forwarders, and local tail workflows all agree on one format.
4. Optionally mirrored to a rotating per-day local file under
   ``logs/audit/<yyyy>/<mm>/<dd>/audit-<yyyy-mm-dd>.jsonl`` when
   ``AUDIT_FILE_SINK_ENABLED=true`` (intended for dev / test
   environments — in production Log Analytics is the canonical sink
   and WORM retention is enforced at the storage layer).

Closes CSA-0016 (FedRAMP AU-2/AU-3/AU-6, CMMC AU, HIPAA §164.312(b),
PCI-DSS 10, SOC 2 CC7.2).

Tamper-evidence is *local* — the hash chain detects modification or
deletion of events in the sequence *as emitted by this process*.  End-to-
end WORM retention requires infrastructure-level controls (immutable
blob storage policy, Log Analytics retention locks, SIEM forward-only
ingestion).  Those live outside this module.

This module is intentionally **append-only by convention**: it exposes no
``delete`` or ``overwrite`` helpers.  The running chain head is held in a
process-local variable protected by a lock — tests that need a fresh
chain should call :func:`_reset_chain_for_testing`.

Typical use in a FastAPI router::

    from csa_platform.common.audit import (
        audit_logger,
        audit_event_from_request,
    )

    @router.post("/{request_id}/approve")
    async def approve(request_id: str, request: Request, user=Depends(...)):
        ...
        audit_logger.emit(
            audit_event_from_request(
                request=request,
                user=user,
                action="access_request.approve",
                resource={"type": "access_request", "id": request_id,
                          "domain": product.domain},
                outcome="success",
                before={"status": "pending"},
                after={"status": "approved"},
            )
        )
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

# ─────────────────────────────────────────────────────────────────────────
# Allowed actions (closed set — reject unknown action strings)
# ─────────────────────────────────────────────────────────────────────────

# Closed enumeration of auditable security-relevant actions.  Adding a new
# action is an intentional change that should be reviewed — the constraint
# forces callers to declare their intent up-front rather than emitting
# free-text event names that vary between revisions.
ALLOWED_ACTIONS: frozenset[str] = frozenset(
    {
        "access_request.create",
        "access_request.approve",
        "access_request.deny",
        "source.register",
        "source.update",
        "source.provision",
        "source.scan",
        "source.decommission",
        "pipeline.trigger",
        "product.publish",
        "product.access_grant",
    }
)


Outcome = Literal["success", "denied", "error"]


# ─────────────────────────────────────────────────────────────────────────
# AuditEvent schema
# ─────────────────────────────────────────────────────────────────────────


class AuditEvent(BaseModel):
    """Canonical audit event.

    All fields are required except the explicitly-optional ones.  The model
    is serialised with a stable field order so downstream hash comparisons
    remain deterministic across Python versions.
    """

    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    actor: dict[str, Any] = Field(
        ...,
        description=(
            "Identity claims from the JWT: sub, oid, tid, roles, domain. "
            "Unknown keys are preserved."
        ),
    )
    action: str = Field(..., description="One of ALLOWED_ACTIONS.")
    resource: dict[str, Any] = Field(
        ...,
        description="Resource descriptor: type, id, domain, classification.",
    )
    outcome: Outcome = Field(..., description="success | denied | error")
    before: dict[str, Any] | None = Field(
        default=None, description="State before the change (for updates)."
    )
    after: dict[str, Any] | None = Field(
        default=None, description="State after the change (for updates)."
    )
    correlation_id: str | None = Field(
        default=None,
        description=(
            "W3C traceparent-derived trace id if present on the request. "
            "Binds the audit event to surrounding application telemetry."
        ),
    )
    source_ip: str | None = Field(
        default=None, description="request.client.host if known."
    )
    user_agent: str | None = Field(
        default=None, description="User-Agent header if present."
    )
    reason: str | None = Field(
        default=None,
        description="Human-readable denial / error reason. Required when "
        "outcome is 'denied' or 'error'; optional otherwise.",
    )
    chain_hash: str | None = Field(
        default=None,
        description=(
            "SHA-256(previous_hash || canonical_event_json).  Populated by "
            "AuditLogger.emit — callers should leave this unset."
        ),
    )

    model_config = {"extra": "forbid"}

    def canonical_json(self) -> str:
        """Deterministic JSON serialisation used for hashing.

        Excludes ``chain_hash`` itself (it is computed over the rest of
        the event) and uses sorted keys so the output is stable across
        Python versions and dict-ordering changes.
        """
        payload = self.model_dump(mode="json", exclude={"chain_hash"})
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))


# ─────────────────────────────────────────────────────────────────────────
# Hash-chain state (process-local, lock-protected)
# ─────────────────────────────────────────────────────────────────────────

# Genesis value — a deterministic constant rather than the empty string so
# a tampered "first" event (where an attacker sets previous_hash="") is
# still detectable as long as the genesis is agreed-upon out-of-band.
_GENESIS_HASH = hashlib.sha256(b"csa_platform.audit.genesis.v1").hexdigest()

_chain_lock = threading.Lock()
_previous_hash: str = _GENESIS_HASH


def _compute_chain_hash(previous: str, canonical_event_json: str) -> str:
    """SHA-256 of previous hash concatenated with the canonical event bytes."""
    h = hashlib.sha256()
    h.update(previous.encode("utf-8"))
    h.update(b"|")
    h.update(canonical_event_json.encode("utf-8"))
    return h.hexdigest()


def _reset_chain_for_testing() -> None:
    """Reset the process-local chain head to genesis. Test-only helper."""
    global _previous_hash
    with _chain_lock:
        _previous_hash = _GENESIS_HASH


# ─────────────────────────────────────────────────────────────────────────
# AuditLogger — emit + verify
# ─────────────────────────────────────────────────────────────────────────


_AUDIT_LOGGER_NAME = "csa.audit"


class AuditLogger:
    """Separate-namespace audit sink with tamper-evident hash chain.

    The logger name ``csa.audit`` is intentionally distinct from every
    application logger so operators can route audit events to a dedicated
    handler (Log Analytics ``AuditLogs_CL`` custom table, SIEM connector,
    WORM blob, etc.) without picking up general application chatter.
    """

    def __init__(self, logger_name: str = _AUDIT_LOGGER_NAME) -> None:
        self._logger = logging.getLogger(logger_name)
        # Audit events must always surface regardless of the root logger
        # level — operators can still raise the bar on the attached
        # handler if needed.
        if self._logger.level == logging.NOTSET:
            self._logger.setLevel(logging.INFO)
        # Prevent silent loss when no handler is attached: a lastResort
        # handler exists on the root logger but audit events should never
        # be swallowed as "no handlers found" warnings.
        self._logger.propagate = True

    # ── Action validation ─────────────────────────────────────────────
    @staticmethod
    def _validate_action(action: str) -> None:
        if action not in ALLOWED_ACTIONS:
            raise ValueError(
                f"Unknown audit action {action!r}. Add it to "
                "csa_platform.common.audit.ALLOWED_ACTIONS if this is a "
                "legitimate new auditable action."
            )

    # ── Emit ──────────────────────────────────────────────────────────
    def emit(self, event: AuditEvent) -> AuditEvent:
        """Chain-hash and record an audit event.

        Returns the event with ``chain_hash`` populated so the caller can
        inspect it in tests or forward it elsewhere.
        """
        self._validate_action(event.action)

        # Enforce reason for negative outcomes — makes denial / error
        # events self-describing for reviewers.
        if event.outcome in ("denied", "error") and not event.reason:
            raise ValueError(
                f"Audit events with outcome={event.outcome!r} must include a "
                "`reason` describing why."
            )

        global _previous_hash
        with _chain_lock:
            canonical = event.canonical_json()
            new_hash = _compute_chain_hash(_previous_hash, canonical)
            event.chain_hash = new_hash
            _previous_hash = new_hash

        line = event.model_dump_json()
        # Structured emit — the message itself is the full JSON payload so
        # any handler that just writes `record.getMessage()` produces a
        # clean JSONL stream.
        self._logger.info(line)

        # Optional file sink for dev / test environments.
        _maybe_write_file_sink(line, event.timestamp)

        return event

    # ── Verify ────────────────────────────────────────────────────────
    @staticmethod
    def verify_chain(
        events: list[AuditEvent],
        *,
        previous_hash: str = _GENESIS_HASH,
    ) -> bool:
        """Recompute the hash chain and confirm every event matches.

        ``events`` must be in emission order.  Any modification to a
        serialised field (actor, action, resource, outcome, before/after,
        timestamp, reason, correlation_id, source_ip, user_agent) in any
        event will cause verification to fail at that event and every
        subsequent one.
        """
        running = previous_hash
        for event in events:
            if event.chain_hash is None:
                return False
            canonical = event.canonical_json()
            expected = _compute_chain_hash(running, canonical)
            if expected != event.chain_hash:
                return False
            running = event.chain_hash
        return True


# Singleton for application code — audit is a global, per-process concern.
audit_logger = AuditLogger()


# ─────────────────────────────────────────────────────────────────────────
# Optional local file sink (dev / test)
# ─────────────────────────────────────────────────────────────────────────


def _audit_file_sink_enabled() -> bool:
    raw = os.environ.get("AUDIT_FILE_SINK_ENABLED", "").strip().lower()
    return raw in {"true", "1", "yes", "on"}


def _audit_file_sink_root() -> Path:
    """Resolve the root directory for the rotating file sink."""
    override = os.environ.get("AUDIT_FILE_SINK_DIR")
    if override:
        return Path(override)
    return Path("logs") / "audit"


def _maybe_write_file_sink(line: str, ts: datetime) -> None:
    """Append an audit line to the dated JSONL file if the sink is on."""
    if not _audit_file_sink_enabled():
        return
    try:
        root = _audit_file_sink_root()
        year = f"{ts.year:04d}"
        month = f"{ts.month:02d}"
        day = f"{ts.day:02d}"
        target_dir = root / year / month / day
        target_dir.mkdir(parents=True, exist_ok=True)
        target_file = target_dir / f"audit-{year}-{month}-{day}.jsonl"
        with target_file.open("a", encoding="utf-8") as fh:
            fh.write(line)
            fh.write("\n")
    except OSError:
        # Never raise from the audit sink — the primary Log Analytics
        # stream remains canonical.  A failed file write is logged to the
        # standard library logger for operator visibility.
        logging.getLogger(__name__).exception(
            "audit file sink write failed (audit event still emitted "
            "to the primary sink)"
        )


# ─────────────────────────────────────────────────────────────────────────
# Helpers: build AuditEvent from a FastAPI Request + user claims
# ─────────────────────────────────────────────────────────────────────────


_TRACEPARENT_HEADER = "traceparent"


def _extract_correlation_id(headers: Any) -> str | None:
    """Pull the 32-hex trace id out of a W3C traceparent header.

    Accepts any mapping-like object exposing ``.get(name)``.
    """
    if headers is None:
        return None
    try:
        raw = headers.get(_TRACEPARENT_HEADER) or headers.get(
            _TRACEPARENT_HEADER.title()
        )
    except AttributeError:
        return None
    if not raw or not isinstance(raw, str):
        return None
    parts = raw.strip().split("-")
    if len(parts) != 4:
        return None
    trace_id = parts[1]
    if len(trace_id) != 32 or not all(c in "0123456789abcdef" for c in trace_id.lower()):
        return None
    return trace_id


def _actor_from_user(user: dict[str, Any]) -> dict[str, Any]:
    """Project the subset of JWT claims that identify the actor."""
    return {
        "sub": user.get("sub"),
        "oid": user.get("oid"),
        "tid": user.get("tid"),
        "roles": list(user.get("roles", []) or []),
        "domain": user.get("domain") or user.get("team"),
        "email": user.get("email") or user.get("preferred_username"),
    }


def audit_event_from_request(
    *,
    request: Any,
    user: dict[str, Any],
    action: str,
    resource: dict[str, Any],
    outcome: Outcome,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    reason: str | None = None,
) -> AuditEvent:
    """Build an :class:`AuditEvent` from a FastAPI ``Request`` + claims.

    ``request`` is typed as ``Any`` so the module has no hard dependency
    on FastAPI / Starlette — test doubles only need to expose
    ``.client.host`` and ``.headers`` (a mapping).  Passing ``None`` is
    supported for callers that do not have a request object (batch jobs,
    lifespan-level audit events).
    """
    client = getattr(request, "client", None) if request is not None else None
    source_ip = getattr(client, "host", None) if client is not None else None

    headers = getattr(request, "headers", None) if request is not None else None
    user_agent: str | None = None
    if headers is not None:
        try:
            user_agent = headers.get("user-agent") or headers.get("User-Agent")
        except AttributeError:
            user_agent = None
    correlation_id = _extract_correlation_id(headers)

    return AuditEvent(
        actor=_actor_from_user(user),
        action=action,
        resource=resource,
        outcome=outcome,
        before=before,
        after=after,
        correlation_id=correlation_id,
        source_ip=source_ip,
        user_agent=user_agent,
        reason=reason,
    )


__all__ = [
    "ALLOWED_ACTIONS",
    "AuditEvent",
    "AuditLogger",
    "audit_event_from_request",
    "audit_logger",
]
