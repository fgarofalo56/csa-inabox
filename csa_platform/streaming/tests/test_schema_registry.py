"""Unit tests for :mod:`csa_platform.streaming.schema_registry`.

Covers:
* NoopSchemaRegistry happy path + empty-ref rejection.
* ConfluentCompatRegistry with a mocked httpx client, including:
  - Happy path resolve.
  - 5xx retry (tenacity backoff).
  - 404 SchemaNotFoundError.
  - TTL cache hit avoids a second network call.
* AzureSchemaRegistry with a fake SDK client.
* Fingerprint mismatch + version conflict surfacing in
  :meth:`StreamingContractBundle.validate_schemas`.

NO network or Azure SDKs are touched — every external dependency is
patched via monkeypatch.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from csa_platform.streaming import schema_registry as sr_mod
from csa_platform.streaming.models import (
    SourceConnection,
    SourceContract,
    SourceType,
    StreamingContractBundle,
)
from csa_platform.streaming.schema_registry import (
    AzureSchemaRegistry,
    ConfluentCompatRegistry,
    NoopSchemaRegistry,
    ResolvedSchema,
    SchemaNotFoundError,
    SchemaRegistryError,
    ValidationIssue,
    compute_fingerprint,
)

# ---------------------------------------------------------------------------
# Tiny helpers
# ---------------------------------------------------------------------------


def _contract(
    name: str, schema_ref: str, *, source_type: SourceType = SourceType.EVENT_HUB,
) -> SourceContract:
    return SourceContract(
        name=name,
        source_type=source_type,
        connection=SourceConnection(namespace="ns", entity="e"),
        partition_key_path="$.k",
        schema_ref=schema_ref,
        watermark_field="ts",
    )


# ---------------------------------------------------------------------------
# NoopSchemaRegistry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_noop_resolves_any_ref() -> None:
    reg = NoopSchemaRegistry()
    resolved = await reg.resolve("schemaregistry://csa/iot/v1")
    assert isinstance(resolved, ResolvedSchema)
    assert resolved.ref == "schemaregistry://csa/iot/v1"
    assert resolved.name == "v1"
    assert resolved.format == "avro"
    assert resolved.fingerprint == compute_fingerprint(resolved.body)


@pytest.mark.asyncio
async def test_noop_rejects_empty_ref() -> None:
    reg = NoopSchemaRegistry()
    with pytest.raises(SchemaNotFoundError):
        await reg.resolve("")
    with pytest.raises(SchemaNotFoundError):
        await reg.validate("", b"payload")


@pytest.mark.asyncio
async def test_noop_validate_true_for_any_sample() -> None:
    reg = NoopSchemaRegistry()
    assert await reg.validate("x", b"anything") is True


# ---------------------------------------------------------------------------
# Fake httpx for Confluent registry
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        return self._payload


class _FakeAsyncClient:
    """Records every GET; returns queued responses in FIFO order."""

    def __init__(
        self, responses: list[_FakeResponse], *, timeout: float | None = None,
    ) -> None:
        self._responses = list(responses)
        self.calls: list[str] = []
        self.closed = False
        _ = timeout

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        self.closed = True

    async def get(
        self, url: str, *, headers: dict[str, str] | None = None, auth: Any = None,
    ) -> _FakeResponse:
        _ = headers
        _ = auth
        self.calls.append(url)
        if not self._responses:
            raise AssertionError(f"unexpected extra GET: {url}")
        return self._responses.pop(0)


class _FakeHttpx:
    """Stand-in for the httpx module used by the lazy loader."""

    def __init__(self, responses_per_client: list[list[_FakeResponse]]) -> None:
        self._queues = list(responses_per_client)
        self.clients: list[_FakeAsyncClient] = []

    def AsyncClient(self, *, timeout: float | None = None) -> _FakeAsyncClient:  # noqa: N802
        if not self._queues:
            raise AssertionError("no more mock responses queued")
        client = _FakeAsyncClient(self._queues.pop(0), timeout=timeout)
        self.clients.append(client)
        return client


@pytest.fixture
def patch_httpx(monkeypatch: pytest.MonkeyPatch) -> dict[str, _FakeHttpx]:
    holder: dict[str, _FakeHttpx] = {}

    def _install(responses_per_client: list[list[_FakeResponse]]) -> _FakeHttpx:
        fake = _FakeHttpx(responses_per_client)
        monkeypatch.setattr(sr_mod, "_load_httpx", lambda: fake)
        holder["fake"] = fake
        return fake

    return {"install": _install}  # type: ignore[dict-item]


# ---------------------------------------------------------------------------
# ConfluentCompatRegistry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_confluent_resolve_happy_path(patch_httpx: Any) -> None:
    body = '{"type":"record","name":"IotTelemetry"}'
    fake = patch_httpx["install"](
        [[_FakeResponse(200, {"schema": body, "version": 3, "schemaType": "AVRO"})]],
    )
    reg = ConfluentCompatRegistry(base_url="https://registry.local", retry_attempts=1)
    resolved = await reg.resolve("schemaregistry://csa/iot_telemetry")
    assert resolved.name == "iot_telemetry"
    assert resolved.version == "3"
    assert resolved.format == "avro"
    assert resolved.body == body
    assert resolved.fingerprint == compute_fingerprint(body)
    assert fake.clients[0].calls == [
        "https://registry.local/subjects/iot_telemetry/versions/latest",
    ]


@pytest.mark.asyncio
async def test_confluent_resolve_ttl_cache_hit(patch_httpx: Any) -> None:
    body = '{"type":"record","name":"A"}'
    fake = patch_httpx["install"](
        [[_FakeResponse(200, {"schema": body, "version": 1})]],
    )
    reg = ConfluentCompatRegistry(
        base_url="https://reg.local", retry_attempts=1, ttl_seconds=60.0,
    )
    # Two calls for the same ref → second one must not hit the fake.
    r1 = await reg.resolve("schemaregistry://csa/a")
    r2 = await reg.resolve("schemaregistry://csa/a")
    assert r1.body == r2.body
    assert len(fake.clients) == 1
    assert len(fake.clients[0].calls) == 1


@pytest.mark.asyncio
async def test_confluent_retry_on_5xx(patch_httpx: Any) -> None:
    body = '{"type":"record","name":"B"}'
    # First attempt 503, second attempt 200.  Each attempt uses a
    # separate AsyncClient (we open a new one inside _get_json).
    fake = patch_httpx["install"](
        [
            [_FakeResponse(503, {})],
            [_FakeResponse(200, {"schema": body, "version": 2})],
        ],
    )
    reg = ConfluentCompatRegistry(base_url="https://reg.local", retry_attempts=3)
    resolved = await reg.resolve("b")
    assert resolved.body == body
    # Both clients were created and called once each.
    assert len(fake.clients) == 2
    assert len(fake.clients[0].calls) == 1
    assert len(fake.clients[1].calls) == 1


@pytest.mark.asyncio
async def test_confluent_5xx_exhausts_retries(patch_httpx: Any) -> None:
    patch_httpx["install"](
        [
            [_FakeResponse(503, {})],
            [_FakeResponse(503, {})],
            [_FakeResponse(503, {})],
        ],
    )
    reg = ConfluentCompatRegistry(base_url="https://reg.local", retry_attempts=3)
    with pytest.raises(SchemaRegistryError):
        await reg.resolve("c")


@pytest.mark.asyncio
async def test_confluent_404_raises_not_found(patch_httpx: Any) -> None:
    patch_httpx["install"]([[_FakeResponse(404, {})]])
    reg = ConfluentCompatRegistry(base_url="https://reg.local", retry_attempts=1)
    with pytest.raises(SchemaNotFoundError):
        await reg.resolve("d")


@pytest.mark.asyncio
async def test_confluent_parses_version_suffix(patch_httpx: Any) -> None:
    body = '{"type":"record","name":"E"}'
    fake = patch_httpx["install"](
        [[_FakeResponse(200, {"schema": body, "version": 7})]],
    )
    reg = ConfluentCompatRegistry(base_url="https://reg.local", retry_attempts=1)
    await reg.resolve("schemaregistry://csa/e#v7")
    assert fake.clients[0].calls == [
        "https://reg.local/subjects/e/versions/7",
    ]


@pytest.mark.asyncio
async def test_confluent_validate_uses_resolve(patch_httpx: Any) -> None:
    body = '{"type":"record","name":"F"}'
    patch_httpx["install"](
        [[_FakeResponse(200, {"schema": body, "version": 1})]],
    )
    reg = ConfluentCompatRegistry(base_url="https://reg.local", retry_attempts=1)
    assert await reg.validate("f", b"payload") is True


# ---------------------------------------------------------------------------
# AzureSchemaRegistry (fully mocked SDK)
# ---------------------------------------------------------------------------


class _FakeAzureResult:
    def __init__(self, definition: str, version: int) -> None:
        self.definition = definition
        self.version = version
        self.format = "Avro"


class _FakeAzureClient:
    def __init__(self, **_kwargs: Any) -> None:
        self.kwargs = _kwargs
        self.closed = False
        self.calls: list[dict[str, Any]] = []
        self._payload = _FakeAzureResult(
            definition='{"type":"record","name":"Azure"}', version=4,
        )

    async def get_schema_properties(
        self, *, group_name: str, name: str, version: int | None = None,
    ) -> _FakeAzureResult:
        self.calls.append(
            {"op": "properties", "group": group_name, "name": name, "version": version},
        )
        return self._payload

    async def get_schema(
        self, *, group_name: str, name: str, version: int,
    ) -> _FakeAzureResult:
        self.calls.append(
            {"op": "get", "group": group_name, "name": name, "version": version},
        )
        return self._payload

    async def close(self) -> None:
        self.closed = True


class _FakeAzureCred:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def patch_azure_sdk(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    created: dict[str, Any] = {}

    def _client_cls(**kwargs: Any) -> _FakeAzureClient:
        client = _FakeAzureClient(**kwargs)
        created["client"] = client
        return client

    def _cred_cls() -> _FakeAzureCred:
        cred = _FakeAzureCred()
        created["cred"] = cred
        return cred

    monkeypatch.setattr(sr_mod, "_load_azure_sr", lambda: _client_cls)
    monkeypatch.setattr(sr_mod, "_load_default_credential", lambda: _cred_cls)
    return created


@pytest.mark.asyncio
async def test_azure_registry_resolve_latest(patch_azure_sdk: dict[str, Any]) -> None:
    reg = AzureSchemaRegistry(fully_qualified_namespace="my-eh.servicebus.windows.net")
    resolved = await reg.resolve("csa-group/iot_telemetry")
    assert resolved.name == "iot_telemetry"
    assert resolved.version == "4"
    assert resolved.format == "avro"
    assert patch_azure_sdk["client"].calls[0]["op"] == "properties"
    await reg.close()
    assert patch_azure_sdk["client"].closed
    assert patch_azure_sdk["cred"].closed


@pytest.mark.asyncio
async def test_azure_registry_resolve_explicit_version(
    patch_azure_sdk: dict[str, Any],
) -> None:
    reg = AzureSchemaRegistry(fully_qualified_namespace="eh")
    await reg.resolve("csa/iot#v4")
    assert patch_azure_sdk["client"].calls[0]["op"] == "get"
    assert patch_azure_sdk["client"].calls[0]["version"] == 4


@pytest.mark.asyncio
async def test_azure_registry_invalid_ref_raises() -> None:
    reg = AzureSchemaRegistry(fully_qualified_namespace="eh")
    with pytest.raises(SchemaNotFoundError):
        await reg.resolve("only-name")


@pytest.mark.asyncio
async def test_azure_registry_ttl_cache(patch_azure_sdk: dict[str, Any]) -> None:
    reg = AzureSchemaRegistry(fully_qualified_namespace="eh", ttl_seconds=60.0)
    await reg.resolve("g/a")
    await reg.resolve("g/a")
    assert len(patch_azure_sdk["client"].calls) == 1


# ---------------------------------------------------------------------------
# validate_schemas — bundle-level integration
# ---------------------------------------------------------------------------


class _DeterministicRegistry:
    """Returns a caller-specified ResolvedSchema for each ref."""

    def __init__(self, table: dict[str, ResolvedSchema]) -> None:
        self._table = table

    async def resolve(self, ref: str) -> ResolvedSchema:
        if ref not in self._table:
            raise SchemaNotFoundError(f"missing: {ref}")
        return self._table[ref]

    async def validate(self, ref: str, sample: bytes) -> bool:
        _ = sample
        return ref in self._table


@pytest.mark.asyncio
async def test_validate_schemas_all_ok() -> None:
    bundle = StreamingContractBundle(
        sources=(
            _contract("a", "schemaregistry://csa/iot#v1"),
            _contract("b", "schemaregistry://csa/iot#v1"),
        ),
    )
    body = '{"name": "Iot"}'
    schema = ResolvedSchema(
        ref="schemaregistry://csa/iot#v1",
        name="iot",
        version="1",
        format="avro",
        body=body,
        fingerprint=compute_fingerprint(body),
    )
    registry = _DeterministicRegistry(
        {
            "schemaregistry://csa/iot#v1": schema,
        },
    )
    issues = await bundle.validate_schemas(registry)
    assert issues == []


@pytest.mark.asyncio
async def test_validate_schemas_surfaces_missing_ref() -> None:
    bundle = StreamingContractBundle(
        sources=(_contract("a", "missing"),),
    )
    registry = _DeterministicRegistry({})
    issues = await bundle.validate_schemas(registry)
    assert len(issues) == 1
    assert isinstance(issues[0], ValidationIssue)
    assert issues[0].severity == "error"
    assert "not found" in issues[0].message
    assert issues[0].source_name == "a"


@pytest.mark.asyncio
async def test_validate_schemas_fingerprint_mismatch() -> None:
    bundle = StreamingContractBundle(
        sources=(
            _contract("a", "ref-a"),
            _contract("b", "ref-b"),
        ),
    )
    schema_a = ResolvedSchema(
        ref="ref-a",
        name="shared",
        version="1",
        format="avro",
        body='{"v":"A"}',
        fingerprint=compute_fingerprint('{"v":"A"}'),
    )
    schema_b = ResolvedSchema(
        ref="ref-b",
        name="shared",
        version="1",
        format="avro",
        body='{"v":"B"}',
        fingerprint=compute_fingerprint('{"v":"B"}'),
    )
    registry = _DeterministicRegistry(
        {"ref-a": schema_a, "ref-b": schema_b},
    )
    issues = await bundle.validate_schemas(registry)
    assert len(issues) == 2
    assert all("fingerprint mismatch" in i.message for i in issues)


@pytest.mark.asyncio
async def test_validate_schemas_version_conflict() -> None:
    bundle = StreamingContractBundle(
        sources=(
            _contract("a", "ref-a"),
            _contract("b", "ref-b"),
        ),
    )
    body_a = '{"v":"A"}'
    body_b = '{"v":"B"}'
    schema_a = ResolvedSchema(
        ref="ref-a",
        name="shared",
        version="1",
        format="avro",
        body=body_a,
        fingerprint=compute_fingerprint(body_a),
    )
    schema_b = ResolvedSchema(
        ref="ref-b",
        name="shared",
        version="2",
        format="avro",
        body=body_b,
        fingerprint=compute_fingerprint(body_b),
    )
    registry = _DeterministicRegistry({"ref-a": schema_a, "ref-b": schema_b})
    issues = await bundle.validate_schemas(registry)
    assert len(issues) == 2
    assert all("conflicting versions" in i.message for i in issues)


def test_compute_fingerprint_is_deterministic() -> None:
    a = compute_fingerprint("abc")
    b = compute_fingerprint("abc")
    c = compute_fingerprint("abd")
    assert a == b
    assert a != c
    assert len(a) == 64


def test_resolve_all_runs_concurrently() -> None:
    # Basic smoke test: resolve_all with a NoopSchemaRegistry.
    async def _run() -> None:
        reg = NoopSchemaRegistry()
        entries = await sr_mod.resolve_all(reg, [("a", "ref-1"), ("b", "ref-2")])
        assert len(entries) == 2
        assert all(e.error is None for e in entries)
        assert all(e.schema is not None for e in entries)

    asyncio.run(_run())
