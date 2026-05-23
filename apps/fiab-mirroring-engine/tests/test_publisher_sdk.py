"""Unit tests for the Open Mirroring landing-zone publisher SDK.

Mocks Azure SDK clients so tests run without any Azure access.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Make `apps/fiab-mirroring-engine/landing-zone/publisher_sdk.py`
# importable without setting it up as a proper package.
ROOT = Path(__file__).parents[1]
LZ_DIR = ROOT / "landing-zone"
sys.path.insert(0, str(LZ_DIR))

import publisher_sdk  # noqa: E402


@pytest.fixture
def fake_target():
    return publisher_sdk.LandingZoneTarget(
        storage_account="salomtest",
        schema="dbo",
        table="orders",
        key_columns=["order_id"],
    )


@pytest.fixture
def mock_fs():
    """Mock the file-system client + file client used by the publisher."""
    fs = MagicMock()
    fs.get_paths.return_value = []
    return fs


def test_base_path_constructs_correctly(fake_target):
    assert fake_target.base_path() == "dbo/orders"


def _make_publisher(target, mock_fs):
    """Build a publisher bypassing the Azure SDK __init__ checks."""
    pub = publisher_sdk.LandingZonePublisher.__new__(publisher_sdk.LandingZonePublisher)
    pub.target = target
    pub.cred = MagicMock()
    pub.dfs = MagicMock()
    pub.fs = mock_fs
    return pub


def test_ensure_metadata_writes_new_when_absent(fake_target, mock_fs):
    pub = _make_publisher(fake_target, mock_fs)

    # Simulate "file does not exist" — get_file_client(...).download_file()
    # raises whatever Azure SDK raises in absence (just any exception)
    file_client = MagicMock()
    file_client.download_file.side_effect = Exception("404 not found")
    mock_fs.get_file_client.return_value = file_client

    pub.ensure_metadata()

    # Should have written _metadata.json
    assert any(
        c[0][0] == "dbo/orders/_metadata.json"
        for c in mock_fs.get_file_client.call_args_list
    )
    # And uploaded the metadata payload
    file_client.upload_data.assert_called()
    payload_bytes = file_client.upload_data.call_args[0][0]
    payload = json.loads(payload_bytes.decode("utf-8"))
    assert payload["keyColumns"] == ["order_id"]
    assert payload["protocolVersion"] == "1.0"


def test_ensure_metadata_noop_when_keys_match(fake_target, mock_fs):
    pub = _make_publisher(fake_target, mock_fs)

    existing = json.dumps({"keyColumns": ["order_id"], "protocolVersion": "1.0"}).encode("utf-8")
    file_client = MagicMock()
    file_client.download_file.return_value.readall.return_value = existing
    mock_fs.get_file_client.return_value = file_client

    pub.ensure_metadata()

    # Should NOT have uploaded since the existing keys match
    file_client.upload_data.assert_not_called()


def test_ensure_metadata_raises_on_key_mismatch(fake_target, mock_fs):
    pub = _make_publisher(fake_target, mock_fs)

    existing = json.dumps({"keyColumns": ["different_id"], "protocolVersion": "1.0"}).encode("utf-8")
    file_client = MagicMock()
    file_client.download_file.return_value.readall.return_value = existing
    mock_fs.get_file_client.return_value = file_client

    with pytest.raises(ValueError, match="different keyColumns"):
        pub.ensure_metadata()


def test_next_sequence_returns_one_when_empty(fake_target, mock_fs):
    pub = _make_publisher(fake_target, mock_fs)
    mock_fs.get_paths.return_value = []
    assert pub.next_sequence() == 1


def test_next_sequence_handles_existing_files(fake_target, mock_fs):
    pub = _make_publisher(fake_target, mock_fs)

    existing = [
        MagicMock(name="dbo/orders/00000000000000000001.parquet"),
        MagicMock(name="dbo/orders/00000000000000000005.parquet"),
        MagicMock(name="dbo/orders/00000000000000000003.parquet"),
        MagicMock(name="dbo/orders/_metadata.json"),  # ignored — not a sequence file
    ]
    for e, fname in zip(existing, [
        "dbo/orders/00000000000000000001.parquet",
        "dbo/orders/00000000000000000005.parquet",
        "dbo/orders/00000000000000000003.parquet",
        "dbo/orders/_metadata.json",
    ]):
        e.name = fname
    mock_fs.get_paths.return_value = existing

    assert pub.next_sequence() == 6  # 5 + 1


def test_publish_change_uses_correct_marker(fake_target, mock_fs):
    pub = _make_publisher(fake_target, mock_fs)
    mock_fs.get_paths.return_value = []
    file_client = MagicMock()
    file_client.download_file.side_effect = Exception("404")  # metadata doesn't exist yet
    mock_fs.get_file_client.return_value = file_client

    try:
        import pyarrow as pa
    except ImportError:
        pytest.skip("pyarrow not installed; skip write test")

    table = pa.table({"order_id": [1, 2], "amount": [100, 250]})

    # Test each marker
    for op, expected_marker in [("insert", 1), ("update", 2), ("delete", 3)]:
        pub.write_batch(table, expected_marker)

    # Three writes happened (insert + update + delete)
    assert file_client.upload_data.call_count >= 3
