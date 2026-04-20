"""csa_platform.streaming.sources_fabric — Fabric RTI adapter (CSA-0137).

Microsoft Fabric Real-Time Intelligence (RTI) is the strategic target
for streaming on Microsoft's unified analytics platform — Eventstream
ingests from Event Hub, IoT Hub, and custom sources into a KQL-queryable
Eventhouse (see https://learn.microsoft.com/fabric/real-time-intelligence).
At the time this module was written Fabric RTI is **not yet GA in
Azure Government** (see ADR-0018), so runtime behaviour is gated by an
environment variable and the adapter surfaces a loud, actionable error
if instantiated in a tenant where RTI is not available.

Behaviour
---------

* If ``FABRIC_RTI_ENABLED=true`` in the environment the adapter
  performs REST-based consumption against the Fabric RTI eventstream
  API via :class:`httpx.AsyncClient`.  The concrete URL template is
  ``https://{workspace}.fabric.microsoft.com/eventstreams/{eventstream_id}/events``
  (see the Microsoft Learn docs cited below) but may be overridden
  with ``FABRIC_RTI_ENDPOINT`` for Gov-cloud tenants on the preview
  programme.
* If the env flag is unset the constructor raises
  :class:`FabricRTINotAvailableError` with a pointer to
  ``docs/adr/0018-fabric-rti-adapter.md``.

The adapter matches :class:`~csa_platform.streaming.sources.SourceAdapter`
so call sites that target Fabric can compile and branch today without
feature flagging every import.

References (from Microsoft Learn — not resolved at import time so the
module stays offline-safe):

* https://learn.microsoft.com/fabric/real-time-intelligence/overview
* https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview
* https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-custom-app
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

from csa_platform.streaming.models import SourceContract, SourceType

if TYPE_CHECKING:  # pragma: no cover
    from collections.abc import AsyncIterator

    from csa_platform.streaming.sources import StreamEvent


_ENV_FLAG = "FABRIC_RTI_ENABLED"
_ENV_ENDPOINT = "FABRIC_RTI_ENDPOINT"
_ENV_TOKEN = "FABRIC_RTI_TOKEN"
_DEFAULT_ENDPOINT_TEMPLATE = (
    "https://{workspace}.fabric.microsoft.com/eventstreams/{entity}/events"
)


class FabricRTINotAvailableError(RuntimeError):
    """Raised when :class:`FabricRTISource` is instantiated pre-GA.

    The message always includes a pointer to ``docs/adr/0018-fabric-rti-adapter.md``
    so operators encountering the error know exactly where to read the
    GA-gate rationale.
    """

    def __init__(self, detail: str | None = None) -> None:
        base = (
            "Fabric Real-Time Intelligence is not available in this tenant. "
            "Set FABRIC_RTI_ENABLED=true to opt in (Commercial preview only), "
            "or consult docs/adr/0018-fabric-rti-adapter.md for the "
            "Government-GA gate rationale and interim EventHub/IoTHub "
            "adapter guidance."
        )
        super().__init__(f"{base} {detail}" if detail else base)


# ---------------------------------------------------------------------------
# Lazy loaders — patchable in tests
# ---------------------------------------------------------------------------


def _load_httpx() -> Any:
    import httpx

    return httpx


def _load_default_credential() -> Any:
    """Lazy import of :class:`azure.identity.aio.DefaultAzureCredential`."""
    from azure.identity.aio import DefaultAzureCredential

    return DefaultAzureCredential


def _env() -> dict[str, str]:
    """Return a snapshot of the RTI-related environment variables."""
    return {
        _ENV_FLAG: os.environ.get(_ENV_FLAG, ""),
        _ENV_ENDPOINT: os.environ.get(_ENV_ENDPOINT, ""),
        _ENV_TOKEN: os.environ.get(_ENV_TOKEN, ""),
    }


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class FabricRTISource:
    """Fabric RTI eventstream source adapter (env-gated pre-GA)."""

    def __init__(self, contract: SourceContract) -> None:
        if contract.source_type is not SourceType.FABRIC_RTI:
            raise ValueError(
                f"FabricRTISource requires source_type=fabric_rti, "
                f"got {contract.source_type.value}",
            )
        env = _env()
        if env[_ENV_FLAG].strip().lower() != "true":
            raise FabricRTINotAvailableError
        self.contract = contract
        self._endpoint = env[_ENV_ENDPOINT] or _DEFAULT_ENDPOINT_TEMPLATE.format(
            workspace=contract.connection.namespace,
            entity=contract.connection.entity,
        )
        self._static_token = env[_ENV_TOKEN] or None
        self._credential: Any | None = None
        self._client: Any | None = None

    # -- lifecycle --------------------------------------------------------

    async def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        httpx = _load_httpx()
        self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def _auth_header(self) -> dict[str, str]:
        """Resolve the bearer token for the Fabric REST call."""
        if self._static_token:
            return {"Authorization": f"Bearer {self._static_token}"}
        if self._credential is None:
            self._credential = _load_default_credential()()
        # Fabric REST accepts AAD tokens scoped to
        # https://analysis.windows.net/powerbi/api/.default.
        token = await self._credential.get_token(
            "https://analysis.windows.net/powerbi/api/.default",
        )
        return {"Authorization": f"Bearer {token.token}"}

    async def stream(self) -> AsyncIterator[StreamEvent]:
        """Yield :class:`StreamEvent` envelopes from the Fabric RTI endpoint."""
        from csa_platform.streaming.sources import StreamEvent

        client = await self._ensure_client()
        headers = await self._auth_header()
        params = {
            "consumerGroup": self.contract.connection.consumer_group,
        }

        async def _pages() -> AsyncIterator[dict[str, Any]]:
            response = await client.get(
                self._endpoint, headers=headers, params=params,
            )
            response.raise_for_status()
            data = response.json()
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        yield item
                return
            if isinstance(data, dict):
                events = data.get("events") or data.get("value") or []
                for item in events:
                    if isinstance(item, dict):
                        yield item

        async for item in _pages():
            body_obj = item.get("body") if isinstance(item.get("body"), dict) else None
            raw = _coerce_raw(item.get("body"))
            yield StreamEvent(
                partition_key=_safe_str(item.get("partitionKey")),
                enqueued_time_utc=_safe_str(item.get("enqueuedTimeUtc")),
                sequence_number=_safe_int(item.get("sequenceNumber")),
                offset=_safe_str(item.get("offset")),
                body=body_obj,
                raw=raw,
            )

    async def close(self) -> None:
        if self._client is not None and hasattr(self._client, "aclose"):
            await self._client.aclose()
        self._client = None
        if self._credential is not None and hasattr(self._credential, "close"):
            await self._credential.close()
        self._credential = None


# ---------------------------------------------------------------------------
# Small coercers — intentionally local so we do not leak them
# ---------------------------------------------------------------------------


def _coerce_raw(body: Any) -> bytes:
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, str):
        return body.encode("utf-8")
    if isinstance(body, dict):
        import json

        return json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return str(body).encode("utf-8")


def _safe_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = [
    "FabricRTINotAvailableError",
    "FabricRTISource",
]
