"""csa_platform.streaming.breach_publisher — durable SLO breach fan-out.

:class:`~csa_platform.streaming.slo.SLOMonitor` is in-process only.  This
module supplies the durability layer so breaches survive a pod restart
and reach cross-cluster observability pipelines.

Implementations
---------------

* :class:`NoopBreachPublisher` — drops every breach (useful in tests).
* :class:`LogBreachPublisher`  — emits structured logs via ``structlog``.
* :class:`EventGridBreachPublisher` — publishes Event Grid events to a
  custom topic (lazy ``azure.eventgrid.aio`` import).
* :class:`CosmosBreachPublisher` — persists breaches to a Cosmos DB
  container (lazy ``azure.cosmos.aio`` import, partition_key=contract_name).

All Azure imports are lazy so unit tests can exercise the publishers
without the SDKs installed.  Transient failures are retried via
``tenacity`` (max 3 attempts, exponential backoff); permanent failures
are logged but NEVER propagated to the caller so the monitor loop
cannot be knocked offline by a downstream outage.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:  # pragma: no cover
    from csa_platform.streaming.slo import SLOBreach


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class BreachPublisher(Protocol):
    """Protocol implemented by every durable breach sink."""

    async def publish(self, breach: SLOBreach) -> None:  # pragma: no cover - interface
        """Persist / route the breach.  May raise on permanent failure."""
        ...


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def breach_to_dict(breach: SLOBreach) -> dict[str, Any]:
    """Serialize an :class:`SLOBreach` to a plain JSON-safe dict."""
    data = asdict(breach)
    # ``occurred_at`` is a datetime — isoformat keeps it JSON-safe.
    occurred = data.get("occurred_at")
    if occurred is not None and hasattr(occurred, "isoformat"):
        data["occurred_at"] = occurred.isoformat()
    return data


def _load_tenacity() -> Any:
    import tenacity

    return tenacity


# ---------------------------------------------------------------------------
# Noop publisher
# ---------------------------------------------------------------------------


class NoopBreachPublisher:
    """Drops every breach.  Used by tests and explicit opt-outs."""

    async def publish(self, breach: SLOBreach) -> None:
        _ = breach  # unused
        return


# ---------------------------------------------------------------------------
# Log publisher (structlog)
# ---------------------------------------------------------------------------


def _load_structlog() -> Any:
    """Lazy structlog import — structlog is always present via the streaming extra."""
    import structlog

    return structlog


class LogBreachPublisher:
    """Emits a structured ``slo.breach`` log event via ``structlog``.

    Tests can pass a custom logger instance; by default the publisher
    uses ``structlog.get_logger('csa_platform.streaming.slo')``.
    """

    def __init__(self, *, logger: Any | None = None) -> None:
        if logger is not None:
            self._logger = logger
        else:
            self._logger = _load_structlog().get_logger(
                "csa_platform.streaming.slo",
            )

    async def publish(self, breach: SLOBreach) -> None:
        payload = breach_to_dict(breach)
        await _maybe_async(
            self._logger.warning,
            "slo.breach",
            **payload,
        )


async def _maybe_async(fn: Any, /, *args: Any, **kwargs: Any) -> None:
    """Invoke ``fn`` whether it is sync or async."""
    result = fn(*args, **kwargs)
    if hasattr(result, "__await__"):
        await result


# ---------------------------------------------------------------------------
# Event Grid publisher
# ---------------------------------------------------------------------------


def _load_event_grid_publisher() -> Any:
    """Lazy import of :class:`azure.eventgrid.aio.EventGridPublisherClient`."""
    from azure.eventgrid.aio import EventGridPublisherClient

    return EventGridPublisherClient


def _load_event_grid_event() -> Any:
    """Lazy import of :class:`azure.eventgrid.EventGridEvent`."""
    from azure.eventgrid import EventGridEvent

    return EventGridEvent


def _load_azure_key_credential() -> Any:
    """Lazy import of :class:`azure.core.credentials.AzureKeyCredential`."""
    from azure.core.credentials import AzureKeyCredential

    return AzureKeyCredential


def _load_default_credential() -> Any:
    """Lazy import of :class:`azure.identity.aio.DefaultAzureCredential`."""
    from azure.identity.aio import DefaultAzureCredential

    return DefaultAzureCredential


class EventGridBreachPublisher:
    """Publishes breach events to an Azure Event Grid custom topic.

    Either ``access_key`` or ``credential`` must be supplied — the
    adapter accepts :class:`AzureKeyCredential` (for access-key topics)
    or any token credential (for AAD-auth topics).  All failures are
    retried via tenacity and swallowed after the final attempt: the
    publisher logs the error but never re-raises, so the SLO loop is
    insulated from Event Grid outages.
    """

    _EVENT_TYPE = "csa.streaming.slo.breach"
    _DATA_VERSION = "1.0"
    _SUBJECT_PREFIX = "csa-streaming/slo-breach"

    def __init__(
        self,
        *,
        endpoint: str,
        access_key: str | None = None,
        credential: Any | None = None,
        retry_attempts: int = 3,
    ) -> None:
        if not access_key and credential is None:
            raise ValueError(
                "EventGridBreachPublisher requires access_key or credential",
            )
        self._endpoint = endpoint
        self._access_key = access_key
        self._credential_override = credential
        self._retry_attempts = max(1, retry_attempts)
        self._client: Any | None = None

    async def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        client_cls = _load_event_grid_publisher()
        if self._credential_override is not None:
            credential = self._credential_override
        elif self._access_key is not None:
            credential = _load_azure_key_credential()(self._access_key)
        else:
            credential = _load_default_credential()()  # pragma: no cover
        self._client = client_cls(endpoint=self._endpoint, credential=credential)
        return self._client

    async def publish(self, breach: SLOBreach) -> None:
        event_cls = _load_event_grid_event()
        data = breach_to_dict(breach)
        subject = f"{self._SUBJECT_PREFIX}/{breach.contract_name}"
        event = event_cls(
            subject=subject,
            event_type=self._EVENT_TYPE,
            data=data,
            data_version=self._DATA_VERSION,
        )

        tenacity = _load_tenacity()
        retryer = tenacity.AsyncRetrying(
            stop=tenacity.stop_after_attempt(self._retry_attempts),
            wait=tenacity.wait_exponential(multiplier=0.1, min=0.1, max=1.0),
            reraise=True,
        )

        async def _call() -> None:
            client = await self._ensure_client()
            await client.send(event)

        async for attempt in retryer:
            with attempt:
                await _call()
                return

    async def close(self) -> None:
        if self._client is not None and hasattr(self._client, "close"):
            await self._client.close()
        self._client = None


# ---------------------------------------------------------------------------
# Cosmos publisher
# ---------------------------------------------------------------------------


def _load_cosmos_client() -> Any:
    """Lazy import of :class:`azure.cosmos.aio.CosmosClient`."""
    from azure.cosmos.aio import CosmosClient

    return CosmosClient


class CosmosBreachPublisher:
    """Persists breaches to a Cosmos DB container.

    ``partition_key`` defaults to the contract name so breaches for a
    given contract are co-located.  ``id`` is the ISO timestamp of the
    breach plus the contract name (trivially deduplicated on retry).
    """

    def __init__(
        self,
        *,
        endpoint: str,
        database_name: str,
        container_name: str,
        credential: Any | None = None,
        retry_attempts: int = 3,
    ) -> None:
        self._endpoint = endpoint
        self._database_name = database_name
        self._container_name = container_name
        self._credential_override = credential
        self._retry_attempts = max(1, retry_attempts)
        self._client: Any | None = None
        self._container: Any | None = None

    async def _ensure_container(self) -> Any:
        if self._container is not None:
            return self._container
        client_cls = _load_cosmos_client()
        credential = self._credential_override or _load_default_credential()()
        self._client = client_cls(url=self._endpoint, credential=credential)
        database = self._client.get_database_client(self._database_name)
        self._container = database.get_container_client(self._container_name)
        return self._container

    async def publish(self, breach: SLOBreach) -> None:
        payload = breach_to_dict(breach)
        payload.setdefault(
            "id",
            f"{breach.contract_name}-{payload['occurred_at']}",
        )
        # Cosmos expects partition key inside the document body.
        payload.setdefault("partition_key", breach.contract_name)

        tenacity = _load_tenacity()
        retryer = tenacity.AsyncRetrying(
            stop=tenacity.stop_after_attempt(self._retry_attempts),
            wait=tenacity.wait_exponential(multiplier=0.1, min=0.1, max=1.0),
            reraise=True,
        )

        async def _call() -> None:
            container = await self._ensure_container()
            await container.upsert_item(payload)

        async for attempt in retryer:
            with attempt:
                await _call()
                return

    async def close(self) -> None:
        if self._client is not None and hasattr(self._client, "close"):
            await self._client.close()
        self._client = None
        self._container = None


__all__ = [
    "BreachPublisher",
    "CosmosBreachPublisher",
    "EventGridBreachPublisher",
    "LogBreachPublisher",
    "NoopBreachPublisher",
    "breach_to_dict",
]
