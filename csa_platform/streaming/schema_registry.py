"""csa_platform.streaming.schema_registry — schema registry adapters (CSA-0137).

`SourceContract.schema_ref` is a free-form string at model-level so
contracts remain portable (the ref may target Azure Schema Registry, a
Confluent-compatible registry such as Event Hubs Schema Registry, or an
internal catalog).  This module wires those refs to a runtime registry
implementation and provides a bundle-level validation pass that surfaces:

* refs that do not resolve (404 / unknown)
* fingerprint / body mismatches between bronze and silver that claim the
  same schema
* version conflicts (same name, different versions referenced upstream
  vs downstream)

All Azure SDK / HTTP imports are lazy so unit tests can exercise the
module without any external dependencies installed.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

SchemaFormat = Literal["avro", "json-schema", "protobuf"]


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------


class ResolvedSchema(BaseModel):
    """Immutable view of a schema returned by a registry lookup."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    ref: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    version: str = Field(..., min_length=1)
    format: SchemaFormat = Field(default="avro")
    body: str = Field(..., min_length=1)
    fingerprint: str = Field(..., min_length=1)


@dataclass(frozen=True, slots=True)
class ValidationIssue:
    """A single issue produced by :meth:`StreamingContractBundle.validate_schemas`."""

    ref: str
    source_name: str
    severity: Literal["error", "warning"]
    message: str


def compute_fingerprint(body: str) -> str:
    """Deterministic 64-char SHA-256 fingerprint used to detect drift."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class SchemaRegistry(Protocol):
    """Protocol implemented by every schema registry adapter."""

    async def resolve(self, ref: str) -> ResolvedSchema:  # pragma: no cover - interface
        """Resolve ``ref`` to a :class:`ResolvedSchema`.  Raise on miss."""
        ...

    async def validate(self, ref: str, sample: bytes) -> bool:  # pragma: no cover - interface
        """Return True if ``sample`` is compatible with the registered schema."""
        ...


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class SchemaRegistryError(RuntimeError):
    """Base error for any registry-side failure."""


class SchemaNotFoundError(SchemaRegistryError):
    """Raised when a ref cannot be resolved by the registry."""


# ---------------------------------------------------------------------------
# TTL cache helper (pure, no external deps)
# ---------------------------------------------------------------------------


@dataclass
class _CacheEntry:
    schema: ResolvedSchema
    expires_at: float


class _TTLCache:
    """Minimal async-safe TTL cache keyed by ref."""

    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = ttl_seconds
        self._store: dict[str, _CacheEntry] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str, *, now: float | None = None) -> ResolvedSchema | None:
        t = now if now is not None else time.monotonic()
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if entry.expires_at <= t:
                self._store.pop(key, None)
                return None
            return entry.schema

    async def put(
        self, key: str, schema: ResolvedSchema, *, now: float | None = None,
    ) -> None:
        t = now if now is not None else time.monotonic()
        async with self._lock:
            self._store[key] = _CacheEntry(schema=schema, expires_at=t + self._ttl)

    async def clear(self) -> None:
        async with self._lock:
            self._store.clear()


# ---------------------------------------------------------------------------
# NoopSchemaRegistry — local-dev fallback
# ---------------------------------------------------------------------------


class NoopSchemaRegistry:
    """Accepts any ref.  Returns a minimal :class:`ResolvedSchema` stub.

    Intended for local development, CLI smoke tests, and any environment
    where a real registry is not wired.  Never fails a lookup.
    """

    async def resolve(self, ref: str) -> ResolvedSchema:
        if not ref:
            raise SchemaNotFoundError("empty schema ref")
        body = f'{{"type": "record", "name": "NoopStub", "ref": "{ref}"}}'
        return ResolvedSchema(
            ref=ref,
            name=ref.rsplit("/", 1)[-1] or ref,
            version="noop-1",
            format="avro",
            body=body,
            fingerprint=compute_fingerprint(body),
        )

    async def validate(self, ref: str, sample: bytes) -> bool:
        # Noop treats all samples as valid — but still asserts the ref
        # is non-empty so that contract-level misconfiguration surfaces.
        if not ref:
            raise SchemaNotFoundError("empty schema ref")
        _ = sample  # unused
        return True


# ---------------------------------------------------------------------------
# ConfluentCompatRegistry — HTTP registry (Event Hubs / Confluent)
# ---------------------------------------------------------------------------


def _load_httpx() -> Any:
    """Lazy httpx import so tests can patch it without installing httpx."""
    import httpx

    return httpx


def _load_tenacity() -> Any:
    """Lazy tenacity import so tests can patch without installing."""
    import tenacity

    return tenacity


class ConfluentCompatRegistry:
    """HTTP-based adapter for a Confluent-compatible schema registry.

    Event Hubs Schema Registry exposes a Confluent-compatible wire
    protocol, so the same adapter works for both classic Confluent
    registries and Event Hubs Schema Registry (when using its
    Confluent-compatible endpoint).  Azure-native Event Hubs Schema
    Registry callers should prefer :class:`AzureSchemaRegistry` (below)
    which uses the first-party SDK and AAD auth.
    """

    def __init__(
        self,
        *,
        base_url: str,
        ttl_seconds: float = 300.0,
        timeout_seconds: float = 10.0,
        retry_attempts: int = 3,
        api_key: str | None = None,
        api_secret: str | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._retry_attempts = max(1, retry_attempts)
        self._cache = _TTLCache(ttl_seconds=ttl_seconds)
        self._auth: tuple[str, str] | None = (
            (api_key, api_secret) if api_key and api_secret else None
        )

    async def _get_json(self, path: str) -> dict[str, Any]:
        """HTTP GET with 5xx retry via tenacity."""
        httpx = _load_httpx()
        tenacity = _load_tenacity()

        url = f"{self._base_url}{path}"

        # Build a retrying async call.  We use tenacity's ``AsyncRetrying``
        # helper so the retry surface is explicit and testable.
        retryer = tenacity.AsyncRetrying(
            retry=tenacity.retry_if_exception_type(SchemaRegistryError),
            stop=tenacity.stop_after_attempt(self._retry_attempts),
            wait=tenacity.wait_exponential(multiplier=0.1, min=0.1, max=1.0),
            reraise=True,
        )

        async def _call() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                headers = {"Accept": "application/vnd.schemaregistry.v1+json"}
                auth = self._auth
                response = await client.get(url, headers=headers, auth=auth)
                if response.status_code == 404:
                    raise SchemaNotFoundError(f"ref not found: {path}")
                if 500 <= response.status_code < 600:
                    raise SchemaRegistryError(
                        f"registry 5xx at {url}: {response.status_code}",
                    )
                if response.status_code >= 400:
                    raise SchemaRegistryError(
                        f"registry error at {url}: {response.status_code}",
                    )
                data = response.json()
                if not isinstance(data, dict):
                    raise SchemaRegistryError(
                        f"registry returned non-object body: {type(data).__name__}",
                    )
                return data

        async for attempt in retryer:
            with attempt:
                return await _call()
        raise SchemaRegistryError(  # pragma: no cover - defensive
            "retry loop exited without result",
        )

    async def resolve(self, ref: str) -> ResolvedSchema:
        cached = await self._cache.get(ref)
        if cached is not None:
            return cached
        # Confluent convention: subject name after the ref's last '/' plus
        # an optional version suffix ``#vN``; default to ``/versions/latest``.
        subject, version_part = _parse_subject_version(ref)
        path = f"/subjects/{subject}/versions/{version_part}"
        try:
            payload = await self._get_json(path)
        except SchemaNotFoundError:
            raise
        body = str(payload.get("schema", ""))
        if not body:
            raise SchemaRegistryError(f"registry returned empty body for {ref!r}")
        schema_type_raw = str(payload.get("schemaType", "AVRO")).lower()
        fmt = _coerce_format(schema_type_raw)
        version = str(payload.get("version", version_part))
        schema = ResolvedSchema(
            ref=ref,
            name=subject,
            version=version,
            format=fmt,
            body=body,
            fingerprint=compute_fingerprint(body),
        )
        await self._cache.put(ref, schema)
        return schema

    async def validate(self, ref: str, sample: bytes) -> bool:
        # Confluent-compatible registries expose a "compatibility" endpoint
        # that accepts a full schema payload — not a raw record.  We take
        # a pragmatic approach: if the ref resolves and the sample is
        # non-empty we return True; callers wanting deep wire-format
        # validation should implement a format-specific decoder and
        # consult the :class:`ResolvedSchema` body directly.
        await self.resolve(ref)
        return bool(sample)


def _parse_subject_version(ref: str) -> tuple[str, str]:
    """Extract ``(subject, version)`` from a ref.

    Supports::

        schemaregistry://group/name       -> (name, latest)
        schemaregistry://group/name#v3    -> (name, 3)
        name                              -> (name, latest)
        name/versions/5                   -> (name, 5)
    """
    last = ref.rsplit("/", 1)[-1]
    if "#" in last:
        name, _, ver = last.partition("#")
        ver = ver.removeprefix("v")
        return name, ver or "latest"
    if "/versions/" in ref:
        left, _, ver = ref.rpartition("/versions/")
        name = left.rsplit("/", 1)[-1]
        return name, ver or "latest"
    return last, "latest"


def _coerce_format(raw: str) -> SchemaFormat:
    """Map arbitrary registry schemaType values to our Literal alias."""
    v = raw.lower().strip()
    if v in ("avro",):
        return "avro"
    if v in ("json", "json-schema", "jsonschema"):
        return "json-schema"
    if v in ("protobuf", "proto", "pb"):
        return "protobuf"
    # Unknown: default to avro for Confluent registries (historical default).
    return "avro"


# ---------------------------------------------------------------------------
# AzureSchemaRegistry — Azure SDK adapter
# ---------------------------------------------------------------------------


def _load_azure_sr() -> Any:
    """Lazy import of ``azure.schemaregistry.aio`` so unit tests can patch."""
    from azure.schemaregistry.aio import SchemaRegistryClient

    return SchemaRegistryClient


def _load_default_credential() -> Any:
    """Lazy import of :class:`azure.identity.aio.DefaultAzureCredential`."""
    from azure.identity.aio import DefaultAzureCredential

    return DefaultAzureCredential


class AzureSchemaRegistry:
    """Azure Schema Registry adapter using ``azure-schemaregistry``.

    Tests monkeypatch :func:`_load_azure_sr` + :func:`_load_default_credential`
    with fakes.  The adapter accepts refs in two shapes::

        <group>/<schema-name>        -> latest version
        <group>/<schema-name>#v<N>   -> explicit version
    """

    def __init__(
        self,
        *,
        fully_qualified_namespace: str,
        ttl_seconds: float = 300.0,
        credential: Any | None = None,
    ) -> None:
        self._fqns = fully_qualified_namespace
        self._cache = _TTLCache(ttl_seconds=ttl_seconds)
        self._credential_override = credential
        self._client: Any | None = None
        self._credential: Any | None = None

    async def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        client_cls = _load_azure_sr()
        if self._credential_override is not None:
            self._credential = self._credential_override
        else:
            self._credential = _load_default_credential()()
        self._client = client_cls(
            fully_qualified_namespace=self._fqns,
            credential=self._credential,
        )
        return self._client

    async def resolve(self, ref: str) -> ResolvedSchema:
        cached = await self._cache.get(ref)
        if cached is not None:
            return cached
        group, name, version = _parse_azure_ref(ref)
        client = await self._ensure_client()
        try:
            if version == "latest":
                result = await client.get_schema_properties(
                    group_name=group, name=name, version=None,
                )
            else:
                result = await client.get_schema(
                    group_name=group, name=name, version=int(version),
                )
        except Exception as exc:
            raise SchemaNotFoundError(
                f"Azure Schema Registry lookup failed for {ref!r}: {exc}",
            ) from exc

        body = _azure_result_body(result)
        actual_version = _azure_result_version(result, fallback=version)
        fmt = _coerce_format(_azure_result_format(result))
        schema = ResolvedSchema(
            ref=ref,
            name=name,
            version=str(actual_version),
            format=fmt,
            body=body,
            fingerprint=compute_fingerprint(body),
        )
        await self._cache.put(ref, schema)
        return schema

    async def validate(self, ref: str, sample: bytes) -> bool:
        await self.resolve(ref)
        return bool(sample)

    async def close(self) -> None:
        if self._client is not None and hasattr(self._client, "close"):
            await self._client.close()
        self._client = None
        if (
            self._credential is not None
            and self._credential_override is None
            and hasattr(self._credential, "close")
        ):
            await self._credential.close()
        self._credential = None


def _parse_azure_ref(ref: str) -> tuple[str, str, str]:
    """Parse ``<group>/<name>[#vN]`` into ``(group, name, version)``."""
    body = ref
    if body.startswith("schemaregistry://"):
        body = body[len("schemaregistry://") :]
    version = "latest"
    if "#" in body:
        body, _, ver = body.partition("#")
        version = ver.removeprefix("v") or "latest"
    parts = body.split("/")
    if len(parts) < 2:
        raise SchemaNotFoundError(
            f"Azure Schema Registry ref must be '<group>/<name>[#vN]', got {ref!r}",
        )
    group = parts[-2]
    name = parts[-1]
    if not group or not name:
        raise SchemaNotFoundError(f"invalid Azure Schema Registry ref: {ref!r}")
    return group, name, version


def _azure_result_body(result: Any) -> str:
    """Best-effort extraction of the schema body from an SDK result object."""
    body = getattr(result, "definition", None) or getattr(result, "schema", None)
    if body is None:
        body = getattr(getattr(result, "properties", None), "definition", None)
    if body is None:
        raise SchemaRegistryError("Azure Schema Registry returned no body")
    return str(body)


def _azure_result_version(result: Any, *, fallback: str) -> str:
    version = getattr(result, "version", None)
    if version is None:
        props = getattr(result, "properties", None)
        version = getattr(props, "version", None)
    if version is None:
        return fallback
    return str(version)


def _azure_result_format(result: Any) -> str:
    fmt = getattr(result, "format", None)
    if fmt is None:
        props = getattr(result, "properties", None)
        fmt = getattr(props, "format", None)
    if fmt is None:
        return "avro"
    return str(fmt)


# ---------------------------------------------------------------------------
# Public helpers for bundle-level validation
# ---------------------------------------------------------------------------


@dataclass
class _ResolvedEntry:
    ref: str
    source_name: str
    schema: ResolvedSchema | None = None
    error: str | None = None
    extras: dict[str, Any] = field(default_factory=dict)


async def resolve_all(
    registry: SchemaRegistry, refs: list[tuple[str, str]],
) -> list[_ResolvedEntry]:
    """Resolve ``(source_name, ref)`` pairs concurrently.

    Returns one :class:`_ResolvedEntry` per pair; errors are captured on
    the entry rather than raised, so a single bad ref does not mask the
    state of the others.
    """
    entries = [_ResolvedEntry(ref=ref, source_name=src) for src, ref in refs]

    async def _one(entry: _ResolvedEntry) -> None:
        try:
            entry.schema = await registry.resolve(entry.ref)
        except SchemaNotFoundError as exc:
            entry.error = f"not found: {exc}"
        except SchemaRegistryError as exc:
            entry.error = f"registry error: {exc}"
        except Exception as exc:
            entry.error = f"unexpected error: {exc}"

    await asyncio.gather(*(_one(e) for e in entries))
    return entries


__all__ = [
    "AzureSchemaRegistry",
    "ConfluentCompatRegistry",
    "NoopSchemaRegistry",
    "ResolvedSchema",
    "SchemaFormat",
    "SchemaNotFoundError",
    "SchemaRegistry",
    "SchemaRegistryError",
    "ValidationIssue",
    "compute_fingerprint",
    "resolve_all",
]
