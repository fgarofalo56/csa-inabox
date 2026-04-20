"""Unit tests for :mod:`csa_platform.streaming.breach_publisher`.

Every Azure SDK is fully mocked — the tests never touch Event Grid,
Cosmos DB, or real credentials.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from csa_platform.streaming import breach_publisher as bp_mod
from csa_platform.streaming.breach_publisher import (
    CosmosBreachPublisher,
    EventGridBreachPublisher,
    LogBreachPublisher,
    NoopBreachPublisher,
    breach_to_dict,
)
from csa_platform.streaming.slo import SLOBreach


def _breach(name: str = "gold_a", occurred: datetime | None = None) -> SLOBreach:
    return SLOBreach(
        contract_name=name,
        observed_p99_ms=3000,
        threshold_ms=2500,
        window_minutes=5,
        sample_count=10,
        occurred_at=occurred or datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc),
    )


# ---------------------------------------------------------------------------
# breach_to_dict + Noop
# ---------------------------------------------------------------------------


def test_breach_to_dict_is_json_safe() -> None:
    data = breach_to_dict(_breach())
    assert data["contract_name"] == "gold_a"
    assert data["observed_p99_ms"] == 3000
    assert data["occurred_at"] == "2026-04-20T12:00:00+00:00"


@pytest.mark.asyncio
async def test_noop_publisher_does_nothing() -> None:
    pub = NoopBreachPublisher()
    await pub.publish(_breach())  # no raise, no effect


# ---------------------------------------------------------------------------
# LogBreachPublisher
# ---------------------------------------------------------------------------


class _FakeLogger:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def warning(self, event: str, **kwargs: Any) -> None:
        self.calls.append((event, kwargs))


@pytest.mark.asyncio
async def test_log_publisher_emits_slo_breach_event() -> None:
    logger = _FakeLogger()
    pub = LogBreachPublisher(logger=logger)
    await pub.publish(_breach())
    assert len(logger.calls) == 1
    event, payload = logger.calls[0]
    assert event == "slo.breach"
    assert payload["contract_name"] == "gold_a"
    assert payload["threshold_ms"] == 2500


@pytest.mark.asyncio
async def test_log_publisher_default_logger_uses_structlog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Ensure the default branch uses our patched structlog.
    class _FakeStructlog:
        def __init__(self) -> None:
            self.name_seen: str | None = None
            self.logger = _FakeLogger()

        def get_logger(self, name: str) -> _FakeLogger:
            self.name_seen = name
            return self.logger

    fake = _FakeStructlog()
    monkeypatch.setattr(bp_mod, "_load_structlog", lambda: fake)
    pub = LogBreachPublisher()
    await pub.publish(_breach())
    assert fake.name_seen == "csa_platform.streaming.slo"
    assert fake.logger.calls


# ---------------------------------------------------------------------------
# EventGridBreachPublisher
# ---------------------------------------------------------------------------


class _FakeEvent:
    def __init__(
        self,
        *,
        subject: str,
        event_type: str,
        data: dict[str, Any],
        data_version: str,
    ) -> None:
        self.subject = subject
        self.event_type = event_type
        self.data = data
        self.data_version = data_version


class _FakeEGClient:
    def __init__(
        self,
        *,
        endpoint: str,
        credential: Any,
        fail_times: int = 0,
    ) -> None:
        self.endpoint = endpoint
        self.credential = credential
        self.sent: list[_FakeEvent] = []
        self._fail_remaining = fail_times
        self.closed = False

    async def send(self, event: _FakeEvent) -> None:
        if self._fail_remaining > 0:
            self._fail_remaining -= 1
            raise RuntimeError("transient Event Grid failure")
        self.sent.append(event)

    async def close(self) -> None:
        self.closed = True


class _FakeAzureKeyCred:
    def __init__(self, key: str) -> None:
        self.key = key


@pytest.fixture
def patch_event_grid(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    state: dict[str, Any] = {"fail_times": 0}

    def _client_cls(*, endpoint: str, credential: Any) -> _FakeEGClient:
        client = _FakeEGClient(
            endpoint=endpoint,
            credential=credential,
            fail_times=state["fail_times"],
        )
        state["client"] = client
        return client

    monkeypatch.setattr(bp_mod, "_load_event_grid_publisher", lambda: _client_cls)
    monkeypatch.setattr(bp_mod, "_load_event_grid_event", lambda: _FakeEvent)
    monkeypatch.setattr(bp_mod, "_load_azure_key_credential", lambda: _FakeAzureKeyCred)
    return state


@pytest.mark.asyncio
async def test_event_grid_publisher_happy_path(patch_event_grid: dict[str, Any]) -> None:
    pub = EventGridBreachPublisher(
        endpoint="https://eg.example/api/events",
        access_key="key-123",
        retry_attempts=1,
    )
    await pub.publish(_breach())
    client = patch_event_grid["client"]
    assert len(client.sent) == 1
    event = client.sent[0]
    assert event.event_type == "csa.streaming.slo.breach"
    assert event.subject.endswith("gold_a")
    assert event.data["contract_name"] == "gold_a"
    assert isinstance(client.credential, _FakeAzureKeyCred)
    assert client.credential.key == "key-123"
    await pub.close()
    assert client.closed


@pytest.mark.asyncio
async def test_event_grid_publisher_retries_on_transient_failure(
    patch_event_grid: dict[str, Any],
) -> None:
    patch_event_grid["fail_times"] = 2
    pub = EventGridBreachPublisher(
        endpoint="https://eg.example/api/events",
        access_key="key",
        retry_attempts=3,
    )
    await pub.publish(_breach())
    # First client had its failure counter exhausted; the send eventually
    # succeeded after two retries on the same client instance.
    client = patch_event_grid["client"]
    assert len(client.sent) == 1


@pytest.mark.asyncio
async def test_event_grid_publisher_exhausted_retries_raise(
    patch_event_grid: dict[str, Any],
) -> None:
    patch_event_grid["fail_times"] = 5
    pub = EventGridBreachPublisher(
        endpoint="https://eg.example/api/events",
        access_key="key",
        retry_attempts=3,
    )
    with pytest.raises(RuntimeError, match="transient"):
        await pub.publish(_breach())


def test_event_grid_publisher_requires_auth() -> None:
    with pytest.raises(ValueError, match="access_key or credential"):
        EventGridBreachPublisher(endpoint="https://eg.example/api/events")


@pytest.mark.asyncio
async def test_event_grid_publisher_accepts_token_credential(
    patch_event_grid: dict[str, Any],
) -> None:
    class _TokenCred:
        async def get_token(self, *_scopes: str) -> Any:  # pragma: no cover - stub
            raise NotImplementedError

    cred = _TokenCred()
    pub = EventGridBreachPublisher(
        endpoint="https://eg.example/api/events",
        credential=cred,
        retry_attempts=1,
    )
    await pub.publish(_breach())
    assert patch_event_grid["client"].credential is cred


# ---------------------------------------------------------------------------
# CosmosBreachPublisher
# ---------------------------------------------------------------------------


class _FakeCosmosContainer:
    def __init__(self, *, fail_times: int = 0) -> None:
        self.items: list[dict[str, Any]] = []
        self._fail_remaining = fail_times

    async def upsert_item(self, item: dict[str, Any]) -> None:
        if self._fail_remaining > 0:
            self._fail_remaining -= 1
            raise RuntimeError("transient Cosmos failure")
        self.items.append(item)


class _FakeCosmosDatabase:
    def __init__(self, container: _FakeCosmosContainer) -> None:
        self._container = container

    def get_container_client(self, name: str) -> _FakeCosmosContainer:
        _ = name
        return self._container


class _FakeCosmosClient:
    def __init__(
        self,
        *,
        url: str,
        credential: Any,
        container: _FakeCosmosContainer,
    ) -> None:
        self.url = url
        self.credential = credential
        self._database = _FakeCosmosDatabase(container)
        self.closed = False

    def get_database_client(self, name: str) -> _FakeCosmosDatabase:
        _ = name
        return self._database

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def patch_cosmos(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    state: dict[str, Any] = {"fail_times": 0, "container": _FakeCosmosContainer()}

    def _client_cls(*, url: str, credential: Any) -> _FakeCosmosClient:
        container = _FakeCosmosContainer(fail_times=state["fail_times"])
        state["container"] = container
        client = _FakeCosmosClient(url=url, credential=credential, container=container)
        state["client"] = client
        return client

    class _Cred:
        pass

    monkeypatch.setattr(bp_mod, "_load_cosmos_client", lambda: _client_cls)
    monkeypatch.setattr(bp_mod, "_load_default_credential", lambda: _Cred)
    return state


@pytest.mark.asyncio
async def test_cosmos_publisher_happy_path(patch_cosmos: dict[str, Any]) -> None:
    pub = CosmosBreachPublisher(
        endpoint="https://cosmos.example",
        database_name="csa",
        container_name="breaches",
        retry_attempts=1,
    )
    await pub.publish(_breach())
    items = patch_cosmos["container"].items
    assert len(items) == 1
    item = items[0]
    assert item["contract_name"] == "gold_a"
    assert item["partition_key"] == "gold_a"
    assert item["id"].startswith("gold_a-")
    await pub.close()
    assert patch_cosmos["client"].closed


@pytest.mark.asyncio
async def test_cosmos_publisher_retries_transient_failure(
    patch_cosmos: dict[str, Any],
) -> None:
    patch_cosmos["fail_times"] = 2
    pub = CosmosBreachPublisher(
        endpoint="https://cosmos.example",
        database_name="d",
        container_name="c",
        retry_attempts=3,
    )
    await pub.publish(_breach())
    assert len(patch_cosmos["container"].items) == 1


@pytest.mark.asyncio
async def test_cosmos_publisher_exhausts_retries(patch_cosmos: dict[str, Any]) -> None:
    patch_cosmos["fail_times"] = 5
    pub = CosmosBreachPublisher(
        endpoint="https://cosmos.example",
        database_name="d",
        container_name="c",
        retry_attempts=3,
    )
    with pytest.raises(RuntimeError, match="transient"):
        await pub.publish(_breach())


# ---------------------------------------------------------------------------
# Fan-out integration — Noop + Log + one failing publisher
# ---------------------------------------------------------------------------


class _AlwaysFailsPublisher:
    def __init__(self) -> None:
        self.calls = 0

    async def publish(self, breach: SLOBreach) -> None:
        _ = breach
        self.calls += 1
        raise RuntimeError("downstream broken")


@pytest.mark.asyncio
async def test_failing_publisher_raises_on_direct_invocation() -> None:
    """Sanity — the failing publisher does raise when called directly.

    The SLO monitor test suite covers the fan-out isolation behaviour —
    here we only assert the raw publisher contract.
    """
    pub = _AlwaysFailsPublisher()
    with pytest.raises(RuntimeError, match="downstream"):
        await pub.publish(_breach())
    assert pub.calls == 1
