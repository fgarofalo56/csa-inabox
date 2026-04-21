#!/usr/bin/env python3
"""Deterministic seed-data generator for the {{ cookiecutter.vertical_name }} vertical.

Produces bronze-layer CSV fixtures for dbt and unit tests. Invoking with the
same ``--seed`` always produces byte-identical output (sha256-stable). This
is the core contract for generators across CSA-in-a-Box verticals and is
enforced by ``tests/test_generate_seed.py``.

Usage:
    python generate_seed.py --days 7 --stations 5 --seed 42

Output directory defaults to ``data/seed/`` next to this generator. Override
with ``--out``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import random
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --- Constants -----------------------------------------------------------

DEFAULT_SEED = 42
DEFAULT_DAYS = 1
DEFAULT_STATIONS = 3
DEFAULT_START_DATE = "2024-01-01"
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "seed"

# Frequency from cookiecutter input. One observation every N hours per station.
SAMPLE_FREQUENCY_HOURS = {{ cookiecutter.sample_frequency_hours }}

ANOMALY_RATE = 0.01  # 1% of rows carry an injected out-of-range anomaly.

METRICS = {
    "temperature_c": (15.0, 8.0, -40.0, 50.0),   # (mu, sigma, min, max)
    "humidity_pct":  (55.0, 15.0, 0.0, 100.0),
    "pressure_hpa":  (1013.0, 5.0, 870.0, 1084.0),
}

STATION_ANCHORS = [
    ("{{ cookiecutter.vertical_slug }}-0001", 40.7128, -74.0060),
    ("{{ cookiecutter.vertical_slug }}-0002", 34.0522, -118.2437),
    ("{{ cookiecutter.vertical_slug }}-0003", 41.8781, -87.6298),
    ("{{ cookiecutter.vertical_slug }}-0004", 29.7604, -95.3698),
    ("{{ cookiecutter.vertical_slug }}-0005", 47.6062, -122.3321),
]


# --- Dataclasses ---------------------------------------------------------

@dataclass(frozen=True)
class Station:
    station_id: str
    lat: float
    lon: float


# --- CLI -----------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="generate_seed",
        description="Deterministic {{ cookiecutter.vertical_name }} seed generator.",
    )
    p.add_argument(
        "--start-date",
        default=DEFAULT_START_DATE,
        help=f"Start date YYYY-MM-DD (default: {DEFAULT_START_DATE})",
    )
    p.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help=f"Number of days to generate (default: {DEFAULT_DAYS})",
    )
    p.add_argument(
        "--stations",
        type=int,
        default=DEFAULT_STATIONS,
        help=f"Number of stations (default: {DEFAULT_STATIONS}, max {len(STATION_ANCHORS)})",
    )
    p.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Random seed for determinism (default: {DEFAULT_SEED})",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    return p.parse_args(argv)


# --- Generation ----------------------------------------------------------

def _iso_utc(dt: datetime) -> str:
    """Stable ISO-8601 UTC without microseconds (keeps diffs clean)."""
    return dt.replace(microsecond=0, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _build_stations(n: int) -> list[Station]:
    n = min(n, len(STATION_ANCHORS))
    return [Station(s, lat, lon) for s, lat, lon in STATION_ANCHORS[:n]]


def generate_observations(
    start: datetime,
    days: int,
    stations: list[Station],
    rng: random.Random,
    out_path: Path,
) -> int:
    """Write observations_bronze.csv. Returns the row count."""
    end = start + timedelta(days=days)
    rows = 0
    metrics = list(METRICS.keys())

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "station_id", "event_time", "metric_name", "value",
            "quality_flag", "latitude", "longitude",
        ])

        t = start
        step = timedelta(hours=max(1, SAMPLE_FREQUENCY_HOURS))
        while t < end:
            for st in stations:
                for metric in metrics:
                    mu, sigma, lo, hi = METRICS[metric]
                    # Mild daily variation for realism.
                    hour_phase = math.sin(2 * math.pi * t.hour / 24.0)
                    base = mu + 0.25 * sigma * hour_phase
                    value = rng.gauss(base, sigma)
                    quality = "GOOD"

                    if rng.random() < ANOMALY_RATE:
                        value = hi + rng.uniform(1.0, 10.0) if rng.random() < 0.5 else lo - rng.uniform(1.0, 10.0)
                        quality = "UNCERTAIN"

                    value = round(value, 4)

                    writer.writerow([
                        st.station_id,
                        _iso_utc(t),
                        metric,
                        value,
                        quality,
                        f"{st.lat:.6f}",
                        f"{st.lon:.6f}",
                    ])
                    rows += 1
            t += step
    return rows


# --- Orchestration -------------------------------------------------------

def run(args: argparse.Namespace) -> dict[str, int]:
    start = datetime.fromisoformat(args.start_date).replace(tzinfo=timezone.utc)
    args.out.mkdir(parents=True, exist_ok=True)

    # Single seeded RNG ensures byte-stability with the same --seed.
    rng = random.Random(args.seed)
    stations = _build_stations(args.stations)

    counts: dict[str, int] = {}
    counts["observations_bronze.csv"] = generate_observations(
        start, args.days, stations, rng, args.out / "observations_bronze.csv",
    )
    return counts


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    counts = run(args)

    print(f"Generated seeds in {args.out}:")
    for name, count in counts.items():
        path = args.out / name
        digest = sha256_of_file(path)[:12]
        print(f"  {name:<28} rows={count:>8}  sha256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
