"""Confirmation broker — CSA-0102 (AQ-0004).

The broker issues, validates, and audits opaque ``ConfirmationToken``
strings that gate every execute-class Copilot tool invocation.  Tokens
are signed HMACs with an explicit expiry, scope, and input-hash
binding.  Every decision (request / approve / deny / used / rejected)
produces a tamper-evident audit event chained via SHA-256.

Public surface::

    from apps.copilot.broker import (
        BrokerDecision,
        ConfirmationBroker,
        ConfirmationRequest,
        ConfirmationToken,
        MissingSigningKeyError,
    )
"""

from __future__ import annotations

from apps.copilot.broker.audit import (
    BrokerAuditEvent,
    BrokerAuditLogger,
    broker_audit_logger,
    reset_broker_chain_for_testing,
)
from apps.copilot.broker.broker import (
    BrokerVerificationError,
    ConfirmationBroker,
    FourEyesViolationError,
    MissingSigningKeyError,
    TokenExpiredError,
)
from apps.copilot.broker.models import (
    BrokerDecision,
    ConfirmationRequest,
    ConfirmationToken,
)

__all__ = [
    "BrokerAuditEvent",
    "BrokerAuditLogger",
    "BrokerDecision",
    "BrokerVerificationError",
    "ConfirmationBroker",
    "ConfirmationRequest",
    "ConfirmationToken",
    "FourEyesViolationError",
    "MissingSigningKeyError",
    "TokenExpiredError",
    "broker_audit_logger",
    "reset_broker_chain_for_testing",
]
