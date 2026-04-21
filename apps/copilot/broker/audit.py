"""Broker audit sink — reuses CSA-0016 primitives for tamper-evidence.

The confirmation broker (CSA-0102) emits a strictly separate stream of
audit events: request / approve / deny / used / rejected / expired.
These actions are not part of the closed
:data:`csa_platform.common.audit.ALLOWED_ACTIONS` set because they are
specific to the Copilot broker and do not belong in the platform-wide
allowlist.

Rather than reimplement the hash chain, we reuse the pure hashing
primitive (``_compute_chain_hash``) and the :class:`AuditEvent` schema
from :mod:`csa_platform.common.audit` — but with an independent
process-local chain head and an isolated allowlist of broker-specific
actions.  This keeps the tamper-evidence guarantees identical to the
platform audit logger while respecting the module boundary laid out
by CSA-0016 (the platform allowlist is a stable contract; callers add
new actions via that module, not by monkey-patching it).

The broker audit logger writes to a dedicated ``csa.audit.broker``
namespace so operators can route broker events to their own SIEM
pipeline independently of general audit traffic.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Re-use the SHA-256 chain hash primitive from CSA-0016 without
# reimplementing it.  The helper is intentionally private in the
# platform module; we import by attribute access and surface a clean
# local name so downstream readers can see the lineage.
from csa_platform.common import audit as _csa_audit

_compute_chain_hash = _csa_audit._compute_chain_hash


# ─────────────────────────────────────────────────────────────────────
# Broker-specific action allowlist
# ─────────────────────────────────────────────────────────────────────

BrokerAction = Literal[
    "broker.request",
    "broker.approve",
    "broker.deny",
    "broker.used",
    "broker.rejected",
    "broker.expired",
]

ALLOWED_BROKER_ACTIONS: frozenset[str] = frozenset(
    {
        "broker.request",
        "broker.approve",
        "broker.deny",
        "broker.used",
        "broker.rejected",
        "broker.expired",
    }
)

BrokerOutcome = Literal["success", "denied", "error"]


# ─────────────────────────────────────────────────────────────────────
# BrokerAuditEvent — mirrors csa_platform.common.audit.AuditEvent
# ─────────────────────────────────────────────────────────────────────


class BrokerAuditEvent(BaseModel):
    """Audit event for a broker lifecycle transition.

    The schema mirrors :class:`csa_platform.common.audit.AuditEvent`
    (actor/resource/outcome/before/after) and uses the same canonical
    JSON serialisation so downstream SIEM parsers can treat both
    streams uniformly.
    """

    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    actor: dict[str, Any] = Field(
        ...,
        description="Identity of the principal performing the broker action.",
    )
    action: str = Field(..., description="One of ALLOWED_BROKER_ACTIONS.")
    resource: dict[str, Any] = Field(
        ...,
        description="Resource descriptor: tool_name, request_id, token_id, scope.",
    )
    outcome: BrokerOutcome = Field(..., description="success | denied | error.")
    before: dict[str, Any] | None = Field(default=None)
    after: dict[str, Any] | None = Field(default=None)
    reason: str | None = Field(
        default=None,
        description="Required when outcome in {denied, error}; optional otherwise.",
    )
    chain_hash: str | None = Field(
        default=None,
        description="SHA-256 chain hash populated by BrokerAuditLogger.emit.",
    )

    model_config = ConfigDict(extra="forbid")

    def canonical_json(self) -> str:
        """Deterministic JSON serialisation used for hashing."""
        payload = self.model_dump(mode="json", exclude={"chain_hash"})
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))


# ─────────────────────────────────────────────────────────────────────
# Chain state (process-local, lock-protected)
# ─────────────────────────────────────────────────────────────────────

_GENESIS_HASH = hashlib.sha256(b"apps.copilot.broker.audit.genesis.v1").hexdigest()

_chain_lock = threading.Lock()
_previous_hash: str = _GENESIS_HASH


def reset_broker_chain_for_testing() -> None:
    """Reset the broker chain head to genesis. Test-only helper."""
    global _previous_hash
    with _chain_lock:
        _previous_hash = _GENESIS_HASH


def get_broker_genesis_hash() -> str:
    """Return the genesis hash used to anchor the broker chain."""
    return _GENESIS_HASH


# ─────────────────────────────────────────────────────────────────────
# BrokerAuditLogger
# ─────────────────────────────────────────────────────────────────────


_BROKER_AUDIT_LOGGER_NAME = "csa.audit.broker"


class BrokerAuditLogger:
    """Tamper-evident audit sink for confirmation broker events.

    The logger shares the SHA-256 chain construction with CSA-0016
    (:mod:`csa_platform.common.audit`) but keeps an independent chain
    head so broker events are only ordered relative to each other.
    The stdlib logger name is ``csa.audit.broker`` so operators can
    route this stream to a dedicated sink.
    """

    def __init__(self, logger_name: str = _BROKER_AUDIT_LOGGER_NAME) -> None:
        self._logger = logging.getLogger(logger_name)
        if self._logger.level == logging.NOTSET:
            self._logger.setLevel(logging.INFO)
        self._logger.propagate = True

    @staticmethod
    def _validate_action(action: str) -> None:
        if action not in ALLOWED_BROKER_ACTIONS:
            raise ValueError(
                f"Unknown broker audit action {action!r}. Allowed: "
                f"{sorted(ALLOWED_BROKER_ACTIONS)}.",
            )

    def emit(self, event: BrokerAuditEvent) -> BrokerAuditEvent:
        """Chain-hash and record *event*.

        Returns the event with ``chain_hash`` populated so tests and
        callers can assert against the value directly.
        """
        self._validate_action(event.action)
        if event.outcome in ("denied", "error") and not event.reason:
            raise ValueError(
                f"Broker audit events with outcome={event.outcome!r} must "
                "include a `reason`.",
            )

        global _previous_hash
        with _chain_lock:
            canonical = event.canonical_json()
            new_hash = _compute_chain_hash(_previous_hash, canonical)
            event.chain_hash = new_hash
            _previous_hash = new_hash

        self._logger.info(event.model_dump_json())
        return event

    @staticmethod
    def verify_chain(
        events: list[BrokerAuditEvent],
        *,
        previous_hash: str = _GENESIS_HASH,
    ) -> bool:
        """Recompute the chain and confirm every event matches.

        Any mutation of actor/action/resource/outcome/before/after/
        timestamp/reason in any event causes verification to fail at
        that event and every subsequent one.
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


# Process-global singleton used by the broker.
broker_audit_logger = BrokerAuditLogger()


__all__ = [
    "ALLOWED_BROKER_ACTIONS",
    "BrokerAction",
    "BrokerAuditEvent",
    "BrokerAuditLogger",
    "BrokerOutcome",
    "broker_audit_logger",
    "get_broker_genesis_hash",
    "reset_broker_chain_for_testing",
]
