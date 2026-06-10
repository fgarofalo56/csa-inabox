# Synthetic IoT dataset (CUI-safe)

The primary workshop dataset. Fabricated device telemetry used across Days 2-4
for ingest, medallion transform, warehouse query, KQL real-time exploration,
semantic modeling, and Data Agent grounding.

!!! warning "CUI-safe by construction"
    All device IDs, sites, and readings are machine-generated. No real telemetry,
    locations, or assets are represented.

## Files

| File | Purpose | Rows (workshop size) |
|---|---|---|
| `sensor_readings.csv` | Time-series readings (Bronze source) | ~50,000 |
| `devices.csv` | Device dimension | ~250 |
| `sites.csv` | Site dimension | ~12 |

## Schema — `sensor_readings`

| Column | Type | Notes |
|---|---|---|
| `reading_id` | string (UUID) | Synthetic surrogate key |
| `device_id` | string | FK → `devices.device_id` (e.g., `DEV-00137`) |
| `timestamp` | timestamp (UTC) | 1-minute cadence per device |
| `metric` | string | `temperature` \| `vibration` \| `pressure` \| `humidity` |
| `reading_value` | double | Plausible range per metric; ~0.5% synthetic anomalies |
| `quality_flag` | string | `ok` \| `suspect` \| `missing` (for Silver cleansing) |

## Schema — `devices`

| Column | Type | Notes |
|---|---|---|
| `device_id` | string | PK (e.g., `DEV-00137`) |
| `site_id` | string | FK → `sites.site_id` |
| `device_type` | string | `pump` \| `compressor` \| `hvac` \| `gateway` |
| `install_date` | date | Synthetic |
| `firmware_version` | string | e.g., `2.4.1` |

## Schema — `sites`

| Column | Type | Notes |
|---|---|---|
| `site_id` | string | PK (e.g., `SITE-04`) |
| `site_name` | string | Fabricated (e.g., `North Facility`) |
| `region` | string | Generic region label, not a real address |

## Sample rows — `sensor_readings`

```csv
reading_id,device_id,timestamp,metric,reading_value,quality_flag
a1f3...,DEV-00137,2026-06-10T09:00:00Z,temperature,71.4,ok
b2e4...,DEV-00137,2026-06-10T09:01:00Z,temperature,72.1,ok
c3d5...,DEV-00204,2026-06-10T09:00:00Z,vibration,0.83,suspect
d4c6...,DEV-00204,2026-06-10T09:01:00Z,vibration,3.97,suspect
```

## Lab use

- **Day 2 (Ingest):** upload `sensor_readings.csv` to `bronze.sensor_readings`
  via **Lakehouse → Get data**; register `devices` + `sites` as dimensions.
- **Day 3 (Transform):** Bronze → Silver cleansing keys on `quality_flag`;
  Silver → Gold aggregates to `gold.device_hourly` (avg/max per device-hour).
- **Day 3 (KQL):** the same readings ingest into ADX (`.ingest inline`) for the
  real-time timechart lab.
- **Day 4 (BI/AI):** the semantic model and Data Agent ground on
  `gold.device_hourly` + the `devices`/`sites` dimensions.

## KQL ingest snippet (ADX real-time lab)

```kusto
.create table sensor_readings (reading_id:string, device_id:string, timestamp:datetime, metric:string, reading_value:real, quality_flag:string)

.ingest inline into table sensor_readings <|
a1f3...,DEV-00137,2026-06-10T09:00:00Z,temperature,71.4,ok
c3d5...,DEV-00204,2026-06-10T09:00:00Z,vibration,0.83,suspect
```

## Related

- [Datasets index](index.md) · [Day 2 — Ingest](../5-day-federal-coe/day-2-ingest.md)
- [Day 3 — Transform](../5-day-federal-coe/day-3-transform.md)
