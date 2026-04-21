"""Unit tests for :mod:`csa_platform.streaming.bronze`."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from csa_platform.streaming import bronze as bronze_mod
from csa_platform.streaming.bronze import BronzeWriter, resolve_bronze_path
from csa_platform.streaming.models import BronzeFormat, StreamingBronze
from csa_platform.streaming.sources import StreamEvent


def _bronze(fmt: BronzeFormat = BronzeFormat.JSON) -> StreamingBronze:
    return StreamingBronze(
        contract_ref="iot_telemetry",
        storage_account="csabronze",
        container="iot",
        path_template="bronze/{source}/year={yyyy}/month={mm}/day={dd}/hour={hh}/",
        format=fmt,
    )


def _event(body: dict[str, Any] | None = None, raw: bytes = b"raw") -> StreamEvent:
    return StreamEvent(
        partition_key="pk",
        enqueued_time_utc="2026-04-20T12:00:00+00:00",
        sequence_number=1,
        offset="100",
        body=body,
        raw=raw,
    )


def test_resolve_bronze_path_tokens() -> None:
    contract = _bronze()
    ts = datetime(2026, 4, 20, 13, 5, tzinfo=timezone.utc)
    path = resolve_bronze_path(contract, source_name="iot", when=ts)
    assert path == "bronze/iot/year=2026/month=04/day=20/hour=13/"


def test_resolve_bronze_path_requires_tzaware() -> None:
    contract = _bronze()
    # Intentionally naive datetime — the resolver must reject it.  Build it
    # via replace(tzinfo=None) rather than a bare constructor to keep the
    # ruff DTZ rule happy.
    ts_naive = datetime(2026, 4, 20, 13, 5, tzinfo=timezone.utc).replace(tzinfo=None)
    with pytest.raises(ValueError, match="timezone-aware"):
        resolve_bronze_path(contract, source_name="iot", when=ts_naive)


def test_resolve_bronze_path_rejects_unknown_token() -> None:
    contract = StreamingBronze(
        contract_ref="iot_telemetry",
        storage_account="s",
        container="c",
        path_template="bronze/{source}/{ss}/",
    )
    with pytest.raises(ValueError, match=r"\{ss\}"):
        resolve_bronze_path(
            contract,
            source_name="iot",
            when=datetime(2026, 4, 20, tzinfo=timezone.utc),
        )


def test_resolve_bronze_path_rejects_unterminated_token() -> None:
    # Build a valid contract first, then swap its template via the
    # internal attribute to exercise the resolver's scanner directly
    # (the model-level validator otherwise blocks this case).
    contract = StreamingBronze(
        contract_ref="iot_telemetry",
        storage_account="s",
        container="c",
        path_template="bronze/{source}/x",
    )
    # Bypass frozen by constructing a sibling via model_copy — but since
    # frozen=True also forbids update, we instead call the private helper.
    from csa_platform.streaming.bronze import _reject_unknown_tokens

    with pytest.raises(ValueError, match="Unterminated"):
        _reject_unknown_tokens("bronze/{source/x")
    # Sanity: the valid contract still resolves cleanly.
    path = resolve_bronze_path(
        contract,
        source_name="iot",
        when=datetime(2026, 4, 20, tzinfo=timezone.utc),
    )
    assert path == "bronze/iot/x"


# ---------------------------------------------------------------------------
# BronzeWriter tests (with patched SDK)
# ---------------------------------------------------------------------------


class _FakeBlobClient:
    def __init__(self) -> None:
        self.uploaded: tuple[bytes, bool] | None = None

    async def upload_blob(self, payload: bytes, overwrite: bool = False) -> None:
        self.uploaded = (payload, overwrite)


class _FakeContainerClient:
    def __init__(self) -> None:
        self.blobs: dict[str, _FakeBlobClient] = {}

    def get_blob_client(self, name: str) -> _FakeBlobClient:
        bc = _FakeBlobClient()
        self.blobs[name] = bc
        return bc


class _FakeBlobServiceClient:
    def __init__(self, **_kwargs: Any) -> None:
        self.closed = False
        self.containers: dict[str, _FakeContainerClient] = {}

    def get_container_client(self, name: str) -> _FakeContainerClient:
        cc = _FakeContainerClient()
        self.containers[name] = cc
        return cc

    async def close(self) -> None:
        self.closed = True


class _FakeCredential:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def patched_blob_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        bronze_mod,
        "_load_blob_service_client",
        lambda: _FakeBlobServiceClient,
    )
    monkeypatch.setattr(
        bronze_mod,
        "_load_default_credential",
        lambda: _FakeCredential,
    )


@pytest.mark.asyncio
async def test_bronze_writer_writes_json_batch(patched_blob_sdk: None) -> None:
    contract = _bronze(BronzeFormat.JSON)
    writer = BronzeWriter(contract, source_name="iot_telemetry")
    async with writer:
        path = await writer.write_batch(
            [_event(body={"sensor_id": "a", "temp": 1})],
            when=datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc),
            filename="test.json",
        )
    assert path == "bronze/iot_telemetry/year=2026/month=04/day=20/hour=12/test.json"
    # The fake client must have been closed via the context manager exit.
    assert writer._client is None


@pytest.mark.asyncio
async def test_bronze_writer_rejects_empty_batch(patched_blob_sdk: None) -> None:
    writer = BronzeWriter(_bronze(), source_name="iot")
    async with writer:
        with pytest.raises(ValueError, match="zero events"):
            await writer.write_batch([])


@pytest.mark.asyncio
async def test_bronze_writer_serializes_avro_as_raw(patched_blob_sdk: None) -> None:
    writer = BronzeWriter(_bronze(BronzeFormat.AVRO), source_name="iot")
    batch = [_event(raw=b"avro-frame-1"), _event(raw=b"avro-frame-2")]
    async with writer:
        path = await writer.write_batch(batch, when=datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc))
        # Grab the fake container client to assert the uploaded payload.
        container = writer._client.containers["iot"]  # type: ignore[union-attr]
    blob_name = path.rsplit("/", 1)[-1]
    uploaded = container.blobs[path].uploaded
    assert uploaded is not None
    payload, overwrite = uploaded
    assert payload == b"avro-frame-1avro-frame-2"
    assert overwrite is True
    assert blob_name.endswith(".avro")


@pytest.mark.asyncio
async def test_bronze_writer_json_payload_shape(patched_blob_sdk: None) -> None:
    import json

    writer = BronzeWriter(_bronze(BronzeFormat.JSON), source_name="iot")
    async with writer:
        ev = _event(body={"a": 1})
        path = await writer.write_batch(
            [ev], when=datetime(2026, 4, 20, 12, 0, tzinfo=timezone.utc),
        )
        container = writer._client.containers["iot"]  # type: ignore[union-attr]
    uploaded = container.blobs[path].uploaded
    assert uploaded is not None
    payload, _ = uploaded
    line = payload.decode("utf-8").strip()
    decoded = json.loads(line)
    assert decoded["body"] == {"a": 1}
    assert decoded["partition_key"] == "pk"
    assert decoded["offset"] == "100"


@pytest.mark.asyncio
async def test_bronze_writer_json_raw_fallback(patched_blob_sdk: None) -> None:
    """When body is None, writer falls back to raw bytes as a _raw field."""
    import json

    writer = BronzeWriter(_bronze(BronzeFormat.JSON), source_name="iot")
    async with writer:
        ev = _event(body=None, raw=b"hello")
        path = await writer.write_batch([ev], when=datetime(2026, 4, 20, tzinfo=timezone.utc))
        container = writer._client.containers["iot"]  # type: ignore[union-attr]
    uploaded = container.blobs[path].uploaded
    assert uploaded is not None
    payload, _ = uploaded
    decoded = json.loads(payload.decode("utf-8").strip())
    assert decoded["body"] == {"_raw": "hello"}
