#!/usr/bin/env python3
"""
NOAA Synthetic Data Generator

Generates realistic synthetic data for the NOAA Climate & Environmental
Analytics platform, including weather station observations, storm events,
and ocean buoy readings. Data follows real-world seasonal patterns,
geographic distributions, and physical correlations.

Usage:
    python generate_noaa_data.py --output-dir ../../domains/dbt/seeds
    python generate_noaa_data.py --stations 200 --storm-events 1000 --buoys 30
    python generate_noaa_data.py --format parquet --output-dir ./output
"""

import argparse
import csv
import math
import os
import random
from datetime import datetime, timedelta
from typing import Any

# ---------------------------------------------------------------------------
# Reference data: realistic station metadata
# ---------------------------------------------------------------------------

US_STATES = [
    ("AL", "ALABAMA", "01", 32.8, -86.8, "SOUTHEAST"),
    ("AK", "ALASKA", "02", 64.2, -152.5, "ALASKA"),
    ("AZ", "ARIZONA", "04", 34.0, -111.1, "SOUTHWEST"),
    ("AR", "ARKANSAS", "05", 35.2, -91.8, "SOUTH"),
    ("CA", "CALIFORNIA", "06", 36.8, -119.4, "WEST"),
    ("CO", "COLORADO", "08", 39.1, -105.4, "SOUTHWEST"),
    ("CT", "CONNECTICUT", "09", 41.6, -72.7, "NORTHEAST"),
    ("DE", "DELAWARE", "10", 38.9, -75.5, "NORTHEAST"),
    ("FL", "FLORIDA", "12", 27.8, -81.8, "SOUTHEAST"),
    ("GA", "GEORGIA", "13", 32.7, -83.5, "SOUTHEAST"),
    ("HI", "HAWAII", "15", 19.9, -155.6, "HAWAII"),
    ("ID", "IDAHO", "16", 44.1, -114.7, "NORTHWEST"),
    ("IL", "ILLINOIS", "17", 40.3, -89.0, "OHIO_VALLEY"),
    ("IN", "INDIANA", "18", 40.3, -86.1, "OHIO_VALLEY"),
    ("IA", "IOWA", "19", 42.0, -93.2, "UPPER_MIDWEST"),
    ("KS", "KANSAS", "20", 38.5, -98.8, "SOUTH"),
    ("KY", "KENTUCKY", "21", 37.7, -84.7, "OHIO_VALLEY"),
    ("LA", "LOUISIANA", "22", 31.2, -92.1, "SOUTH"),
    ("ME", "MAINE", "23", 45.3, -69.4, "NORTHEAST"),
    ("MD", "MARYLAND", "24", 39.0, -76.6, "NORTHEAST"),
    ("MA", "MASSACHUSETTS", "25", 42.4, -71.4, "NORTHEAST"),
    ("MI", "MICHIGAN", "26", 44.3, -84.5, "UPPER_MIDWEST"),
    ("MN", "MINNESOTA", "27", 46.7, -94.7, "UPPER_MIDWEST"),
    ("MS", "MISSISSIPPI", "28", 32.4, -89.7, "SOUTH"),
    ("MO", "MISSOURI", "29", 38.6, -91.8, "OHIO_VALLEY"),
    ("MT", "MONTANA", "30", 47.0, -109.6, "NORTHERN_ROCKIES_PLAINS"),
    ("NE", "NEBRASKA", "31", 41.5, -99.9, "NORTHERN_ROCKIES_PLAINS"),
    ("NV", "NEVADA", "32", 38.8, -116.4, "WEST"),
    ("NH", "NEW HAMPSHIRE", "33", 43.2, -71.6, "NORTHEAST"),
    ("NJ", "NEW JERSEY", "34", 40.1, -74.4, "NORTHEAST"),
    ("NM", "NEW MEXICO", "35", 34.8, -106.2, "SOUTHWEST"),
    ("NY", "NEW YORK", "36", 43.3, -75.0, "NORTHEAST"),
    ("NC", "NORTH CAROLINA", "37", 35.6, -79.8, "SOUTHEAST"),
    ("ND", "NORTH DAKOTA", "38", 47.5, -100.5, "NORTHERN_ROCKIES_PLAINS"),
    ("OH", "OHIO", "39", 40.4, -82.9, "OHIO_VALLEY"),
    ("OK", "OKLAHOMA", "40", 35.0, -97.1, "SOUTH"),
    ("OR", "OREGON", "41", 44.0, -120.5, "NORTHWEST"),
    ("PA", "PENNSYLVANIA", "42", 41.2, -77.2, "NORTHEAST"),
    ("RI", "RHODE ISLAND", "44", 41.6, -71.5, "NORTHEAST"),
    ("SC", "SOUTH CAROLINA", "45", 34.0, -81.0, "SOUTHEAST"),
    ("SD", "SOUTH DAKOTA", "46", 44.3, -100.4, "NORTHERN_ROCKIES_PLAINS"),
    ("TN", "TENNESSEE", "47", 35.5, -86.6, "OHIO_VALLEY"),
    ("TX", "TEXAS", "48", 31.0, -100.0, "SOUTH"),
    ("UT", "UTAH", "49", 39.3, -111.1, "SOUTHWEST"),
    ("VT", "VERMONT", "50", 44.6, -72.6, "NORTHEAST"),
    ("VA", "VIRGINIA", "51", 37.8, -79.4, "SOUTHEAST"),
    ("WA", "WASHINGTON", "53", 47.4, -121.5, "NORTHWEST"),
    ("WV", "WEST VIRGINIA", "54", 38.6, -80.9, "OHIO_VALLEY"),
    ("WI", "WISCONSIN", "55", 43.8, -89.5, "UPPER_MIDWEST"),
    ("WY", "WYOMING", "56", 43.1, -107.6, "NORTHERN_ROCKIES_PLAINS"),
]

STORM_EVENT_TYPES = [
    ("Thunderstorm Wind", 0.30, ["SPRING", "SUMMER"]),
    ("Hail", 0.18, ["SPRING", "SUMMER"]),
    ("Flash Flood", 0.10, ["SPRING", "SUMMER", "FALL"]),
    ("Tornado", 0.06, ["SPRING", "SUMMER"]),
    ("Heavy Rain", 0.08, ["SPRING", "SUMMER", "FALL"]),
    ("Winter Storm", 0.07, ["WINTER"]),
    ("Heavy Snow", 0.05, ["WINTER"]),
    ("High Wind", 0.04, ["WINTER", "SPRING", "FALL"]),
    ("Flood", 0.03, ["SPRING"]),
    ("Blizzard", 0.02, ["WINTER"]),
    ("Lightning", 0.02, ["SUMMER"]),
    ("Drought", 0.01, ["SUMMER"]),
    ("Hurricane", 0.01, ["SUMMER", "FALL"]),
    ("Ice Storm", 0.01, ["WINTER"]),
    ("Wildfire", 0.01, ["SUMMER", "FALL"]),
    ("Excessive Heat", 0.01, ["SUMMER"]),
]

BUOY_STATIONS = [
    ("41001", "HATTERAS", 34.68, -72.66, 4427.0, "ATLANTIC_EAST_COAST"),
    ("41002", "S HATTERAS", 32.27, -75.42, 3832.0, "ATLANTIC_EAST_COAST"),
    ("41004", "EDISTO", 32.50, -79.10, 38.0, "ATLANTIC_EAST_COAST"),
    ("41008", "GRAYS REEF", 31.40, -80.87, 18.0, "ATLANTIC_EAST_COAST"),
    ("41013", "FRYING PAN", 33.44, -77.74, 23.5, "ATLANTIC_EAST_COAST"),
    ("42001", "MID GULF", 25.90, -89.67, 3247.0, "GULF_OF_MEXICO"),
    ("42002", "W GULF", 26.09, -93.65, 2556.0, "GULF_OF_MEXICO"),
    ("42003", "E GULF", 26.01, -85.91, 3280.0, "GULF_OF_MEXICO"),
    ("42019", "FREEPORT", 27.91, -95.36, 82.0, "GULF_OF_MEXICO"),
    ("42020", "CORPUS CHRISTI", 26.97, -96.69, 84.0, "GULF_OF_MEXICO"),
    ("42035", "GALVESTON", 29.23, -94.41, 16.0, "GULF_OF_MEXICO"),
    ("44013", "BOSTON", 42.35, -70.69, 64.0, "ATLANTIC_EAST_COAST"),
    ("44017", "MONTAUK", 40.69, -72.05, 46.0, "ATLANTIC_EAST_COAST"),
    ("44025", "LONG ISLAND", 40.25, -73.16, 36.0, "ATLANTIC_EAST_COAST"),
    ("46001", "GULF OF ALASKA", 56.30, -148.17, 4206.0, "GULF_OF_ALASKA"),
    ("46005", "WASHINGTON", 46.14, -131.02, 2808.0, "PACIFIC_WEST_COAST"),
    ("46011", "SANTA MARIA", 34.87, -120.87, 200.0, "PACIFIC_WEST_COAST"),
    ("46025", "SANTA MONICA", 33.75, -119.08, 882.0, "PACIFIC_WEST_COAST"),
    ("46026", "SAN FRANCISCO", 37.75, -122.82, 52.0, "PACIFIC_WEST_COAST"),
    ("46027", "CRESCENT CITY", 41.85, -124.38, 48.0, "PACIFIC_WEST_COAST"),
    ("46029", "COLUMBIA RIVER", 46.14, -124.51, 140.0, "PACIFIC_WEST_COAST"),
    ("46041", "CAPE ELIZABETH", 47.35, -124.73, 132.0, "PACIFIC_WEST_COAST"),
    ("46047", "TANNER BANK", 32.43, -119.53, 1393.0, "PACIFIC_WEST_COAST"),
    ("51001", "NW HAWAII", 23.43, -162.21, 4846.0, "HAWAII_PACIFIC"),
    ("51003", "SE HAWAII", 19.16, -160.74, 4822.0, "HAWAII_PACIFIC"),
]


def _seasonal_temp(
    day_of_year: int,
    base_temp_c: float,
    amplitude_c: float,
    elevation_m: float,
) -> float:
    """Produce a seasonal temperature curve with elevation lapse rate."""
    seasonal = amplitude_c * math.sin(
        2 * math.pi * (day_of_year - 80) / 365.0  # peak around day 172 (late June)
    )
    lapse_rate = -6.5 / 1000.0  # °C per meter
    elevation_adj = lapse_rate * elevation_m
    return base_temp_c + seasonal + elevation_adj


def _seasonal_precip(
    day_of_year: int,
    base_mm: float,
    region: str,
) -> float:
    """Produce seasonal precipitation pattern varying by climate region."""
    if region in ("NORTHWEST", "WEST"):
        # Winter-wet pattern (Mediterranean)
        seasonal = 1.0 + 0.8 * math.cos(2 * math.pi * (day_of_year - 15) / 365.0)
    elif region in ("SOUTH", "SOUTHEAST"):
        # Summer-wet pattern (subtropical)
        seasonal = 1.0 + 0.5 * math.sin(2 * math.pi * (day_of_year - 80) / 365.0)
    else:
        # Spring/summer peak (continental)
        seasonal = 1.0 + 0.4 * math.sin(2 * math.pi * (day_of_year - 60) / 365.0)
    return max(0, base_mm * seasonal)


# ---------------------------------------------------------------------------
# Generator functions
# ---------------------------------------------------------------------------

def generate_weather_observations(
    num_stations: int = 500,
    num_days: int = 365,
    start_date: datetime | None = None,
) -> list[dict[str, Any]]:
    """
    Generate synthetic GHCN-Daily weather station observations.

    Each record is an element-level observation (TMAX, TMIN, PRCP, SNOW, AWND)
    at a station on a given date. Values use GHCN units: tenths of degrees
    Celsius and tenths of millimeters.

    Args:
        num_stations: Number of unique stations to generate.
        num_days: Number of days of data per station.
        start_date: First observation date. Defaults to Jan 1 of previous year.

    Returns:
        List of observation dicts ready for CSV output.
    """
    if start_date is None:
        start_date = datetime(datetime.now().year - 1, 1, 1)

    records: list[dict[str, Any]] = []
    rng = random.Random(42)  # Deterministic for reproducibility

    # Create stations distributed across states
    stations = []
    for i in range(num_stations):
        state = US_STATES[i % len(US_STATES)]
        station_id = f"USW{str(10000 + i).zfill(8)}"
        lat = state[3] + rng.uniform(-1.5, 1.5)
        lon = state[4] + rng.uniform(-2.0, 2.0)
        elev = max(0, rng.gauss(300, 400))  # Elevation in meters
        stations.append({
            "station_id": station_id,
            "station_name": f"STATION_{state[0]}_{i:04d}",
            "state_code": state[0],
            "country_code": "US",
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "elevation": round(elev, 1),
            "region": state[5],
            "base_temp": rng.gauss(15, 8),      # Base annual mean temp °C
            "temp_amplitude": rng.uniform(10, 20),  # Seasonal swing
            "base_precip": rng.uniform(1.5, 6.0),   # Base daily precip mm
        })

    load_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for station in stations:
        for day_offset in range(num_days):
            obs_date = start_date + timedelta(days=day_offset)
            doy = obs_date.timetuple().tm_yday

            # Skip some days randomly (5% data gaps)
            if rng.random() < 0.05:
                continue

            # Temperature
            base_t = _seasonal_temp(
                doy, station["base_temp"], station["temp_amplitude"], station["elevation"]
            )
            daily_var = rng.gauss(0, 2.5)
            tmax_c = base_t + abs(rng.gauss(4, 1.5)) + daily_var
            tmin_c = base_t - abs(rng.gauss(4, 1.5)) + daily_var

            # GHCN units: tenths of degrees Celsius
            tmax_raw = round(tmax_c * 10)
            tmin_raw = round(tmin_c * 10)

            # Precipitation (log-normal when it rains)
            precip_chance = _seasonal_precip(doy, 0.35, station["region"])
            if rng.random() < precip_chance:
                precip_mm = rng.lognormvariate(1.0, 1.2)
            else:
                precip_mm = 0.0
            prcp_raw = round(precip_mm * 10)  # tenths of mm

            # Snowfall (only when cold enough)
            snow_raw = 0
            if tmin_c < 1.0 and precip_mm > 0:
                snow_ratio = rng.uniform(8, 15)
                snow_raw = round(precip_mm * snow_ratio * 10)  # tenths of mm

            # Wind speed (m/s * 10)
            base_wind = rng.uniform(1.5, 5.0)
            wind_ms = max(0, base_wind + rng.gauss(0, 1.5))
            awnd_raw = round(wind_ms * 10)

            # Quality flag: mostly empty (pass), occasionally flagged
            qc_flag = "" if rng.random() > 0.02 else rng.choice(["S", "R", ""])

            common = {
                "station_id": station["station_id"],
                "station_name": station["station_name"],
                "latitude": station["latitude"],
                "longitude": station["longitude"],
                "elevation": station["elevation"],
                "state_code": station["state_code"],
                "country_code": station["country_code"],
                "observation_date": obs_date.strftime("%Y-%m-%d"),
                "measurement_flag": "",
                "quality_flag": qc_flag,
                "source_flag": "W",
                "load_time": load_time,
            }

            for element, value in [
                ("TMAX", str(tmax_raw)),
                ("TMIN", str(tmin_raw)),
                ("PRCP", str(prcp_raw)),
                ("SNOW", str(snow_raw)),
                ("AWND", str(awnd_raw)),
            ]:
                rec = {**common, "element": element, "value": value}
                records.append(rec)

    return records


def generate_storm_events(n: int = 2000) -> list[dict[str, Any]]:
    """
    Generate synthetic NCEI Storm Events Database records.

    Events follow realistic seasonal and geographic distributions, with
    damage and casualty values correlated to event type and magnitude.

    Args:
        n: Number of storm events to generate.

    Returns:
        List of storm event dicts ready for CSV output.
    """
    rng = random.Random(123)
    records: list[dict[str, Any]] = []

    # Build weighted event type selector
    event_weights = [e[1] for e in STORM_EVENT_TYPES]
    event_types_list = [e[0] for e in STORM_EVENT_TYPES]
    event_seasons_map = {e[0]: e[2] for e in STORM_EVENT_TYPES}

    # Tornado-prone states
    tornado_alley = {"TX", "OK", "KS", "NE", "SD", "IA", "MO", "AR", "MS", "AL", "IL", "IN"}

    load_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for i in range(n):
        event_type = rng.choices(event_types_list, weights=event_weights, k=1)[0]
        valid_seasons = event_seasons_map[event_type]

        # Pick a season and derive month/date
        season = rng.choice(valid_seasons)
        if season == "WINTER":
            month = rng.choice([12, 1, 2])
        elif season == "SPRING":
            month = rng.choice([3, 4, 5])
        elif season == "SUMMER":
            month = rng.choice([6, 7, 8])
        else:
            month = rng.choice([9, 10, 11])

        year = rng.randint(2018, 2024)
        day = rng.randint(1, 28)
        begin_date = datetime(year, month, day)
        duration_hours = rng.lognormvariate(1.5, 1.0)
        end_date = begin_date + timedelta(hours=duration_hours)

        # Geographic clustering: tornadoes prefer tornado alley
        if event_type == "Tornado":
            state_pool = [s for s in US_STATES if s[0] in tornado_alley]
        elif event_type == "Hurricane":
            state_pool = [s for s in US_STATES if s[0] in {"FL", "TX", "LA", "NC", "SC", "AL", "MS"}]
        elif event_type in ("Heavy Snow", "Blizzard", "Ice Storm", "Winter Storm"):
            state_pool = [s for s in US_STATES if s[0] not in {"FL", "HI", "CA", "AZ", "NM"}]
        else:
            state_pool = list(US_STATES)

        state = rng.choice(state_pool)

        # Magnitude (for wind/hail events in knots or inches)
        magnitude = None
        magnitude_type = None
        if event_type in ("Thunderstorm Wind", "High Wind"):
            magnitude = round(rng.uniform(50, 100), 0)  # knots
            magnitude_type = "EG"  # Estimated gust
        elif event_type == "Hail":
            magnitude = round(rng.uniform(0.75, 3.0), 2)  # inches
            magnitude_type = "Inches"
        elif event_type == "Tornado":
            magnitude = round(rng.uniform(65, 200), 0)
            magnitude_type = "EG"

        # Tornado EF scale
        ef_scale = None
        tor_length = None
        tor_width = None
        if event_type == "Tornado":
            ef_rating = rng.choices([0, 1, 2, 3, 4, 5], weights=[40, 30, 15, 10, 4, 1], k=1)[0]
            ef_scale = f"EF{ef_rating}"
            tor_length = round(rng.lognormvariate(1.5, 1.2), 1)
            tor_width = round(rng.lognormvariate(4.5, 0.8), 0)

        # Damage estimation (correlated to event type and magnitude)
        if event_type == "Hurricane":
            prop_damage = rng.lognormvariate(18, 2.0)  # Can be billions
        elif event_type == "Tornado" and ef_scale in ("EF3", "EF4", "EF5"):
            prop_damage = rng.lognormvariate(16, 1.5)
        elif event_type in ("Flash Flood", "Flood"):
            prop_damage = rng.lognormvariate(12, 2.0)
        elif event_type == "Wildfire":
            prop_damage = rng.lognormvariate(14, 2.0)
        else:
            prop_damage = rng.lognormvariate(9, 2.5)

        prop_damage = max(0, prop_damage)
        crop_damage = prop_damage * rng.uniform(0, 0.3) if event_type not in ("Hurricane", "Tornado") else prop_damage * rng.uniform(0, 0.5)

        # Format damage as NCEI strings
        def _fmt_damage(val: float) -> str:
            if val >= 1e9:
                return f"{val/1e9:.2f}B"
            if val >= 1e6:
                return f"{val/1e6:.2f}M"
            if val >= 1e3:
                return f"{val/1e3:.2f}K"
            return f"{val:.0f}"

        # Casualties (rare, correlated to severity)
        deaths_direct = 0
        injuries_direct = 0
        if event_type in ("Tornado", "Hurricane", "Flash Flood") and rng.random() < 0.1:
            deaths_direct = rng.choices([0, 1, 2, 3, 5, 10], weights=[60, 20, 10, 5, 3, 2], k=1)[0]
            injuries_direct = deaths_direct * rng.randint(2, 10) if deaths_direct > 0 else rng.randint(0, 5)

        lat = state[3] + rng.uniform(-1.0, 1.0)
        lon = state[4] + rng.uniform(-1.5, 1.5)

        records.append({
            "event_id": str(700000 + i),
            "episode_id": str(100000 + i // 3),
            "event_type": event_type,
            "begin_date": begin_date.strftime("%Y-%m-%d"),
            "end_date": end_date.strftime("%Y-%m-%d"),
            "begin_time": begin_date.strftime("%H:%M"),
            "end_time": end_date.strftime("%H:%M"),
            "state": state[0],
            "state_fips": state[2],
            "cz_name": f"{state[1]}_COUNTY_{rng.randint(1,30):03d}",
            "cz_type": "C",
            "cz_fips": f"{rng.randint(1, 200):03d}",
            "begin_lat": round(lat, 6),
            "begin_lon": round(lon, 6),
            "end_lat": round(lat + rng.uniform(-0.1, 0.1), 6),
            "end_lon": round(lon + rng.uniform(-0.1, 0.1), 6),
            "magnitude": magnitude,
            "magnitude_type": magnitude_type,
            "injuries_direct": injuries_direct,
            "injuries_indirect": max(0, injuries_direct // 2 + rng.randint(0, 2)),
            "deaths_direct": deaths_direct,
            "deaths_indirect": max(0, deaths_direct // 3),
            "damage_property": _fmt_damage(prop_damage),
            "damage_crops": _fmt_damage(crop_damage),
            "source": rng.choice(["Trained Spotter", "Law Enforcement", "ASOS", "Emergency Mgr", "Public"]),
            "tor_f_scale": ef_scale,
            "tor_length": tor_length,
            "tor_width": tor_width,
            "flood_cause": rng.choice(["Heavy Rain", "Dam Break", "Ice Jam", None]) if "Flood" in event_type else None,
            "event_narrative": f"Synthetic {event_type} event in {state[1]}.",
            "episode_narrative": f"Synthetic episode containing {event_type} events.",
            "load_time": load_time,
        })

    return records


def generate_buoy_observations(
    num_buoys: int = 50,
    num_days: int = 90,
    start_date: datetime | None = None,
) -> list[dict[str, Any]]:
    """
    Generate synthetic NDBC ocean buoy observations.

    Produces realistic wave height, sea surface temperature, wind, pressure,
    salinity, and ocean current data with proper seasonal patterns and
    marine-region-specific characteristics.

    Args:
        num_buoys: Number of unique buoy stations to generate.
        num_days: Number of days of data per buoy.
        start_date: First observation date. Defaults to 90 days ago.

    Returns:
        List of buoy observation dicts ready for CSV output.
    """
    if start_date is None:
        start_date = datetime.now() - timedelta(days=num_days)

    rng = random.Random(456)
    records: list[dict[str, Any]] = []

    # Create buoy stations — use real stations first, then generate extras
    buoys = []
    for i in range(num_buoys):
        if i < len(BUOY_STATIONS):
            ref = BUOY_STATIONS[i]
            buoys.append({
                "station_id": ref[0],
                "station_name": ref[1],
                "latitude": ref[2],
                "longitude": ref[3],
                "water_depth_m": ref[4],
                "marine_region": ref[5],
                "station_type": "Buoy",
            })
        else:
            region_choices = ["ATLANTIC_EAST_COAST", "GULF_OF_MEXICO", "PACIFIC_WEST_COAST"]
            region = rng.choice(region_choices)
            if region == "ATLANTIC_EAST_COAST":
                lat, lon = rng.uniform(28, 44), rng.uniform(-78, -65)
            elif region == "GULF_OF_MEXICO":
                lat, lon = rng.uniform(24, 30), rng.uniform(-97, -83)
            else:
                lat, lon = rng.uniform(30, 48), rng.uniform(-130, -117)
            buoys.append({
                "station_id": f"4{rng.randint(1000, 9999):04d}",
                "station_name": f"SYNTH_BUOY_{i}",
                "latitude": round(lat, 6),
                "longitude": round(lon, 6),
                "water_depth_m": round(rng.uniform(15, 5000), 1),
                "marine_region": region,
                "station_type": "Buoy",
            })

    load_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Observations per day: every 60 minutes (24 per day)
    for buoy in buoys:
        # Base SST depends on region and latitude
        if buoy["marine_region"] == "GULF_OF_MEXICO":
            base_sst = 26.0
            sst_amplitude = 5.0
        elif buoy["marine_region"] == "HAWAII_PACIFIC":
            base_sst = 25.0
            sst_amplitude = 2.0
        elif buoy["marine_region"] == "ATLANTIC_EAST_COAST":
            base_sst = 18.0 - (buoy["latitude"] - 35) * 0.5
            sst_amplitude = 8.0
        elif buoy["marine_region"] == "PACIFIC_WEST_COAST":
            base_sst = 14.0
            sst_amplitude = 4.0
        elif buoy["marine_region"] == "GULF_OF_ALASKA":
            base_sst = 7.0
            sst_amplitude = 5.0
        else:
            base_sst = 20.0
            sst_amplitude = 6.0

        for day_offset in range(num_days):
            obs_date = start_date + timedelta(days=day_offset)
            doy = obs_date.timetuple().tm_yday

            for hour in range(0, 24, 1):
                # 10% chance of missing an observation (buoy maintenance, comms issues)
                if rng.random() < 0.10:
                    continue

                obs_dt = obs_date.replace(hour=hour, minute=0, second=0)

                # Seasonal SST
                sst = base_sst + sst_amplitude * math.sin(2 * math.pi * (doy - 60) / 365.0)
                sst += rng.gauss(0, 0.5)
                sst = round(max(-2.0, min(34.0, sst)), 2)

                # Air temperature: correlated with SST
                air_temp = sst + rng.gauss(-2, 1.5)
                air_temp = round(max(-30, min(45, air_temp)), 1)

                # Wind speed: seasonal with random storms
                base_wind = 4.0 + 2.0 * math.sin(2 * math.pi * (doy - 350) / 365.0)  # Winter peak
                if rng.random() < 0.05:
                    base_wind += rng.uniform(8, 20)  # Storm event
                wind_speed = max(0, base_wind + rng.gauss(0, 2.0))
                wind_dir = rng.randint(0, 359)

                # Wave height: correlated with wind
                wave_height = 0.3 + wind_speed * 0.25 + rng.gauss(0, 0.3)
                wave_height = round(max(0.05, wave_height), 2)
                wave_period = round(3.0 + wave_height * 1.2 + rng.gauss(0, 0.5), 1)
                wave_period = max(2.0, wave_period)

                # Pressure
                pressure = round(1013.25 + rng.gauss(0, 8), 1)

                # Salinity
                salinity = round(35.0 + rng.gauss(0, 0.8), 2)

                # Current
                current_speed = round(max(0, rng.gauss(0.3, 0.15)), 2)
                current_dir = rng.randint(0, 359)

                records.append({
                    "station_id": buoy["station_id"],
                    "station_name": buoy["station_name"],
                    "station_type": buoy["station_type"],
                    "latitude": buoy["latitude"],
                    "longitude": buoy["longitude"],
                    "water_depth_m": buoy["water_depth_m"],
                    "observation_datetime": obs_dt.strftime("%Y-%m-%d %H:%M:%S"),
                    "observation_date": obs_date.strftime("%Y-%m-%d"),
                    "wind_direction_deg": wind_dir,
                    "wind_speed_ms": round(wind_speed, 2),
                    "wind_gust_ms": round(wind_speed * rng.uniform(1.1, 1.6), 2),
                    "wave_height_m": wave_height,
                    "dominant_wave_period_s": wave_period,
                    "average_wave_period_s": round(wave_period * rng.uniform(0.7, 0.9), 1),
                    "mean_wave_direction_deg": (wind_dir + rng.randint(-30, 30)) % 360,
                    "pressure_hpa": pressure,
                    "air_temperature_c": air_temp,
                    "dewpoint_c": round(air_temp - rng.uniform(1, 8), 1),
                    "visibility_nmi": round(rng.uniform(5, 20), 1),
                    "sea_surface_temp_c": sst,
                    "salinity_psu": salinity,
                    "ocean_current_speed_ms": current_speed,
                    "ocean_current_direction_deg": current_dir,
                    "water_level_m": round(rng.gauss(0, 0.5), 3),
                    "load_time": load_time,
                })

    return records


def _write_csv(records: list[dict], filepath: str) -> None:
    """Write a list of dicts to CSV."""
    if not records:
        print(f"  ⚠ No records to write for {filepath}")
        return
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=records[0].keys())
        writer.writeheader()
        writer.writerows(records)
    print(f"  ✓ Wrote {len(records):,} records to {filepath}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate synthetic NOAA climate and environmental data",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --output-dir ../../domains/dbt/seeds
  %(prog)s --stations 200 --storm-events 500 --buoys 20
  %(prog)s --start-date 2022-01-01 --days 730
        """,
    )
    parser.add_argument(
        "--output-dir", "-o",
        default="./output",
        help="Output directory for generated CSV files (default: ./output)",
    )
    parser.add_argument(
        "--stations", type=int, default=500,
        help="Number of weather stations (default: 500)",
    )
    parser.add_argument(
        "--days", type=int, default=365,
        help="Number of days of weather data per station (default: 365)",
    )
    parser.add_argument(
        "--storm-events", type=int, default=2000,
        help="Number of storm events to generate (default: 2000)",
    )
    parser.add_argument(
        "--buoys", type=int, default=50,
        help="Number of ocean buoy stations (default: 50)",
    )
    parser.add_argument(
        "--buoy-days", type=int, default=90,
        help="Number of days of buoy data (default: 90)",
    )
    parser.add_argument(
        "--start-date",
        type=lambda s: datetime.strptime(s, "%Y-%m-%d"),
        default=None,
        help="Start date for observations (YYYY-MM-DD). Default: Jan 1 of previous year.",
    )
    parser.add_argument(
        "--format", choices=["csv", "parquet"], default="csv",
        help="Output format (default: csv). Parquet requires pyarrow.",
    )

    args = parser.parse_args()

    print("=" * 60)
    print("NOAA Synthetic Data Generator")
    print("=" * 60)

    # Weather observations
    print(f"\n📡 Generating weather observations ({args.stations} stations × {args.days} days)...")
    weather = generate_weather_observations(
        num_stations=args.stations,
        num_days=args.days,
        start_date=args.start_date,
    )
    _write_csv(weather, os.path.join(args.output_dir, "ghcn_daily.csv"))

    # Storm events
    print(f"\n🌪 Generating storm events ({args.storm_events} events)...")
    storms = generate_storm_events(n=args.storm_events)
    _write_csv(storms, os.path.join(args.output_dir, "storm_events.csv"))

    # Buoy observations
    print(f"\n🌊 Generating buoy observations ({args.buoys} buoys × {args.buoy_days} days)...")
    buoys = generate_buoy_observations(
        num_buoys=args.buoys,
        num_days=args.buoy_days,
        start_date=args.start_date,
    )
    _write_csv(buoys, os.path.join(args.output_dir, "ndbc_buoy.csv"))

    print(f"\n✅ Data generation complete! Files in: {os.path.abspath(args.output_dir)}")
    print(f"   Total records: {len(weather) + len(storms) + len(buoys):,}")


if __name__ == "__main__":
    main()
