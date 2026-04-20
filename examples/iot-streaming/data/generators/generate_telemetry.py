#!/usr/bin/env python3
"""
Deterministic IoT telemetry seed generator for the iot-streaming vertical.

Produces bronze-layer CSV fixtures for dbt testing:
  - telemetry_bronze.csv  (IoT sensor readings, long format)
  - weather_bronze.csv    (NOAA-style weather observations)
  - aqi_bronze.csv        (EPA-style AQI readings)
  - slots_bronze.csv      (casino slot machine events)

Deterministic: invoking with the same --seed produces byte-identical output.

Anomalies (~1% of telemetry rows) are intentionally injected so that the
downstream silver layer can exercise range-validation and z-score anomaly
flagging.

Usage:
    python generate_telemetry.py --days 7 --devices 10 --seed 42

The output directory defaults to examples/iot-streaming/data/seed/ relative
to the repo root. Override with --out.
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

# ─── Constants ─────────────────────────────────────────────────────────

DEFAULT_SEED = 42
DEFAULT_DAYS = 1
DEFAULT_DEVICES = 10
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "data" / "seed"
DEFAULT_START_DATE = "2024-01-01"

TELEMETRY_CADENCE_SEC = 60   # Keep test fixtures small
WEATHER_CADENCE_MIN = 15
AQI_CADENCE_MIN = 60
SLOTS_EVENTS_PER_DAY_PER_MACHINE = 48

ANOMALY_RATE = 0.01  # 1% of telemetry rows carry an injected anomaly

# Metric catalogs
IOT_METRIC_RANGES = {
    "temperature_c": (18.0, 24.0, -40.0, 85.0),   # (mu, sigma, min, max)
    "humidity_pct":  (45.0, 8.0, 0.0, 100.0),
    "pressure_hpa":  (1013.0, 4.0, 800.0, 1100.0),
    "battery_pct":   (85.0, 10.0, 0.0, 100.0),
}

WEATHER_STATIONS = [
    ("weather-ghcn-0001", 42.3601, -71.0589),
    ("weather-ghcn-0002", 37.7749, -122.4194),
    ("weather-ghcn-0003", 25.7617, -80.1918),
]

AQI_SENSORS = [
    ("aqi-epa-0001", 34.0522, -118.2437),
    ("aqi-epa-0002", 29.7604, -95.3698),
    ("aqi-epa-0003", 41.8781, -87.6298),
]

SLOT_MACHINES = [
    "slots-mgm-0001",
    "slots-mgm-0002",
    "slots-mgm-0003",
    "slots-mgm-0004",
    "slots-mgm-0005",
]
SLOT_GAME_THEMES = ["DOUBLE_DIAMOND", "WHEEL_OF_FORTUNE", "BUFFALO", "LIGHTNING_LINK", "CLEOPATRA"]
SLOT_FLOOR_ZONES = ["HIGH_LIMIT", "MAIN_FLOOR_A", "MAIN_FLOOR_B", "PENNY_SLOTS"]
SLOT_EVENT_TYPES = ["SPIN", "CASH_IN", "CASH_OUT", "JACKPOT", "TILT"]


# ─── Dataclasses ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class IoTDevice:
    device_id: str
    metric_type: str
    lat: float
    lon: float


# ─── CLI ───────────────────────────────────────────────────────────────

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="generate_telemetry",
        description="Deterministic IoT telemetry seed generator.",
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
        "--devices",
        type=int,
        default=DEFAULT_DEVICES,
        help=f"Number of IoT devices (default: {DEFAULT_DEVICES})",
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


# ─── Generators ────────────────────────────────────────────────────────

def _iso_utc(dt: datetime) -> str:
    """Stable ISO-8601 UTC without microseconds (keeps diffs clean)."""
    return dt.replace(microsecond=0, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _build_iot_devices(n_devices: int) -> list[IoTDevice]:
    """Build a deterministic catalog of n IoT devices across the 4 metrics.

    Devices cycle through metric types so we cover each type with roughly
    equal counts. Lat/lon are drawn from a fixed list for reproducibility.
    """
    metric_types = list(IOT_METRIC_RANGES.keys())
    anchors = [
        (47.6062, -122.3321), (40.7128, -74.0060),
        (34.0522, -118.2437), (41.8781, -87.6298),
        (29.7604, -95.3698),
    ]
    devices: list[IoTDevice] = []
    for i in range(n_devices):
        metric = metric_types[i % len(metric_types)]
        lat, lon = anchors[i % len(anchors)]
        prefix = {
            "temperature_c": "iot-temp",
            "humidity_pct": "iot-hum",
            "pressure_hpa": "iot-press",
            "battery_pct": "iot-batt",
        }[metric]
        devices.append(IoTDevice(
            device_id=f"{prefix}-{i+1:04d}",
            metric_type=metric,
            lat=lat,
            lon=lon,
        ))
    return devices


def generate_telemetry(
    start: datetime,
    days: int,
    devices: list[IoTDevice],
    rng: random.Random,
    out_path: Path,
) -> int:
    """Write telemetry_bronze.csv. Returns the row count."""
    end = start + timedelta(days=days)
    rows = 0
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "device_id", "event_time", "metric_type", "value",
            "quality_flag", "source_event_hub", "latitude", "longitude",
        ])

        # Iterate by minute so readings are interleaved across devices
        # deterministically. Sorting by event_time keeps the output stable.
        minute = start
        while minute < end:
            for dev in devices:
                mu, sigma, lo, hi = IOT_METRIC_RANGES[dev.metric_type]
                # Small daily sinusoidal variation to keep it realistic
                hour_phase = math.sin(2 * math.pi * minute.hour / 24.0)
                base = mu + 0.5 * sigma * hour_phase
                value = rng.gauss(base, sigma)

                quality = "GOOD"

                # Inject anomalies ~1% of the time
                if rng.random() < ANOMALY_RATE:
                    # Push out of range to exercise silver anomaly flags
                    value = hi + rng.uniform(1.0, 10.0) if rng.random() < 0.5 else lo - rng.uniform(1.0, 10.0)
                    quality = "UNCERTAIN"

                # Clamp extreme numeric weirdness but keep out-of-range
                value = round(max(min(value, hi * 2), lo * 2 if lo < 0 else -1e6), 4)

                writer.writerow([
                    dev.device_id,
                    _iso_utc(minute),
                    dev.metric_type,
                    value,
                    quality,
                    "telemetry",
                    f"{dev.lat:.6f}",
                    f"{dev.lon:.6f}",
                ])
                rows += 1
            minute += timedelta(seconds=TELEMETRY_CADENCE_SEC)
    return rows


def generate_weather(
    start: datetime,
    days: int,
    rng: random.Random,
    out_path: Path,
) -> int:
    end = start + timedelta(days=days)
    rows = 0
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "station_id", "event_time", "temperature_c", "humidity_pct",
            "pressure_hpa", "wind_speed_ms", "wind_direction_deg",
            "wind_gust_ms", "precipitation_mm", "visibility_km",
            "cloud_cover_pct", "latitude", "longitude", "elevation_m",
            "quality_flag",
        ])
        t = start
        while t < end:
            for station_id, lat, lon in WEATHER_STATIONS:
                writer.writerow([
                    station_id,
                    _iso_utc(t),
                    round(rng.gauss(15.0, 10.0), 2),
                    round(max(0.0, min(100.0, rng.gauss(60.0, 15.0))), 2),
                    round(rng.gauss(1013.0, 6.0), 2),
                    round(max(0.0, rng.gauss(5.0, 3.0)), 2),
                    round(rng.uniform(0, 359), 0),
                    round(max(0.0, rng.gauss(8.0, 4.0)), 2),
                    round(max(0.0, rng.gauss(0.5, 1.5)), 2),
                    round(max(0.1, rng.gauss(20.0, 5.0)), 2),
                    round(max(0.0, min(100.0, rng.gauss(40.0, 20.0))), 1),
                    f"{lat:.6f}",
                    f"{lon:.6f}",
                    round(rng.uniform(0, 200), 2),
                    "GOOD",
                ])
                rows += 1
            t += timedelta(minutes=WEATHER_CADENCE_MIN)
    return rows


def generate_aqi(
    start: datetime,
    days: int,
    rng: random.Random,
    out_path: Path,
) -> int:
    end = start + timedelta(days=days)
    rows = 0

    def aqi_category(aqi: int) -> str:
        if aqi <= 50:
            return "GOOD"
        if aqi <= 100:
            return "MODERATE"
        if aqi <= 150:
            return "UNHEALTHY_SENSITIVE"
        if aqi <= 200:
            return "UNHEALTHY"
        if aqi <= 300:
            return "VERY_UNHEALTHY"
        return "HAZARDOUS"

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "sensor_id", "event_time", "pm25_ugm3", "pm10_ugm3",
            "ozone_ppb", "no2_ppb", "aqi", "aqi_category",
            "latitude", "longitude", "quality_flag",
        ])
        t = start
        while t < end:
            for sensor_id, lat, lon in AQI_SENSORS:
                pm25 = round(max(0.0, rng.gauss(12.0, 6.0)), 2)
                pm10 = round(max(0.0, rng.gauss(25.0, 10.0)), 2)
                o3 = round(max(0.0, rng.gauss(35.0, 12.0)), 2)
                no2 = round(max(0.0, rng.gauss(20.0, 8.0)), 2)
                aqi_value = int(max(0, min(500, rng.gauss(60.0, 25.0))))
                writer.writerow([
                    sensor_id,
                    _iso_utc(t),
                    pm25,
                    pm10,
                    o3,
                    no2,
                    aqi_value,
                    aqi_category(aqi_value),
                    f"{lat:.6f}",
                    f"{lon:.6f}",
                    "GOOD",
                ])
                rows += 1
            t += timedelta(minutes=AQI_CADENCE_MIN)
    return rows


def generate_slots(
    start: datetime,
    days: int,
    rng: random.Random,
    out_path: Path,
) -> int:
    end = start + timedelta(days=days)
    rows = 0
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "machine_id", "event_time", "event_type", "denomination",
            "credits_wagered", "credits_won", "coin_in", "coin_out",
            "floor_zone", "game_theme", "quality_flag",
        ])
        # Generate events per machine per day at a deterministic cadence
        interval = timedelta(seconds=int(86400 / SLOTS_EVENTS_PER_DAY_PER_MACHINE))
        for machine_id in SLOT_MACHINES:
            # Assign a stable theme/zone per machine via seeded hash
            theme = SLOT_GAME_THEMES[hash(machine_id) % len(SLOT_GAME_THEMES)]
            zone = SLOT_FLOOR_ZONES[hash(machine_id + "zone") % len(SLOT_FLOOR_ZONES)]
            t = start
            while t < end:
                event_type = rng.choices(
                    SLOT_EVENT_TYPES,
                    weights=[80, 5, 5, 2, 1],
                    k=1,
                )[0]
                denomination = rng.choice([0.01, 0.05, 0.25, 1.00, 5.00])
                credits_wagered = rng.randint(1, 100)
                # House edge ~8%
                won_draw = rng.random()
                if won_draw < 0.35:
                    credits_won = rng.randint(1, credits_wagered * 2)
                elif won_draw < 0.99:
                    credits_won = 0
                else:
                    credits_won = credits_wagered * rng.randint(10, 100)
                coin_in = round(credits_wagered * denomination, 2)
                coin_out = round(credits_won * denomination, 2)
                writer.writerow([
                    machine_id,
                    _iso_utc(t),
                    event_type,
                    denomination,
                    credits_wagered,
                    credits_won,
                    coin_in,
                    coin_out,
                    zone,
                    theme,
                    "GOOD",
                ])
                rows += 1
                t += interval
    return rows


# ─── Orchestration ─────────────────────────────────────────────────────

def run(args: argparse.Namespace) -> dict[str, int]:
    """Execute all generators; return row counts per file."""
    start = datetime.fromisoformat(args.start_date).replace(tzinfo=timezone.utc)
    args.out.mkdir(parents=True, exist_ok=True)

    # IMPORTANT: use a single seeded RNG and call generators in a fixed
    # order so the output is byte-identical across runs with the same seed.
    rng = random.Random(args.seed)

    devices = _build_iot_devices(args.devices)

    counts = {}
    counts["telemetry_bronze.csv"] = generate_telemetry(
        start, args.days, devices, rng, args.out / "telemetry_bronze.csv"
    )
    counts["weather_bronze.csv"] = generate_weather(
        start, args.days, rng, args.out / "weather_bronze.csv"
    )
    counts["aqi_bronze.csv"] = generate_aqi(
        start, args.days, rng, args.out / "aqi_bronze.csv"
    )
    counts["slots_bronze.csv"] = generate_slots(
        start, args.days, rng, args.out / "slots_bronze.csv"
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
        print(f"  {name:<26} rows={count:>8}  sha256={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
