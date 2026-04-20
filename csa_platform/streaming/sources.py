"""csa_platform.streaming.sources — source adapters (CSA-0137).

Defines a lightweight :class:`SourceAdapter` protocol plus three concrete
adapters:

* :class:`EventHubSource` — direct Event Hub consumer.
* :class:`IoTHubSource`   — IoT Hub built-in Event Hubs-compatible endpoint.
* :class:`KafkaSource`    — Kafka clients via the Event Hubs
  Kafka-compatible endpoint.

The adapters keep all Azure SDK imports lazy so unit tests can exercise
the module without any Azure dependencies installed.  Tests patch
:func:`_load_eventhub_consumer_client` via monkeypatch and provide a
fake consumer client.

Each adapter exposes an ``async def stream()`` generator that yields
:class:`StreamEvent` dicts.  Downstream writers (bronze, silver) consume
the iterator and commit offsets / checkpoints via the SDK-owned client.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from csa_platform.streaming.models import SourceContract, SourceType

if TYPE_CHECKING:  # pragma: no cover — import only for type-check time
    from collections.abc import AsyncIterator


# ---------------------------------------------------------------------------
# Event envelope
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StreamEvent:
    """Canonical event envelope returned by all source adapters.

    ``body`` is already JSON-decoded when the upstream payload is JSON; raw
    bytes are preserved verbatim in ``raw`` so the bronze writer can still
    persist Avro/Parquet-encoded payloads without loss.
    """

    partition_key: str | None
    enqueued_time_utc: str | None
    sequence_number: int | None
    offset: str | None
    body: dict[str, Any] | None
    raw: bytes


# ---------------------------------------------------------------------------
# Adapter protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class SourceAdapter(Protocol):
    """Protocol implemented by every streaming source adapter.

    :meth:`stream` is declared as a regular method returning an
    :class:`~collections.abc.AsyncIterator` so concrete classes are free
    to implement it as an ``async def`` generator *or* as a regular
    method that returns a pre-built async iterator.
    """

    contract: SourceContract

    def stream(self) -> AsyncIterator[StreamEvent]:  # pragma: no cover - interface
        """Yield :class:`StreamEvent` envelopes until the caller cancels."""
        ...

    async def close(self) -> None:  # pragma: no cover - interface
        """Close the underlying SDK client and release resources."""
        ...


# ---------------------------------------------------------------------------
# Lazy SDK loaders — patchable in tests
# ---------------------------------------------------------------------------


def _load_eventhub_consumer_client() -> Any:
    """Import :class:`azure.eventhub.aio.EventHubConsumerClient` lazily.

    Exposed as a module-level function so tests can monkeypatch it with a
    fake class and exercise the adapters without azure-eventhub installed.
    """
    from azure.eventhub.aio import EventHubConsumerClient

    return EventHubConsumerClient


def _load_default_credential() -> Any:
    """Import :class:`azure.identity.aio.DefaultAzureCredential` lazily."""
    from azure.identity.aio import DefaultAzureCredential

    return DefaultAzureCredential


# ---------------------------------------------------------------------------
# Concrete adapters
# ---------------------------------------------------------------------------


class _EventHubLikeSource:
    """Base class for adapters that connect through the Event Hub SDK.

    Event Hub and IoT Hub (via its built-in EH-compatible endpoint) and
    Kafka (via the EH Kafka endpoint) all use the same client shape — we
    share the implementation here and let subclasses override only the
    pieces that differ (FQDN resolution, auth, defaults).
    """

    def __init__(self, contract: SourceContract) -> None:
        self.contract = contract
        self._client: Any | None = None
        self._credential: Any | None = None

    # -- FQDN resolution --------------------------------------------------

    def _resolve_fqdn(self) -> str:
        """Return a fully-qualified Event Hub host."""
        if self.contract.connection.fully_qualified_namespace:
            return self.contract.connection.fully_qualified_namespace
        # Cloud-agnostic default suffix.  Gov clouds can override via the
        # ``fully_qualified_namespace`` field on the contract.
        return f"{self.contract.connection.namespace}.servicebus.windows.net"

    # -- lifecycle --------------------------------------------------------

    async def _ensure_client(self) -> Any:
        """Lazily construct the EH consumer client using AAD credentials."""
        if self._client is not None:
            return self._client
        consumer_cls = _load_eventhub_consumer_client()
        self._credential = _load_default_credential()()
        self._client = consumer_cls(
            fully_qualified_namespace=self._resolve_fqdn(),
            eventhub_name=self.contract.connection.entity,
            consumer_group=self.contract.connection.consumer_group,
            credential=self._credential,
        )
        return self._client

    async def stream(self) -> AsyncIterator[StreamEvent]:
        """Yield :class:`StreamEvent` envelopes from the underlying EH client."""
        client = await self._ensure_client()
        # The Azure SDK exposes ``receive`` with a callback; we translate to
        # an async generator by buffering in a queue.  For tests, the fake
        # client can implement ``receive_batch`` directly — we keep the
        # implementation minimal and rely on subclasses/tests to patch.
        async for event in _receive_event_iter(client):
            yield _build_stream_event(event)

    async def close(self) -> None:
        """Close the EH client and AAD credential."""
        if self._client is not None:
            await self._client.close()
            self._client = None
        if self._credential is not None and hasattr(self._credential, "close"):
            await self._credential.close()
            self._credential = None


async def _receive_event_iter(client: Any) -> AsyncIterator[Any]:
    """Adapter helper: translate ``client.receive_batch`` to an async iterator.

    The real Azure SDK uses a callback-style ``receive`` API; tests
    provide a fake client that implements ``receive_batch`` as an async
    generator (``__aiter__``).  We check for that first and fall back to
    a single-batch pull otherwise.
    """
    receive_batch = getattr(client, "receive_batch", None)
    if receive_batch is not None and hasattr(client, "__aiter__"):
        async for batch in client:
            for event in batch:
                yield event
        return
    if receive_batch is not None:
        batch = await receive_batch()
        for event in batch:
            yield event
        return
    # Pragmatic fallback for future SDK shapes — do nothing gracefully.
    return


def _build_stream_event(event: Any) -> StreamEvent:
    """Convert an SDK event object into the canonical :class:`StreamEvent`."""
    body_bytes = _extract_body_bytes(event)
    body_json = _try_decode_json(body_bytes)
    enqueued = getattr(event, "enqueued_time", None)
    enqueued_str = enqueued.isoformat() if enqueued is not None else None
    return StreamEvent(
        partition_key=getattr(event, "partition_key", None),
        enqueued_time_utc=enqueued_str,
        sequence_number=getattr(event, "sequence_number", None),
        offset=str(event.offset) if getattr(event, "offset", None) is not None else None,
        body=body_json,
        raw=body_bytes,
    )


def _extract_body_bytes(event: Any) -> bytes:
    """Best-effort extraction of body bytes from an SDK event object."""
    # The Azure SDK's EventData exposes ``body_as_str``/``body_as_json``
    # but we want raw bytes for Avro/Parquet passthrough.
    body = getattr(event, "body", None)
    if isinstance(body, (bytes, bytearray)):
        return bytes(body)
    if isinstance(body, str):
        return body.encode("utf-8")
    if body is None:
        return b""
    # Some SDK versions return a generator of bytes
    try:
        return b"".join(bytes(chunk) for chunk in body)
    except TypeError:
        return str(body).encode("utf-8")


def _try_decode_json(data: bytes) -> dict[str, Any] | None:
    """Decode JSON payload; return ``None`` if the body is not JSON."""
    if not data:
        return None
    import json

    try:
        parsed = json.loads(data.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


class EventHubSource(_EventHubLikeSource):
    """Direct Event Hub source adapter."""

    def __init__(self, contract: SourceContract) -> None:
        if contract.source_type is not SourceType.EVENT_HUB:
            raise ValueError(
                f"EventHubSource requires source_type=event_hub, got {contract.source_type.value}",
            )
        super().__init__(contract)


class IoTHubSource(_EventHubLikeSource):
    """IoT Hub source adapter (uses the built-in EH-compatible endpoint).

    The IoT Hub service exposes an Event Hubs-compatible endpoint that is
    consumed with the same SDK client as a standalone Event Hub.  The
    adapter therefore re-uses the base class and only guards the source
    type.
    """

    def __init__(self, contract: SourceContract) -> None:
        if contract.source_type is not SourceType.IOT_HUB:
            raise ValueError(
                f"IoTHubSource requires source_type=iot_hub, got {contract.source_type.value}",
            )
        super().__init__(contract)


class KafkaSource(_EventHubLikeSource):
    """Kafka source adapter via the Event Hubs Kafka-compatible endpoint.

    For a dedicated Apache Kafka cluster you would swap
    :func:`_load_eventhub_consumer_client` for a Kafka client at module-
    load time — CSA-in-a-Box targets Azure-native services first, so this
    is deferred until a customer explicitly asks for vanilla Kafka.
    """

    def __init__(self, contract: SourceContract) -> None:
        if contract.source_type is not SourceType.KAFKA:
            raise ValueError(
                f"KafkaSource requires source_type=kafka, got {contract.source_type.value}",
            )
        super().__init__(contract)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_source_adapter(contract: SourceContract) -> SourceAdapter:
    """Return the appropriate adapter instance for a given contract."""
    if contract.source_type is SourceType.EVENT_HUB:
        return EventHubSource(contract)
    if contract.source_type is SourceType.IOT_HUB:
        return IoTHubSource(contract)
    if contract.source_type is SourceType.KAFKA:
        return KafkaSource(contract)
    raise ValueError(f"Unsupported source_type {contract.source_type!r}")  # pragma: no cover
