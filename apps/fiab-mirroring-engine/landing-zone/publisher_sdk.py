"""CSA Loom — Open Mirroring landing-zone publisher SDK.

Partner publishers (Qlik Replicate, Striim, Informatica IDMC, SAP SNP
Glue, Theobald Xtract Universal) drop Parquet files into ADLS Gen2
following this protocol. This SDK provides a reference implementation
for Python publishers; the protocol itself is language-agnostic.

Protocol contract:
    Path:            <ADLS>/landing-zone/<schema>/<table>/
    Metadata:        _metadata.json declares ``keyColumns`` array
    Sequence files:  20-digit zero-padded names (00000000000000000001.parquet)
    Row marker:      ``__rowMarker__`` column with 1=INSERT, 2=UPDATE, 3=DELETE
    Idempotency:     publisher MUST never reuse a sequence number;
                     replicator MUST skip already-applied sequences.

This is the same protocol Fabric publishes — partner ecosystem
compatibility is byte-for-byte.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Iterator

from azure.identity import DefaultAzureCredential
from azure.storage.filedatalake import DataLakeServiceClient
import pyarrow as pa
import pyarrow.parquet as pq

logger = logging.getLogger(__name__)


@dataclass
class LandingZoneTarget:
    storage_account: str
    container: str = "landing-zone"
    schema: str = ""
    table: str = ""
    key_columns: list[str] = None  # type: ignore

    def base_path(self) -> str:
        return f"{self.schema}/{self.table}"


class LandingZonePublisher:
    """Reference publisher implementing the Open Mirroring protocol.

    Usage:
        target = LandingZoneTarget(
            storage_account='salomexample',
            schema='dbo', table='orders',
            key_columns=['order_id'])
        publisher = LandingZonePublisher(target)
        publisher.ensure_metadata()
        publisher.write_batch(table=arrow_table, row_marker=1)
    """

    SEQUENCE_DIGITS = 20

    def __init__(self, target: LandingZoneTarget, credential: object | None = None):
        self.target = target
        self.cred = credential or DefaultAzureCredential()
        suffix = "core.windows.net"  # production resolves per cloud
        self.dfs = DataLakeServiceClient(
            account_url=f"https://{target.storage_account}.dfs.{suffix}",
            credential=self.cred,
        )
        self.fs = self.dfs.get_file_system_client(target.container)

    def ensure_metadata(self) -> None:
        """Write _metadata.json once (no-op if it exists with same keys)."""
        path = f"{self.target.base_path()}/_metadata.json"
        try:
            existing = self.fs.get_file_client(path).download_file().readall()
            parsed = json.loads(existing)
            if parsed.get("keyColumns") == self.target.key_columns:
                return
            raise ValueError(
                f"Existing metadata has different keyColumns "
                f"({parsed.get('keyColumns')}) than declared "
                f"({self.target.key_columns}). Manual reconciliation required."
            )
        except Exception:
            metadata = {
                "keyColumns": self.target.key_columns,
                "protocolVersion": "1.0",
                "publisher": "csa-loom-publisher-sdk",
            }
            client = self.fs.get_file_client(path)
            payload = json.dumps(metadata, indent=2).encode("utf-8")
            client.upload_data(payload, overwrite=True)
            logger.info("Wrote metadata to %s", path)

    def next_sequence(self) -> int:
        """Find the highest existing sequence number and return the next one.

        Production publishers persist their own counter to avoid scanning
        the container on every write.
        """
        max_seq = 0
        try:
            paths = self.fs.get_paths(path=self.target.base_path(), recursive=False)
            for p in paths:
                name = p.name.rsplit("/", 1)[-1]
                if name.endswith(".parquet") and len(name) == self.SEQUENCE_DIGITS + len(".parquet"):
                    try:
                        n = int(name[: self.SEQUENCE_DIGITS])
                        max_seq = max(max_seq, n)
                    except ValueError:
                        pass
        except Exception as exc:  # noqa: BLE001
            logger.debug("Sequence scan returned empty: %s", exc)
        return max_seq + 1

    def write_batch(self, table: "pa.Table", row_marker: int) -> str:
        """Append __rowMarker__ column and write the table as the next sequence file."""
        marker_arr = pa.array([row_marker] * table.num_rows, type=pa.int32())
        table_with_marker = table.append_column("__rowMarker__", marker_arr)

        seq = self.next_sequence()
        filename = f"{str(seq).zfill(self.SEQUENCE_DIGITS)}.parquet"
        path = f"{self.target.base_path()}/{filename}"

        # Write to in-memory buffer then upload
        import io
        buf = io.BytesIO()
        pq.write_table(table_with_marker, buf, compression="snappy")
        buf.seek(0)
        client = self.fs.get_file_client(path)
        client.upload_data(buf.read(), overwrite=False)

        logger.info("Published %d rows (marker=%d) to %s", table.num_rows, row_marker, path)
        return path


def publish_change(target: LandingZoneTarget, df: "pa.Table", op: str) -> str:
    """Convenience wrapper for one-shot publication.

    op: 'insert' | 'update' | 'delete'
    """
    marker = {"insert": 1, "update": 2, "delete": 3}[op]
    pub = LandingZonePublisher(target)
    pub.ensure_metadata()
    return pub.write_batch(df, marker)
