#!/usr/bin/env python3
"""
Generate synthetic Interior Department data for the CSA-in-a-Box platform.

Produces realistic USGS earthquake events, NPS park visitor statistics,
and USGS water gauge measurements suitable for developing and testing
the medallion architecture pipeline.

Usage:
    python generate_interior_data.py --output-dir ../domains/dbt/seeds --seed 42
    python generate_interior_data.py --earthquakes 5000 --parks 60 --park-months 36
"""

import argparse
import csv
import math
import os
import random
from datetime import datetime, timedelta
from typing import Any

# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

# Fault zone centers for geographic clustering of earthquakes
# (lat, lon, name, base_rate, max_depth, typical_magnitude_range)
FAULT_ZONES: list[dict[str, Any]] = [
    {"lat": 36.0, "lon": -120.0, "name": "San Andreas (Central CA)",
     "rate": 0.25, "max_depth": 20, "mag_range": (2.5, 7.5)},
    {"lat": 34.0, "lon": -118.5, "name": "San Andreas (Southern CA)",
     "rate": 0.20, "max_depth": 15, "mag_range": (2.5, 7.8)},
    {"lat": 38.0, "lon": -122.0, "name": "Hayward Fault (Bay Area)",
     "rate": 0.15, "max_depth": 15, "mag_range": (2.5, 7.0)},
    {"lat": 47.5, "lon": -122.5, "name": "Cascadia (Pacific NW)",
     "rate": 0.08, "max_depth": 60, "mag_range": (2.5, 9.0)},
    {"lat": 61.0, "lon": -150.0, "name": "Alaska Subduction",
     "rate": 0.12, "max_depth": 200, "mag_range": (2.5, 9.2)},
    {"lat": 19.5, "lon": -155.5, "name": "Hawaii Hotspot",
     "rate": 0.05, "max_depth": 40, "mag_range": (2.0, 6.5)},
    {"lat": 36.5, "lon": -89.5, "name": "New Madrid (Central US)",
     "rate": 0.03, "max_depth": 15, "mag_range": (2.0, 5.5)},
    {"lat": 44.5, "lon": -110.5, "name": "Yellowstone",
     "rate": 0.06, "max_depth": 15, "mag_range": (1.5, 5.0)},
    {"lat": 37.0, "lon": -112.0, "name": "Intermountain Seismic Belt",
     "rate": 0.04, "max_depth": 20, "mag_range": (2.0, 6.0)},
    {"lat": 35.5, "lon": -97.5, "name": "Oklahoma (Induced)",
     "rate": 0.05, "max_depth": 10, "mag_range": (2.5, 5.8)},
]

# National Parks with visitor statistics reference
NPS_PARKS: list[dict[str, Any]] = [
    {"code": "GRCA", "name": "Grand Canyon", "state": "AZ", "type": "National Park",
     "annual_base": 6_380_000, "acres": 1_218_375, "seasonality": 1.8},
    {"code": "GRTE", "name": "Grand Teton", "state": "WY", "type": "National Park",
     "annual_base": 3_490_000, "acres": 310_044, "seasonality": 2.5},
    {"code": "YELL", "name": "Yellowstone", "state": "WY,MT,ID", "type": "National Park",
     "annual_base": 4_860_000, "acres": 2_219_791, "seasonality": 3.0},
    {"code": "ZION", "name": "Zion", "state": "UT", "type": "National Park",
     "annual_base": 4_690_000, "acres": 147_242, "seasonality": 1.6},
    {"code": "ROMO", "name": "Rocky Mountain", "state": "CO", "type": "National Park",
     "annual_base": 4_670_000, "acres": 265_807, "seasonality": 2.0},
    {"code": "ACAD", "name": "Acadia", "state": "ME", "type": "National Park",
     "annual_base": 4_070_000, "acres": 49_071, "seasonality": 3.5},
    {"code": "GSMNP", "name": "Great Smoky Mountains", "state": "NC,TN", "type": "National Park",
     "annual_base": 12_940_000, "acres": 522_427, "seasonality": 1.5},
    {"code": "JOTR", "name": "Joshua Tree", "state": "CA", "type": "National Park",
     "annual_base": 3_060_000, "acres": 790_636, "seasonality": 2.0},
    {"code": "YOSE", "name": "Yosemite", "state": "CA", "type": "National Park",
     "annual_base": 3_880_000, "acres": 761_748, "seasonality": 2.2},
    {"code": "GLAC", "name": "Glacier", "state": "MT", "type": "National Park",
     "annual_base": 3_080_000, "acres": 1_013_572, "seasonality": 4.0},
    {"code": "OLYM", "name": "Olympic", "state": "WA", "type": "National Park",
     "annual_base": 3_450_000, "acres": 922_650, "seasonality": 2.0},
    {"code": "EVER", "name": "Everglades", "state": "FL", "type": "National Park",
     "annual_base": 940_000, "acres": 1_508_938, "seasonality": 2.5},
    {"code": "DENA", "name": "Denali", "state": "AK", "type": "National Park",
     "annual_base": 587_000, "acres": 4_740_912, "seasonality": 8.0},
    {"code": "ARCH", "name": "Arches", "state": "UT", "type": "National Park",
     "annual_base": 1_810_000, "acres": 76_678, "seasonality": 2.0},
    {"code": "SHEN", "name": "Shenandoah", "state": "VA", "type": "National Park",
     "annual_base": 1_590_000, "acres": 199_224, "seasonality": 1.8},
    {"code": "SAGU", "name": "Saguaro", "state": "AZ", "type": "National Park",
     "annual_base": 1_080_000, "acres": 91_716, "seasonality": 1.5},
    {"code": "CRLA", "name": "Crater Lake", "state": "OR", "type": "National Park",
     "annual_base": 710_000, "acres": 183_224, "seasonality": 5.0},
    {"code": "HAVO", "name": "Hawaii Volcanoes", "state": "HI", "type": "National Park",
     "annual_base": 1_260_000, "acres": 335_259, "seasonality": 1.3},
    {"code": "BRCA", "name": "Bryce Canyon", "state": "UT", "type": "National Park",
     "annual_base": 2_600_000, "acres": 35_835, "seasonality": 2.8},
    {"code": "CANY", "name": "Canyonlands", "state": "UT", "type": "National Park",
     "annual_base": 910_000, "acres": 337_598, "seasonality": 2.0},
    {"code": "BADL", "name": "Badlands", "state": "SD", "type": "National Park",
     "annual_base": 1_060_000, "acres": 242_756, "seasonality": 3.0},
    {"code": "BISC", "name": "Biscayne", "state": "FL", "type": "National Park",
     "annual_base": 708_000, "acres": 172_924, "seasonality": 1.5},
    {"code": "GRSM", "name": "Great Sand Dunes", "state": "CO", "type": "National Park",
     "annual_base": 602_000, "acres": 149_028, "seasonality": 2.5},
    {"code": "SEKI", "name": "Sequoia & Kings Canyon", "state": "CA", "type": "National Park",
     "annual_base": 1_850_000, "acres": 631_173, "seasonality": 2.0},
    {"code": "MEVE", "name": "Mesa Verde", "state": "CO", "type": "National Park",
     "annual_base": 563_000, "acres": 52_485, "seasonality": 3.5},
]

# Water gauge sites (state, center_lat, center_lon)
WATER_GAUGE_STATES = [
    ("CA", 35.0, -119.0), ("OR", 44.0, -121.0), ("WA", 47.5, -121.0),
    ("CO", 39.0, -105.5), ("MT", 47.0, -110.0), ("ID", 44.0, -114.0),
    ("UT", 39.5, -111.5), ("AZ", 34.0, -111.5), ("NM", 35.0, -106.0),
    ("TX", 31.0, -100.0), ("OK", 35.5, -97.0), ("KS", 38.5, -98.5),
    ("NE", 41.0, -100.0), ("SD", 44.0, -100.0), ("ND", 47.5, -100.5),
    ("WY", 43.0, -107.5), ("NV", 39.0, -117.0), ("VA", 37.5, -79.0),
    ("NC", 35.5, -79.5), ("GA", 33.0, -83.5), ("FL", 28.0, -82.0),
    ("AL", 33.0, -87.0), ("PA", 41.0, -77.5), ("NY", 42.5, -75.5),
    ("OH", 40.5, -82.5),
]

MAGNITUDE_TYPES = ["mw", "ml", "mb", "md", "ms"]
USGS_NETWORKS = ["us", "ci", "nc", "uw", "nn", "ak", "hv", "nm", "ok"]


# ---------------------------------------------------------------------------
# Earthquake data generator
# ---------------------------------------------------------------------------

def generate_earthquake_data(rng: random.Random, n: int = 5000) -> list[dict]:
    """Generate synthetic earthquake events with realistic distributions.

    Uses the Gutenberg-Richter frequency-magnitude relationship:
    log10(N) = a - b*M  (b ~ 1.0)

    This means for every M5.0 event, there are ~10 M4.0 events,
    ~100 M3.0 events, etc. We implement this via inverse CDF sampling.

    Events are geographically clustered along fault zones with
    realistic depth distributions for each tectonic setting.
    """
    records = []
    now = datetime.now().isoformat()

    # Fault zone weights (proportional to rate)
    zone_weights = [z["rate"] for z in FAULT_ZONES]

    for _i in range(n):
        # Select fault zone with weighted probability
        zone = rng.choices(FAULT_ZONES, weights=zone_weights, k=1)[0]

        # Generate magnitude using Gutenberg-Richter inverse CDF
        # For b=1.0: P(M >= m) = 10^(a - b*m)
        # Sampling: m = Mc - (1/b) * log10(U), U ~ Uniform(0,1)
        b_value = rng.gauss(1.0, 0.05)
        b_value = max(0.7, min(1.3, b_value))
        mc = zone["mag_range"][0]
        max_mag = zone["mag_range"][1]

        u = rng.random()
        magnitude = mc - (1.0 / b_value) * math.log10(max(u, 1e-10))
        magnitude = min(magnitude, max_mag)
        magnitude = round(magnitude, 1)

        # Depth: log-normal distribution, capped by zone max
        depth = rng.lognormvariate(math.log(10), 0.8)
        depth = min(depth, zone["max_depth"])
        depth = max(0.1, depth)
        depth = round(depth, 2)

        # Location: Gaussian scatter around fault zone center
        lat = zone["lat"] + rng.gauss(0, 0.5)
        lon = zone["lon"] + rng.gauss(0, 0.5)
        lat = round(max(-90, min(90, lat)), 6)
        lon = round(max(-180, min(180, lon)), 6)

        # Time: random within last 10 years, with some temporal clustering
        days_ago = rng.randint(0, 3650)
        event_dt = datetime.now() - timedelta(days=days_ago)
        # Add hour/minute randomness
        event_dt += timedelta(
            hours=rng.randint(0, 23),
            minutes=rng.randint(0, 59),
            seconds=rng.randint(0, 59),
        )

        # Event ID (USGS-style network + serial)
        network = rng.choice(USGS_NETWORKS)
        event_id = f"{network}{rng.randint(1000000, 9999999):07d}"

        # Magnitude type: prefer Mw for larger events
        mag_type = "mw" if magnitude >= 4.0 else rng.choice(MAGNITUDE_TYPES)

        # Quality metrics
        num_stations = max(3, int(rng.gauss(25, 12)))
        gap = max(10, min(355, rng.gauss(120, 60)))
        rms_val = max(0.01, rng.gauss(0.5, 0.2))

        # Felt reports (more for larger, shallower events)
        felt = 0
        if magnitude >= 3.0 and depth < 30:
            felt = max(0, int(10 ** (magnitude - 2.5) * rng.uniform(0.3, 1.5)))

        # Modified Mercalli Intensity estimate
        mmi = 0.0
        if magnitude >= 3.0 and depth < 100:
            mmi = round(min(12, max(0, 2.0 * magnitude - 1.0 - math.log10(max(depth, 1)))), 1)

        # PAGER alert level
        alert = None
        if magnitude >= 7.0:
            alert = rng.choice(["red", "orange"])
        elif magnitude >= 5.5:
            alert = rng.choice(["orange", "yellow"])
        elif magnitude >= 4.5:
            alert = "yellow"
        elif magnitude >= 3.5:
            alert = "green"

        # Tsunami flag
        tsunami = 1 if magnitude >= 7.0 and depth < 50 else 0

        # Significance score (USGS composite metric 0-1000)
        sig = int(min(1000, magnitude ** 3 * rng.uniform(1, 3) + felt * 0.5))

        records.append({
            "event_id": event_id,
            "event_time": event_dt.strftime("%Y-%m-%d %H:%M:%S"),
            "updated_time": (event_dt + timedelta(minutes=rng.randint(5, 120))).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            "latitude": lat,
            "longitude": lon,
            "depth_km": depth,
            "magnitude": magnitude,
            "magnitude_type": mag_type,
            "place_description": f"{rng.randint(1, 50)}km {'NESW'[rng.randint(0,3)]} of {zone['name']}",
            "event_type": "earthquake",
            "status": rng.choices(["reviewed", "automatic"], weights=[0.8, 0.2])[0],
            "tsunami_flag": tsunami,
            "felt_reports": felt,
            "cdi": round(mmi * rng.uniform(0.7, 1.0), 1) if mmi > 0 else None,
            "mmi": mmi if mmi > 0 else None,
            "alert_level": alert,
            "num_stations": num_stations,
            "azimuthal_gap": round(gap, 2),
            "distance_to_nearest_station": round(rng.uniform(0.01, 2.0), 4),
            "rms": round(rms_val, 4),
            "horizontal_error": round(rng.uniform(0.1, 5.0), 4),
            "depth_error": round(rng.uniform(0.5, 10.0), 4),
            "magnitude_error": round(rng.uniform(0.05, 0.5), 2),
            "network": network,
            "sources": f",{network},",
            "types": ",origin,magnitude,phase-data,",
            "sig": sig,
            "_source": "BATCH",
            "load_time": now,
        })

    return records


# ---------------------------------------------------------------------------
# Park visitor data generator
# ---------------------------------------------------------------------------

def generate_park_visitors(
    rng: random.Random, parks: int = 60, months: int = 36
) -> list[dict]:
    """Generate synthetic monthly park visitor data with seasonal patterns.

    Uses a seasonal model: visitors(month) = trend * seasonal_index * noise

    Seasonal indices are derived from known NPS visitation patterns:
    - Peak: June-August (highest)
    - Shoulder: April-May, September-October
    - Off-peak: November-March (lowest)

    COVID-19 impact modeled as multiplicative shock in 2020-2021.
    """
    records = []
    now = datetime.now().isoformat()

    # Base seasonal indices (January=0 through December=11)
    base_seasonal = [0.25, 0.25, 0.40, 0.60, 0.80, 1.20, 1.50, 1.40, 0.90, 0.70, 0.35, 0.30]

    selected_parks = NPS_PARKS[:parks]
    # If more parks requested than available, duplicate with modifications
    while len(selected_parks) < parks:
        template = NPS_PARKS[rng.randint(0, len(NPS_PARKS) - 1)]
        new_park = template.copy()
        suffix = len(selected_parks) - len(NPS_PARKS) + 1
        new_park["code"] = f"P{suffix:03d}"
        new_park["name"] = f"Park Unit {suffix}"
        new_park["annual_base"] = int(template["annual_base"] * rng.uniform(0.3, 1.5))
        selected_parks.append(new_park)

    end_date = datetime.now()
    start_date = end_date - timedelta(days=months * 30)

    nps_regions = ["Northeast", "Southeast", "Midwest", "Intermountain",
                   "Pacific West", "Alaska", "National Capital"]

    for park in selected_parks:
        monthly_base = park["annual_base"] / 12.0
        seasonality_factor = park["seasonality"]

        # Adjust seasonal indices based on park-specific seasonality strength
        park_seasonal = [
            max(0.1, s ** (1 / seasonality_factor) if s < 1.0 else s ** seasonality_factor)
            for s in base_seasonal
        ]
        # Normalize so they average to 1.0
        avg_s = sum(park_seasonal) / 12.0
        park_seasonal = [s / avg_s for s in park_seasonal]

        # Park characteristics
        campground_cap = max(0, int(park.get("acres", 100000) / 5000 * rng.uniform(0.5, 2.0)))
        trail_mi = round(park.get("acres", 100000) / 3000 * rng.uniform(0.3, 1.5), 1)
        parking = max(100, int(campground_cap * rng.uniform(3, 8)))

        for m_offset in range(months):
            dt = start_date + timedelta(days=m_offset * 30)
            yr = dt.year
            mo = dt.month

            # Trend: slight annual growth (1-4% per year)
            year_factor = 1.0 + (yr - 2020) * rng.uniform(0.01, 0.04)

            # COVID-19 impact
            covid_factor = 1.0
            if yr == 2020 and mo >= 3:
                covid_factor = rng.uniform(0.1, 0.5) if mo <= 5 else rng.uniform(0.5, 0.8)
            elif yr == 2021 and mo <= 3:
                covid_factor = rng.uniform(0.6, 0.85)

            # Monthly visitors = base * season * trend * covid * noise
            seasonal_idx = park_seasonal[mo - 1]
            visitors = int(
                monthly_base * seasonal_idx * year_factor * covid_factor
                * rng.gauss(1.0, 0.08)
            )
            visitors = max(0, visitors)

            # Camping breakdown
            total_campers = int(visitors * rng.uniform(0.02, 0.08))
            tent = int(total_campers * rng.uniform(0.4, 0.6))
            rv = int(total_campers * rng.uniform(0.2, 0.4))
            backcountry = total_campers - tent - rv

            # Recreation hours (avg 4-8 hours per visit)
            rec_hours = round(visitors * rng.uniform(3.5, 8.0), 2)

            records.append({
                "park_code": park["code"],
                "park_name": park["name"],
                "park_type": park["type"],
                "state": park["state"],
                "region": rng.choice(nps_regions),
                "year": yr,
                "month": mo,
                "recreation_visits": visitors,
                "non_recreation_visits": int(visitors * rng.uniform(0.01, 0.05)),
                "recreation_hours": rec_hours,
                "concessioner_lodging": int(visitors * rng.uniform(0.005, 0.02)),
                "concessioner_camping": int(total_campers * rng.uniform(0.3, 0.6)),
                "tent_campers": tent,
                "rv_campers": rv,
                "backcountry_campers": max(0, backcountry),
                "park_acres": park.get("acres", 100000),
                "trail_miles": trail_mi,
                "campground_capacity": campground_cap,
                "parking_spaces": parking,
                "load_time": now,
            })

    return records


# ---------------------------------------------------------------------------
# Water gauge data generator
# ---------------------------------------------------------------------------

def generate_water_gauge_data(
    rng: random.Random, gauges: int = 200, days: int = 365
) -> list[dict]:
    """Generate synthetic stream flow and water level data.

    Uses a seasonal model with storm event superposition:
    - Base flow: sinusoidal seasonal pattern (spring high, late summer low)
    - Storm events: random Poisson-distributed spikes
    - Long-term trend: slight variation for drought/wet year simulation

    Streamflow units: cubic feet per second (CFS)
    Gauge height units: feet
    """
    records = []
    now = datetime.now().isoformat()

    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)

    # Generate gauge site metadata
    sites = []
    for g in range(gauges):
        state_info = WATER_GAUGE_STATES[g % len(WATER_GAUGE_STATES)]
        state_code = state_info[0]
        base_lat = state_info[1] + rng.gauss(0, 1.5)
        base_lon = state_info[2] + rng.gauss(0, 1.5)

        site_id = f"{rng.randint(1, 9):01d}{rng.randint(1000000, 9999999):07d}"
        drainage_area = max(5, rng.lognormvariate(math.log(500), 1.2))

        # Base flow proportional to drainage area
        base_flow = drainage_area * rng.uniform(0.5, 2.0)

        # HUC code (8-digit hydrologic unit code)
        huc = f"{rng.randint(1, 21):02d}{rng.randint(10, 99):02d}{rng.randint(1000, 9999):04d}"

        sites.append({
            "site_id": site_id,
            "site_name": f"Stream near {state_code}-{g + 1:03d}",
            "site_latitude": round(base_lat, 6),
            "site_longitude": round(base_lon, 6),
            "site_type": "ST",
            "state_code": state_code,
            "county_code": f"{rng.randint(1, 200):03d}",
            "huc_code": huc,
            "drainage_area_sq_mi": round(drainage_area, 1),
            "base_flow": base_flow,
        })

    for site in sites:
        base_flow = site["base_flow"]

        # Historical percentiles (for drought/flood classification)
        p10 = round(base_flow * 0.2, 4)
        p25 = round(base_flow * 0.4, 4)
        p50 = round(base_flow * 0.8, 4)
        p75 = round(base_flow * 1.3, 4)
        p90 = round(base_flow * 2.0, 4)

        # NWS flood stages (gauge height in feet)
        base_gauge = rng.uniform(3, 8)
        action_stage = round(base_gauge + rng.uniform(3, 6), 2)
        flood_stage = round(action_stage + rng.uniform(2, 4), 2)
        moderate_flood = round(flood_stage + rng.uniform(2, 4), 2)
        major_flood = round(moderate_flood + rng.uniform(3, 6), 2)

        # Storm event schedule (approximately Poisson-distributed)
        storm_days = set()
        avg_storms = days / 30  # ~1 storm per month
        n_storms = int(max(0, rng.gauss(avg_storms, avg_storms * 0.3)))
        for _ in range(n_storms):
            storm_days.add(rng.randint(0, days - 1))

        for d in range(days):
            date = start_date + timedelta(days=d)
            day_of_year = date.timetuple().tm_yday

            # Seasonal flow pattern:
            # Peak around day 100 (April snowmelt), trough around day 250 (September)
            seasonal_factor = 1.0 + 0.6 * math.cos(
                2 * math.pi * (day_of_year - 100) / 365
            )

            # Storm hydrograph superposition
            storm_factor = 1.0
            for storm_day in storm_days:
                days_since_storm = d - storm_day
                if 0 <= days_since_storm <= 7:
                    # Quick rise on day 0, exponential recession
                    if days_since_storm == 0:
                        storm_factor += rng.uniform(2, 8)
                    else:
                        storm_factor += max(0, rng.uniform(1, 5) * math.exp(
                            -days_since_storm / 2.0
                        ))

            # Daily mean streamflow
            daily_flow = max(0.1, base_flow * seasonal_factor * storm_factor
                             * rng.gauss(1.0, 0.1))
            daily_min = daily_flow * rng.uniform(0.7, 0.95)
            daily_max = daily_flow * rng.uniform(1.05, 1.4)

            # Gauge height (approximate from flow using Manning's equation power law)
            # Stage ~ flow^0.4
            gauge_ht = round(base_gauge * (daily_flow / base_flow) ** 0.4, 2)

            # Streamflow record (USGS parameter code 00060)
            records.append({
                "site_id": site["site_id"],
                "site_name": site["site_name"],
                "site_latitude": site["site_latitude"],
                "site_longitude": site["site_longitude"],
                "site_type": site["site_type"],
                "state_code": site["state_code"],
                "county_code": site["county_code"],
                "huc_code": site["huc_code"],
                "drainage_area_sq_mi": site["drainage_area_sq_mi"],
                "measurement_date": date.strftime("%Y-%m-%d"),
                "measurement_datetime": None,
                "parameter_code": "00060",
                "parameter_name": "Streamflow, ft3/s",
                "parameter_unit": "ft3/s",
                "value": round(daily_flow, 4),
                "daily_mean": round(daily_flow, 4),
                "daily_min": round(daily_min, 4),
                "daily_max": round(daily_max, 4),
                "qualification_code": rng.choices(["A", "P"], weights=[0.85, 0.15])[0],
                "action_stage_ft": action_stage,
                "flood_stage_ft": flood_stage,
                "moderate_flood_stage_ft": moderate_flood,
                "major_flood_stage_ft": major_flood,
                "percentile_10": p10,
                "percentile_25": p25,
                "percentile_50": p50,
                "percentile_75": p75,
                "percentile_90": p90,
                "_source": "BATCH",
                "load_time": now,
            })

            # Gauge height record (USGS parameter code 00065)
            records.append({
                "site_id": site["site_id"],
                "site_name": site["site_name"],
                "site_latitude": site["site_latitude"],
                "site_longitude": site["site_longitude"],
                "site_type": site["site_type"],
                "state_code": site["state_code"],
                "county_code": site["county_code"],
                "huc_code": site["huc_code"],
                "drainage_area_sq_mi": site["drainage_area_sq_mi"],
                "measurement_date": date.strftime("%Y-%m-%d"),
                "measurement_datetime": None,
                "parameter_code": "00065",
                "parameter_name": "Gage height, ft",
                "parameter_unit": "ft",
                "value": gauge_ht,
                "daily_mean": gauge_ht,
                "daily_min": round(gauge_ht * 0.95, 2),
                "daily_max": round(gauge_ht * 1.08, 2),
                "qualification_code": rng.choices(["A", "P"], weights=[0.85, 0.15])[0],
                "action_stage_ft": action_stage,
                "flood_stage_ft": flood_stage,
                "moderate_flood_stage_ft": moderate_flood,
                "major_flood_stage_ft": major_flood,
                "percentile_10": round(base_gauge * 0.6, 2),
                "percentile_25": round(base_gauge * 0.8, 2),
                "percentile_50": round(base_gauge, 2),
                "percentile_75": round(base_gauge * 1.3, 2),
                "percentile_90": round(base_gauge * 1.8, 2),
                "_source": "BATCH",
                "load_time": now,
            })

    return records


# ---------------------------------------------------------------------------
# File writing
# ---------------------------------------------------------------------------

def write_csv(rows: list[dict], filepath: str) -> None:
    """Write a list of dicts to a CSV file."""
    if not rows:
        return
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    fieldnames = list(rows[0].keys())
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Wrote {len(rows):,} rows to {filepath}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate synthetic Interior Department data for CSA-in-a-Box"
    )
    parser.add_argument(
        "--earthquakes", type=int, default=5000,
        help="Number of earthquake events to generate (default: 5000)",
    )
    parser.add_argument(
        "--parks", type=int, default=60,
        help="Number of national parks (default: 60)",
    )
    parser.add_argument(
        "--park-months", type=int, default=36,
        help="Months of park visitor data per park (default: 36)",
    )
    parser.add_argument(
        "--gauges", type=int, default=200,
        help="Number of water gauge sites (default: 200)",
    )
    parser.add_argument(
        "--gauge-days", type=int, default=365,
        help="Days of water gauge data per site (default: 365)",
    )
    parser.add_argument(
        "--output-dir", type=str, default="output",
        help="Output directory for CSV files (default: output)",
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)",
    )

    args = parser.parse_args()
    rng = random.Random(args.seed)

    print("=" * 60)
    print("Interior Department Synthetic Data Generator")
    print("=" * 60)
    print(f"  Earthquakes:     {args.earthquakes:,}")
    print(f"  Parks:           {args.parks}")
    print(f"  Park months:     {args.park_months}")
    print(f"  Water gauges:    {args.gauges}")
    print(f"  Gauge days:      {args.gauge_days}")
    print(f"  Output dir:      {args.output_dir}")
    print(f"  Random seed:     {args.seed}")
    print()

    print("[1/3] Generating earthquake event data...")
    earthquakes = generate_earthquake_data(rng, n=args.earthquakes)
    write_csv(earthquakes, os.path.join(args.output_dir, "usgs_earthquakes.csv"))
    print()

    print("[2/3] Generating park visitor data...")
    visitors = generate_park_visitors(rng, parks=args.parks, months=args.park_months)
    write_csv(visitors, os.path.join(args.output_dir, "nps_visitors.csv"))
    print()

    print("[3/3] Generating water gauge data...")
    water = generate_water_gauge_data(rng, gauges=args.gauges, days=args.gauge_days)
    write_csv(water, os.path.join(args.output_dir, "usgs_water_gauges.csv"))
    print()

    print("=" * 60)
    total = len(earthquakes) + len(visitors) + len(water)
    print(f"Done! Generated {total:,} total records.")
    print(f"Files saved to: {os.path.abspath(args.output_dir)}")
    print("=" * 60)


if __name__ == "__main__":
    main()
