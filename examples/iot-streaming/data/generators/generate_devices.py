#!/usr/bin/env python3
"""
Regenerate the dbt seed files `devices.csv` and `sensor_metadata.csv` for
the iot-streaming vertical.

This is optional: the canonical seeds live at
`examples/iot-streaming/domains/dbt/seeds/` and are hand-curated for
readability. This script rebuilds them deterministically so the catalog can
grow to hundreds of devices for load-testing without manual edits.

Usage:
    python generate_devices.py --devices 100 --seed 42

Output is written to `--out` (default: the dbt seeds directory).
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from datetime import date, timedelta
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "domains" / "dbt" / "seeds"
DEFAULT_SEED = 42

DEVICE_TYPES = ["temperature", "humidity", "pressure", "weather", "aqi", "slot_machine"]
VENDORS_BY_TYPE = {
    "temperature": ["Acme Sensors", "Bosch", "Honeywell"],
    "humidity": ["Acme Sensors", "Bosch"],
    "pressure": ["Bosch", "Honeywell"],
    "weather": ["NOAA", "Vaisala"],
    "aqi": ["EPA", "PurpleAir"],
    "slot_machine": ["IGT", "Aristocrat", "Scientific Games"],
}
CITY_COORDS = [
    (47.6062, -122.3321), (40.7128, -74.0060),
    (34.0522, -118.2437), (41.8781, -87.6298),
    (29.7604, -95.3698), (42.3601, -71.0589),
    (37.7749, -122.4194), (25.7617, -80.1918),
    (36.1699, -115.1398),
]

SENSOR_METADATA_ROWS = [
    ("temperature_c", "celsius", -40.0, 85.0, 2),
    ("humidity_pct", "percent", 0.0, 100.0, 2),
    ("pressure_hpa", "hectopascal", 800.0, 1100.0, 2),
    ("battery_pct", "percent", 0.0, 100.0, 1),
    ("wind_speed_ms", "meters_per_second", 0.0, 120.0, 2),
    ("wind_gust_ms", "meters_per_second", 0.0, 140.0, 2),
    ("precipitation_mm", "millimeter", 0.0, 1000.0, 2),
    ("pm25_ugm3", "micrograms_per_m3", 0.0, 500.0, 2),
    ("pm10_ugm3", "micrograms_per_m3", 0.0, 600.0, 2),
    ("ozone_ppb", "parts_per_billion", 0.0, 500.0, 2),
    ("no2_ppb", "parts_per_billion", 0.0, 2000.0, 2),
    ("visibility_km", "kilometer", 0.0, 200.0, 2),
    ("cloud_cover_pct", "percent", 0.0, 100.0, 1),
    ("coin_in", "usd", 0.0, 100000.0, 2),
    ("coin_out", "usd", 0.0, 100000.0, 2),
]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Regenerate iot-streaming dbt device seeds.")
    p.add_argument("--devices", type=int, default=20)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return p.parse_args(argv)


def generate_devices(n: int, rng: random.Random, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    base_date = date(2024, 1, 1)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["device_id", "type", "location_lat", "location_lon", "vendor", "install_date"])
        for i in range(n):
            dtype = DEVICE_TYPES[i % len(DEVICE_TYPES)]
            vendor = rng.choice(VENDORS_BY_TYPE[dtype])
            lat, lon = rng.choice(CITY_COORDS)
            prefix_map = {
                "temperature": "iot-temp",
                "humidity": "iot-hum",
                "pressure": "iot-press",
                "weather": "weather-ghcn",
                "aqi": "aqi-epa",
                "slot_machine": "slots-mgm",
            }
            device_id = f"{prefix_map[dtype]}-{i+1:04d}"
            install = base_date + timedelta(days=rng.randint(0, 365))
            w.writerow([device_id, dtype, f"{lat:.4f}", f"{lon:.4f}", vendor, install.isoformat()])
            rows += 1
    return rows


def generate_sensor_metadata(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["metric_type", "unit", "min_valid", "max_valid", "precision"])
        for row in SENSOR_METADATA_ROWS:
            w.writerow(row)
    return len(SENSOR_METADATA_ROWS)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    rng = random.Random(args.seed)
    dev_rows = generate_devices(args.devices, rng, args.out / "devices.csv")
    meta_rows = generate_sensor_metadata(args.out / "sensor_metadata.csv")
    print(f"Wrote {dev_rows} rows to {args.out / 'devices.csv'}")
    print(f"Wrote {meta_rows} rows to {args.out / 'sensor_metadata.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
