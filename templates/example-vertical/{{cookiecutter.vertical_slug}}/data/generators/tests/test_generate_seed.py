"""Tests for the {{ cookiecutter.vertical_name }} seed generator.

Locks in determinism (same --seed produces byte-identical output) and
sanity-checks row counts / anomaly injection. Mirrors the pattern from
examples/iot-streaming/data/generators/tests/test_generators.py.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

# Make the generator module importable without packaging it.
GENERATORS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GENERATORS_DIR))

import generate_seed  # noqa: E402


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def test_seed_is_deterministic(tmp_path: Path) -> None:
    """Same --seed must produce byte-identical output."""
    out_a = tmp_path / "a"
    out_b = tmp_path / "b"
    base = [
        "--start-date", "2024-06-01",
        "--days", "1",
        "--stations", "3",
        "--seed", "42",
    ]
    assert generate_seed.main([*base, "--out", str(out_a)]) == 0
    assert generate_seed.main([*base, "--out", str(out_b)]) == 0
    assert _sha256(out_a / "observations_bronze.csv") == _sha256(out_b / "observations_bronze.csv")


def test_different_seeds_produce_different_output(tmp_path: Path) -> None:
    out_a = tmp_path / "s1"
    out_b = tmp_path / "s2"
    base = ["--start-date", "2024-06-01", "--days", "1", "--stations", "3"]
    generate_seed.main([*base, "--seed", "1", "--out", str(out_a)])
    generate_seed.main([*base, "--seed", "2", "--out", str(out_b)])
    assert _sha256(out_a / "observations_bronze.csv") != _sha256(out_b / "observations_bronze.csv")


def test_row_count_matches_cadence(tmp_path: Path) -> None:
    """Row count = (days * 24 / sample_frequency_hours) * stations * metrics."""
    out = tmp_path / "out"
    generate_seed.main([
        "--start-date", "2024-06-01",
        "--days", "1",
        "--stations", "3",
        "--seed", "42",
        "--out", str(out),
    ])
    with (out / "observations_bronze.csv").open("r", encoding="utf-8") as f:
        lines = f.readlines()
    stations = 3
    metrics = len(generate_seed.METRICS)
    readings_per_day = max(1, 24 // max(1, generate_seed.SAMPLE_FREQUENCY_HOURS))
    expected = 1 + readings_per_day * stations * metrics  # +1 header
    assert len(lines) == expected


def test_anomalies_injected(tmp_path: Path) -> None:
    """Over a 7-day sample at least some rows should be quality=UNCERTAIN."""
    out = tmp_path / "out"
    generate_seed.main([
        "--start-date", "2024-06-01",
        "--days", "7",
        "--stations", "5",
        "--seed", "42",
        "--out", str(out),
    ])
    uncertain = 0
    total = 0
    with (out / "observations_bronze.csv").open("r", encoding="utf-8") as f:
        header = f.readline().strip().split(",")
        quality_idx = header.index("quality_flag")
        for line in f:
            total += 1
            if line.strip().split(",")[quality_idx] == "UNCERTAIN":
                uncertain += 1
    assert total > 0
    # 1% anomaly rate - any non-zero count within a reasonable band confirms
    # injection is wired up.
    assert uncertain >= 1
    assert uncertain < total * 0.1


def test_help_exits_clean() -> None:
    """--help must exit 0 (smoke test for argparse wiring)."""
    with pytest.raises(SystemExit) as ex:
        generate_seed.parse_args(["--help"])
    assert ex.value.code == 0


def test_seed_flag_exists() -> None:
    """The --seed flag must exist (enforced by scripts/lint-vertical.sh)."""
    ns = generate_seed.parse_args(["--seed", "99"])
    assert ns.seed == 99
