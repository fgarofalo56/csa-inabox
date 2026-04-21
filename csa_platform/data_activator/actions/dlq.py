"""Dead-letter queue (DLQ) for Data Activator notifications.

Events that exhaust their retry budget OR raise
:class:`~csa_platform.data_activator.actions.errors.DataActivatorFatalError`
are pushed to a durable sink so operators can inspect, replay, or dead-end
them.  The primary sink is an Azure Storage Queue (configured via the
``DATA_ACTIVATOR_DLQ_CONNECTION_STRING`` environment variable), but the
module also supplies a memory-backed :class:`InMemoryDLQ` for tests and a
:class:`NullDLQ` that logs-and-drops when no DLQ is configured.

Patterns reused from :mod:`csa_platform.streaming.breach_publisher`:
  * Lazy Azure SDK imports so unit tests never need the SDK installed.
  * Protocol-based so test fixtures can swap implementations freely.
  * Failures inside the DLQ itself are logged but NEVER re-raised — the
    DLQ is a best-effort last resort, not a hard dependency of the
    notification loop.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, runtime_checkable

from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Envelope
# ---------------------------------------------------------------------------


@dataclass
class DLQEnvelope:
    """Standard envelope for dead-lettered notification events.

    Attributes:
        rule_name: Alert rule that produced the payload.
        notifier_type: ``"teams" | "webhook" | "email" | "incident"`` etc.
        failure_reason: One of ``"transient_exhausted"`` or ``"fatal"``.
        error_class: Qualified class name of the raised error.
        error_message: Human-readable error string.
        attempts: Total attempts made (including the fatal/final one).
        payload: The original alert payload (serialized).
        occurred_at: ISO-8601 UTC timestamp when the event was dead-lettered.
    """

    rule_name: str
    notifier_type: str
    failure_reason: str
    error_class: str
    error_message: str
    attempts: int
    payload: dict[str, Any]
    occurred_at: str

    @classmethod
    def build(
        cls,
        *,
        rule_name: str,
        notifier_type: str,
        failure_reason: str,
        error: BaseException,
        attempts: int,
        payload: dict[str, Any],
    ) -> DLQEnvelope:
        return cls(
            rule_name=rule_name,
            notifier_type=notifier_type,
            failure_reason=failure_reason,
            error_class=f"{type(error).__module__}.{type(error).__qualname__}",
            error_message=str(error),
            attempts=attempts,
            payload=payload,
            occurred_at=datetime.now(timezone.utc).isoformat(),
        )

    def to_json(self) -> str:
        return json.dumps(asdict(self), default=str, separators=(",", ":"))


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class DeadLetterQueue(Protocol):
    """Protocol every DLQ implementation must satisfy."""

    def send(self, envelope: DLQEnvelope) -> bool:  # pragma: no cover - interface
        """Enqueue ``envelope``.  Return ``True`` on success."""
        ...


# ---------------------------------------------------------------------------
# Null DLQ
# ---------------------------------------------------------------------------


class NullDLQ:
    """No-op DLQ that logs the envelope at WARNING level and drops it.

    Used when ``DATA_ACTIVATOR_DLQ_CONNECTION_STRING`` is not set so the
    notifier path degrades gracefully without crashing.
    """

    def send(self, envelope: DLQEnvelope) -> bool:
        logger.warning(
            "data_activator.dlq.not_configured",
            rule_name=envelope.rule_name,
            notifier_type=envelope.notifier_type,
            failure_reason=envelope.failure_reason,
            error_class=envelope.error_class,
            attempts=envelope.attempts,
        )
        return False


# ---------------------------------------------------------------------------
# In-memory DLQ (tests + local dev)
# ---------------------------------------------------------------------------


class InMemoryDLQ:
    """In-memory DLQ used by tests and local development.

    Exposes :attr:`envelopes` for assertion and :meth:`clear` for
    fixture reset.
    """

    def __init__(self) -> None:
        self.envelopes: list[DLQEnvelope] = []

    def send(self, envelope: DLQEnvelope) -> bool:
        self.envelopes.append(envelope)
        logger.info(
            "data_activator.dlq.enqueued_memory",
            rule_name=envelope.rule_name,
            notifier_type=envelope.notifier_type,
            failure_reason=envelope.failure_reason,
            attempts=envelope.attempts,
        )
        return True

    def clear(self) -> None:
        self.envelopes.clear()


# ---------------------------------------------------------------------------
# Azure Storage Queue DLQ
# ---------------------------------------------------------------------------


def _load_queue_client() -> Any:
    """Lazy import of :class:`azure.storage.queue.QueueClient`."""
    from azure.storage.queue import QueueClient  # type: ignore[import-not-found]

    return QueueClient


class AzureStorageQueueDLQ:
    """Azure Storage Queue backed DLQ.

    Args:
        connection_string: Azure Storage connection string.
        queue_name: Queue name (default ``data-activator-dlq``).
        client: Optional pre-built queue client (tests inject mocks here).
        base64_encode: Whether to base64-encode the envelope JSON before
            sending.  The default ``True`` matches the Azure Functions
            queue-trigger default encoding and keeps JSON payloads safe
            across HTTP transport.

    The queue is created on first send if it does not exist.  All send
    failures are logged and swallowed — the DLQ must never crash the
    notifier loop.
    """

    DEFAULT_QUEUE_NAME = "data-activator-dlq"

    def __init__(
        self,
        *,
        connection_string: str = "",
        queue_name: str = "",
        client: Any | None = None,
        base64_encode: bool = True,
    ) -> None:
        self._connection_string = connection_string or os.environ.get(
            "DATA_ACTIVATOR_DLQ_CONNECTION_STRING",
            "",
        )
        self._queue_name = queue_name or os.environ.get(
            "DATA_ACTIVATOR_DLQ_QUEUE_NAME",
            self.DEFAULT_QUEUE_NAME,
        )
        self._client_override = client
        self._base64_encode = base64_encode
        self._client: Any | None = client
        self._ensured = False

    @property
    def queue_name(self) -> str:
        return self._queue_name

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not self._connection_string:
            raise RuntimeError(
                "AzureStorageQueueDLQ requires DATA_ACTIVATOR_DLQ_CONNECTION_STRING",
            )
        client_cls = _load_queue_client()
        self._client = client_cls.from_connection_string(
            conn_str=self._connection_string,
            queue_name=self._queue_name,
        )
        return self._client

    def _ensure_queue(self, client: Any) -> None:
        if self._ensured:
            return
        try:
            client.create_queue()
        except Exception:  # noqa: BLE001 — create_queue raises a grab-bag of SDK errors
            # Queue already exists / forbidden / transient — keep going; the
            # send call is the real authority on whether the queue works.
            pass
        self._ensured = True

    def send(self, envelope: DLQEnvelope) -> bool:
        """Enqueue the envelope.  Always returns a bool; never raises."""
        try:
            client = self._ensure_client()
        except Exception:  # noqa: BLE001 — defensive guard
            logger.exception(
                "data_activator.dlq.client_unavailable",
                rule_name=envelope.rule_name,
                queue_name=self._queue_name,
            )
            return False

        self._ensure_queue(client)

        body = envelope.to_json()
        if self._base64_encode:
            body = base64.b64encode(body.encode("utf-8")).decode("ascii")

        try:
            client.send_message(body)
        except Exception:  # noqa: BLE001 — defensive guard
            logger.exception(
                "data_activator.dlq.send_failed",
                rule_name=envelope.rule_name,
                notifier_type=envelope.notifier_type,
                queue_name=self._queue_name,
            )
            return False

        logger.info(
            "data_activator.dlq.enqueued",
            rule_name=envelope.rule_name,
            notifier_type=envelope.notifier_type,
            failure_reason=envelope.failure_reason,
            attempts=envelope.attempts,
            queue_name=self._queue_name,
        )
        return True


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_default_dlq() -> DeadLetterQueue:
    """Return the default DLQ for this process.

    If ``DATA_ACTIVATOR_DLQ_CONNECTION_STRING`` is set, return an
    :class:`AzureStorageQueueDLQ`; otherwise return :class:`NullDLQ`.
    """
    conn = os.environ.get("DATA_ACTIVATOR_DLQ_CONNECTION_STRING", "")
    if conn:
        return AzureStorageQueueDLQ(connection_string=conn)
    return NullDLQ()


__all__ = [
    "AzureStorageQueueDLQ",
    "DLQEnvelope",
    "DeadLetterQueue",
    "InMemoryDLQ",
    "NullDLQ",
    "get_default_dlq",
]
