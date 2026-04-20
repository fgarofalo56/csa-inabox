"""Unit tests for :mod:`csa_platform.streaming.sources_fabric`.

Covers:
* Env-guarded behaviour: raises FabricRTINotAvailableError when
  FABRIC_RTI_ENABLED is not set.
* Source-type validation.
* Full happy path with a mocked httpx client (both list and dict
  response shapes).
* build_source_adapter dispatches to FabricRTISource.
"""

from __future__ import annotations

from typing import Any

import pytest

from csa_platform.streaming import sources_fabric as fabric_mod
from csa_platform.streaming.models import SourceConnection, SourceContract, SourceType
from csa_platform.streaming.sources import build_source_adapter
from csa_platform.streaming.sources_fabric import (
    FabricRTINotAvailableError,
    FabricRTISource,
)


def _contract(source_type: SourceType = SourceType.FABRIC_RTI) -> SourceContract:
    return SourceContract(
        name="rti_stream",
        source_type=source_type,
        connection=SourceConnection(
            namespace="workspace-xyz",
            entity="es-123",
            consumer_group="csa",
        ),
        partition_key_path="$.key",
        schema_ref="x",
        watermark_field="ts",
    )


# ---------------------------------------------------------------------------
# Env gating
# ---------------------------------------------------------------------------


def test_raises_when_fabric_rti_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FABRIC_RTI_ENABLED", raising=False)
    with pytest.raises(FabricRTINotAvailableError) as excinfo:
        FabricRTISource(_contract())
    assert "0018-fabric-rti-adapter.md" in str(excinfo.value)


def test_raises_when_env_flag_is_not_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FABRIC_RTI_ENABLED", "false")
    with pytest.raises(FabricRTINotAvailableError):
        FabricRTISource(_contract())


def test_source_type_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FABRIC_RTI_ENABLED", "true")
    with pytest.raises(ValueError, match="fabric_rti"):
        FabricRTISource(_contract(SourceType.EVENT_HUB))


# ---------------------------------------------------------------------------
# Happy path with mocked httpx
# ---------------------------------------------------------------------------


class _FakeHttpxResponse:
    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> Any:
        return self._payload


class _FakeHttpxClient:
    def __init__(self, *, timeout: float | None = None) -> None:
        _ = timeout
        self.calls: list[dict[str, Any]] = []
        self.aclosed = False
        self._response: _FakeHttpxResponse | None = None

    def set_response(self, response: _FakeHttpxResponse) -> None:
        self._response = response

    async def get(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, str] | None = None,
    ) -> _FakeHttpxResponse:
        self.calls.append({"url": url, "headers": headers, "params": params})
        assert self._response is not None
        return self._response

    async def aclose(self) -> None:
        self.aclosed = True


class _FakeHttpxModule:
    def __init__(self) -> None:
        self.client: _FakeHttpxClient | None = None

    def AsyncClient(self, *, timeout: float | None = None) -> _FakeHttpxClient:  # noqa: N802
        self.client = _FakeHttpxClient(timeout=timeout)
        return self.client


@pytest.fixture
def fabric_ready(monkeypatch: pytest.MonkeyPatch) -> _FakeHttpxModule:
    monkeypatch.setenv("FABRIC_RTI_ENABLED", "true")
    monkeypatch.setenv("FABRIC_RTI_TOKEN", "static-test-token")
    fake = _FakeHttpxModule()
    monkeypatch.setattr(fabric_mod, "_load_httpx", lambda: fake)
    return fake


@pytest.mark.asyncio
async def test_fabric_stream_list_response_shape(fabric_ready: _FakeHttpxModule) -> None:
    adapter = FabricRTISource(_contract())
    # Touch _ensure_client so the fake is created for set_response.
    await adapter._ensure_client()
    assert fabric_ready.client is not None
    fabric_ready.client.set_response(
        _FakeHttpxResponse(
            [
                {
                    "partitionKey": "p1",
                    "enqueuedTimeUtc": "2026-04-20T12:00:00Z",
                    "sequenceNumber": 42,
                    "offset": "100",
                    "body": {"sensor_id": "s1", "value": 1.2},
                },
                {
                    "partitionKey": "p2",
                    "enqueuedTimeUtc": "2026-04-20T12:00:01Z",
                    "sequenceNumber": 43,
                    "offset": "101",
                    "body": "raw-text",
                },
            ],
        ),
    )
    events = [event async for event in adapter.stream()]
    assert len(events) == 2
    assert events[0].partition_key == "p1"
    assert events[0].body == {"sensor_id": "s1", "value": 1.2}
    assert events[0].offset == "100"
    assert events[0].sequence_number == 42
    assert events[1].body is None  # string body -> raw bytes only
    assert events[1].raw == b"raw-text"

    call = fabric_ready.client.calls[0]
    assert call["headers"] == {"Authorization": "Bearer static-test-token"}
    assert call["params"] == {"consumerGroup": "csa"}
    assert "workspace-xyz" in call["url"]
    assert "es-123" in call["url"]

    await adapter.close()
    assert fabric_ready.client.aclosed


@pytest.mark.asyncio
async def test_fabric_stream_dict_events_key(fabric_ready: _FakeHttpxModule) -> None:
    adapter = FabricRTISource(_contract())
    await adapter._ensure_client()
    assert fabric_ready.client is not None
    fabric_ready.client.set_response(
        _FakeHttpxResponse(
            {
                "events": [
                    {"partitionKey": "x", "body": {"n": 1}},
                ],
            },
        ),
    )
    events = [event async for event in adapter.stream()]
    assert len(events) == 1
    assert events[0].partition_key == "x"
    assert events[0].body == {"n": 1}


@pytest.mark.asyncio
async def test_fabric_stream_dict_value_key(fabric_ready: _FakeHttpxModule) -> None:
    adapter = FabricRTISource(_contract())
    await adapter._ensure_client()
    assert fabric_ready.client is not None
    fabric_ready.client.set_response(
        _FakeHttpxResponse({"value": [{"body": {"n": 2}}]}),
    )
    events = [event async for event in adapter.stream()]
    assert len(events) == 1
    assert events[0].body == {"n": 2}


@pytest.mark.asyncio
async def test_fabric_stream_empty_response(fabric_ready: _FakeHttpxModule) -> None:
    adapter = FabricRTISource(_contract())
    await adapter._ensure_client()
    assert fabric_ready.client is not None
    fabric_ready.client.set_response(_FakeHttpxResponse({}))
    events = [event async for event in adapter.stream()]
    assert events == []


@pytest.mark.asyncio
async def test_fabric_endpoint_override_honoured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FABRIC_RTI_ENABLED", "true")
    monkeypatch.setenv("FABRIC_RTI_TOKEN", "tok")
    monkeypatch.setenv(
        "FABRIC_RTI_ENDPOINT", "https://gov-fabric.example/stream",
    )
    fake = _FakeHttpxModule()
    monkeypatch.setattr(fabric_mod, "_load_httpx", lambda: fake)
    adapter = FabricRTISource(_contract())
    await adapter._ensure_client()
    assert fake.client is not None
    fake.client.set_response(_FakeHttpxResponse([]))
    async for _ in adapter.stream():
        break
    assert fake.client.calls[0]["url"] == "https://gov-fabric.example/stream"


@pytest.mark.asyncio
async def test_fabric_acquires_aad_token_when_no_static_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FABRIC_RTI_ENABLED", "true")
    monkeypatch.delenv("FABRIC_RTI_TOKEN", raising=False)
    fake = _FakeHttpxModule()
    monkeypatch.setattr(fabric_mod, "_load_httpx", lambda: fake)

    class _Token:
        def __init__(self, token: str) -> None:
            self.token = token

    class _FakeCred:
        def __init__(self) -> None:
            self.scopes_seen: list[tuple[str, ...]] = []
            self.closed = False

        async def get_token(self, *scopes: str) -> _Token:
            self.scopes_seen.append(scopes)
            return _Token("aad-token-value")

        async def close(self) -> None:
            self.closed = True

    holder: dict[str, _FakeCred] = {}

    def _cred_factory() -> _FakeCred:
        c = _FakeCred()
        holder["cred"] = c
        return c

    monkeypatch.setattr(
        fabric_mod, "_load_default_credential", lambda: _cred_factory,
    )

    adapter = FabricRTISource(_contract())
    await adapter._ensure_client()
    assert fake.client is not None
    fake.client.set_response(_FakeHttpxResponse([]))
    async for _ in adapter.stream():
        break
    cred = holder["cred"]
    assert cred.scopes_seen == [
        ("https://analysis.windows.net/powerbi/api/.default",),
    ]
    call = fake.client.calls[0]
    assert call["headers"] == {"Authorization": "Bearer aad-token-value"}
    await adapter.close()
    assert cred.closed


def test_build_source_adapter_dispatches_to_fabric(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FABRIC_RTI_ENABLED", "true")
    adapter = build_source_adapter(_contract())
    assert isinstance(adapter, FabricRTISource)


def test_build_source_adapter_fabric_raises_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FABRIC_RTI_ENABLED", raising=False)
    with pytest.raises(FabricRTINotAvailableError):
        build_source_adapter(_contract())
