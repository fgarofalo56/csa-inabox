"""Tests for scripts/Azure IPs/parseIPs.py — IP prefix parsing and merging."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import load_script_module

# Load parseIPs as a module since it's in a directory with spaces (not a package).
_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "Azure IPs" / "parseIPs.py"
_mod = load_script_module("parseIPs", _SCRIPT_PATH)

extract_address_prefixes = _mod.extract_address_prefixes  # type: ignore[attr-defined]
merge_prefixes = _mod.merge_prefixes  # type: ignore[attr-defined]
write_to_file = _mod.write_to_file  # type: ignore[attr-defined]


# ── Fixtures ────────────────────────────────────────────────────────


def _write_service_tags(directory: Path, prefixes_v4: list[str], prefixes_v6: list[str] | None = None) -> None:
    """Write a minimal Azure Service Tags JSON file."""
    all_prefixes = list(prefixes_v4) + (prefixes_v6 or [])
    data: dict[str, Any] = {
        "values": [
            {
                "name": "TestService",
                "properties": {
                    "addressPrefixes": all_prefixes,
                },
            },
        ],
    }
    (directory / "test_tags.json").write_text(json.dumps(data), encoding="utf-8")


# ── extract_address_prefixes tests ──────────────────────────────────


class TestExtractAddressPrefixes:
    def test_extracts_ipv4_prefixes(self, tmp_path: Path) -> None:
        _write_service_tags(tmp_path, ["10.0.0.0/8", "192.168.1.0/24"])
        v4, v6 = extract_address_prefixes(str(tmp_path))
        assert "10.0.0.0/8" in v4
        assert "192.168.1.0/24" in v4
        assert len(v6) == 0

    def test_extracts_ipv6_prefixes(self, tmp_path: Path) -> None:
        _write_service_tags(tmp_path, [], ["2001:db8::/32", "fe80::/10"])
        v4, v6 = extract_address_prefixes(str(tmp_path))
        assert len(v4) == 0
        assert len(v6) == 2

    def test_separates_v4_and_v6(self, tmp_path: Path) -> None:
        _write_service_tags(tmp_path, ["10.0.0.0/8"], ["2001:db8::/32"])
        v4, v6 = extract_address_prefixes(str(tmp_path))
        assert len(v4) == 1
        assert len(v6) == 1

    def test_raises_on_missing_directory(self) -> None:
        with pytest.raises(FileNotFoundError):
            extract_address_prefixes("/nonexistent/path/abc123")

    def test_handles_empty_directory(self, tmp_path: Path) -> None:
        v4, v6 = extract_address_prefixes(str(tmp_path))
        assert len(v4) == 0
        assert len(v6) == 0

    def test_skips_invalid_prefixes(self, tmp_path: Path) -> None:
        data: dict[str, Any] = {
            "values": [
                {"properties": {"addressPrefixes": ["10.0.0.0/8", "not-an-ip"]}},
            ],
        }
        (tmp_path / "bad.json").write_text(json.dumps(data), encoding="utf-8")
        v4, _v6 = extract_address_prefixes(str(tmp_path))
        assert "10.0.0.0/8" in v4
        assert len(v4) == 1

    def test_deduplicates_prefixes(self, tmp_path: Path) -> None:
        _write_service_tags(tmp_path, ["10.0.0.0/8", "10.0.0.0/8"])
        v4, _ = extract_address_prefixes(str(tmp_path))
        assert len(v4) == 1


# ── merge_prefixes tests ───────────────────────────────────────────


class TestMergePrefixes:
    def test_collapses_adjacent_subnets(self) -> None:
        prefixes = {"192.168.0.0/25", "192.168.0.128/25"}
        merged = merge_prefixes(prefixes)
        assert "192.168.0.0/24" in merged

    def test_returns_empty_for_empty_input(self) -> None:
        assert merge_prefixes(set()) == []

    def test_preserves_non_overlapping(self) -> None:
        prefixes = {"10.0.0.0/8", "172.16.0.0/12"}
        merged = merge_prefixes(prefixes)
        assert len(merged) == 2

    def test_output_is_sorted(self) -> None:
        prefixes = {"172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"}
        merged = merge_prefixes(prefixes)
        assert merged == sorted(merged)

    def test_collapses_superset_and_subset(self) -> None:
        prefixes = {"10.0.0.0/8", "10.1.0.0/16"}
        merged = merge_prefixes(prefixes)
        assert merged == ["10.0.0.0/8"]


# ── write_to_file tests ───────────────────────────────────────────


class TestWriteToFile:
    def test_writes_prefixes_one_per_line(self, tmp_path: Path) -> None:
        output = tmp_path / "output.txt"
        write_to_file(["10.0.0.0/8", "172.16.0.0/12"], str(output))
        lines = output.read_text(encoding="utf-8").strip().splitlines()
        assert lines == ["10.0.0.0/8", "172.16.0.0/12"]

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        output = tmp_path / "sub" / "dir" / "output.txt"
        write_to_file(["10.0.0.0/8"], str(output))
        assert output.exists()

    def test_handles_empty_list(self, tmp_path: Path) -> None:
        output = tmp_path / "empty.txt"
        write_to_file([], str(output))
        assert output.read_text(encoding="utf-8") == ""
