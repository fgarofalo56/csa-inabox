"""csa_platform.streaming.bronze — bronze writer (CSA-0137).

The :class:`BronzeWriter` persists :class:`StreamEvent` envelopes to
ADLS Gen2 using a date-partitioned path layout derived from
:class:`StreamingBronze`.  All Azure SDK access is lazy so tests can
patch :func:`_load_blob_service_client` with a fake and exercise the
writer without any Azure dependencies installed.

The writer is deliberately minimal — it does not attempt to implement
full Avro/Parquet encoding here.  For JSON format we emit newline-
delimited JSON; for Avro/Parquet the writer persists the raw event
bytes as-is (Event Hub Capture already emits Avro, so the expected
pipeline is that the EH Capture feature writes to ADLS directly and
this writer is only exercised for non-Capture use cases).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from csa_platform.streaming.models import BronzeFormat, StreamingBronze

if TYPE_CHECKING:  # pragma: no cover
    from csa_platform.streaming.sources import StreamEvent


_ALLOWED_TOKENS = {"source", "yyyy", "mm", "dd", "hh"}


# ---------------------------------------------------------------------------
# Lazy SDK loader — patchable in tests
# ---------------------------------------------------------------------------


def _load_blob_service_client() -> Any:
    """Import :class:`azure.storage.blob.aio.BlobServiceClient` lazily."""
    from azure.storage.blob.aio import BlobServiceClient

    return BlobServiceClient


def _load_default_credential() -> Any:
    """Import :class:`azure.identity.aio.DefaultAzureCredential` lazily."""
    from azure.identity.aio import DefaultAzureCredential

    return DefaultAzureCredential


# ---------------------------------------------------------------------------
# Path resolver (pure — fully covered by tests)
# ---------------------------------------------------------------------------


def resolve_bronze_path(
    contract: StreamingBronze,
    *,
    source_name: str,
    when: datetime,
) -> str:
    """Resolve a bronze path template for the given ``source_name`` + timestamp.

    Accepts only the tokens ``{source}``, ``{yyyy}``, ``{mm}``, ``{dd}``,
    ``{hh}``.  Any other ``{token}`` raises :class:`ValueError`.
    """
    if when.tzinfo is None:
        raise ValueError("resolve_bronze_path requires a timezone-aware datetime")
    template = contract.path_template
    # Scan for any tokens not in our allowlist.
    _reject_unknown_tokens(template)
    utc = when.astimezone(timezone.utc)
    return template.format(
        source=source_name,
        yyyy=f"{utc.year:04d}",
        mm=f"{utc.month:02d}",
        dd=f"{utc.day:02d}",
        hh=f"{utc.hour:02d}",
    )


def _reject_unknown_tokens(template: str) -> None:
    """Raise if the template contains tokens outside :data:`_ALLOWED_TOKENS`."""
    # Minimal parser: walk the string and extract ``{name}`` substrings.
    i = 0
    while i < len(template):
        if template[i] == "{":
            end = template.find("}", i)
            if end == -1:
                raise ValueError(f"Unterminated '{{' in path_template: {template!r}")
            token = template[i + 1 : end]
            if token not in _ALLOWED_TOKENS:
                raise ValueError(
                    f"Unknown token {{{token}}} in path_template; "
                    f"allowed: {sorted(_ALLOWED_TOKENS)}",
                )
            i = end + 1
        else:
            i += 1


# ---------------------------------------------------------------------------
# BronzeWriter
# ---------------------------------------------------------------------------


class BronzeWriter:
    """Persists :class:`StreamEvent` batches to ADLS Gen2.

    Typical usage::

        writer = BronzeWriter(bronze_contract, source_name="iot_telemetry")
        async with writer:
            await writer.write_batch(events)
    """

    def __init__(self, contract: StreamingBronze, *, source_name: str) -> None:
        self.contract = contract
        self.source_name = source_name
        self._client: Any | None = None
        self._credential: Any | None = None

    # ----- lifecycle ----------------------------------------------------

    async def __aenter__(self) -> BronzeWriter:
        await self._ensure_client()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        blob_cls = _load_blob_service_client()
        self._credential = _load_default_credential()()
        account_url = f"https://{self.contract.storage_account}.blob.core.windows.net"
        self._client = blob_cls(account_url=account_url, credential=self._credential)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
        if self._credential is not None and hasattr(self._credential, "close"):
            await self._credential.close()
            self._credential = None

    # ----- serialization -----------------------------------------------

    def _serialize_batch(self, events: list[StreamEvent]) -> bytes:
        """Serialize a batch of events according to the bronze format."""
        if self.contract.format is BronzeFormat.JSON:
            lines: list[str] = []
            for ev in events:
                payload = ev.body if ev.body is not None else {"_raw": ev.raw.decode("utf-8", errors="replace")}
                lines.append(
                    json.dumps(
                        {
                            "partition_key": ev.partition_key,
                            "enqueued_time_utc": ev.enqueued_time_utc,
                            "sequence_number": ev.sequence_number,
                            "offset": ev.offset,
                            "body": payload,
                        },
                        separators=(",", ":"),
                        sort_keys=True,
                    ),
                )
            return ("\n".join(lines) + "\n").encode("utf-8")
        # Avro / Parquet — passthrough of raw bytes (each event already
        # framed by the EH capture producer). We concatenate with no
        # separator; the downstream reader (dbt-external-tables, Synapse
        # SERVERLESS OPENROWSET) resolves boundaries from the format
        # header.
        return b"".join(ev.raw for ev in events)

    # ----- write API ----------------------------------------------------

    async def write_batch(
        self,
        events: list[StreamEvent],
        *,
        when: datetime | None = None,
        filename: str | None = None,
    ) -> str:
        """Write a batch to ADLS Gen2 and return the resolved blob path.

        ``when`` defaults to ``datetime.now(timezone.utc)``; ``filename``
        defaults to ``<epoch-ms>.<format>``.
        """
        if not events:
            raise ValueError("write_batch called with zero events")
        ts = when or datetime.now(timezone.utc)
        prefix = resolve_bronze_path(self.contract, source_name=self.source_name, when=ts)
        name = filename or f"{int(ts.timestamp() * 1000)}.{self.contract.format.value}"
        blob_path = f"{prefix.rstrip('/')}/{name}"
        payload = self._serialize_batch(events)

        client = await self._ensure_client()
        container_client = client.get_container_client(self.contract.container)
        blob_client = container_client.get_blob_client(blob_path)
        await blob_client.upload_blob(payload, overwrite=True)
        return blob_path
