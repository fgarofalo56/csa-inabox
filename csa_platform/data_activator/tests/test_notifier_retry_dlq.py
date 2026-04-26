"""CSA-0049 — Data Activator retry + DLQ tests.

Coverage matrix (per the CSA-0049 finding):

1. ``test_retry_then_succeed_transient`` (x3 across TeamsNotifier,
   WebhookNotifier, IncidentCreator) — transient failures are retried
   with exponential backoff and the final attempt delivers the payload.

2. ``test_retry_exhausted_sends_to_dlq`` — exhausting the retry budget
   pushes a ``transient_exhausted`` envelope to the configured DLQ and
   returns ``False``.

3. ``test_fatal_error_skips_retry`` — :class:`DataActivatorFatalError`
   (4xx auth) bypasses retry entirely and lands in the DLQ as ``fatal``.

The tests also exercise the :class:`InMemoryDLQ` invariant set — it
captures every envelope and never blocks the hot path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from csa_platform.data_activator.actions.dlq import (
    DLQEnvelope,
    InMemoryDLQ,
    NullDLQ,
)
from csa_platform.data_activator.actions.errors import (
    DataActivatorFatalError,
    DataActivatorTransientError,
)
from csa_platform.data_activator.actions.notifier import (
    AlertPayload,
    IncidentCreator,
    TeamsNotifier,
    WebhookNotifier,
    _classify_http_error,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def dlq() -> InMemoryDLQ:
    return InMemoryDLQ()


@pytest.fixture
def alert_payload() -> AlertPayload:
    return AlertPayload(
        rule_name="temp-spike",
        description="Sensor 42 exceeded 45C",
        severity="critical",
        field="temperature_c",
        actual_value=48.7,
        threshold=45.0,
        timestamp="2026-04-20T12:00:00Z",
        source="iot/sensor-42",
        metadata={"domain": "iot"},
    )


@dataclass
class FakeResp:
    status_code: int = 200

    def raise_for_status(self) -> None:
        import requests

        if self.status_code >= 400:
            err = requests.HTTPError(f"{self.status_code}")
            err.response = self  # type: ignore[attr-defined, unused-ignore]
            raise err


def _http_error(status_code: int) -> Any:
    import requests

    resp = FakeResp(status_code=status_code)
    err = requests.HTTPError(f"http {status_code}")
    err.response = resp  # type: ignore[attr-defined, unused-ignore]
    return err


def _timeout_error() -> Any:
    import requests

    return requests.Timeout("deadline exceeded")


def _connection_error() -> Any:
    import requests

    return requests.ConnectionError("connection refused")


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------


def test_classify_timeout_is_transient() -> None:
    assert isinstance(_classify_http_error(_timeout_error()), DataActivatorTransientError)


def test_classify_connection_is_transient() -> None:
    assert isinstance(_classify_http_error(_connection_error()), DataActivatorTransientError)


@pytest.mark.parametrize("status", [500, 502, 503, 504, 429, 408])
def test_classify_5xx_and_429_are_transient(status: int) -> None:
    assert isinstance(_classify_http_error(_http_error(status)), DataActivatorTransientError)


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_classify_4xx_is_fatal(status: int) -> None:
    assert isinstance(_classify_http_error(_http_error(status)), DataActivatorFatalError)


# ---------------------------------------------------------------------------
# Retry-then-succeed (3 variants — Teams, Webhook, Incident)
# ---------------------------------------------------------------------------


def test_teams_retry_then_succeed(
    dlq: InMemoryDLQ,
    alert_payload: AlertPayload,
) -> None:
    """First 2 attempts raise 503; 3rd succeeds."""
    with patch(
        "csa_platform.data_activator.actions.notifier.requests.post",
    ) as post:
        post.side_effect = _sequential(
            _http_error(503),
            _http_error(503),
            FakeResp(status_code=200),
        )
        notifier = TeamsNotifier(
            webhook_url="https://teams.example.gov/webhook",
            retry_attempts=3,
            dlq=dlq,
        )
        ok = notifier.send(alert_payload)

    assert ok is True
    assert post.call_count == 3
    assert dlq.envelopes == []  # no DLQ on success


def test_webhook_retry_then_succeed(
    dlq: InMemoryDLQ,
    alert_payload: AlertPayload,
) -> None:
    """Transient ConnectionError twice, then 200."""
    with patch(
        "csa_platform.data_activator.actions.notifier.requests.post",
    ) as post:
        post.side_effect = _sequential(
            _connection_error(),
            _timeout_error(),
            FakeResp(status_code=200),
        )
        notifier = WebhookNotifier(
            url="https://hooks.example.gov/alert",
            retry_attempts=3,
            dlq=dlq,
        )
        ok = notifier.send(alert_payload)

    assert ok is True
    assert post.call_count == 3
    assert dlq.envelopes == []


def test_incident_retry_then_succeed(
    dlq: InMemoryDLQ,
    alert_payload: AlertPayload,
) -> None:
    """PagerDuty 429 then 500, then success."""
    with patch(
        "csa_platform.data_activator.actions.notifier.requests.post",
    ) as post:
        post.side_effect = _sequential(
            _http_error(429),
            _http_error(500),
            FakeResp(status_code=202),
        )
        creator = IncidentCreator(
            service="pagerduty",
            api_key="routing-key-abc",
            retry_attempts=3,
            dlq=dlq,
        )
        ok = creator.send(alert_payload)

    assert ok is True
    assert post.call_count == 3
    assert dlq.envelopes == []


# ---------------------------------------------------------------------------
# Retry exhausted → DLQ
# ---------------------------------------------------------------------------


def test_retry_exhausted_sends_to_dlq(
    dlq: InMemoryDLQ,
    alert_payload: AlertPayload,
) -> None:
    """All 3 attempts fail with transient — payload lands in DLQ."""
    with patch(
        "csa_platform.data_activator.actions.notifier.requests.post",
    ) as post:
        post.side_effect = _sequential(
            _http_error(503),
            _http_error(503),
            _http_error(503),
        )
        notifier = TeamsNotifier(
            webhook_url="https://teams.example.gov/webhook",
            retry_attempts=3,
            dlq=dlq,
        )
        ok = notifier.send(alert_payload)

    assert ok is False
    assert post.call_count == 3  # exactly max_attempts tries
    assert len(dlq.envelopes) == 1
    env = dlq.envelopes[0]
    assert env.failure_reason == "transient_exhausted"
    assert env.notifier_type == "teams"
    assert env.rule_name == "temp-spike"
    assert env.attempts == 3
    assert "DataActivatorTransientError" in env.error_class
    assert env.payload["rule_name"] == "temp-spike"
    assert env.payload["severity"] == "critical"


# ---------------------------------------------------------------------------
# Fatal error → skip retry → DLQ
# ---------------------------------------------------------------------------


def test_fatal_error_skips_retry(
    dlq: InMemoryDLQ,
    alert_payload: AlertPayload,
) -> None:
    """403 Forbidden (fatal) — exactly 1 attempt, lands in DLQ as 'fatal'."""
    with patch(
        "csa_platform.data_activator.actions.notifier.requests.post",
    ) as post:
        post.side_effect = _sequential(_http_error(403))
        notifier = WebhookNotifier(
            url="https://hooks.example.gov/alert",
            retry_attempts=5,  # intentionally high — should NOT be used
            dlq=dlq,
        )
        ok = notifier.send(alert_payload)

    assert ok is False
    assert post.call_count == 1  # NO retry on fatal
    assert len(dlq.envelopes) == 1
    env = dlq.envelopes[0]
    assert env.failure_reason == "fatal"
    assert env.notifier_type == "webhook"
    assert env.attempts == 1
    assert "DataActivatorFatalError" in env.error_class


# ---------------------------------------------------------------------------
# DLQ envelope shape
# ---------------------------------------------------------------------------


def test_dlq_envelope_is_json_serializable(alert_payload: AlertPayload) -> None:
    env = DLQEnvelope.build(
        rule_name=alert_payload.rule_name,
        notifier_type="teams",
        failure_reason="transient_exhausted",
        error=DataActivatorTransientError("timeout"),
        attempts=3,
        payload={"rule_name": alert_payload.rule_name, "severity": "critical"},
    )
    body = env.to_json()
    assert '"failure_reason":"transient_exhausted"' in body
    assert '"attempts":3' in body
    assert "temp-spike" in body


def test_null_dlq_returns_false_and_logs() -> None:
    null = NullDLQ()
    env = DLQEnvelope.build(
        rule_name="x",
        notifier_type="teams",
        failure_reason="fatal",
        error=DataActivatorFatalError("403"),
        attempts=1,
        payload={},
    )
    assert null.send(env) is False


# ---------------------------------------------------------------------------
# AzureStorageQueueDLQ (mocked client)
# ---------------------------------------------------------------------------


def test_azure_storage_queue_dlq_sends_via_client(alert_payload: AlertPayload) -> None:
    from csa_platform.data_activator.actions.dlq import AzureStorageQueueDLQ

    mock_client = MagicMock()
    dlq = AzureStorageQueueDLQ(
        connection_string="UseDevelopmentStorage=true",
        queue_name="test-dlq",
        client=mock_client,
        base64_encode=True,
    )
    env = DLQEnvelope.build(
        rule_name=alert_payload.rule_name,
        notifier_type="teams",
        failure_reason="fatal",
        error=DataActivatorFatalError("403"),
        attempts=1,
        payload={"rule_name": alert_payload.rule_name},
    )
    ok = dlq.send(env)

    assert ok is True
    mock_client.send_message.assert_called_once()
    # Body should be base64-encoded JSON
    sent_body = mock_client.send_message.call_args.args[0]
    import base64

    decoded = base64.b64decode(sent_body).decode("utf-8")
    assert "temp-spike" in decoded
    assert "transient_exhausted" in decoded or "fatal" in decoded


def test_azure_storage_queue_dlq_swallows_send_errors(
    alert_payload: AlertPayload,
) -> None:
    """DLQ send failures never crash the notifier loop."""
    from csa_platform.data_activator.actions.dlq import AzureStorageQueueDLQ

    mock_client = MagicMock()
    mock_client.send_message.side_effect = RuntimeError("queue down")
    dlq = AzureStorageQueueDLQ(
        connection_string="UseDevelopmentStorage=true",
        queue_name="test-dlq",
        client=mock_client,
    )
    env = DLQEnvelope.build(
        rule_name=alert_payload.rule_name,
        notifier_type="teams",
        failure_reason="fatal",
        error=DataActivatorFatalError("403"),
        attempts=1,
        payload={},
    )
    assert dlq.send(env) is False


# ---------------------------------------------------------------------------
# Notifier without valid config returns False, does NOT hit DLQ
# ---------------------------------------------------------------------------


def test_notifier_without_config_returns_false_without_dlq(
    dlq: InMemoryDLQ,
    alert_payload: AlertPayload,
) -> None:
    notifier = TeamsNotifier(webhook_url="", retry_attempts=3, dlq=dlq)
    assert notifier.send(alert_payload) is False
    assert dlq.envelopes == []  # misconfig is user error, not a delivery failure


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sequential(*items: Any) -> Any:
    """Return a ``side_effect`` callable that replays ``items`` in order.

    Mock's ``side_effect`` list doesn't distinguish "return this" from
    "raise this" cleanly — HTTPError without a ``response`` attribute
    confuses our classifier.  This helper sequences calls explicitly:
    exceptions are raised, other values are returned, and running off
    the end raises StopIteration.
    """
    iterator = iter(items)

    def _apply(*_a: Any, **_kw: Any) -> Any:
        item = next(iterator)
        if isinstance(item, BaseException):
            raise item
        return item

    return _apply
