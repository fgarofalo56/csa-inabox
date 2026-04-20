"""
Tests for the iot-streaming seed generators.

These tests lock in determinism — the same seed must produce byte-identical
output — and sanity-check row counts / anomaly injection.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

# Make the generator modules importable without packaging them.
GENERATORS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GENERATORS_DIR))

import generate_telemetry  # noqa: E402
import generate_devices    # noqa: E402


# ─── Helpers ───────────────────────────────────────────────────────────

def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ─── Tests ─────────────────────────────────────────────────────────────

def test_telemetry_is_deterministic(tmp_path: Path) -> None:
    """Same --seed must produce byte-identical telemetry output."""
    out_a = tmp_path / "run_a"
    out_b = tmp_path / "run_b"

    args = [
        "--start-date", "2024-06-01",
        "--days", "1",
        "--devices", "4",
        "--seed", "42",
    ]

    rc_a = generate_telemetry.main(args + ["--out", str(out_a)])
    rc_b = generate_telemetry.main(args + ["--out", str(out_b)])
    assert rc_a == 0 and rc_b == 0

    for name in ("telemetry_bronze.csv", "weather_bronze.csv", "aqi_bronze.csv", "slots_bronze.csv"):
        assert (out_a / name).exists(), f"missing {name}"
        assert (out_b / name).exists(), f"missing {name}"
        assert _sha256(out_a / name) == _sha256(out_b / name), (
            f"{name} differs between two runs with same seed"
        )


def test_different_seeds_produce_different_output(tmp_path: Path) -> None:
    """Different --seed values should produce different telemetry."""
    out_a = tmp_path / "s1"
    out_b = tmp_path / "s2"
    base = ["--start-date", "2024-06-01", "--days", "1", "--devices", "4"]
    generate_telemetry.main(base + ["--seed", "1", "--out", str(out_a)])
    generate_telemetry.main(base + ["--seed", "2", "--out", str(out_b)])
    assert _sha256(out_a / "telemetry_bronze.csv") != _sha256(out_b / "telemetry_bronze.csv")


def test_telemetry_row_count_matches_cadence(tmp_path: Path) -> None:
    """Row count should equal days * 1440 minutes * device_count."""
    out = tmp_path / "out"
    generate_telemetry.main([
        "--start-date", "2024-06-01",
        "--days", "1",
        "--devices", "3",
        "--seed", "42",
        "--out", str(out),
    ])
    telemetry = out / "telemetry_bronze.csv"
    with telemetry.open("r", encoding="utf-8") as f:
        lines = f.readlines()
    # Header + 1440 minutes * 3 devices = 4321
    assert len(lines) == 1 + 1440 * 3


def test_telemetry_includes_anomalies(tmp_path: Path) -> None:
    """At least one row in a 7-day sample should be quality=UNCERTAIN."""
    out = tmp_path / "out"
    generate_telemetry.main([
        "--start-date", "2024-06-01",
        "--days", "7",
        "--devices", "5",
        "--seed", "42",
        "--out", str(out),
    ])
    uncertain_count = 0
    total_count = 0
    with (out / "telemetry_bronze.csv").open("r", encoding="utf-8") as f:
        header = f.readline().strip().split(",")
        quality_idx = header.index("quality_flag")
        for line in f:
            total_count += 1
            if line.strip().split(",")[quality_idx] == "UNCERTAIN":
                uncertain_count += 1
    assert total_count > 0
    # Anomaly rate is 1% so in 7 days * 1440 * 5 = 50,400 rows we expect
    # ~504 anomalies. Assert we got a reasonable count.
    assert 50 < uncertain_count < 2000, f"anomaly count {uncertain_count} out of expected band"


def test_devices_generator_is_deterministic(tmp_path: Path) -> None:
    """generate_devices must also be deterministic."""
    out_a = tmp_path / "d_a"
    out_b = tmp_path / "d_b"
    generate_devices.main(["--devices", "30", "--seed", "42", "--out", str(out_a)])
    generate_devices.main(["--devices", "30", "--seed", "42", "--out", str(out_b)])
    assert _sha256(out_a / "devices.csv") == _sha256(out_b / "devices.csv")
    assert _sha256(out_a / "sensor_metadata.csv") == _sha256(out_b / "sensor_metadata.csv")


def test_help_works() -> None:
    """--help must exit cleanly (smoke test for argparse wiring)."""
    with pytest.raises(SystemExit) as ex:
        generate_telemetry.parse_args(["--help"])
    assert ex.value.code == 0
