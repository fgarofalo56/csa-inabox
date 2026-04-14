"""
Generic IoT sensor simulator for CSA-in-a-Box streaming patterns.

Generates realistic sensor telemetry and publishes to Azure Event Hubs.
Supports multiple sensor types: temperature, humidity, pressure, AQI,
slot machines, weather stations, and water gauges.

Usage:
    python iot_simulator.py --connection-string "$EH_CONN" --sensor-count 10
    python iot_simulator.py --sensor-type weather --sensor-count 5 --interval 10
    python iot_simulator.py --sensor-type slot_machine --sensor-count 50 --interval 1
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Optional: azure-eventhub for actual publishing
try:
    from azure.eventhub import EventHubProducerClient, EventData

    HAS_EVENTHUB = True
except ImportError:
    HAS_EVENTHUB = False


@dataclass
class SensorConfig:
    """Configuration for a single sensor instance."""

    sensor_id: str
    sensor_type: str
    location: dict[str, float] = field(default_factory=dict)
    baseline: dict[str, float] = field(default_factory=dict)
    noise_scale: float = 0.1


def _generate_temperature_reading(
    sensor: SensorConfig, t: float
) -> dict[str, Any]:
    """Generate a temperature/humidity reading with diurnal pattern."""
    base_temp = sensor.baseline.get("temperature", 20.0)
    # Diurnal cycle: warmer midday, cooler at night
    diurnal = 5.0 * math.sin(2 * math.pi * (t / 86400 - 0.25))
    # Random noise
    noise = random.gauss(0, sensor.noise_scale * 2)
    temp = base_temp + diurnal + noise

    humidity = sensor.baseline.get("humidity", 50.0)
    humidity += -0.5 * diurnal + random.gauss(0, 3)
    humidity = max(10, min(100, humidity))

    return {
        "sensor_id": sensor.sensor_id,
        "sensor_type": "temperature",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "temperature_c": round(temp, 2),
        "humidity_pct": round(humidity, 1),
        "pressure_hpa": round(
            sensor.baseline.get("pressure", 1013.25) + random.gauss(0, 1), 1
        ),
        "battery_pct": max(
            0, sensor.baseline.get("battery", 95) - random.random() * 0.01
        ),
        "latitude": sensor.location.get("lat", 38.9),
        "longitude": sensor.location.get("lon", -77.0),
    }


def _generate_aqi_reading(sensor: SensorConfig, t: float) -> dict[str, Any]:
    """Generate an AQI sensor reading with traffic and weather patterns."""
    base_pm25 = sensor.baseline.get("pm25", 12.0)
    # Morning and evening rush hour spikes
    hour_of_day = (t % 86400) / 3600
    rush_hour = 8.0 * (
        math.exp(-((hour_of_day - 8) ** 2) / 4)
        + math.exp(-((hour_of_day - 17) ** 2) / 4)
    )
    noise = max(0, random.gauss(0, 3))
    pm25 = max(0, base_pm25 + rush_hour + noise)

    # AQI calculation (simplified EPA breakpoints for PM2.5)
    if pm25 <= 12:
        aqi = pm25 * 50 / 12
    elif pm25 <= 35.4:
        aqi = 50 + (pm25 - 12) * 50 / 23.4
    elif pm25 <= 55.4:
        aqi = 100 + (pm25 - 35.4) * 50 / 20
    elif pm25 <= 150.4:
        aqi = 150 + (pm25 - 55.4) * 100 / 95
    else:
        aqi = 200 + (pm25 - 150.4) * 100 / 100

    return {
        "sensor_id": sensor.sensor_id,
        "sensor_type": "aqi",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pm25_ugm3": round(pm25, 1),
        "pm10_ugm3": round(pm25 * 1.5 + random.gauss(0, 5), 1),
        "ozone_ppb": round(
            max(0, sensor.baseline.get("ozone", 30) + noise * 2), 1
        ),
        "no2_ppb": round(max(0, 15 + rush_hour * 2 + random.gauss(0, 3)), 1),
        "aqi": round(aqi),
        "aqi_category": (
            "Good"
            if aqi <= 50
            else "Moderate"
            if aqi <= 100
            else "Unhealthy for Sensitive Groups"
            if aqi <= 150
            else "Unhealthy"
        ),
        "latitude": sensor.location.get("lat", 38.9),
        "longitude": sensor.location.get("lon", -77.0),
    }


def _generate_weather_reading(
    sensor: SensorConfig, t: float
) -> dict[str, Any]:
    """Generate a weather station reading (NOAA-style)."""
    temp_reading = _generate_temperature_reading(sensor, t)
    wind_speed = max(0, sensor.baseline.get("wind", 10) + random.gauss(0, 5))
    wind_dir = (sensor.baseline.get("wind_dir", 180) + random.gauss(0, 30)) % 360

    precip = 0.0
    if random.random() < 0.1:  # 10% chance of precipitation each interval
        precip = random.expovariate(1 / 2.5)

    return {
        "station_id": sensor.sensor_id,
        "sensor_type": "weather_station",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "temperature_c": temp_reading["temperature_c"],
        "humidity_pct": temp_reading["humidity_pct"],
        "pressure_hpa": temp_reading["pressure_hpa"],
        "wind_speed_ms": round(wind_speed, 1),
        "wind_direction_deg": round(wind_dir, 0),
        "wind_gust_ms": round(wind_speed * (1 + random.random() * 0.5), 1),
        "precipitation_mm": round(precip, 2),
        "visibility_km": round(
            max(0.1, 10 - precip * 2 + random.gauss(0, 1)), 1
        ),
        "cloud_cover_pct": round(
            max(0, min(100, 50 + random.gauss(0, 25))), 0
        ),
        "latitude": sensor.location.get("lat", 38.9),
        "longitude": sensor.location.get("lon", -77.0),
        "elevation_m": sensor.location.get("elevation", 100),
    }


def _generate_slot_event(sensor: SensorConfig, t: float) -> dict[str, Any]:
    """Generate a slot machine telemetry event."""
    denomination = random.choice([0.01, 0.05, 0.25, 1.00, 5.00])
    credits_wagered = random.choice([1, 2, 3, 5, 10, 20, 50, 100])
    _rtp = sensor.baseline.get("rtp", 0.92)  # noqa: F841 — reserved for future RTP-based payout modeling

    # Most spins are losses, some small wins, rare big wins
    r = random.random()
    if r < 0.55:  # 55% loss
        credits_won = 0
    elif r < 0.85:  # 30% small win
        credits_won = random.randint(1, credits_wagered * 2)
    elif r < 0.98:  # 13% medium win
        credits_won = random.randint(credits_wagered * 2, credits_wagered * 10)
    else:  # 2% big win
        credits_won = random.randint(credits_wagered * 10, credits_wagered * 100)

    event_type = "spin"
    if credits_won > credits_wagered * 50:
        event_type = "jackpot"
    elif credits_won > credits_wagered * 5:
        event_type = "bonus"

    return {
        "machine_id": sensor.sensor_id,
        "sensor_type": "slot_machine",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event_type": event_type,
        "denomination": denomination,
        "credits_wagered": credits_wagered,
        "credits_won": credits_won,
        "coin_in": round(denomination * credits_wagered, 2),
        "coin_out": round(denomination * credits_won, 2),
        "floor_zone": sensor.location.get("zone", "A"),
        "game_theme": sensor.baseline.get("theme", "classic"),
    }


GENERATORS = {
    "temperature": _generate_temperature_reading,
    "aqi": _generate_aqi_reading,
    "weather": _generate_weather_reading,
    "slot_machine": _generate_slot_event,
}


def create_sensors(
    sensor_type: str, count: int, seed: int = 42
) -> list[SensorConfig]:
    """Create a fleet of sensor instances with varied baselines."""
    rng = random.Random(seed)
    sensors = []

    for i in range(count):
        lat = rng.uniform(25, 48)
        lon = rng.uniform(-125, -70)

        if sensor_type == "slot_machine":
            zone = rng.choice(["A", "B", "C", "D", "VIP", "HIGH_LIMIT"])
            theme = rng.choice(
                [
                    "classic",
                    "video_poker",
                    "progressive",
                    "themed_adventure",
                    "megabucks",
                ]
            )
            sensors.append(
                SensorConfig(
                    sensor_id=f"SLOT-{i+1:04d}",
                    sensor_type=sensor_type,
                    location={"zone": zone, "row": rng.randint(1, 20)},
                    baseline={"rtp": rng.uniform(0.88, 0.96), "theme": theme},
                )
            )
        else:
            sensors.append(
                SensorConfig(
                    sensor_id=f"{sensor_type.upper()}-{i+1:04d}",
                    sensor_type=sensor_type,
                    location={"lat": lat, "lon": lon, "elevation": rng.uniform(0, 2000)},
                    baseline={
                        "temperature": rng.uniform(5, 35),
                        "humidity": rng.uniform(20, 80),
                        "pressure": rng.uniform(1000, 1030),
                        "pm25": rng.uniform(5, 30),
                        "ozone": rng.uniform(15, 50),
                        "wind": rng.uniform(0, 20),
                        "wind_dir": rng.uniform(0, 360),
                    },
                    noise_scale=rng.uniform(0.05, 0.2),
                )
            )

    return sensors


def run_simulator(
    sensor_type: str,
    sensor_count: int,
    interval_seconds: float,
    connection_string: str | None,
    event_hub_name: str,
    max_events: int | None,
    seed: int,
) -> None:
    """Run the IoT sensor simulator."""
    sensors = create_sensors(sensor_type, sensor_count, seed)
    generator = GENERATORS[sensor_type]

    producer = None
    if connection_string and HAS_EVENTHUB:
        producer = EventHubProducerClient.from_connection_string(
            connection_string, eventhub_name=event_hub_name
        )
        print(f"Connected to Event Hub: {event_hub_name}")
    elif connection_string and not HAS_EVENTHUB:
        print("WARNING: azure-eventhub not installed. Outputting to stdout.")
    else:
        print("No connection string provided. Outputting to stdout.")

    start_time = time.time()
    event_count = 0

    try:
        while True:
            elapsed = time.time() - start_time
            batch_events = []

            for sensor in sensors:
                event = generator(sensor, elapsed)
                batch_events.append(event)
                event_count += 1

            if producer:
                batch = producer.create_batch()
                for event in batch_events:
                    batch.add(EventData(json.dumps(event)))
                producer.send_batch(batch)
            else:
                for event in batch_events:
                    print(json.dumps(event))

            if event_count % (sensor_count * 10) == 0:
                print(
                    f"[{datetime.now(timezone.utc).isoformat()}] "
                    f"Published {event_count} events from {sensor_count} sensors",
                    file=sys.stderr,
                )

            if max_events and event_count >= max_events:
                break

            time.sleep(interval_seconds)

    except KeyboardInterrupt:
        print(f"\nStopped after {event_count} events.", file=sys.stderr)
    finally:
        if producer:
            producer.close()


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="IoT Sensor Simulator for CSA-in-a-Box"
    )
    parser.add_argument(
        "--sensor-type",
        choices=list(GENERATORS.keys()),
        default="temperature",
        help="Type of sensor to simulate",
    )
    parser.add_argument(
        "--sensor-count", type=int, default=10, help="Number of sensors"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=5.0,
        help="Seconds between readings per sensor",
    )
    parser.add_argument(
        "--connection-string",
        default=None,
        help="Event Hub connection string (omit for stdout)",
    )
    parser.add_argument(
        "--event-hub-name", default="raw-events", help="Event Hub name"
    )
    parser.add_argument(
        "--max-events", type=int, default=None, help="Max events then stop"
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed")

    args = parser.parse_args()

    print(f"Starting {args.sensor_type} simulator", file=sys.stderr)
    print(f"  Sensors: {args.sensor_count}", file=sys.stderr)
    print(f"  Interval: {args.interval}s", file=sys.stderr)
    print(
        f"  Target: {'Event Hub' if args.connection_string else 'stdout'}",
        file=sys.stderr,
    )

    run_simulator(
        sensor_type=args.sensor_type,
        sensor_count=args.sensor_count,
        interval_seconds=args.interval,
        connection_string=args.connection_string,
        event_hub_name=args.event_hub_name,
        max_events=args.max_events,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
