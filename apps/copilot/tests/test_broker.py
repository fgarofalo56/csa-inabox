"""Tests for :mod:`apps.copilot.broker.broker` (CSA-0102).

Full broker lifecycle is covered end-to-end: request → approve →
verify → used.  Negative paths (expiry, bad signature, replay,
four-eyes violation) are exercised exhaustively because they are
what stops a compromised planner from elevating itself.

The tamper-evident audit chain is asserted by emitting a sequence of
events and running :meth:`BrokerAuditLogger.verify_chain` against the
captured sequence.  A deliberate mutation of one event's reason
string breaks the chain — this is the "tamper" test.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from apps.copilot.broker import (
    BrokerAuditEvent,
    BrokerAuditLogger,
    BrokerDecision,
    BrokerVerificationError,
    ConfirmationBroker,
    ConfirmationRequest,
    FourEyesViolationError,
    MissingSigningKeyError,
    TokenExpiredError,
    reset_broker_chain_for_testing,
)
from apps.copilot.broker.broker import compute_input_hash
from apps.copilot.config import CopilotSettings


@pytest.fixture(autouse=True)
def _reset_chain() -> None:
    """Each test starts from a fresh broker audit chain head."""
    reset_broker_chain_for_testing()


@pytest.fixture
def settings() -> CopilotSettings:
    """Settings with a fixed signing key for deterministic signatures."""
    return CopilotSettings(
        broker_signing_key="unit-test-signing-key",
        broker_token_ttl_seconds=300,
        broker_token_salt="unit.test.salt",
    )


@pytest.fixture
def four_eyes_settings() -> CopilotSettings:
    """Settings with four-eyes mode enabled."""
    return CopilotSettings(
        broker_signing_key="unit-test-signing-key",
        broker_token_ttl_seconds=300,
        broker_require_four_eyes=True,
    )


def _make_request(
    *,
    request_id: str = "req-1",
    tool_name: str = "run_alembic_upgrade",
    caller: str = "alice@example.com",
    payload: dict[str, object] | None = None,
) -> ConfirmationRequest:
    """Return a minimally-populated :class:`ConfirmationRequest`."""
    hash_value = compute_input_hash(payload or {"revision": "head"})
    return ConfirmationRequest(
        request_id=request_id,
        tool_name=tool_name,
        caller_principal=caller,
        scope="dev",
        input_hash=hash_value,
        justification="Initial schema migration",
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_then_approve_emits_signed_token(settings: CopilotSettings) -> None:
    """A full request → approve cycle must produce a verifiable token."""
    broker = ConfirmationBroker(settings)
    req = _make_request()

    decision = await broker.request(req)
    assert decision == BrokerDecision.pending

    token = await broker.approve(req.request_id, approver_principal="bob@example.com")
    assert token.tool_name == req.tool_name
    assert token.caller_principal == req.caller_principal
    assert token.approver_principal == "bob@example.com"
    assert token.decision == BrokerDecision.approved
    assert token.is_expired() is False
    assert token.token  # non-empty signed string


@pytest.mark.asyncio
async def test_verify_succeeds_for_valid_token(settings: CopilotSettings) -> None:
    """``verify`` returns True once, then refuses replay."""
    broker = ConfirmationBroker(settings)
    req = _make_request()
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")

    assert await broker.verify(token, req.tool_name, req.input_hash) is True

    # Replay must fail.
    with pytest.raises(BrokerVerificationError, match="already been consumed"):
        await broker.verify(token, req.tool_name, req.input_hash)


# ---------------------------------------------------------------------------
# Negative paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_verify_rejects_input_hash_mismatch(settings: CopilotSettings) -> None:
    """A token bound to input A cannot authorise input B."""
    broker = ConfirmationBroker(settings)
    req = _make_request()
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")

    with pytest.raises(BrokerVerificationError, match="input_hash"):
        await broker.verify(token, req.tool_name, "deadbeef" * 8)


@pytest.mark.asyncio
async def test_verify_rejects_tool_mismatch(settings: CopilotSettings) -> None:
    """A token for tool X must not authorise tool Y."""
    broker = ConfirmationBroker(settings)
    req = _make_request(tool_name="publish_draft_adr")
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")

    with pytest.raises(BrokerVerificationError, match="tool"):
        await broker.verify(token, "run_alembic_upgrade", req.input_hash)


@pytest.mark.asyncio
async def test_verify_rejects_expired_token() -> None:
    """A token past its ``expires_at`` must raise ``TokenExpiredError``."""
    # Fix "now" so issuance happens well before expiry then jump ahead.
    current = datetime(2026, 4, 20, 10, 0, 0, tzinfo=timezone.utc)

    class _Clock:
        def __init__(self) -> None:
            self.value = current

        def __call__(self) -> datetime:
            return self.value

    clock = _Clock()
    settings = CopilotSettings(broker_signing_key="k", broker_token_ttl_seconds=60)
    broker = ConfirmationBroker(settings, now=clock)
    req = _make_request()
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")

    clock.value = current + timedelta(seconds=120)
    with pytest.raises(TokenExpiredError):
        await broker.verify(token, req.tool_name, req.input_hash)


@pytest.mark.asyncio
async def test_deny_transitions_to_denied(settings: CopilotSettings) -> None:
    """Deny must transition the pending request and emit a denial event."""
    broker = ConfirmationBroker(settings)
    req = _make_request()
    await broker.request(req)
    decision = await broker.deny(req.request_id, "bob@example.com", reason="Too risky")
    assert decision == BrokerDecision.denied

    # Subsequent approve attempts should fail — the request was consumed.
    with pytest.raises(KeyError):
        await broker.approve(req.request_id, "bob@example.com")


@pytest.mark.asyncio
async def test_deny_requires_reason(settings: CopilotSettings) -> None:
    """An empty reason on deny is unacceptable."""
    broker = ConfirmationBroker(settings)
    req = _make_request()
    await broker.request(req)
    with pytest.raises(ValueError, match="non-empty reason"):
        await broker.deny(req.request_id, "bob@example.com", reason="")


@pytest.mark.asyncio
async def test_four_eyes_blocks_self_approval(four_eyes_settings: CopilotSettings) -> None:
    """Four-eyes mode must reject same-principal approval."""
    broker = ConfirmationBroker(four_eyes_settings)
    req = _make_request(caller="alice@example.com")
    await broker.request(req)
    with pytest.raises(FourEyesViolationError):
        await broker.approve(req.request_id, "alice@example.com")


@pytest.mark.asyncio
async def test_four_eyes_allows_different_approver(four_eyes_settings: CopilotSettings) -> None:
    """Four-eyes mode permits a different principal."""
    broker = ConfirmationBroker(four_eyes_settings)
    req = _make_request(caller="alice@example.com")
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")
    assert token.approver_principal == "bob@example.com"


@pytest.mark.asyncio
async def test_missing_signing_key_fails_closed() -> None:
    """With no signing key, the broker refuses to mint tokens."""
    settings = CopilotSettings(broker_signing_key="")
    broker = ConfirmationBroker(settings)
    req = _make_request()
    await broker.request(req)
    with pytest.raises(MissingSigningKeyError):
        await broker.approve(req.request_id, "bob@example.com")


@pytest.mark.asyncio
async def test_duplicate_request_id_rejected(settings: CopilotSettings) -> None:
    """The broker refuses two pending requests with the same id."""
    broker = ConfirmationBroker(settings)
    req = _make_request()
    await broker.request(req)
    with pytest.raises(ValueError, match="already pending"):
        await broker.request(req)


# ---------------------------------------------------------------------------
# Audit chain — tamper-evidence
# ---------------------------------------------------------------------------


def _capture_audit_events() -> tuple[BrokerAuditLogger, list[BrokerAuditEvent]]:
    """Build a fresh audit logger that captures every emitted event."""
    logger = BrokerAuditLogger(logger_name="csa.audit.broker.test")
    captured: list[BrokerAuditEvent] = []
    original_emit = logger.emit

    def _capture(event: BrokerAuditEvent) -> BrokerAuditEvent:
        result = original_emit(event)
        captured.append(result)
        return result

    logger.emit = _capture  # type: ignore[method-assign]
    return logger, captured


@pytest.mark.asyncio
async def test_audit_chain_verifies_after_n_events(settings: CopilotSettings) -> None:
    """A sequence of broker actions produces a verifiable SHA-256 chain."""
    audit, captured = _capture_audit_events()
    broker = ConfirmationBroker(settings, audit=audit)

    req = _make_request()
    await broker.request(req)
    token = await broker.approve(req.request_id, "bob@example.com")
    await broker.verify(token, req.tool_name, req.input_hash)

    # request + approve + used — three events.
    assert [e.action for e in captured] == [
        "broker.request",
        "broker.approve",
        "broker.used",
    ]
    assert all(e.chain_hash is not None for e in captured)
    assert BrokerAuditLogger.verify_chain(captured) is True


@pytest.mark.asyncio
async def test_audit_chain_detects_tamper(settings: CopilotSettings) -> None:
    """Mutating a captured event's reason must break verification."""
    audit, captured = _capture_audit_events()
    broker = ConfirmationBroker(settings, audit=audit)

    req = _make_request()
    await broker.request(req)
    await broker.deny(req.request_id, "bob@example.com", reason="policy violation")

    assert BrokerAuditLogger.verify_chain(captured) is True

    # Tamper: change the deny reason on the second event.  The frozen
    # AuditEvent uses ``extra='forbid'`` but the ``reason`` field is
    # mutable — we create a copy with a different reason to simulate
    # an attacker replacing the event in the log.
    tampered = [
        captured[0],
        captured[1].model_copy(update={"reason": "approved (lie)"}),
    ]
    assert BrokerAuditLogger.verify_chain(tampered) is False


@pytest.mark.asyncio
async def test_audit_chain_rejects_missing_hash(settings: CopilotSettings) -> None:
    """An event whose chain_hash was stripped fails verification."""
    audit, captured = _capture_audit_events()
    broker = ConfirmationBroker(settings, audit=audit)
    req = _make_request()
    await broker.request(req)

    stripped = [captured[0].model_copy(update={"chain_hash": None})]
    assert BrokerAuditLogger.verify_chain(stripped) is False


def test_broker_audit_event_requires_reason_on_failure() -> None:
    """An audit event with outcome=denied must include a reason."""
    logger = BrokerAuditLogger(logger_name="csa.audit.broker.reason-test")
    with pytest.raises(ValueError, match="reason"):
        logger.emit(
            BrokerAuditEvent(
                actor={"principal": "tester"},
                action="broker.deny",
                resource={"tool_name": "t", "request_id": "r"},
                outcome="denied",
                reason=None,
            ),
        )


def test_broker_audit_event_rejects_unknown_action() -> None:
    """Actions outside the allowlist are rejected at emit time."""
    logger = BrokerAuditLogger(logger_name="csa.audit.broker.action-test")
    with pytest.raises(ValueError, match="Unknown broker audit action"):
        logger.emit(
            BrokerAuditEvent(
                actor={"principal": "tester"},
                action="broker.hax",
                resource={"tool_name": "t"},
                outcome="success",
            ),
        )


# ---------------------------------------------------------------------------
# compute_input_hash
# ---------------------------------------------------------------------------


def test_compute_input_hash_is_deterministic() -> None:
    """The hash is stable across dict orderings and Python versions."""
    a = compute_input_hash({"foo": 1, "bar": 2})
    b = compute_input_hash({"bar": 2, "foo": 1})
    assert a == b


def test_compute_input_hash_handles_pydantic_models(settings: CopilotSettings) -> None:  # noqa: ARG001
    """A Pydantic model is hashable via ``model_dump``."""
    req = _make_request(request_id="x", payload={"revision": "abc123"})
    hash_value = compute_input_hash(req)
    assert len(hash_value) == 64  # SHA-256 hex digest
