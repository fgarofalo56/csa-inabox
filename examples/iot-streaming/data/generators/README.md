# IoT Streaming — Seed Data Generators

Deterministic batch-fixture generators for the iot-streaming vertical's
dbt project. These do **not** replace the real-time simulator at
`examples/iot-streaming/producers/iot_simulator.py` — they produce static
CSV fixtures so the medallion (bronze → silver → gold) can be exercised
without standing up Event Hub or ADX.

## Files

| File | Purpose |
|---|---|
| `generate_telemetry.py` | Produces the four bronze-layer CSVs (telemetry, weather, AQI, slots). |
| `generate_devices.py`   | Regenerates the `devices.csv` + `sensor_metadata.csv` dbt seeds. |
| `tests/test_generators.py` | Determinism + row-count + anomaly-injection tests. |

## Quick start

```bash
# 7 days of telemetry for 10 devices (default seed=42)
python examples/iot-streaming/data/generators/generate_telemetry.py --days 7

# Custom run
python examples/iot-streaming/data/generators/generate_telemetry.py \
  --start-date 2024-06-01 \
  --days 3 \
  --devices 20 \
  --seed 42 \
  --out examples/iot-streaming/data/seed/
```

Output (one CSV per source) lands in
`examples/iot-streaming/data/seed/`:

- `telemetry_bronze.csv`  — long format (device_id, event_time, metric_type, value, ...)
- `weather_bronze.csv`    — wide NOAA-style weather observations
- `aqi_bronze.csv`        — EPA-style AQI readings with category bands
- `slots_bronze.csv`      — casino slot-machine events

## Reproducibility

Both generators use a single seeded `random.Random(seed)` instance and
call the per-source generators in a fixed order. The same `--seed` value
produces byte-identical output; the test suite enforces this with
sha256 comparison.

Non-determinism sources to watch for when extending:

- Avoid `random.shuffle()` over unordered sets — iterate lists.
- Avoid iterating `dict.items()` on versions < 3.7 (not relevant here; we
  require Python 3.10+).
- Avoid embedding `datetime.now()` — every timestamp derives from
  `--start-date`.

## Anomaly injection

~1% of telemetry readings are pushed intentionally out of range (with
`quality_flag = UNCERTAIN`) so the silver-layer anomaly detection models
(`slv_anomaly_flags`) have signal to flag. See `ANOMALY_RATE` at the top
of `generate_telemetry.py`.

## Running the tests

```bash
python -m pytest examples/iot-streaming/data/generators/tests/ -v
```

The tests cover:

1. Same-seed determinism across two invocations.
2. Different seeds produce different output.
3. Telemetry row count matches the `days * 1440 * devices` formula.
4. Anomaly injection lands within the expected 1% band.
5. `generate_devices.py` is also deterministic.
6. `--help` exits cleanly (argparse wiring smoke test).

## Integrating with dbt

Once the seeds are generated, point your dbt profile's sources at the
`data/seed/` directory (or upload the CSVs to ADLS bronze) and run:

```bash
cd examples/iot-streaming/domains/dbt
dbt seed     # load devices.csv + sensor_metadata.csv
dbt run      # bronze → silver → gold
dbt test     # schema tests from models/schema.yml
```
