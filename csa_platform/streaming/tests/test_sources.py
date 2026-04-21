"""Unit tests for :mod:`csa_platform.streaming.sources`.

These tests do NOT require the Azure SDK to be installed — they
monkeypatch :func:`_load_eventhub_consumer_client` and
:func:`_load_default_credential` with in-memory fakes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pytest

from csa_platform.streaming import sources as sources_mod
from csa_platform.streaming.models import SourceConnection, SourceContract, SourceType
from csa_platform.streaming.sources import (
    EventHubSource,
    IoTHubSource,
    KafkaSource,
    SourceAdapter,
    StreamEvent,
    build_source_adapter,
)

# ---------------------------------------------------------------------------
# Fake SDK objects
# ---------------------------------------------------------------------------


@dataclass
class _FakeEvent:
    partition_key: str | None = None
    enqueued_time: datetime | None = None
    sequence_number: int | None = None
    offset: int | None = None
    body: bytes | str | None = None


class _FakeConsumerClient:
    """Async-iterable fake that yields batches of fake events."""

    def __init__(self, **_kwargs: object) -> None:
        self.closed = False
        self.batches: list[list[_FakeEvent]] = [
            [
                _FakeEvent(
                    partition_key="sensor-1",
                    enqueued_time=datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc),
                    sequence_number=1,
                    offset=100,
                    body=b'{"sensor_id":"sensor-1","temp":21.5}',
                ),
                _FakeEvent(
                    partition_key="sensor-2",
                    enqueued_time=datetime(2026, 4, 20, 12, 0, 1, tzinfo=timezone.utc),
                    sequence_number=2,
                    offset=101,
                    body=b"not-json-bytes",
                ),
            ],
        ]
        self._iter_started = False

    def __aiter__(self) -> _FakeConsumerClient:
        return self

    async def __anext__(self) -> list[_FakeEvent]:
        if not self.batches:
            raise StopAsyncIteration
        return self.batches.pop(0)

    async def receive_batch(self) -> list[_FakeEvent]:
        """Present for the hasattr(...) branch in _receive_event_iter."""
        return []

    async def close(self) -> None:
        self.closed = True


class _FakeCredential:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def patched_sdk(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    """Patch the lazy SDK loaders with fakes and return them for assertions."""
    created: dict[str, object] = {}

    def _fake_consumer_loader() -> type[_FakeConsumerClient]:
        return _FakeConsumerClient

    def _fake_cred_loader() -> type[_FakeCredential]:
        return _FakeCredential

    monkeypatch.setattr(sources_mod, "_load_eventhub_consumer_client", _fake_consumer_loader)
    monkeypatch.setattr(sources_mod, "_load_default_credential", _fake_cred_loader)
    return created


def _contract(source_type: SourceType = SourceType.EVENT_HUB) -> SourceContract:
    return SourceContract(
        name="iot_telemetry",
        source_type=source_type,
        connection=SourceConnection(
            namespace="csaiot",
            entity="telemetry",
        ),
        partition_key_path="$.sensor_id",
        schema_ref="x",
        watermark_field="event_time",
    )


@pytest.mark.asyncio
async def test_event_hub_source_streams_and_closes(patched_sdk: object) -> None:
    adapter = EventHubSource(_contract())
    events: list[StreamEvent] = []
    async for ev in adapter.stream():
        events.append(ev)
    assert len(events) == 2
    assert events[0].partition_key == "sensor-1"
    assert events[0].body == {"sensor_id": "sensor-1", "temp": 21.5}
    assert events[0].offset == "100"
    # Body that is not JSON is exposed as raw bytes + body=None.
    assert events[1].body is None
    assert events[1].raw == b"not-json-bytes"
    await adapter.close()
    # Closing twice is safe
    await adapter.close()


@pytest.mark.asyncio
async def test_iot_hub_source_validates_source_type(patched_sdk: object) -> None:
    with pytest.raises(ValueError, match="iot_hub"):
        IoTHubSource(_contract(SourceType.EVENT_HUB))
    adapter = IoTHubSource(_contract(SourceType.IOT_HUB))
    async for _ in adapter.stream():
        break
    await adapter.close()


@pytest.mark.asyncio
async def test_kafka_source_validates_source_type(patched_sdk: object) -> None:
    with pytest.raises(ValueError, match="kafka"):
        KafkaSource(_contract(SourceType.EVENT_HUB))
    adapter = KafkaSource(_contract(SourceType.KAFKA))
    async for _ in adapter.stream():
        break
    await adapter.close()


def test_event_hub_source_requires_event_hub_type() -> None:
    with pytest.raises(ValueError, match="event_hub"):
        EventHubSource(_contract(SourceType.IOT_HUB))


def test_build_source_adapter_dispatch() -> None:
    eh = build_source_adapter(_contract(SourceType.EVENT_HUB))
    iot = build_source_adapter(_contract(SourceType.IOT_HUB))
    kafka = build_source_adapter(_contract(SourceType.KAFKA))
    assert isinstance(eh, EventHubSource)
    assert isinstance(iot, IoTHubSource)
    assert isinstance(kafka, KafkaSource)
    # All adapters satisfy the protocol.
    assert isinstance(eh, SourceAdapter)
    assert isinstance(iot, SourceAdapter)
    assert isinstance(kafka, SourceAdapter)


def test_resolve_fqdn_default_and_override() -> None:
    # Default FQDN derived from namespace
    eh = EventHubSource(_contract(SourceType.EVENT_HUB))
    assert eh._resolve_fqdn() == "csaiot.servicebus.windows.net"
    # Explicit FQDN honoured
    c = SourceContract(
        name="iot_telemetry",
        source_type=SourceType.EVENT_HUB,
        connection=SourceConnection(
            namespace="csaiot",
            entity="telemetry",
            fully_qualified_namespace="csaiot-gov.servicebus.usgovcloudapi.net",
        ),
        partition_key_path="$.k",
        schema_ref="x",
        watermark_field="ts",
    )
    assert EventHubSource(c)._resolve_fqdn() == "csaiot-gov.servicebus.usgovcloudapi.net"


def test_body_extraction_variants() -> None:
    from csa_platform.streaming.sources import _extract_body_bytes, _try_decode_json

    class _EvB:
        body = b"abc"

    class _EvS:
        body = "abc"

    class _EvG:
        def __init__(self) -> None:
            self.body = iter([b"ab", b"c"])

    class _EvN:
        body = None

    class _EvOther:
        body = 42

    assert _extract_body_bytes(_EvB()) == b"abc"
    assert _extract_body_bytes(_EvS()) == b"abc"
    assert _extract_body_bytes(_EvG()) == b"abc"
    assert _extract_body_bytes(_EvN()) == b""
    assert _extract_body_bytes(_EvOther()) == b"42"
    assert _try_decode_json(b"") is None
    assert _try_decode_json(b"not json") is None
    assert _try_decode_json(b"[1,2,3]") is None  # non-dict JSON
    assert _try_decode_json(b'{"k": 1}') == {"k": 1}
